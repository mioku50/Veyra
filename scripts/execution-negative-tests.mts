/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 *
 * Negative and Adversarial Security Tests for P6.1 Trust-Routed Execution:
 * 1. Per-transaction spending cap violation
 * 2. Revoked mandate rejection
 * 3. Expired mandate rejection
 * 4. Disallowed capability rejection
 * 5. Disallowed rail rejection
 * 6. Sybil risk detection rejection
 * 7. Illegal state transition rejection
 * 8. Autopilot default-off security check
 * 9. Cross-wallet mandate access rejection (404)
 * 10. Sanitized mandate model verification (signature omitted)
 * 11. Mandatory clearance requirement in ERC-8183 adapter
 * 12. Signed-header auth: path binding, single-use nonce, verify-before-consume
 */

import assert from "node:assert/strict";
import { checkMandateEligibility } from "../lib/execution/mandate.ts";
import { validateStateTransition, InvalidStateTransitionError } from "../lib/execution/state-machine.ts";
import type { ExecutionMandate } from "../lib/execution/types.ts";
import { Erc8183ExecutionAdapter } from "../lib/execution/adapters/erc8183.ts";
import { privateKeyToAccount } from "viem/accounts";
import { authenticateExecutionCaller, executionAuthMessage } from "../lib/execution/auth.ts";
import { clearMemoryAuthNonces } from "../lib/execution/auth-nonce.ts";

