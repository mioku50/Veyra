/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { setByoaClientForTesting } from "../lib/byoa/service.ts";
import { hashCanonical } from "../lib/counterparty-selection/canonical.ts";
import type { MarketplaceSelection } from "../lib/counterparty-selection/marketplace.ts";
import { ARC_MAINNET_NETWORK, ARC_MAINNET_USDC_ADDRESS } from "../lib/wallet/arc.ts";
import { selectAnswer } from "../lib/x402/trust-api/answers.ts";
import { buildCircleRecipientAllowlistCommand } from "../lib/x402/trust-api/circle-policy.ts";
import { buildVerdictPreflight, type BuildPreflightInput } from "../lib/x402/trust-api/preflight.ts";
import { publicVerdict } from "../lib/x402/trust-api/http.ts";
import { resourceKeyFor } from "../lib/x402/trust-api/resource.ts";
import { computeTrustApiVerdict } from "../lib/x402/trust-api/verdict.ts";

const payToA = "0x1111111111111111111111111111111111111111";
const payToB = "0x2222222222222222222222222222222222222222";
const payToC = "0x3333333333333333333333333333333333333333";

function basePreflightInput(overrides: Partial<BuildPreflightInput> = {}): BuildPreflightInput {
  return {
    probe: {
      reachable: true,
      respondedWith402: true,
      challengeParseable: true,
      criticalFailure: null,
      failedChecks: [],
    },
    network: ARC_MAINNET_NETWORK,
    livePayTo: payToA,
    priceUsdc: 0.1,
    priceUnknown: false,
    budgetUsdc: 0.5,
    catalogPayTo: payToA,
    lastCheckPayTo: payToA,
    lastCheckPriceUsdc: 0.1,
    lastObservationPayTo: payToA,
    lastObservationPriceUsdc: 0.1,
    reasons: [],
    statisticalEvidenceAvailable: true,
    ...overrides,
  };
}

test("buildVerdictPreflight detects every blocking signal individually", () => {
  const cases: Array<[Partial<BuildPreflightInput>, string]> = [
    [{ probe: { ...basePreflightInput().probe, reachable: false } }, "endpoint_unreachable"],
    [{ probe: { ...basePreflightInput().probe, respondedWith402: false } }, "no_402_response"],
    [{ probe: { ...basePreflightInput().probe, challengeParseable: false } }, "challenge_unparseable"],
    [{ probe: { ...basePreflightInput().probe, criticalFailure: "invalid_challenge" } }, "critical_failure"],
    [{ network: "eip155:8453" }, "arc_mainnet_usdc_missing"],
    [{ livePayTo: null }, "arc_mainnet_usdc_missing"],
    [{ priceUsdc: 0.75, budgetUsdc: 0.5 }, "over_budget"],
    [{ catalogPayTo: payToB }, "payto_differs_from_catalog"],
    [{ lastCheckPayTo: payToC }, "payto_differs_from_last_check"],
    [{ lastCheckPayTo: null, lastObservationPayTo: payToC }, "payto_differs_from_last_check"],
  ];

  for (const [overrides, expectedCode] of cases) {
    const out = buildVerdictPreflight(basePreflightInput(overrides));
    assert.equal(out.result, "block", `Expected block for ${expectedCode}`);
    assert(
      out.blocking.some((signal) => signal.code === expectedCode),
      `Expected blocking signal ${expectedCode}, got ${JSON.stringify(out.blocking)}`,
    );
  }
});

test("buildVerdictPreflight attaches non-blocking note signals without blocking", () => {
  const out = buildVerdictPreflight(basePreflightInput({
    probe: {
      ...basePreflightInput().probe,
      failedChecks: ["declares_input_schema", "declares_output_schema", "provider_documented"],
    },
    priceUsdc: 0.15,
    lastCheckPriceUsdc: 0.1,
    reasons: ["NO_REPUTATION_DATA"],
    statisticalEvidenceAvailable: false,
  }));

  assert.equal(out.result, "pass");
  assert.deepEqual(out.blocking, []);
  assert.deepEqual(
    out.notes.map((n) => n.code),
    [
      "missing_input_schema",
      "missing_output_schema",
      "provider_undocumented",
      "price_changed",
      "no_reputation_data",
    ],
  );
  const priceNote = out.notes.find((n) => n.code === "price_changed");
  assert.deepEqual(priceNote?.meta, { previousPriceUsdc: 0.1, currentPriceUsdc: 0.15 });
});

