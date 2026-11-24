/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse, type NextRequest } from "next/server";
import { recordAdoptionEvent, verdictAdoptionChannel } from "@/lib/x402/trust-api/adoption-metrics";
import { ARC_MAINNET_NETWORK, ARC_TRUST_API } from "@/lib/x402/trust-api/arc-mainnet";
import { publicVerdict, readJsonBody, trustApiError, TRUST_API_HEADERS } from "@/lib/x402/trust-api/http";
import { callerKey, consumeFreeCall } from "@/lib/x402/trust-api/rate-limit";
import { computeTrustApiVerdict } from "@/lib/x402/trust-api/verdict";

export const dynamic = "force-dynamic";

/**
 * Free. One endpoint in, one answer out: should an agent pay this counterparty.
 *
 * No account, no key, no payment — an agent that has never heard of Veyra can
 * ask this on its first call. It reads the live Arc mainnet USDC offer and
 * returns evidence and a verdict without issuing a signed clearance.
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
      publicArc: true,
      method: body.method,
      capability: typeof body.capability === "string" ? body.capability : undefined,
      budgetUsdc: Number(body.budgetUsdc ?? 1),
    });

    const response = NextResponse.json({
      ...publicVerdict(verdict),
      signed: false,
      clearance: null,
      /* Said plainly rather than left to be discovered: a live probe sees only
         this moment; paid Arc endpoint history adds observed latency, uptime,
         and price or payee changes over time. */
      upgrade: {
        reason: "A verdict probes the live offer once. Endpoint history returns observed latency, uptime, price and payee changes on Arc mainnet.",
        endpoint: ARC_TRUST_API.history.path,
        priceUsdc: ARC_TRUST_API.history.priceUsdc,
        network: ARC_MAINNET_NETWORK,
      },
    }, { headers: TRUST_API_HEADERS });
    recordAdoptionEvent(request.headers, verdictAdoptionChannel(request.headers));
    return response;
  } catch (error) {
    return trustApiError(error);
  }
}
