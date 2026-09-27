/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import type { NextRequest } from "next/server";
import { answerHistory, checkHistoryRequest } from "@/lib/x402/trust-api/answers";
import { ARC_TRUST_API } from "@/lib/x402/trust-api/arc-mainnet";
import { withTrustApiPayment } from "@/lib/x402/trust-api/seller";

export const dynamic = "force-dynamic";

/**
 * Paid, on Arc mainnet. The same archive as `/api/x402/v1/history`, paid in
 * USDC on Arc through Circle's mainnet Gateway, to Veyra's own wallet. It
 * takes no credits.
 */
export const POST = withTrustApiPayment((request: NextRequest) => answerHistory(request), {
  endpoint: ARC_TRUST_API.history.path,
  priceUsdc: ARC_TRUST_API.history.priceUsdc,
  description: ARC_TRUST_API.history.description,
  schema: ARC_TRUST_API.history.schema,
  validate: checkHistoryRequest,
  rail: "arc",
});
