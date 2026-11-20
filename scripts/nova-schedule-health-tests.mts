/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import assert from "node:assert/strict";
import { GET } from "../app/api/status/route.ts";
import { getNovaScheduleHealth } from "../lib/nova/schedule-health.ts";

process.env.AGENT_DB_SUPABASE_URL = "https://db.example.test";
process.env.AGENT_DB_SUPABASE_SECRET_KEY = "not-a-real-key";
const now = new Date("2026-11-20T12:00:00Z");
const tick = {
  started_at: "2026-11-20T10:00:00Z",
  finished_at: "2026-11-20T10:01:00Z",
  failed: 0,
  stopped_early: false,
  // The response must stay allowlisted even if a backend returns more fields.
  tick_id: "internal-identifier",
};
const originalFetch = globalThis.fetch;
let result: () => Response = () => Response.json([tick]);

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  assert.equal(url.origin, "https://db.example.test");
  assert.equal(url.pathname, "/rest/v1/nova_ticks");
  assert.equal(url.searchParams.get("select"), "started_at,finished_at,failed,stopped_early");
  assert.equal(url.searchParams.get("order"), "started_at.desc");
  assert.equal(url.searchParams.get("limit"), "1");
  assert.equal(init?.method, "GET");
  assert.ok(init?.signal);
  return result();
};

try {
  const healthy = {
    status: "healthy",
    lastStartedAt: "2026-11-20T10:00:00.000Z",
    lastCompletedAt: "2026-11-20T10:01:00.000Z",
    staleAfterMinutes: 180,
  };
  assert.deepEqual(await getNovaScheduleHealth(now), healthy);

  result = () => Response.json([{ ...tick, failed: 1 }]);
  assert.deepEqual(await getNovaScheduleHealth(now), { ...healthy, status: "degraded" });
  result = () => Response.json([{ ...tick, stopped_early: true }]);
  assert.deepEqual(await getNovaScheduleHealth(now), { ...healthy, status: "degraded" });
  assert.deepEqual(await getNovaScheduleHealth(new Date("2026-11-20T13:01:00Z")), {
    ...healthy,
    status: "stale",
  });

  const noData = {
    status: "no_data",
    lastStartedAt: null,
    lastCompletedAt: null,
    staleAfterMinutes: 180,
  };
  result = () => Response.json([]);
  assert.deepEqual(await getNovaScheduleHealth(now), noData);

  const unavailable = { ...noData, status: "error" };
  result = () => Response.json([{ ...tick, finished_at: "2026-11-20T09:00:00Z" }]);
  assert.deepEqual(await getNovaScheduleHealth(now), unavailable);

  const currentTick = {
    ...tick,
    started_at: new Date(Date.now() - 60_000).toISOString(),
    finished_at: new Date(Date.now() - 30_000).toISOString(),
  };
  result = () => Response.json([currentTick]);
  const activeResponse = await GET();
  assert.equal(activeResponse.status, 200);
  const active = await activeResponse.json();
  assert.deepEqual(active.novaSchedule, {
    ...healthy,
    lastStartedAt: currentTick.started_at,
    lastCompletedAt: currentTick.finished_at,
  });
  assert.doesNotMatch(JSON.stringify(active), /internal-identifier|stopped_early/);

  result = () => Response.json({ message: "do not expose database errors" }, { status: 403 });
  assert.deepEqual(await getNovaScheduleHealth(now), unavailable);
  const response = await GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=15, s-maxage=30");
  const payload = await response.json();
  assert.equal(payload.status, "operational");
  assert.deepEqual(payload.novaSchedule, unavailable);
  assert.doesNotMatch(JSON.stringify(payload), /do not expose|internal-identifier/);
} finally {
  globalThis.fetch = originalFetch;
}

console.log("Nova schedule health snapshot and public /api/status response passed");
