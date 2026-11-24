/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import assert from "node:assert/strict";
import { guardedFetch, VeyraBlockedError } from "../src/index.ts";

const verdictUrl = process.env.VEYRA_VERDICT_URL ?? "https://agent-commerce-six.vercel.app/api/x402/v1/verdict";
const aisaEndpoint = "https://api.aisa.one/apis/v2/apollo/labels";

// 1. Live Arc listing within budget should pass preflight and return the untouched 402.
const passResponse = await guardedFetch(aisaEndpoint, { method: "GET" }, {
  budgetUsdc: 0.25,
  verdictUrl,
  verdictHeaders: { "Sec-GPC": "1" },
});
assert.equal(passResponse.status, 402);
console.log("PASS case succeeded: received HTTP 402 untouched for", aisaEndpoint);

// 2. Over-budget / blocked case should throw VeyraBlockedError before payment.
await assert.rejects(
  guardedFetch(aisaEndpoint, { method: "GET" }, {
    budgetUsdc: 0.01,
    verdictUrl,
    verdictHeaders: { "Sec-GPC": "1" },
  }),
  (error: unknown) => {
    assert(error instanceof VeyraBlockedError);
    assert(error.blocking.some((signal) => signal.code === "over_budget"));
    console.log("BLOCK case succeeded:", error.blocking.map((s) => s.code));
    return true;
  },
);
