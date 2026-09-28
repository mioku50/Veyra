/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import type { NextRequest } from "next/server";
import { answerSelect, checkSelectRequest } from "@/lib/x402/trust-api/answers";
import { TRUST_API_PRICING } from "@/lib/x402/trust-api/pricing";
import { withTrustApiChallenge, withTrustApiPayment, type TrustApiRouteOptions } from "@/lib/x402/trust-api/seller";

export const dynamic = "force-dynamic";

/**
 * Paid. "Find me someone to buy this from, and tell me who not to."
 *
 * This costs the most to serve because it is the most work: Circle's catalog is
 * queried, every affordable candidate is probed live and in parallel, and all
 * of them are ranked against the same policy a single verdict uses. Each of
 * those probes is also written to the evidence base, so a paid selection makes
 * every later verdict — including the free ones — a little better informed.
 */
const TERMS: TrustApiRouteOptions = {
  endpoint: TRUST_API_PRICING.select.path,
  priceUsdc: TRUST_API_PRICING.select.priceUsdc,
  description: TRUST_API_PRICING.select.description,
  schema: TRUST_API_PRICING.select.schema,
  validate: (body) => checkSelectRequest(body, "testnets"),
};

export const POST = withTrustApiPayment((request: NextRequest, context) => answerSelect(request, context.payer, "testnets"), TERMS);

/** A GET reads the challenge and is never charged: see withTrustApiChallenge. */
export const GET = withTrustApiChallenge(TERMS);
