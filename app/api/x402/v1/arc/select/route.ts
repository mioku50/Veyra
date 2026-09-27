/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import type { NextRequest } from "next/server";
import { answerSelect, checkSelectRequest } from "@/lib/x402/trust-api/answers";
import { ARC_TRUST_API } from "@/lib/x402/trust-api/arc-mainnet";
import { withTrustApiPayment } from "@/lib/x402/trust-api/seller";

export const dynamic = "force-dynamic";

/**
 * Paid, on Arc mainnet. The same search and ranking as `/api/x402/v1/select`,
 * over sellers paid on Arc unless another network is asked for. It is paid in
 * USDC on Arc, takes no credits, and signs no clearance: the TrustGate that
 * verifies one exists on Arc Testnet only.
 */
export const POST = withTrustApiPayment((request: NextRequest, context) => answerSelect(request, context.payer, "arc"), {
  endpoint: ARC_TRUST_API.select.path,
  priceUsdc: ARC_TRUST_API.select.priceUsdc,
  description: ARC_TRUST_API.select.description,
  schema: ARC_TRUST_API.select.schema,
  validate: (body) => checkSelectRequest(body, "arc"),
  rail: "arc",
});
