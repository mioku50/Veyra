/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import assert from "node:assert/strict";
import { emptyShadowMetrics, observeShadowPass } from "../lib/nova/shadow-observability.ts";
import type { ShadowPass } from "../lib/nova/shadow-run.ts";

const empty: ShadowPass = {
  ran: false, blocked: null, considered: 0, decided: 0, wouldAllow: 0, wouldDeny: 0,
  unpriced: 0, unpricedReasons: {}, ranOutOfTime: false, skipped: 0, wouldSpendUsdc: 0,
};
const metrics = emptyShadowMetrics();
await observeShadowPass(metrics, false, async () => { throw new Error("must not run"); });
assert.equal(metrics.shadowSkippedForTime, 1);
assert.equal(metrics.shadowPasses, 0);
await observeShadowPass(metrics, true, async () => { throw new Error("private request with secret"); });
assert.equal(metrics.shadowFailed, 1);
assert(!JSON.stringify(metrics).includes("secret"));
await observeShadowPass(metrics, true, async () => ({ ...empty, blocked: "mandate_expired" }));
assert.deepEqual(metrics.shadowBlocked, { mandate_expired: 1 });
await observeShadowPass(metrics, true, async () => ({
  ...empty, ran: true, considered: 4, decided: 1, wouldAllow: 1, wouldSpendUsdc: 0.006,
  unpriced: 2, unpricedReasons: { nothing_askable: 2 }, skipped: 1, ranOutOfTime: true,
}));
await observeShadowPass(metrics, true, async () => ({
  ...empty, ran: true, considered: 1, unpriced: 1, unpricedReasons: { nothing_askable: 1 },
}));
assert.equal(metrics.shadowPasses, 4);
assert.equal(metrics.shadowConsidered, 5);
assert.equal(metrics.shadowSkipped, 1);
assert.equal(metrics.shadowDeadlineHits, 1);
assert.equal(metrics.shadowDecided, 1);
assert.equal(metrics.shadowWouldAllow, 1);
assert.equal(metrics.shadowWouldSpendUsdc, 0.006);
assert.deepEqual(metrics.shadowUnpriced, { nothing_askable: 3 });
assert.equal(emptyShadowMetrics().shadowFailed, 0);
assert.deepEqual(emptyShadowMetrics().shadowUnpriced, {});
console.log("PASS: shadow exceptions, time skips, readiness blocks and successful passes remain distinguishable without private error text");