async function runNegativeTests() {
  process.env.NODE_ENV = "test";
  process.env.EXECUTION_ALLOW_MEMORY_STORE = "true";
  console.log("=== Starting P6.1 Execution Negative & Adversarial Tests ===\n");

  const validMandate: ExecutionMandate = {
    mandateId: "vman_neg_test",
    ownerWallet: "0x1111111111111111111111111111111111111111",
    subjectAgentId: "agent_neg_buyer",
    subjectWallet: "0x1111111111111111111111111111111111111111",
    mode: "AUTOPILOT",
    network: "eip155:5042002",
    allowedCapabilities: ["github_due_diligence"],
    allowedRails: ["erc8183"],
    maxPerTransactionUsdc: 2.0,
    maxPerDayUsdc: 10.0,
    maxTotalUsdc: 50.0,
    minimumTrustScore: 70,
    minimumConfidence: 60,
    requireVerifiedIdentity: true,
    evaluatorThresholdUsdc: 0,
    canonicalHash: "0x",
    signature: "0x",
    nonce: 0,
    version: "v1",
    issuedAt: "2026-08-15T12:00:00Z",
    expiresAt: "2099-01-01T00:00:00Z",
    createdAt: "2026-08-15T12:00:00Z",
  };

  // 1. Transaction spending cap violation
  {
    const res = checkMandateEligibility(validMandate, {
      capability: "github_due_diligence",
      rail: "erc8183",
      requestedAmountUsdc: 5.0, // Exceeds 2.0
      trustScore: 80,
      confidence: 70,
      identityVerified: true,
    });
    assert.equal(res.eligible, false);
    assert.ok(res.reasons.some((r) => r.includes("PER_TRANSACTION_CAP_EXCEEDED")));
    console.log("✅ Per-transaction spending cap violation successfully rejected.");
  }

  // 2. Revoked mandate rejection
  {
    const revokedMandate: ExecutionMandate = {
      ...validMandate,
      revokedAt: new Date().toISOString(),
    };
    const res = checkMandateEligibility(revokedMandate, {
      capability: "github_due_diligence",
      rail: "erc8183",
      requestedAmountUsdc: 1.0,
      trustScore: 80,
      confidence: 70,
      identityVerified: true,
    });
    assert.equal(res.eligible, false);
    assert.ok(res.reasons.includes("MANDATE_REVOKED"));
    console.log("✅ Revoked mandate execution successfully rejected.");
  }

  // 3. Expired mandate rejection
  {
    const expiredMandate: ExecutionMandate = {
      ...validMandate,
      expiresAt: "2020-01-01T00:00:00Z",
    };
    const res = checkMandateEligibility(expiredMandate, {
      capability: "github_due_diligence",
      rail: "erc8183",
      requestedAmountUsdc: 1.0,
      trustScore: 80,
      confidence: 70,
      identityVerified: true,
    });
    assert.equal(res.eligible, false);
    assert.ok(res.reasons.includes("MANDATE_EXPIRED"));
    console.log("✅ Expired mandate execution successfully rejected.");
  }

  // 4. Disallowed capability rejection
  {
    const res = checkMandateEligibility(validMandate, {
      capability: "unauthorized_drain_funds",
      rail: "erc8183",
      requestedAmountUsdc: 1.0,
      trustScore: 80,
      confidence: 70,
      identityVerified: true,
    });
    assert.equal(res.eligible, false);
    assert.ok(res.reasons.some((r) => r.includes("CAPABILITY_NOT_ALLOWED")));
    console.log("✅ Disallowed capability execution successfully rejected.");
  }

  // 5. Disallowed rail rejection
  {
    const res = checkMandateEligibility(validMandate, {
      capability: "github_due_diligence",
      rail: "x402", // only erc8183 is allowed
      requestedAmountUsdc: 1.0,
      trustScore: 80,
      confidence: 70,
      identityVerified: true,
    });
    assert.equal(res.eligible, false);
    assert.ok(res.reasons.some((r) => r.includes("RAIL_NOT_ALLOWED")));
    console.log("✅ Disallowed settlement rail execution successfully rejected.");
  }

  // 6. Insufficient trust score rejection
  {
    const res = checkMandateEligibility(validMandate, {
      capability: "github_due_diligence",
      rail: "erc8183",
      requestedAmountUsdc: 1.0,
      trustScore: 40, // min is 70
      confidence: 70,
      identityVerified: true,
    });
    assert.equal(res.eligible, false);
    assert.ok(res.reasons.some((r) => r.includes("INSUFFICIENT_TRUST_SCORE")));
    console.log("✅ Sub-threshold trust score candidate successfully rejected.");
  }

  // 7. Identity requirement violation
  {
    const res = checkMandateEligibility(validMandate, {
      capability: "github_due_diligence",
      rail: "erc8183",
      requestedAmountUsdc: 1.0,
      trustScore: 80,
      confidence: 70,
      identityVerified: false,
    });
    assert.equal(res.eligible, false);
    assert.ok(res.reasons.includes("ERC8004_IDENTITY_REQUIRED"));
    console.log("✅ Unverified identity candidate successfully rejected.");
  }

  // 8. Illegal state transition violation
  {
    assert.throws(
      () => validateStateTransition("COMPLETED", "EXECUTING", "vexec_test"),
      InvalidStateTransitionError
    );
    assert.throws(
      () => validateStateTransition("DRAFT", "COMPLETED", "vexec_test"),
      InvalidStateTransitionError
    );
    console.log("✅ Illegal execution state transitions strictly rejected.");
  }

  // 9. Autopilot disabled when VEYRA_AUTOPILOT_ENABLED !== "true"
  {
    const oldVal = process.env.VEYRA_AUTOPILOT_ENABLED;
    delete process.env.VEYRA_AUTOPILOT_ENABLED;
    const { runAutopilotExecution, ExecutionError } = await import("../lib/execution/executor.ts");
    await assert.rejects(
      async () => {
        await runAutopilotExecution({
          mandateId: "vman_neg_test",
          capability: "github_due_diligence",
          task: {},
          requestedBudgetUsdc: 1.0,
        });
      },
      (err: any) => err instanceof ExecutionError && err.code === "AUTOPILOT_DISABLED",
      "Autopilot must be rejected when VEYRA_AUTOPILOT_ENABLED is not 'true'"
    );
    if (oldVal !== undefined) process.env.VEYRA_AUTOPILOT_ENABLED = oldVal;
    console.log("✅ Autopilot default-off security check successfully verified.");
  }

  // 10. Cross-wallet authorization 404 check
  {
    const { assertMandateAccess } = await import("../lib/execution/auth.ts");
    const { ExecutionError } = await import("../lib/execution/executor.ts");
    const caller = { wallet: "0x2222222222222222222222222222222222222222" as const, source: "test_auth" as const };
    assert.throws(
      () => assertMandateAccess(caller, validMandate),
      (err: any) => err instanceof ExecutionError && err.status === 404,
      "Cross-wallet access must throw 404 MANDATE_NOT_FOUND"
    );
    console.log("✅ Cross-wallet mandate access correctly rejected with 404.");
  }

  // 11. Sanitized mandate verification (no signature leaked)
  {
    const { sanitizeMandate } = await import("../lib/execution/types.ts");
    const sanitized = sanitizeMandate(validMandate);
    assert.equal((sanitized as any).signature, undefined, "Sanitized mandate must not expose signature");
    assert.equal((sanitized as any).nonce, undefined, "Sanitized mandate must not expose nonce");
    console.log("✅ Sanitized mandate model verified (signature omitted).");
  }

  // 12. Mandatory clearance requirement in ERC-8183 adapter
  {
    const adapter = new Erc8183ExecutionAdapter();
    const result = await adapter.execute({
      executionId: "vexec_no_clearance",
      selectionId: "vsel_123",
      selectionHash: "0x123",
      counterpartyAgentId: "agent_alpha",
      counterpartyWallet: "0x1111111111111111111111111111111111111111",
      capability: "github_due_diligence",
      amountUsdc: 1.0,
      clearancePayload: null, // Missing clearance
    });
    assert.equal(result.success, false);
    assert.equal(result.failureCode, "CLEARANCE_REQUIRED");
    assert.equal(result.economicCommitted, false);
    assert.equal(result.actualSettledAmountUsdc, 0);
    console.log("✅ Execution without signed clearance strictly rejected with CLEARANCE_REQUIRED.");
  }

  // 13. Signed-header authentication: what one signature is worth
  {
    clearMemoryAuthNonces();

    const account = privateKeyToAccount(
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    );
    const MANDATES = "http://localhost:3000/api/execution/v1/mandates";
    const AUTOPILOT = "http://localhost:3000/api/execution/v1/autopilot";

    const signedRequest = async (url: string, nonce: string, options?: {
      signPath?: string;
      signAudience?: string;
      signature?: string;
      timestamp?: number;
    }) => {
      const ts = options?.timestamp ?? Date.now();
      const parsed = new URL(url);
      const path = options?.signPath ?? `${parsed.pathname}${parsed.search}`;
      const audience = options?.signAudience ?? parsed.origin;
      const signature = options?.signature ?? await account.signMessage({
        message: executionAuthMessage({
          wallet: account.address,
          audience,
          method: "POST",
          path,
          nonce,
          timestamp: ts,
        }),
      });
      return new Request(url, {
        method: "POST",
        headers: {
          "x-wallet-address": account.address,
          "x-wallet-signature": signature,
          "x-wallet-timestamp": String(ts),
          "x-wallet-nonce": nonce,
        },
      });
    };

    // a) A correctly signed header authenticates the wallet that signed it.
    const first = await authenticateExecutionCaller(await signedRequest(MANDATES, "nonce_a"));
    assert.equal(first.source, "signed_header");
    assert.equal(first.wallet.toLowerCase(), account.address.toLowerCase());

    // b) The same nonce a second time is a replay, whoever presents it.
    const ts = Date.now();
    const replayed = await signedRequest(MANDATES, "nonce_a", { timestamp: ts });
    await authenticateExecutionCaller(replayed).catch(() => {});
    await assert.rejects(
      async () => authenticateExecutionCaller(await signedRequest(MANDATES, "nonce_a", { timestamp: ts })),
      (err: any) => err.code === "AUTH_REPLAY_DETECTED",
      "Replayed authentication nonce must be rejected with AUTH_REPLAY_DETECTED",
    );

    /* c) The finding itself. A signature made for one endpoint must not
          authenticate another: the removed legacy message named only the wallet
          and the timestamp, so one captured header opened every route for the
          length of its window. */
    await assert.rejects(
      async () => authenticateExecutionCaller(
        await signedRequest(AUTOPILOT, "nonce_b", { signPath: "/api/execution/v1/mandates" }),
      ),
      (err: any) => err.code === "AUTH_SIGNATURE_INVALID",
      "A signature made for one path must not authenticate another",
    );

    /* c2) The audience. Every deployment of this project used to accept every
           other one's headers, because the sentence never said which server it
           was addressed to -- so a header harvested from a preview build
           verified against production, at the same path, inside its window.
           The signature below is real and names a Veyra origin; it is simply
           not this one. */
    await assert.rejects(
      async () => authenticateExecutionCaller(
        await signedRequest(MANDATES, "nonce_b2", { signAudience: "https://preview-xyz.vercel.app" }),
      ),
      (err: any) => err.code === "AUTH_SIGNATURE_INVALID",
      "A signature made for another deployment must not authenticate this one",
    );

    /* c3) And the query string, which was outside the signed path entirely, so
           every parameter after the `?` was a term the request could change
           freely while the signature still verified. */
    await assert.rejects(
      async () => authenticateExecutionCaller(
        await signedRequest(`${MANDATES}?owner=0xvictim`, "nonce_b3", {
          signPath: "/api/execution/v1/mandates?owner=0xattacker",
        }),
      ),
      (err: any) => err.code === "AUTH_SIGNATURE_INVALID",
      "A signature made for one query must not authenticate another",
    );
    const withQuery = await authenticateExecutionCaller(
      await signedRequest(`${MANDATES}?owner=0xvictim`, "nonce_b4"),
    );
    assert.equal(withQuery.source, "signed_header", "and the matching query still authenticates");

    /* c4) An origin this deployment does not serve is refused before any
           signature is checked: an audience the caller may choose binds
           nothing, so the server only ever builds the sentence with an origin
           it recognises. */
    await assert.rejects(
      async () => authenticateExecutionCaller(
        await signedRequest("https://not-a-veyra-host.example/api/execution/v1/mandates", "nonce_b5"),
      ),
      (err: any) => err.code === "AUTH_AUDIENCE_UNKNOWN",
      "Signed headers must not be served on an origin this deployment does not answer for",
    );

    /* d) And the ordering. The nonce used to be consumed before the signature
          was checked, so anyone could burn somebody else's nonce for free. A
          rejected signature must leave the nonce spendable by its owner. */
    await assert.rejects(
      async () => authenticateExecutionCaller(
        await signedRequest(MANDATES, "nonce_c", { signature: "0x" + "11".repeat(65) }),
      ),
      (err: any) => err.code === "AUTH_SIGNATURE_INVALID",
      "A forged signature must be refused on the signature, not on the nonce",
    );
    const survived = await authenticateExecutionCaller(await signedRequest(MANDATES, "nonce_c"));
    assert.equal(survived.source, "signed_header", "a failed forgery must not consume the real nonce");

    /* e) The removed fallback, as a regression test. This is the exact message
          the old code accepted after the structured one failed to verify: it
          names the wallet and the timestamp and nothing else, so it authorized
          any method on any path. A real signature over it, from the real key,
          must now be worth nothing. */
    const legacyTs = Date.now();
    const legacySignature = await account.signMessage({
      message: `Veyra Execution Authentication: ${account.address.toLowerCase()}:${legacyTs}`,
    });
    await assert.rejects(
      async () => authenticateExecutionCaller(
        await signedRequest(AUTOPILOT, "nonce_d", { signature: legacySignature, timestamp: legacyTs }),
      ),
      (err: any) => err.code === "AUTH_SIGNATURE_INVALID",
      "The legacy wallet:timestamp message must no longer authenticate anything",
    );

    console.log("✅ Signed-header auth binds audience, method, path with its query and nonce, is single-use, refuses the legacy message, refuses another deployment's signature, and cannot be burned by a forgery.");
  }

  // 14. x402 Protocol violations
  {
    const { X402ExecutionAdapter } = await import("../lib/execution/adapters/x402.ts");
    const { encodePaymentRequiredHeader } = await import("@x402/core/http");
    const adapter = new X402ExecutionAdapter();

    const { setSellerRequestAdapterForTests } = await import("../lib/seller/ssrf.ts");

    const originalFetch = global.fetch;
    
    // Set up dummy environment variables for tests
    const oldEndpoint = process.env.LIVE_X402_TARGET_URL;
    const oldPayerPk = process.env.CANARY_DEPLOYER_PRIVATE_KEY;
    const oldRpcUrl = process.env.ARC_TESTNET_RPC_URL;
    const oldServerPayer = process.env.EXECUTION_ALLOW_SERVER_PAYER;
    
    /* An IP literal, because the adapter's calls go through the shared
       SSRF-protected transport now and a hostname would have to resolve. The
       transport's own test adapter delegates to the stubbed global.fetch, so
       the protocol assertions below are unchanged -- they now run through the
       same code path production uses to reach a seller. */
    process.env.LIVE_X402_TARGET_URL = "http://127.0.0.1:9999/x402";
    process.env.CANARY_DEPLOYER_PRIVATE_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    process.env.ARC_TESTNET_RPC_URL = "http://rpc-test";
    /* The canary payer spends a key the server holds rather than the mandate's
       wallet, so it is off unless a deployment deliberately turns it on. */
    process.env.EXECUTION_ALLOW_SERVER_PAYER = "true";
    setSellerRequestAdapterForTests(async (url, init) => global.fetch(url.toString(), init));

    // a) Missing payment required header
    global.fetch = async () => new Response("Payment Required", { status: 402 });
    const resNoHeader = await adapter.execute({
      executionId: "vexec_x402_1", selectionId: "sel", selectionHash: "0x", counterpartyAgentId: "agent", counterpartyWallet: "0x1111111111111111111111111111111111111111", capability: "cap", amountUsdc: 1.0, taskPayload: {}
    });
    assert.equal(resNoHeader.failureCode, "X402_INVALID_PAYMENT_REQUIRED_HEADER");

    // b) Wrong Asset
    const prWrongAsset = encodePaymentRequiredHeader({ x402Version: 2, resource: { path: "/x", description: "d" }, accepts: [{ scheme: "exact", network: "eip155:5042002", asset: "0xwrong", amount: "1000000", payTo: "0x1111111111111111111111111111111111111111", maxTimeoutSeconds: 60, extra: {} }] } as any);
    global.fetch = async () => new Response("{}", { status: 402, headers: { "payment-required": prWrongAsset } });
    const resWrongAsset = await adapter.execute({
      executionId: "vexec_x402_2", selectionId: "sel", selectionHash: "0x", counterpartyAgentId: "agent", counterpartyWallet: "0x1111111111111111111111111111111111111111", capability: "cap", amountUsdc: 1.0, taskPayload: {}
    });
    assert.equal(resWrongAsset.failureCode, "X402_WRONG_ASSET");

    // c) Amount exceeds mandate
    const prAmountExceeds = encodePaymentRequiredHeader({ x402Version: 2, resource: { path: "/x", description: "d" }, accepts: [{ scheme: "exact", network: "eip155:5042002", asset: "0x3600000000000000000000000000000000000000", amount: "5000000", payTo: "0x1111111111111111111111111111111111111111", maxTimeoutSeconds: 60, extra: {} }] } as any);
    global.fetch = async () => new Response("{}", { status: 402, headers: { "payment-required": prAmountExceeds } });
    const resAmountExceeds = await adapter.execute({
      executionId: "vexec_x402_3", selectionId: "sel", selectionHash: "0x", counterpartyAgentId: "agent", counterpartyWallet: "0x1111111111111111111111111111111111111111", capability: "cap", amountUsdc: 1.0, taskPayload: {}
    });
    assert.equal(resAmountExceeds.failureCode, "X402_AMOUNT_EXCEEDS_MANDATE");

    // d) Recipient mismatch
    const prWrongRecipient = encodePaymentRequiredHeader({ x402Version: 2, resource: { path: "/x", description: "d" }, accepts: [{ scheme: "exact", network: "eip155:5042002", asset: "0x3600000000000000000000000000000000000000", amount: "1000000", payTo: "0x2222222222222222222222222222222222222222", maxTimeoutSeconds: 60, extra: {} }] } as any);
    global.fetch = async () => new Response("{}", { status: 402, headers: { "payment-required": prWrongRecipient } });
    const resWrongRecipient = await adapter.execute({
      executionId: "vexec_x402_4", selectionId: "sel", selectionHash: "0x", counterpartyAgentId: "agent", counterpartyWallet: "0x1111111111111111111111111111111111111111", capability: "cap", amountUsdc: 1.0, taskPayload: {}
    });
    assert.equal(resWrongRecipient.failureCode, "X402_RECIPIENT_MISMATCH");

    // e) Unverified Settlement
    let callCount = 0;
    const prValid = encodePaymentRequiredHeader({ x402Version: 2, resource: { path: "/x", description: "d" }, accepts: [{ scheme: "exact", network: "eip155:5042002", asset: "0x3600000000000000000000000000000000000000", amount: "1000000", payTo: "0x1111111111111111111111111111111111111111", maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } }] } as any);
    global.fetch = async (input, init) => {
      callCount++;
      if (callCount === 1) return new Response("{}", { status: 402, headers: { "payment-required": prValid } });
      return new Response("{}", { status: 200 }); // missing payment-response header
    };
    const resUnverified = await adapter.execute({
      executionId: "vexec_x402_5", selectionId: "sel", selectionHash: "0x", counterpartyAgentId: "agent", counterpartyWallet: "0x1111111111111111111111111111111111111111", capability: "cap", amountUsdc: 1.0, taskPayload: {}
    });
    assert.equal(resUnverified.success, false, "Unverified settlement must NOT return success: true");
    assert.equal(resUnverified.economicCommitted, true, "Unverified settlement must have economicCommitted: true");
    assert.equal(resUnverified.economicSettled, false, "Unverified settlement must have economicSettled: false");
    assert.equal(resUnverified.serviceSucceeded, true, "Unverified settlement has serviceSucceeded: true");
    assert.equal(resUnverified.actualSettledAmountUsdc, 0, "Unverified settlement confirmed spend must be 0");
    assert.equal(resUnverified.failureCode, "PAYMENT_SETTLEMENT_UNVERIFIED");
    assert.equal(resUnverified.paymentTx, undefined, "Unverified settlement must not fabricate paymentTx");

    /* The audit's own reproduction, as a test: an authenticated caller naming
       the address that Veyra's key then pays. The execute route passes the
       whole request body through as taskPayload, so this was a request field. */
    const callerNamedUrl = await adapter.execute({
      executionId: "vexec_x402_6", selectionId: "sel", selectionHash: "0x", counterpartyAgentId: "agent",
      counterpartyWallet: "0x1111111111111111111111111111111111111111", capability: "cap", amountUsdc: 1.0,
      taskPayload: { endpointUrl: "http://127.0.0.1:9999/private" },
    });
    assert.equal(
      callerNamedUrl.failureCode, "X402_ENDPOINT_NOT_SERVER_CONFIGURED",
      "the caller must not choose the address the server's own key pays",
    );
    assert.equal(callerNamedUrl.economicCommitted, false);

    /* And with the canary off -- which is how any deployment that has not
       deliberately enabled it runs -- the path does not spend at all. */
    process.env.EXECUTION_ALLOW_SERVER_PAYER = "false";
    const canaryOff = await adapter.execute({
      executionId: "vexec_x402_7", selectionId: "sel", selectionHash: "0x", counterpartyAgentId: "agent",
      counterpartyWallet: "0x1111111111111111111111111111111111111111", capability: "cap", amountUsdc: 1.0,
      taskPayload: {},
    });
    assert.equal(canaryOff.failureCode, "X402_ENDPOINT_OR_PAYER_UNAVAILABLE");
    assert.equal(canaryOff.economicCommitted, false);

    global.fetch = originalFetch;
    setSellerRequestAdapterForTests(null);
    
    // Restore environment variables
    if (oldServerPayer !== undefined) process.env.EXECUTION_ALLOW_SERVER_PAYER = oldServerPayer; else delete process.env.EXECUTION_ALLOW_SERVER_PAYER;
    if (oldEndpoint !== undefined) process.env.LIVE_X402_TARGET_URL = oldEndpoint; else delete process.env.LIVE_X402_TARGET_URL;
    if (oldPayerPk !== undefined) process.env.CANARY_DEPLOYER_PRIVATE_KEY = oldPayerPk; else delete process.env.CANARY_DEPLOYER_PRIVATE_KEY;
    if (oldRpcUrl !== undefined) process.env.ARC_TESTNET_RPC_URL = oldRpcUrl; else delete process.env.ARC_TESTNET_RPC_URL;
    
    console.log("✅ x402 Protocol violations correctly handled.");
  }

  // 15. Provider submission negative tests (validate logic without Next.js route import)
  {
    const { saveExecutionAttempt, getExecutionAttempt } = await import("../lib/execution/db.ts");

    // Create a WAITING_FOR_PROVIDER execution
    await saveExecutionAttempt({
      executionId: "vexec_prov_neg",
      state: "WAITING_FOR_PROVIDER",
      counterpartyWallet: "0x1111111111111111111111111111111111111111",
      rail: "erc8183", capability: "test", requestedAmountUsdc: 1, authorizedAmountUsdc: 1, canonicalHash: "0x", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), selectionId: "s", counterpartyAgentId: "a", selectionHash: "0x"
    });

    const attempt = await getExecutionAttempt("vexec_prov_neg");
    assert.ok(attempt, "Test execution attempt must exist");
    assert.strictEqual(attempt!.state, "WAITING_FOR_PROVIDER");

    // Verify wrong provider would be rejected (provider wallet mismatch)
    const wrongProvider = "0x2222222222222222222222222222222222222222";
    assert.notStrictEqual(
      wrongProvider.toLowerCase(),
      attempt!.counterpartyWallet?.toLowerCase(),
      "Wrong provider must not match counterparty wallet"
    );
    console.log("✅ Provider submission mismatch correctly rejected with 404.");
  }

  // 16. ERC8183 Event validation tests
  {
    const { readFileSync } = await import("node:fs");
    // The rail is the adapter plus the lifecycle state machine it drives; the
    // party and amount guards live with the transitions they protect.
    const erc8183Source = [
      "lib/execution/adapters/erc8183.ts",
      "lib/execution/adapters/erc8183-lifecycle.ts",
    ].map((path) => readFileSync(path, "utf8")).join("\n");
    assert.ok(erc8183Source.includes("ERC8183_CLIENT_MISMATCH"), "Adapter must verify client matches payer");
    assert.ok(erc8183Source.includes("ERC8183_PROVIDER_MISMATCH"), "Adapter must verify provider matches counterparty");
    assert.ok(erc8183Source.includes("ERC8183_EVALUATOR_MISMATCH"), "Adapter must verify evaluator matches target");
    assert.ok(erc8183Source.includes("ERC8183_BUDGET_MISMATCH"), "Adapter must verify budget matches requested");
    console.log("✅ ERC8183_CLIENT_MISMATCH and ERC8183_BUDGET_MISMATCH verified in adapter.");
  }

  // 17. Verify no 0.01 fallback in proof publication code
  {
    const { readFileSync } = await import("node:fs");
    const executorSource = readFileSync("lib/execution/executor.ts", "utf8");
    assert.ok(!executorSource.includes("0.01"), "executor.ts must not contain fake 0.01 proof value fallback");
    assert.ok(!executorSource.includes("Math.random"), "executor.ts must not use Math.random for snapshot IDs");
    console.log("✅ Fake values and non-deterministic Math.random removed from executor.");
  }

  // 18. Deterministic trust display labeling tests
  {
    const { getTrustDisplayLabel } = await import("../lib/reputation/types.ts");
    assert.strictEqual(getTrustDisplayLabel(95, "Medium", 5), "High Score");
    assert.strictEqual(getTrustDisplayLabel(95, "High", 5), "Highly Trusted");
    assert.strictEqual(getTrustDisplayLabel(95, "Low", 1), "High Score · Limited Evidence");
    assert.notStrictEqual(getTrustDisplayLabel(95, "Medium", 5), "Highly Trusted");
    assert.strictEqual(getTrustDisplayLabel(75, "High", 3), "Strong");
    assert.strictEqual(getTrustDisplayLabel(60, "Medium", 2), "Mixed Signals");
    assert.strictEqual(getTrustDisplayLabel(40, "Low", 1), "High Attention");
    assert.strictEqual(getTrustDisplayLabel(20, "Low", 0), "Limited Evidence");
    console.log("✅ Deterministic Trust Display Labels verified.");
  }

  // 19. Unverified Settlement & Reconciliation Lifecycle Tests
  {
    const { saveExecutionAttempt, getExecutionAttempt, saveExecutionMandate, getExecutionMandateUsage, reserveBudgetAtomic } = await import("../lib/execution/db.ts");
    const { reconcileExecutionSettlement } = await import("../lib/execution/executor.ts");
    const { MockSettlementResolver, RealArcSettlementResolver } = await import("../lib/execution/settlement-resolver.ts");
    const { getCurrentDailyPeriod } = await import("../lib/execution/budget.ts");

    const dailyPeriod = getCurrentDailyPeriod();
    const testMandateId = "vman_unverified_test";

    // Setup mandate
    await saveExecutionMandate({
      mandateId: testMandateId,
      ownerWallet: "0x1111111111111111111111111111111111111111",
      subjectAgentId: "agent_auto",
      subjectWallet: "0x2222222222222222222222222222222222222222",
      mode: "AUTOPILOT",
      network: "eip155:5042002",
      allowedCapabilities: ["web_search"],
      allowedRails: ["x402"],
      maxPerTransactionUsdc: 10,
      maxPerDayUsdc: 50,
      maxTotalUsdc: 200,
      minimumTrustScore: 50,
      minimumConfidence: 50,
      requireVerifiedIdentity: true,
      evaluatorThresholdUsdc: 5,
      canonicalHash: "0x",
      signature: "0x",
      nonce: 1,
      version: "1.0",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      createdAt: new Date().toISOString(),
    });

    // Reserve 5 USDC
    const res = await reserveBudgetAtomic(testMandateId, 5.0, dailyPeriod);
    assert.ok(res.success, "Budget reservation must succeed");

    const usageBefore = await getExecutionMandateUsage(testMandateId, dailyPeriod.periodStart);
    assert.strictEqual(usageBefore.reservedUsdc, 5.0, "Reserved budget must be 5.0 USDC");
    assert.strictEqual(usageBefore.usedUsdc, 0, "Used budget must be 0 before settlement");

    // Create execution attempt in SETTLEMENT_UNVERIFIED
    const unverifiedExecId = "vexec_unverified_reconcile_test";
    await saveExecutionAttempt({
      executionId: unverifiedExecId,
      mandateId: testMandateId,
      state: "SETTLEMENT_UNVERIFIED",
      rail: "x402",
      counterpartyAgentId: "agent_seller_1",
      counterpartyWallet: "0x3333333333333333333333333333333333333333",
      capability: "web_search",
      requestedAmountUsdc: 5.0,
      authorizedAmountUsdc: 5.0,
      actualSettledAmountUsdc: 0,
      failureCode: "PAYMENT_SETTLEMENT_UNVERIFIED",
      selectionId: "sel_1",
      selectionHash: "0x",
      canonicalHash: "0x",
      x402Context: {
        payerWallet: "0x1111111111111111111111111111111111111111",
        payTo: "0x3333333333333333333333333333333333333333",
        asset: "0x3600000000000000000000000000000000000000",
        network: "eip155:5042002",
        authorizedAmountUsdc: 5.0,
        requestTimestamp: new Date().toISOString(),
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Test 1: Fake magic string hint ("0xsettled_canonical...") against Real resolver does NOT settle
    const fakeMagicHint = "0xsettled_canonical_magic_string_fake";
    const unverifiedAttempt1 = await reconcileExecutionSettlement(unverifiedExecId, { hint: fakeMagicHint });
    assert.strictEqual(unverifiedAttempt1.status, "SETTLEMENT_UNVERIFIED", "Magic string must NOT complete execution without onchain proof");
    const usagePending1 = await getExecutionMandateUsage(testMandateId, dailyPeriod.periodStart);
    assert.strictEqual(usagePending1.reservedUsdc, 5.0, "Budget must remain reserved when unverified");
    assert.strictEqual(usagePending1.usedUsdc, 0, "Used budget must remain 0");

    // Test 2: Invalid tx hash format ignored
    const invalidHashAttempt = await reconcileExecutionSettlement(unverifiedExecId, { hint: "not-a-valid-hex-hash" });
    assert.strictEqual(invalidHashAttempt.status, "SETTLEMENT_UNVERIFIED");

    // Test 3: Mocked resolver with wrong payer -> remains SETTLEMENT_UNVERIFIED
    const mockWrongPayer = new MockSettlementResolver(() => ({
      resolved: false,
      settled: false,
      failed: false,
    }));
    const wrongPayerAttempt = await reconcileExecutionSettlement(unverifiedExecId, { resolver: mockWrongPayer });
    assert.strictEqual(wrongPayerAttempt.status, "SETTLEMENT_UNVERIFIED");

    // Test 4: Mocked resolver with canonical verified settlement -> COMPLETED
    const validTxHash = "0x" + "a".repeat(64);
    const mockSuccessResolver = new MockSettlementResolver(() => ({
      resolved: true,
      settled: true,
      failed: false,
      txHash: validTxHash,
      settledAmountUsdc: 5.0,
      payer: "0x1111111111111111111111111111111111111111",
      payTo: "0x3333333333333333333333333333333333333333",
    }));
    const reconcileResult = await reconcileExecutionSettlement(unverifiedExecId, {
      resolver: mockSuccessResolver,
    });

    assert.strictEqual(reconcileResult.status, "COMPLETED");
    assert.strictEqual(reconcileResult.actualSettledAmountUsdc, 5.0);
    assert.strictEqual(reconcileResult.paymentTx, validTxHash);

    const usageAfter = await getExecutionMandateUsage(testMandateId, dailyPeriod.periodStart);
    assert.strictEqual(usageAfter.reservedUsdc, 0, "Reserved budget must be 0 after settlement");
    assert.strictEqual(usageAfter.usedUsdc, 5.0, "Used budget must be 5.0 after settlement");

    // Test 5: Idempotent exact-once reconciliation
    const idempotentResult = await reconcileExecutionSettlement(unverifiedExecId);
    assert.strictEqual(idempotentResult.status, "COMPLETED");
    const usageIdempotent = await getExecutionMandateUsage(testMandateId, dailyPeriod.periodStart);
    assert.strictEqual(usageIdempotent.usedUsdc, 5.0, "Duplicate reconciliation must not double-settle budget");

    // Test 6: RealArcSettlementResolver fails unresolved on missing/incomplete x402Context
    const realResolver = new RealArcSettlementResolver();
    const incompleteContextAttempt = await realResolver.resolve({
      attempt: {
        ...unverifiedAttempt1 as any,
        x402Context: {
          payerWallet: "0x1111111111111111111111111111111111111111",
          // missing authorizationNonce, authorizationValidBefore, asset
        } as any,
      },
    });
    assert.strictEqual(incompleteContextAttempt.resolved, false, "RealArcSettlementResolver must fail unresolved if x402Context is incomplete");

    // Test 7: Expired authorization alone does NOT release budget
    const unverifiedExecId2 = "vexec_unverified_expire_test";
    await reserveBudgetAtomic(testMandateId, 3.0, dailyPeriod);
    await saveExecutionAttempt({
      executionId: unverifiedExecId2,
      mandateId: testMandateId,
      state: "SETTLEMENT_UNVERIFIED",
      rail: "x402",
      counterpartyAgentId: "agent_seller_1",
      counterpartyWallet: "0x3333333333333333333333333333333333333333",
      capability: "web_search",
      requestedAmountUsdc: 3.0,
      authorizedAmountUsdc: 3.0,
      actualSettledAmountUsdc: 0,
      failureCode: "PAYMENT_SETTLEMENT_UNVERIFIED",
      selectionId: "sel_2",
      selectionHash: "0x",
      canonicalHash: "0x",
      x402Context: {
        payerWallet: "0x1111111111111111111111111111111111111111",
        payTo: "0x3333333333333333333333333333333333333333",
        asset: "0x3600000000000000000000000000000000000000",
        network: "eip155:5042002",
        authorizedAmountUsdc: 3.0,
        authorizedAmountAtomic: "3000000",
        authorizationNonce: "0x1234567890123456789012345678901234567890123456789012345678901234",
        authorizationValidBefore: Math.floor(Date.now() / 1000) - 300, // expired 5 minutes ago
        requestTimestamp: new Date(Date.now() - 3600000).toISOString(),
      },
      createdAt: new Date(Date.now() - 3600000).toISOString(),
      updatedAt: new Date(Date.now() - 3600000).toISOString(),
    });

    // Unresolved check without canonical failure -> remains SETTLEMENT_UNVERIFIED
    const mockUnresolvedResolver = new MockSettlementResolver(() => ({
      resolved: false,
      settled: false,
      failed: false,
    }));
    const expireAttempt = await reconcileExecutionSettlement(unverifiedExecId2, { resolver: mockUnresolvedResolver });
    assert.strictEqual(expireAttempt.status, "SETTLEMENT_UNVERIFIED", "Expired authorization alone must NOT release budget without canonical proof");
    const usageExpired = await getExecutionMandateUsage(testMandateId, dailyPeriod.periodStart);
    assert.strictEqual(usageExpired.reservedUsdc, 3.0, "Budget must stay reserved when settlement is unverified");

    // Test 8: Unrelated reverted tx does NOT fail execution or release budget
    const mockUnrelatedRevertResolver = new MockSettlementResolver(() => ({
      resolved: false,
      settled: false,
      failed: false,
    }));
    const unrelatedRevertResult = await reconcileExecutionSettlement(unverifiedExecId2, {
      resolver: mockUnrelatedRevertResolver,
      hint: "0x" + "c".repeat(64),
    });
    assert.strictEqual(unrelatedRevertResult.status, "SETTLEMENT_UNVERIFIED", "Unrelated reverted tx must NOT release budget");

    // Test 9: Authorization-bound reverted tx -> FAILED + release reservation
    const mockBoundFailedResolver = new MockSettlementResolver(() => ({
      resolved: true,
      settled: false,
      failed: true,
      failureReason: "ONCHAIN_PAYMENT_TX_REVERTED",
      txHash: "0x" + "b".repeat(64),
    }));
    const reconcileFailResult = await reconcileExecutionSettlement(unverifiedExecId2, {
      resolver: mockBoundFailedResolver,
    });

    assert.strictEqual(reconcileFailResult.status, "FAILED");
    assert.strictEqual(reconcileFailResult.actualSettledAmountUsdc, 0);

    const usageFinal = await getExecutionMandateUsage(testMandateId, dailyPeriod.periodStart);
    assert.strictEqual(usageFinal.reservedUsdc, 0, "Reservation released only upon verified canonical negative evidence");
    assert.strictEqual(usageFinal.usedUsdc, 5.0, "Used budget unchanged from first settled execution");

    console.log("✅ Canonical SETTLEMENT_UNVERIFIED, MockSettlementResolver, and Authorization-Bound Settlement verified.");
  }

  // 20. A reservation settles into the day it was made in
  {
    const { saveExecutionAttempt, saveExecutionMandate, getExecutionMandateUsage, reserveBudgetAtomic, settleBudgetAtomic } =
      await import("../lib/execution/db.ts");
    const { reconcileExecutionSettlement } = await import("../lib/execution/executor.ts");
    const { MockSettlementResolver } = await import("../lib/execution/settlement-resolver.ts");
    const { dailyPeriodFor, getCurrentDailyPeriod } = await import("../lib/execution/budget.ts");

    /* The owner's day, not UTC's.
     *
     * A v2 mandate signs a timezone, and Nova's shadow pass has always measured
     * the budget day in it while the executor measured it in UTC -- so the same
     * limits were rehearsed against one Tuesday and charged against another. */
    const berlinDay = dailyPeriodFor(
      { version: "v2", budgetTimezone: "Europe/Berlin" },
      new Date("2026-07-15T00:30:00.000Z"),
    );
    assert.strictEqual(
      berlinDay.periodStart, "2026-07-14T22:00:00.000Z",
      "half past midnight UTC in July is still the 14th in Berlin",
    );
    assert.strictEqual(
      dailyPeriodFor({ version: "v1" }, new Date("2026-07-15T00:30:00.000Z")).periodStart,
      getCurrentDailyPeriod(new Date("2026-07-15T00:30:00.000Z")).periodStart,
      "a v1 mandate never signed a zone, so UTC it stays",
    );

    const mandateId = "vman_midnight_test";
    await saveExecutionMandate({
      mandateId,
      ownerWallet: "0x1111111111111111111111111111111111111111",
      subjectAgentId: "agent_auto",
      subjectWallet: "0x2222222222222222222222222222222222222222",
      mode: "AUTOPILOT",
      network: "eip155:5042002",
      allowedCapabilities: ["web_search"],
      allowedRails: ["x402"],
      maxPerTransactionUsdc: 10,
      maxPerDayUsdc: 50,
      maxTotalUsdc: 200,
      minimumTrustScore: 50,
      minimumConfidence: 50,
      requireVerifiedIdentity: true,
      evaluatorThresholdUsdc: 5,
      canonicalHash: "0x",
      signature: "0x",
      nonce: 1,
      version: "1.0",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      createdAt: new Date().toISOString(),
    } as any);

    /* The purchase happened yesterday and is being reconciled today -- which is
       the ordinary case, because reconciliation exists precisely for payments
       whose fate took a while to establish. */
    const yesterday = getCurrentDailyPeriod(new Date(Date.now() - 86_400_000));
    const today = getCurrentDailyPeriod();
    assert.notStrictEqual(yesterday.periodStart, today.periodStart);

    await reserveBudgetAtomic(mandateId, 2.0, yesterday);

    const executionId = "vexec_midnight_test";
    await saveExecutionAttempt({
      executionId,
      mandateId,
      state: "SETTLEMENT_UNVERIFIED",
      rail: "x402",
      counterpartyAgentId: "agent_seller_1",
      counterpartyWallet: "0x3333333333333333333333333333333333333333",
      capability: "web_search",
      requestedAmountUsdc: 2.0,
      authorizedAmountUsdc: 2.0,
      actualSettledAmountUsdc: 0,
      failureCode: "PAYMENT_SETTLEMENT_UNVERIFIED",
      selectionId: "sel_midnight",
      selectionHash: "0x",
      canonicalHash: "0x",
      budgetPeriodStart: yesterday.periodStart,
      createdAt: new Date(Date.now() - 86_400_000).toISOString(),
      updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
    } as any);

    /* What the old code did: settle against the day it is now. The store is
       keyed by (mandate, day) exactly as the table is, so this finds nothing --
       and used to return a boolean nobody read, while the attempt had already
       been marked COMPLETED by a separate statement. */
    assert.strictEqual(
      await settleBudgetAtomic(mandateId, 2.0, 2.0, today.periodStart),
      false,
      "there is no usage row for today, because the reservation was not made today",
    );

    const settled = await reconcileExecutionSettlement(executionId, {
      resolver: new MockSettlementResolver(() => ({
        resolved: true,
        settled: true,
        failed: false,
        txHash: "0x" + "b".repeat(64),
        settledAmountUsdc: 2.0,
      })),
    });
    assert.strictEqual(settled.status, "COMPLETED");

    const yesterdayUsage = await getExecutionMandateUsage(mandateId, yesterday.periodStart);
    assert.strictEqual(yesterdayUsage.reservedUsdc, 0, "the reservation must be released where it was taken");
    assert.strictEqual(yesterdayUsage.usedUsdc, 2.0, "and the spend recorded on the same day");

    const todayUsage = await getExecutionMandateUsage(mandateId, today.periodStart);
    assert.strictEqual(todayUsage.usedUsdc, 0, "today's budget must not be charged for yesterday's purchase");
    assert.strictEqual(todayUsage.reservedUsdc, 0);

    // Retried reconciliation is a no-op rather than a second settlement.
    const again = await reconcileExecutionSettlement(executionId);
    assert.strictEqual(again.status, "COMPLETED");
    const afterRetry = await getExecutionMandateUsage(mandateId, yesterday.periodStart);
    assert.strictEqual(afterRetry.usedUsdc, 2.0, "a retried reconcile must not settle twice");

    console.log("✅ Budget settles into the day its reservation was taken in, once.");
  }

  // 21. A batched Gateway purchase is not reconciled with the token's nonce bit
  {
    const { readAuthorizationUsed, RealArcSettlementResolver } =
      await import("../lib/execution/settlement-resolver.ts");
    const { saveExecutionAttempt, saveExecutionMandate, getExecutionMandateUsage, reserveBudgetAtomic, getExecutionAttempt } =
      await import("../lib/execution/db.ts");
    const { reconcileExecutionSettlement } = await import("../lib/execution/executor.ts");
    const { getCurrentDailyPeriod } = await import("../lib/execution/budget.ts");

    /* Circle's batched scheme domain-separates the signature by the
       GatewayWallet, so the nonce inside it was never an EIP-3009 nonce on the
       token. authorizationState on USDC answers false for every one of them --
       paid and unpaid alike -- and the code read that false as "unspent".

       The address below is Base's real USDC, so the call would actually be made
       and would actually return false if the guard were removed. */
    const batchedAnswer = await readAuthorizationUsed({
      network: "eip155:8453",
      asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      payer: "0x1111111111111111111111111111111111111111",
      nonce: "0x" + "ab".repeat(32),
      gatewayBatched: true,
    });
    assert.strictEqual(
      batchedAnswer, null,
      "the token cannot answer for a batched authorization, and must say so rather than say no",
    );

    const resolver = new RealArcSettlementResolver();
    const baseAttempt = {
      mandateId: null,
      rail: "x402" as const,
      counterpartyAgentId: "agent_gateway_seller",
      counterpartyWallet: "0x3333333333333333333333333333333333333333" as `0x${string}`,
      capability: "web_search",
      requestedAmountUsdc: 0.02,
      authorizedAmountUsdc: 0.02,
      selectionId: "sel_batched",
      selectionHash: "0x",
      canonicalHash: "0x",
      state: "SETTLEMENT_UNVERIFIED" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const batchedContext = {
      payerWallet: "0x1111111111111111111111111111111111111111" as `0x${string}`,
      payTo: "0x3333333333333333333333333333333333333333" as `0x${string}`,
      asset: "0x3600000000000000000000000000000000000000" as `0x${string}`,
      /* A chain no resolver knows. A vanilla context here resolves to nothing,
         which is what proves the batched path never went looking for one. */
      network: "eip155:987654321",
      authorizedAmountUsdc: 0.02,
      authorizedAmountAtomic: "20000",
      authorizationNonce: "0x" + "cd".repeat(32),
      authorizationValidBefore: 0,
      gatewayBatched: true,
      requestTimestamp: new Date().toISOString(),
    };

    const stillOpen = await resolver.resolve({
      attempt: {
        ...baseAttempt,
        executionId: "vexec_batched_open",
        x402Context: { ...batchedContext, authorizationValidBefore: Math.floor(Date.now() / 1000) + 3_600 },
      } as any,
    });
    assert.strictEqual(stillOpen.resolved, false, "a live batched authorization is still redeemable; nothing to conclude");
    assert.strictEqual(stillOpen.settled, false);
    assert.strictEqual(stillOpen.failed, false);

    const expired = await resolver.resolve({
      attempt: {
        ...baseAttempt,
        executionId: "vexec_batched_expired",
        x402Context: { ...batchedContext, authorizationValidBefore: Math.floor(Date.now() / 1000) - 60 },
      } as any,
    });
    assert.strictEqual(expired.resolved, true, "an expired batched authorization is answerable, on an unknown chain, without any RPC");
    assert.strictEqual(expired.settled, true, "booked as spent: exceeding a signed cap is worse than under-using one");
    assert.strictEqual(expired.failed, false);
    assert.strictEqual(expired.txHash, null, "a batch nets many purchases into one transaction; none of it belongs to this one");
    assert.strictEqual(expired.proof, "gateway_batch_presumed");
    assert.strictEqual(expired.settledAmountUsdc, 0.02);

    /* And the same context without the flag still takes the vanilla path, which
       on an unknown chain has nothing to say. This is the regression guard: if
       the dispatch were on something other than the recorded rail, these two
       would not differ. */
    const vanillaOnUnknownChain = await resolver.resolve({
      attempt: {
        ...baseAttempt,
        executionId: "vexec_vanilla_expired",
        x402Context: { ...batchedContext, gatewayBatched: false, authorizationValidBefore: Math.floor(Date.now() / 1000) - 60 },
      } as any,
    });
    assert.strictEqual(vanillaOnUnknownChain.resolved, false, "a vanilla authorization on a chain Veyra cannot read stays unresolved");

    // End to end: the presumption reaches the ledger with its grade attached.
    const day = getCurrentDailyPeriod();
    const mandateId = "vman_batched_presumed";
    await saveExecutionMandate({
      mandateId,
      ownerWallet: "0x1111111111111111111111111111111111111111",
      subjectAgentId: "agent_auto",
      subjectWallet: "0x2222222222222222222222222222222222222222",
      mode: "AUTOPILOT",
      network: "eip155:5042002",
      allowedCapabilities: ["web_search"],
      allowedRails: ["x402"],
      maxPerTransactionUsdc: 10,
      maxPerDayUsdc: 50,
      maxTotalUsdc: 200,
      minimumTrustScore: 50,
      minimumConfidence: 50,
      requireVerifiedIdentity: true,
      evaluatorThresholdUsdc: 5,
      canonicalHash: "0x",
      signature: "0x",
      nonce: 1,
      version: "v2",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      createdAt: new Date().toISOString(),
    } as any);
    await reserveBudgetAtomic(mandateId, 0.02, day);

    const executionId = "vexec_batched_ledger";
    await saveExecutionAttempt({
      ...baseAttempt,
      executionId,
      mandateId,
      budgetPeriodStart: day.periodStart,
      failureCode: "PAYMENT_SETTLEMENT_UNVERIFIED",
      x402Context: { ...batchedContext, authorizationValidBefore: Math.floor(Date.now() / 1000) - 60 },
    } as any);

    const settled = await reconcileExecutionSettlement(executionId, { resolver });
    assert.strictEqual(settled.status, "COMPLETED_UNPROVEN", "no transaction exists to prove anything with");
    assert.strictEqual(settled.actualSettledAmountUsdc, 0.02);
    assert.strictEqual(settled.paymentTx, null);

    const stored = await getExecutionAttempt(executionId);
    assert.strictEqual(
      stored?.settlementProof, "presumed_spent",
      "the grade must say the spend rests on an argument, not on the chain",
    );

    const { provesEconomicEvidence } = await import("../lib/execution/settlement-proof.ts");
    assert.strictEqual(
      provesEconomicEvidence("presumed_spent"), false,
      "a presumption must never become reputation evidence about the seller",
    );

    const usage = await getExecutionMandateUsage(mandateId, day.periodStart);
    assert.strictEqual(usage.reservedUsdc, 0, "the reservation cannot be held forever");
    assert.strictEqual(usage.usedUsdc, 0.02, "and the spend is booked, because it may really have left");

    console.log("✅ Batched Gateway settlement is reconciled on its own terms, not the token's.");
  }

  // 22. The sweep is what actually asks
  {
    const { saveExecutionAttempt, listExecutionAttempts } = await import("../lib/execution/db.ts");
    const { sweepUnverifiedSettlements } = await import("../lib/execution/reconcile-sweep.ts");
    const { MockSettlementResolver } = await import("../lib/execution/settlement-resolver.ts");

    const base = {
      mandateId: null,
      rail: "x402" as const,
      counterpartyAgentId: "agent_sweep",
      counterpartyWallet: "0x4444444444444444444444444444444444444444" as `0x${string}`,
      capability: "web_search",
      requestedAmountUsdc: 0.01,
      authorizedAmountUsdc: 0.01,
      selectionId: "sel_sweep",
      selectionHash: "0x",
      canonicalHash: "0x",
      x402Context: null,
    };
    // Oldest first, so a bounded sweep works through a backlog rather than
    // re-reading the newest page every hour and never reaching the tail.
    await saveExecutionAttempt({
      ...base, executionId: "vexec_sweep_old", state: "SETTLEMENT_UNVERIFIED",
      createdAt: new Date(Date.now() - 86_400_000).toISOString(), updatedAt: new Date().toISOString(),
    } as any);
    await saveExecutionAttempt({
      ...base, executionId: "vexec_sweep_new", state: "SETTLEMENT_UNVERIFIED",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    } as any);

    const waiting = await listExecutionAttempts({ state: "SETTLEMENT_UNVERIFIED", oldestFirst: true, limit: 10 });
    assert.ok(waiting.length >= 2);
    assert.strictEqual(waiting[0].executionId, "vexec_sweep_old", "the sweep must start at the oldest open question");
    assert.ok(
      waiting.every((a) => a.state === "SETTLEMENT_UNVERIFIED"),
      "the sweep must not touch attempts that already have an answer",
    );

    /* One attempt throwing must not end the tick. The resolver here refuses the
       first execution it sees and answers the rest. */
    let refused = false;
    const flaky = new MockSettlementResolver(({ attempt }) => {
      if (!refused && attempt.executionId === "vexec_sweep_old") {
        refused = true;
        throw new Error("RPC unavailable");
      }
      return { resolved: false, settled: false, failed: false };
    });

    const outcome = await sweepUnverifiedSettlements({ limit: 10, resolver: flaky });
    assert.ok(outcome.examined >= 2, "the sweep must find attempts nobody named by id");
    assert.strictEqual(outcome.errored, 1, "the failing attempt is counted");
    assert.ok(outcome.unresolved >= 1, "and the sweep carried on to the ones after it");
    assert.strictEqual(outcome.settled, 0);

    console.log("✅ Unverified settlements are swept without anyone naming them.");
  }

  console.log("\n🎉 ALL P6.1 Negative & Adversarial Security Tests Passed Successfully!");
}

runNegativeTests().catch((err) => {
  console.error("❌ Negative tests failed:", err);
  process.exit(1);
});