test("computeTrustApiVerdict blocks swapped payees and passes ordinary aisa listings while keeping legacy fields identical", async () => {
  const aisaUrl = "https://api.aisa.one/apis/v2/apollo/labels";
  const challengeHeader = (accept: Record<string, unknown>) =>
    Buffer.from(JSON.stringify({ x402Version: 2, accepts: [accept] })).toString("base64");

  const fixedNow = new Date("2026-11-24T12:00:00.000Z");
  const baseAccept = {
    scheme: "exact",
    network: ARC_MAINNET_NETWORK,
    asset: ARC_MAINNET_USDC_ADDRESS,
    payTo: payToA,
    amount: "100000",
    maxTimeoutSeconds: 60,
  };

  setByoaClientForTesting({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }),
          order: () => ({ limit: async () => ({ data: [], error: null }) }),
        }),
      }),
      insert: async () => ({ error: null }),
    }),
  } as never);

  try {
    const mockAisaFetch = async (_url: string, init: RequestInit) => {
      if (init.method === "GET") {
        return new Response(null, { status: 402, headers: { "PAYMENT-REQUIRED": challengeHeader(baseAccept) } });
      }
      return new Response(null, { status: 405 });
    };

    // 1. Ordinary listing (matching catalog & last check): pass with notes
    const aisaVerdict = await computeTrustApiVerdict({
      resource: aisaUrl,
      method: "GET",
      budgetUsdc: 0.25,
      now: fixedNow,
      publicArc: true,
      probeFetchImpl: mockAisaFetch,
      arcIndexReference: {
        catalogPayTo: payToA,
        lastCheckPayTo: payToA,
        lastCheckPriceUsdc: 0.1,
      },
    });
    const publicAisa = publicVerdict(aisaVerdict);
    assert.equal(publicAisa.preflight.result, "pass");
    assert.deepEqual(publicAisa.preflight.blocking, []);
    assert(publicAisa.preflight.notes.some((n) => n.code === "no_reputation_data"));
    assert(publicAisa.preflight.notes.some((n) => n.code === "missing_input_schema"));

    // Snapshot test of all pre-Block-D legacy fields (unchanged contract)
    const resourceKey = resourceKeyFor("GET", aisaUrl);
    const { preflight: _omitPreflight, ...legacyFields } = publicAisa;
    const expectedEvidenceHash = hashCanonical({
      schema: "veyra.trust-api-verdict.v1",
      resourceKey,
      probeVersion: legacyFields.probeVersion,
      integrityScore: legacyFields.probe.integrityScore,
      observations: 1,
      coverage: (1 / 3).toFixed(6),
      payTo: payToA.toLowerCase(),
      priceUsdc: "0.100000",
      probedAt: fixedNow.toISOString(),
    });
    assert.deepEqual(
      {
        verdictVersion: legacyFields.verdictVersion,
        resource: legacyFields.resource,
        resourceKey: legacyFields.resourceKey,
        method: legacyFields.method,
        baseline: legacyFields.baseline,
        decision: legacyFields.decision,
        granted: legacyFields.granted,
        payTo: legacyFields.payTo,
        network: legacyFields.network,
        priceUsdc: legacyFields.priceUsdc,
        maxExposureUsdc: legacyFields.maxExposureUsdc,
        postCallVerificationRequired: legacyFields.postCallVerificationRequired,
        reasons: legacyFields.reasons,
        evidenceHash: legacyFields.evidenceHash,
        issuedAt: legacyFields.issuedAt,
        expiresAt: legacyFields.expiresAt,
      },
      {
        verdictVersion: "veyra-trust-api-verdict-v1",
        resource: aisaUrl,
        resourceKey,
        method: "GET",
        baseline: "first_sighting",
        decision: "REQUIRE_EVALUATOR",
        granted: true,
        payTo: payToA,
        network: ARC_MAINNET_NETWORK,
        priceUsdc: 0.1,
        maxExposureUsdc: 0.1,
        postCallVerificationRequired: true,
        reasons: ["NO_REPUTATION_DATA"],
        evidenceHash: expectedEvidenceHash,
        issuedAt: fixedNow.toISOString(),
        expiresAt: new Date(fixedNow.getTime() + 300_000).toISOString(),
      },
    );

    // 2. Swapped payee vs catalog & last check: must block
    const swappedVerdict = await computeTrustApiVerdict({
      resource: aisaUrl,
      method: "GET",
      budgetUsdc: 0.25,
      now: fixedNow,
      publicArc: true,
      probeFetchImpl: mockAisaFetch,
      arcIndexReference: {
        catalogPayTo: payToB,
        lastCheckPayTo: payToC,
        lastCheckPriceUsdc: 0.05,
      },
    });
    assert.equal(swappedVerdict.preflight.result, "block");
    assert(swappedVerdict.preflight.blocking.some((s) => s.code === "payto_differs_from_catalog"));
    assert(swappedVerdict.preflight.blocking.some((s) => s.code === "payto_differs_from_last_check"));
    assert(swappedVerdict.preflight.notes.some((n) => n.code === "price_changed"));
  } finally {
    setByoaClientForTesting(null);
  }
});

test("Circle CLI allowlist generator emits exact skill flags and filters non-passing select candidates", () => {
  const generated = buildCircleRecipientAllowlistCommand([
    payToA,
    payToA.toUpperCase(),
    "0x0000000000000000000000000000000000000000",
    "not-an-address",
    payToB,
  ]);
  assert(generated);
  assert.equal(
    generated.command,
    `circle wallet limit set --address <YOUR_AGENT_WALLET> --chain ARC --policy-type stablecoin --rule-type recipient-allowlist --targets "[${payToA},${payToB}]" --output json`,
  );
  assert.equal(buildCircleRecipientAllowlistCommand([]), null);

  const selection = {
    requestedBudgetUsdc: 0.2,
    candidates: [
      {
        marketplace: { payTo: payToA, network: ARC_MAINNET_NETWORK, priceUsdc: 0.1 },
        probe: { reachable: true, respondedWith402: true, criticalFailure: null, catalogDrift: [] },
      },
      {
        marketplace: { payTo: payToB, network: ARC_MAINNET_NETWORK, priceUsdc: 0.15 },
        probe: { reachable: true, respondedWith402: true, criticalFailure: null, catalogDrift: ["payto_changed"] },
      },
      {
        marketplace: { payTo: payToC, network: "eip155:8453", priceUsdc: 0.05 },
        probe: { reachable: true, respondedWith402: true, criticalFailure: null, catalogDrift: [] },
      },
    ],
  } as unknown as MarketplaceSelection;

  const arcResponse = selectAnswer(selection, { onArc: true, unsigned: false }) as {
    circlePolicyCommand?: { targets: string[]; command: string } | null;
  };
  assert.deepEqual(arcResponse.circlePolicyCommand?.targets, [payToA]);
  assert(arcResponse.circlePolicyCommand?.command.includes("--rule-type recipient-allowlist"));
  assert(arcResponse.circlePolicyCommand?.command.includes("--policy-type stablecoin"));
});
