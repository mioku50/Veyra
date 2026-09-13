/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse, type NextRequest } from "next/server";
import { publicVerdict, readJsonBody, trustApiError, TRUST_API_HEADERS } from "@/lib/x402/trust-api/http";
import { TRUST_API_PRICING } from "@/lib/x402/trust-api/pricing";
import { callerKey, consumeFreeCall } from "@/lib/x402/trust-api/rate-limit";
import { computeTrustApiVerdict } from "@/lib/x402/trust-api/verdict";

export const dynamic = "force-dynamic";

/**
 * Free. One endpoint in, one answer out: should an agent pay this counterparty.
 *
 * No account, no key, no payment — an agent that has never heard of Veyra can
 * ask this on its first call. The verdict is the identical computation the paid
 * clearance endpoint runs; what money buys there is the signature, not a better
 * opinion. Keeping the opinion free is the point: an unsafe payment prevented
 * for a stranger is worth more to this network than a cent of revenue.
 */
export async function POST(request: NextRequest) {
  const limit = consumeFreeCall(callerKey(request));
  if (!limit.allowed) {
    return NextResponse.json({
      error: {
        code: "rate_limited",
        message: "Too many free verdicts from this caller. Retry shortly, or use the paid endpoints, which are not limited this way.",
      },
    }, {
      status: 429,
      headers: { ...TRUST_API_HEADERS, "Retry-After": String(limit.retryAfterSeconds) },
    });
  }

  try {
    const body = await readJsonBody(request);
    const verdict = await computeTrustApiVerdict({
      resource: body.resource,
      method: body.method,
      capability: typeof body.capability === "string" ? body.capability : undefined,
      budgetUsdc: Number(body.budgetUsdc ?? 1),
    });

    return NextResponse.json({
      ...publicVerdict(verdict),
      signed: false,
      clearance: null,
      /* Said plainly rather than left to be discovered: this answer is Veyra's
         opinion, and an opinion is not something a contract can consume. */
      upgrade: {
        reason: "A verdict is advice. A clearance is an EIP-712 attestation VeyraTrustGate.consumeClearance will accept onchain.",
        endpoint: TRUST_API_PRICING.clearance.path,
        priceUsdc: TRUST_API_PRICING.clearance.priceUsdc,
        freeWith: TRUST_API_PRICING.outcomes.path,
      },
    }, { headers: TRUST_API_HEADERS });
  } catch (error) {
    return trustApiError(error);
  }
}
