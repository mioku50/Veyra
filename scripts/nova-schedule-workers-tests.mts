/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import assert from "node:assert/strict";
import { runScheduledTick, SHADOW_HEADROOM_MS, tickReader } from "../lib/nova/schedule.ts";

process.env.AGENT_DB_SUPABASE_URL = "https://db.example.test";
process.env.AGENT_DB_SUPABASE_SECRET_KEY = "not-a-real-key";

const now = new Date("2026-11-20T12:00:00Z");
const initialClock = now.getTime();
const originalNow = Date.now;
const originalFetch = globalThis.fetch;
let clock = initialClock;
Date.now = () => clock;
const dueAgent = (id: string) => ({
  agent_id: id,
  public_id: "nva_" + id,
  name: id,
  interests: [],
  owner_wallet: null,
  last_scheduled_refresh_at: null,
});

function scenario(ids: string[]) {
  return {
    due: ids.map(dueAgent),
    refreshes: [] as string[],
    claims: [] as string[],
    releases: [] as string[],
    persistedTicks: [] as Record<string, unknown>[],
    duringClaim: (_id: string): Response | undefined => undefined,
    duringRefresh: async (_id: string): Promise<Response> => Response.json({ goal: null }),
  };
}

let test = scenario([]);
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  assert.equal(url.origin, "https://db.example.test", "Scheduler fixtures use no live providers");
  const table = url.pathname.split("/").at(-1);
  const method = init?.method ?? "GET";
  const id = url.searchParams.get("agent_id")?.slice(3) ?? "";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};

  if (table === "nova_agents" && method === "GET") {
    if (url.searchParams.get("select") === "goal") {
      test.refreshes.push(id);
      return test.duringRefresh(id);
    }
    return Response.json(url.searchParams.get("last_scheduled_refresh_at") === "is.null" ? test.due : []);
  }
  if (table === "nova_agents" && method === "PATCH") {
    if (body.dormant_since) return Response.json([]);
    if (body.last_brief_at) return new Response(null, { status: 204 });
    if (url.searchParams.get("select") === "agent_id") {
      assert.equal(url.searchParams.get("last_scheduled_refresh_at"), "is.null");
      assert.equal(url.searchParams.get("dormant_since"), "is.null", "A dormant agent cannot be claimed");
      assert.equal(body.last_scheduled_refresh_at, now.toISOString());
      test.claims.push(id);
      return test.duringClaim(id) ?? Response.json([{ agent_id: id }]);
    }
    assert.equal(body.last_scheduled_refresh_at, null);
    assert.equal(url.searchParams.get("last_scheduled_refresh_at"), "eq." + now.toISOString(), "Rollback only our own claim");
    test.releases.push(id);
    return new Response(null, { status: 204 });
  }
  if (table === "nova_refreshes" && method === "POST") return Response.json({ refresh_id: "fixture", ...body });
  if (table === "nova_ticks" && method === "POST") {
    test.persistedTicks.push(body);
    return new Response(null, { status: 201 });
  }
  if (method === "GET" && ["nova_project_context", "nova_subjects", "nova_memory", "nova_signals", "arc_registry_snapshots"].includes(table ?? "")) {
    return Response.json([]);
  }
  assert.fail("Unexpected fixture request to " + method + " " + table);
};

try {
  test = scenario(["alpha", "bravo", "charlie", "delta"]);
  const releaseFirstBatch = Promise.withResolvers<void>();
  const twoActive = Promise.withResolvers<void>();
  test.duringRefresh = async (id) => {
    if (id === "alpha" || id === "bravo") {
      if (test.refreshes.length === 2) twoActive.resolve();
      await releaseFirstBatch.promise;
    }
    return Response.json({ goal: null });
  };
  const running = runScheduledTick({ now, maxAgents: 3 });
  const timeout = setTimeout(() => twoActive.reject(new Error("Both refresh workers must start before either finishes")), 5_000);
  try {
    await twoActive.promise;
    assert.deepEqual(test.claims.toSorted(), ["alpha", "bravo"], "Only two claims can make progress at once");
  } finally {
    clearTimeout(timeout);
    releaseFirstBatch.resolve();
    await running;
  }
  const complete = await running;
  assert.equal(complete.refreshed, 3);
  assert.equal(complete.failed, 0);
  assert.equal(complete.due, 4);
  assert.deepEqual(test.claims.toSorted(), ["alpha", "bravo", "charlie"], "The two workers share the refresh cap");
  assert.equal(complete.shadowPasses, 3);
  assert.deepEqual(complete.shadowBlocked, { autonomy_frozen: 3 });
  assert.equal(complete.shadowWouldSpendUsdc, 0);
  assert.equal(test.persistedTicks.length, 1);

  test = scenario(["conflict", "claim-error", "refresh-error", "later"]);
  test.duringClaim = (id) => {
    if (id === "conflict") return Response.json([]);
    if (id === "claim-error") return Response.json({ message: "fixture DB error" }, { status: 400 });
  };
  test.duringRefresh = async (id) => id === "refresh-error"
    ? Response.json({ message: "fixture refresh error" }, { status: 400 })
    : Response.json({ goal: null });
  const errors = await runScheduledTick({ now, maxAgents: 3 });
  assert.deepEqual(test.refreshes.toSorted(), ["later", "refresh-error"], "Claim conflicts and errors do not start refreshes");
  assert.deepEqual(test.releases, ["refresh-error"], "Failed owned work is released, and unowned work is skipped");
  assert.equal(errors.refreshed, 1);
  assert.equal(errors.failed, 2);
  assert.equal(errors.shadowPasses, 1);
  assert.equal(test.persistedTicks[0].failed, 2);

  test = scenario(["late", "waiting"]);
  test.duringClaim = () => {
    clock += 120;
    return undefined;
  };
  const late = await runScheduledTick({ now, maxAgents: 1, budgetMs: 120 });
  assert.equal(late.stoppedEarly, true);
  assert.equal(late.failed, 0);
  assert.equal(late.refreshed, 0);
  assert.deepEqual(test.claims, ["late"]);
  assert.deepEqual(test.refreshes, [], "A claim finishing at the deadline never starts a refresh");
  assert.deepEqual(test.releases, ["late"], "A late claim is immediately put back");

  test = scenario(["waiting"]);
  const outOfTime = await runScheduledTick({ now, budgetMs: 0 });
  assert.equal(outOfTime.stoppedEarly, true);
  assert.deepEqual(test.claims, [], "A tick at its deadline never claims");

  test = scenario(["brief"]);
  const noShadowTime = await runScheduledTick({ now, budgetMs: SHADOW_HEADROOM_MS - 1 });
  assert.equal(noShadowTime.refreshed, 1, "The brief still runs when there is no time for a shadow pass");
  assert.equal(noShadowTime.shadowPasses, 0);
  assert.equal(noShadowTime.shadowSkippedForTime, 1);
} finally {
  Date.now = originalNow;
  globalThis.fetch = originalFetch;
}

const pending = Promise.withResolvers<Response>();
let reads = 0;
const sharedReader = tickReader(async () => {
  reads++;
  return pending.promise;
});
const first = sharedReader("https://source.example.test/resource");
const second = sharedReader("https://source.example.test/resource");
assert.equal(reads, 1, "Concurrent workers share an in-flight read");
pending.resolve(Response.json({ usable: true }));
assert.deepEqual(await (await first).json(), { usable: true });
assert.deepEqual(await (await second).json(), { usable: true });

console.log("Nova scheduler concurrency, shared cap, deadlines, claim rollback and frozen shadow metrics passed");
