/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse, type NextRequest } from "next/server";
import { getByoaClient } from "@/lib/byoa/service";
import { findIssuedClearance } from "@/lib/x402/trust-api/clearance-ledger";
import { CREDIT_HEADER, issueCredit } from "@/lib/x402/trust-api/credits";
import { readJsonBody, trustApiError, TRUST_API_HEADERS } from "@/lib/x402/trust-api/http";
import { TRUST_API_PRICING } from "@/lib/x402/trust-api/pricing";
import { TrustApiError } from "@/lib/x402/trust-api/resource";
import { callerKey, consumeFreeCall } from "@/lib/x402/trust-api/rate-limit";

export const dynamic = "force-dynamic";

const OUTCOMES = new Set(["fulfilled", "failed", "refused", "drifted"]);

/**
 * Free, and it pays the reporter.
 *
 * Veyra can watch an endpoint answer a challenge, but it cannot see what
 * happened after somebody paid it — whether the goods arrived, whether they
 * were what was promised. Only the buyer knows that, so the buyer is who gets
 * paid for saying it: one report earns one credit, and a credit buys one
 * clearance.
 *
 * The loop is not farmable. A report is only accepted against a clearance Veyra
 * itself issued, exactly once, and a clearance costs more than the credit it
 * returns. Buying clearances to mint credits loses money; reporting honestly
 * about clearances you were going to buy anyway is free.
 */
export async function POST(request: NextRequest) {
  const limit = consumeFreeCall(callerKey(request), 60);
  if (!limit.allowed) {
    return NextResponse.json({
      error: { code: "rate_limited", message: "Too many reports from this caller. Retry shortly." },
    }, { status: 429, headers: { ...TRUST_API_HEADERS, "Retry-After": String(limit.retryAfterSeconds) } });
  }

  try {
    const body = await readJsonBody(request);

    const digest = typeof body.clearanceDigest === "string" ? body.clearanceDigest.trim() : "";
    if (!/^0x[0-9a-fA-F]{64}$/.test(digest)) {
      throw new TrustApiError("outcome_invalid", 400, "`clearanceDigest` must be a 32-byte hex digest.");
    }
    const outcome = typeof body.outcome === "string" ? body.outcome.trim().toLowerCase() : "";
    if (!OUTCOMES.has(outcome)) {
      throw new TrustApiError(
        "outcome_invalid",
        400,
        `\`outcome\` must be one of ${[...OUTCOMES].join(", ")}.`,
      );
    }

    const issued = await findIssuedClearance(digest);
    if (!issued) {
      throw new TrustApiError("outcome_unknown_clearance", 404);
    }

    const paidUsdc = Number(body.paidUsdc);
    const latencyMs = Number(body.latencyMs);
    const httpStatus = Number(body.httpStatus);

    const { data, error } = await getByoaClient()
      .from("x402_trust_outcomes")
      .insert({
        clearance_digest: digest.toLowerCase(),
        resource_key: issued.resource_key,
        resource_url: issued.resource_url,
        reporter: issued.payer,
        outcome,
        paid_usdc: Number.isFinite(paidUsdc) && paidUsdc >= 0 ? paidUsdc : null,
        latency_ms: Number.isFinite(latencyMs) && latencyMs >= 0 ? Math.round(latencyMs) : null,
        settlement_tx: typeof body.settlementTx === "string" ? body.settlementTx.slice(0, 200) : null,
        http_status: Number.isFinite(httpStatus) ? Math.round(httpStatus) : null,
        detail: typeof body.detail === "string" ? body.detail.slice(0, 2_000) : null,
      })
      .select("outcome_id")
      .single();

    if (error) {
      // The unique constraint on the digest is the anti-farming rule, and
      // hitting it is a normal outcome rather than a server fault.
      if (error.code === "23505") throw new TrustApiError("outcome_already_reported", 409);
      throw new TrustApiError("outcome_not_recorded", 503, "The outcome could not be recorded.");
    }

    const credit = await issueCredit({ outcomeId: String(data.outcome_id) });

    return NextResponse.json({
      recorded: true,
      outcomeId: data.outcome_id,
      resource: issued.resource_url,
      thanks: "This is the only way Veyra learns what happens after a payment.",
      credit: credit
        ? {
            // Returned exactly once. Only its hash is stored, so nobody -
            // including Veyra - can spend it after this response.
            token: credit.token,
            uses: credit.uses,
            expiresAt: credit.expiresAt,
            header: CREDIT_HEADER,
            redeemableAt: [TRUST_API_PRICING.clearance.path, TRUST_API_PRICING.history.path, TRUST_API_PRICING.select.path],
          }
        : null,
      creditNote: credit ? undefined : "The report was recorded, but a credit could not be issued right now.",
    }, { headers: TRUST_API_HEADERS });
  } catch (error) {
    return trustApiError(error);
  }
}
