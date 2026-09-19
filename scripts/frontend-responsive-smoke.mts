import assert from "node:assert/strict";
import { chromium } from "playwright";

function baseUrl() {
  const argument = process.argv.find((value) => value.startsWith("--base-url="));
  return (argument?.slice("--base-url=".length) ?? process.env.BASE_URL ?? "http://127.0.0.1:3100").replace(/\/$/, "");
}

async function noHorizontalOverflow(page: import("playwright").Page, path: string) {
  await page.goto(`${baseUrl()}${path}`, { waitUntil: "load" });
  const overflow = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  assert(overflow.scroll <= overflow.client + 1, `${path} overflows horizontally (${overflow.scroll} > ${overflow.client}).`);
}

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });

  /* The front door.
   *
   * This leg used to wait for a hero, five workflow headings and a row of
   * /agent-runner deep links, because the first screen was a tour of the
   * catalogue. It now creates a personal agent, so what has to be on it is the
   * one heading, the interests, and the single button that starts everything. */
  await page.goto(`${baseUrl()}/`, { waitUntil: "load" });
  await page.getByRole("heading", { name: "An agent that watches so you do not have to." }).waitFor();
  await page.getByLabel("Agent name").waitFor();
  await page.getByRole("button", { name: "Arc", exact: true }).waitFor();
  await page.getByRole("button", { name: /^Create/ }).waitFor();

  /* Nothing on the front door may advertise a subsystem. The catalogue is still
     there and still reachable; it is no longer what a stranger meets first. */
  assert.equal(await page.locator('a[href^="/agent-runner"]').count(), 0);
  assert.equal(await page.locator('input[name="repository"]').count(), 0);

  /* Everything below is frozen behind the developer console: opening the
     console is the opt-in and it lasts the session, so the test takes the same
     path an operator does instead of asserting against a redirect. */
  await page.context().addCookies([{
    name: "veyra_console",
    value: "1",
    url: baseUrl(),
  }]);

  await page.goto(`${baseUrl()}/agent-runner?workflow=builder_update`, { waitUntil: "load" });
  assert.equal(
    await page.getByRole("button", { name: /Builder Update Summary/ }).getAttribute("aria-pressed"),
    "true",
  );
  await page.getByRole("button", { name: /Market Context Brief/ }).click();
  assert.equal(
    await page.getByRole("button", { name: /Market Context Brief/ }).getAttribute("aria-pressed"),
    "true",
  );
  await page.getByRole("button", { name: /Sentiment & Tone Report/ }).click();
  assert.equal(
    await page.getByRole("button", { name: /Sentiment & Tone Report/ }).getAttribute("aria-pressed"),
    "true",
  );
  await page.goto(`${baseUrl()}/agent-runner?workflow=market_context&symbol=ETH%2FUSD`, { waitUntil: "load" });
  assert.equal(
    await page.getByRole("button", { name: /Market Context Brief/ }).getAttribute("aria-pressed"),
    "true",
  );
  await page.goto(`${baseUrl()}/agent-runner?workflow=invalid&symbol=DOGE%2FUSD`, { waitUntil: "load" });
  assert.equal(
    await page.getByRole("button", { name: /GitHub Project Due Diligence/ }).getAttribute("aria-pressed"),
    "true",
  );
  await page.getByText("Enter a public GitHub repository URL (e.g. github.com/owner/repository).", { exact: true }).waitFor();
  await page.goto(`${baseUrl()}/agent-runner?workflow=agent_trust`, { waitUntil: "load" });
  assert.equal(
    await page.getByRole("button", { name: /Veyra Agent Trust Report/ }).getAttribute("aria-pressed"),
    "true",
  );
  await page.getByLabel("Agent ID", { exact: true }).fill("agt_0123456789abcdefghij");
  await page.getByText("Provide at least one Agent ID", { exact: false }).waitFor({ state: "detached" });
  await page.goto(`${baseUrl()}/agent-runner?workflow=sentiment`, { waitUntil: "load" });
  await page.locator("#input-text").focus();
  assert.equal(await page.evaluate(() => document.activeElement?.id), "input-text");

  await page.goto(`${baseUrl()}/workflows`, { waitUntil: "load" });
  assert.equal(await page.locator('a[href="/agent-runner?workflow=custom"]').count(), 0);
  await page.locator('a[href="/agent-runner?workflow=github"]').waitFor();
  const provider = page.locator('[data-provider-type="live_provider"]').first();
  await provider.getByText("Live Provider · GitHub API", { exact: true }).waitFor();
  await provider.getByText("USDC pays Veyra", { exact: false }).waitFor();

  await page.goto(`${baseUrl()}/results?workflow=market_context&status=warnings&sort=oldest&q=ETH`, { waitUntil: "load" });
  assert.equal(await page.getByLabel("Search reports").inputValue(), "ETH");
  assert.equal(await page.getByLabel("Workflow").inputValue(), "market_context");
  assert.equal(await page.getByLabel("Completion status").inputValue(), "warnings");
  assert.equal(await page.getByLabel("Sort").inputValue(), "oldest");
  await page.locator('[data-testid="results-count"]').waitFor();

  for (const viewport of [
    { width: 1366, height: 768 },
    { width: 1093, height: 614 },
    { width: 911, height: 512 },
    { width: 768, height: 1024 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    for (const path of ["/", "/executions", "/agent-runner", "/workflows", "/results", "/proofs", "/console"]) {
      await noHorizontalOverflow(page, path);
    }
  }

  /* The left rail is the console's alone. On the public side there is nothing
     to scroll through: four links sit in the top bar, which is the right shape
     for a person reading one brief and the wrong one for an operator moving
     between many tools -- so each side now gets the shape that fits it. */
  await page.setViewportSize({ width: 911, height: 512 });
  await page.goto(`${baseUrl()}/`, { waitUntil: "load" });
  assert.equal(await page.locator('[data-testid="desktop-sidebar"]').count(), 0);

  await page.setViewportSize({ width: 1093, height: 768 });
  const desktopSidebar = page.locator('[data-testid="desktop-sidebar"]');
  await page.goto(`${baseUrl()}/console`, { waitUntil: "load" });
  await desktopSidebar.getByRole("link", { name: "Operations", exact: true }).scrollIntoViewIfNeeded();
  await desktopSidebar.getByRole("link", { name: "Operations", exact: true }).waitFor();
  assert.equal(await desktopSidebar.getByRole("link", { name: "Services / Seller", exact: true }).count(), 0);

  /* Narrow screens keep the drawer, and it carries the same four public links
     the top bar does -- so the navigation is never smaller than the product,
     only differently shaped. */
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl()}/`, { waitUntil: "load" });
  await page.getByRole("button", { name: "Open navigation" }).click();
  const mobileSidebar = page.locator('[data-testid="mobile-sidebar"]');
  assert.equal(await mobileSidebar.isVisible(), true);
  await mobileSidebar.getByRole("link", { name: "Memory", exact: true }).click();
  await page.waitForURL(`${baseUrl()}/memory`);
  await mobileSidebar.waitFor({ state: "detached" });

  console.log("[frontend-responsive-smoke] passed: curated deep links, query-backed Results controls, helper/requester/provider copy, keyboard labels, desktop/125%/150%/tablet/mobile overflow, operations navigation, and mobile close-on-navigation");
} finally {
  await browser.close();
}
