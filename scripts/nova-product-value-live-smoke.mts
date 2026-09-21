/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { getServerSupabaseConfig } from "../lib/supabase/server-env.ts";

// Explicit opt-in: writes only a dedicated test agent, reads public sources and
// calls the configured model. No payment endpoint, wallet or signer is used.
assert(process.argv.includes("--live"), "Pass --live to run the isolated live smoke.");
const base = process.argv.find(a => a.startsWith("--base-url="))?.slice("--base-url=".length) ?? "http://127.0.0.1:3100";
const config = getServerSupabaseConfig();
const db = createClient(config.url!, config.key!);
const name = `Value QA ${Date.now()}`;
const goal = "Find official Arc and Circle changes that affect integrating Veyra with agent payments. Explain what changed and which documented compatibility checks are needed.";
let who: { publicId: string; ownerSecret: string } | null = null;
const browser = await chromium.launch({ headless: true });
const errors: string[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  page.on("pageerror", e => errors.push(e.name));
  await page.goto(base);
  await page.getByLabel("Agent name", { exact: true }).fill(name);
  await page.getByLabel("What do you want Nova to help you achieve?").fill(goal);
  await page.getByRole("button", { name: "Arc", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Arc", exact: true }).getAttribute("aria-pressed"), "true");
  const createdPromise = page.waitForResponse(r => r.url() === `${base}/api/nova/v1/agents` && r.request().method() === "POST", { timeout: 30000 });
  await page.getByRole("button", { name: `Create ${name}`, exact: true }).click();
  const createdResponse = await createdPromise;
  assert.equal(createdResponse.status(), 201);
  const created = await createdResponse.json();
  who = { publicId: created.agent.publicId, ownerSecret: created.ownerSecret };
  assert.equal(created.agent.goal, goal);
  console.log("Created dedicated agent with a persisted goal.");
  // Avoid capturing the one-time recovery-key panel in screenshots or logs.
  await page.getByText("Your goal:", { exact: true }).waitFor({ timeout: 120000 });
  await page.reload();
  await page.getByText("Your goal:", { exact: true }).waitFor();
  const headers = { "x-nova-key": who.ownerSecret, "Content-Type": "application/json" };
  const readBrief = async () => {
    const response = await fetch(`${base}/api/nova/v1/agents/${who!.publicId}/brief`, { headers });
    assert.equal(response.status, 200);
    return response.json();
  };
  const brief = await readBrief();
  assert(brief.worthAttention.every((s: { kind: string }) => !["repository_activity", "capability_available"].includes(s.kind)));
  const all = [...brief.worthAttention, ...brief.watchlist, ...brief.noise];
  const event = all.find(s => s.kind === "official_publication" && s.evidence.valueAssessment);
  console.log(JSON.stringify({observed:all.length,unavailable:brief.lastRefresh?.sourcesUnavailable,analyses:all.filter(s=>!!s.evidence.valueAssessment).length}));
  assert(event, "At least one real public-source analysis must succeed");
  const analysis = event.evidence.valueAssessment;
  assert.equal(analysis.goal, goal);
  assert(analysis.citations.length > 0);
  const unauthorized = await fetch(`${base}/api/nova/v1/agents/${who.publicId}/signals/${event.signalId}/read`, { method: "POST" });
  assert.equal(unauthorized.status, 404);
  const read = await fetch(`${base}/api/nova/v1/agents/${who.publicId}/signals/${event.signalId}/read`, { method: "POST", headers });
  assert.equal(read.status, 200);
  for (const viewport of [{ width: 1366, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    const size = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
    assert(size.scroll <= size.width + 1, "No horizontal overflow");
    await page.screenshot({ path: `/tmp/nova-product-value-${viewport.width}.png`, fullPage: true });
  }
  if (brief.worthAttention.length) {
    const savedFeedback = page.waitForResponse(r => r.request().method() === "PATCH" && /\/signals\/[^/]+$/.test(new URL(r.url()).pathname));
    await page.getByRole("button", { name: "Useful", exact: true }).first().click();
    const feedbackResponse = await savedFeedback;
    assert.equal(feedbackResponse.status(), 200);
    const ratedSignalId = new URL(feedbackResponse.url()).pathname.split("/").pop()!;
    await page.getByText("marked useful", { exact: true }).first().waitFor();
    const rated = await db.from("nova_value_feedback").select("feedback,goal").eq("signal_id", ratedSignalId);
    assert.equal(rated.data?.[0]?.feedback, "useful");
    assert.equal(rated.data?.[0]?.goal, goal);
  }
  await page.goto(`${base}/agent`);
  await page.getByRole("button", { name: /Change goal and sources/ }).click();
  const edited = `${goal} Prioritize documented integration requirements.`;
  await page.getByLabel("What result should Nova help you achieve?").fill(edited);
  await page.getByRole("button", { name: "Save and look again", exact: true }).click();
  await page.getByRole("button", { name: /Change goal and sources/ }).waitFor({ timeout: 120000 });
  // The edit form closes before refresh: wait for the persisted goal to appear.
  await page.getByText(edited, { exact: true }).waitFor({ timeout: 120000 });
  assert.equal((await readBrief()).agent.goal, edited);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, goalSaved: true, goalEdited: true, publicEvents: all.filter(s => s.kind === "official_publication").length, analyzedEvents: all.filter(s => !!s.evidence.valueAssessment).length, briefItems: brief.worthAttention.length, citations: analysis.citations.length, incompleteSources: brief.lastRefresh?.sourcesUnavailable ?? [], mobileAndDesktop: true, unauthorizedReadRejected: true }));
} finally {
  await browser.close();
  if (who) {
    const { error, data } = await db.from("nova_agents").delete().eq("public_id", who.publicId).eq("name", name).select("public_id");
    assert(!error && data?.length === 1, "Dedicated test agent cleanup must succeed");
    console.log("Dedicated test agent and its cascading records removed.");
  }
}
