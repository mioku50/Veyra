/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse, type NextRequest } from "next/server";
import { BRAND } from "@/lib/brand";
import { issueMarketplaceClearance } from "@/lib/counterparty-selection/marketplace";
import { CREDIT_HEADER } from "@/lib/x402/trust-api/credits";
import {
  attesterConfigured,
  recordIssuedClearance,
} from "@/lib/x402/trust-api/clearance-ledger";
import { publicVerdict, readJsonBody, trustApiError, TRUST_API_HEADERS } from "@/lib/x402/trust-api/http";
import { TRUST_API_PRICING } from "@/lib/x402/trust-api/pricing";
import { TrustApiError } from "@/lib/x402/trust-api/resource";
import { withTrustApiPayment } from "@/lib/x402/trust-api/seller";
import { computeTrustApiVerdict } from "@/lib/x402/trust-api/verdict";

export const dynamic = "force-dynamic";

/**
 * Paid. The verdict, plus the thing only Veyra can produce.
 *
 * The signature is the product. An agent can reach the same conclusion Veyra
 * reaches - the free endpoint hands it over, and the evidence with it - but it
 * cannot mint an EIP-712 attestation that `VeyraTrustGate.consumeClearance`
 * will accept, because that requires the attester key the gate recognises. What
 * is sold here is not knowledge. It is an onchain consequence.
 *
 * The clearance is bound to the wallet that paid for it. A payer that reports
 * back what happened earns a credit that pays for the next one.
 */
export const POST = withTrustApiPayment(async (request: NextRequest, context) => {
  try {
    const body = await readJsonBody(request);

    // The clearance is signed for whoever paid. A caller may name a different
    // executor, but never silently: an unpaid wallet cannot be handed an
    // authorization it did not buy.
    const requesterWallet = context.payer
      ?? (typeof body.requesterWallet === "string" ? body.requesterWallet : undefined);
    if (!requesterWallet) {
      throw new TrustApiError(
        "requester_wallet_required",
        400,
        "A clearance must name the wallet it authorizes. Pay from that wallet, or send `requesterWallet`.",
      );
    }

    const verdict = await computeTrustApiVerdict({
      resource: body.resource,
      method: body.method,
      capability: typeof body.capability === "string" ? body.capability : undefined,
      budgetUsdc: Number(body.budgetUsdc ?? 1),
      requesterWallet,
    });

    if (!verdict.granted) {
      /* A refusal is a complete answer, and the caller paid for the work of
         reaching it. Veyra does not sign for a counterparty it cannot justify,
         and does not pretend the call failed either. */
      return NextResponse.json({
        ...publicVerdict(verdict),
        signed: false,
        clearance: null,
        refused: true,
        message: `${BRAND.name} will not sign for this counterparty. The evidence and the reasons are above.`,
      }, { headers: TRUST_API_HEADERS });
    }

    const clearance = await issueMarketplaceClearance({
      decision: {
        ...verdict.trustDecision,
        policy: { ...verdict.trustDecision.policy, maxValueUsdc: verdict.maxExposureUsdc },
      },
      selectionHash: verdict.evidenceHash,
      issuedAt: verdict.issuedAt,
      expiresAt: new Date(Math.min(
        Date.parse(verdict.expiresAt),
        Date.parse(verdict.trustDecision.expiresAt),
      )).toISOString(),
    });

    const recorded = await recordIssuedClearance({
      clearance,
      resourceKey: verdict.resourceKey,
      resourceUrl: verdict.resource,
      payer: context.payer,
      payTo: verdict.payTo,
      decision: verdict.decision,
      maxExposureUsdc: verdict.maxExposureUsdc,
    });

    return NextResponse.json({
      ...publicVerdict(verdict),
      signed: true,
      clearance,
      consume: {
        contract: "VeyraTrustGate",
        method: "consumeClearance",
        chainId: clearance.chainId,
        verifyingContract: clearance.verifyingContract,
      },
      reportOutcome: {
        endpoint: TRUST_API_PRICING.outcomes.path,
        clearanceDigest: clearance.clearanceDigest,
        earns: recorded
          ? `One credit, redeemable at ${TRUST_API_PRICING.clearance.path} via the ${CREDIT_HEADER} header.`
          : "Reporting is still welcome, but this clearance was not recorded, so it cannot earn a credit.",
      },
    }, { headers: TRUST_API_HEADERS });
  } catch (error) {
    return trustApiError(error);
  }
}, {
  endpoint: TRUST_API_PRICING.clearance.path,
  priceUsdc: TRUST_API_PRICING.clearance.priceUsdc,
  description: TRUST_API_PRICING.clearance.description,
  schema: TRUST_API_PRICING.clearance.schema,
  // Never charge for a signature that cannot be produced.
  preflight: async () => attesterConfigured()
    ? { ok: true }
    : {
        ok: false,
        code: "clearance_unavailable",
        message: `${BRAND.name} cannot sign clearances right now, so this call was refused before it was charged. The free verdict endpoint is unaffected.`,
      },
});
