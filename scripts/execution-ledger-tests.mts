/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { terminalStateFor } from "../lib/execution/browser-x402-ledger.ts";
import type { PostCallVerification } from "../lib/x402/post-call-verification.ts";

function verification(verdict: PostCallVerification["verdict"], failed?: string): PostCallVerification {
  return {
    verdict,
    required: true,
    summary: "",
    responseHash: `0x${"1".repeat(64)}`,
    verifiedAt: "2026-09-13T12:00:00.000Z",
    checks: failed
      ? [{ id: failed, passed: false, severity: "critical", detail: "" }]
      : [],
  };
}

// The happy path is the only one that may be called completed.
assert.deepEqual(
  terminalStateFor({ paid: true, httpOk: true, verification: verification("PASS") }),
  { state: "COMPLETED", failureCode: null },
);

// Paid, answered, and the answer did not hold up. Money gone, goods unproven —
// a distinct fact from success, and the one an operator most needs to find.
assert.deepEqual(
  terminalStateFor({ paid: true, httpOk: true, verification: verification("FAIL", "response_is_not_an_error") }),
  { state: "SETTLED_SERVICE_FAILED", failureCode: "response_is_not_an_error" },
);

// Verification that could not conclude is not a pass and not a failure.
assert.deepEqual(
  terminalStateFor({ paid: true, httpOk: true, verification: verification("INCONCLUSIVE") }),
  { state: "COMPLETED_UNPROVEN", failureCode: null },
);

// Charged and then refused by the endpoint.
assert.deepEqual(
  terminalStateFor({ paid: true, httpOk: false, verification: null }),
  { state: "SETTLED_SERVICE_FAILED", failureCode: "endpoint_error_after_payment" },
);

// The seller rejected the signed payment: nothing moved.
assert.deepEqual(
  terminalStateFor({ paid: false, httpOk: false, verification: null }),
  { state: "REJECTED", failureCode: "payment_rejected" },
);

// No verification ran at all and the call succeeded: completed, because the
// tier did not demand proof. Absence of a requirement is not absence of proof.
assert.deepEqual(
  terminalStateFor({ paid: true, httpOk: true, verification: null }),
  { state: "COMPLETED", failureCode: null },
);

// A FAIL with no named critical check still records a reason rather than null.
assert.equal(
  terminalStateFor({ paid: true, httpOk: true, verification: verification("FAIL") }).failureCode,
  "post_call_verification_failed",
);

console.log("[execution-ledger-test] passed: terminal states for settled, unproven, service-failed, rejected and unverified purchases");
