/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import type { NextRequest } from "next/server";
import { answerHistory, checkHistoryRequest } from "@/lib/x402/trust-api/answers";
import { TRUST_API_PRICING } from "@/lib/x402/trust-api/pricing";
import { withTrustApiPayment } from "@/lib/x402/trust-api/seller";

export const dynamic = "force-dynamic";

/**
 * Paid. Everything Veyra has ever observed about one endpoint.
 *
 * This is the archive, not a probe: it answers what this endpoint has been
 * like, not what it is doing this second. That is the half no caller can
 * reconstruct for themselves — anyone can measure an endpoint once, but only
 * something that has been watching has a distribution and a list of the days
 * its payee changed.
 */
export const POST = withTrustApiPayment((request: NextRequest) => answerHistory(request), {
  endpoint: TRUST_API_PRICING.history.path,
  priceUsdc: TRUST_API_PRICING.history.priceUsdc,
  description: TRUST_API_PRICING.history.description,
  schema: TRUST_API_PRICING.history.schema,
  validate: checkHistoryRequest,
});
