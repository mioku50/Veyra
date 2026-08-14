/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExecutionRailAdapter, NormalizedRailResult, RailExecutionParams } from "./types.ts";

export class X402ExecutionAdapter implements ExecutionRailAdapter {
  readonly rail = "x402" as const;

  async prepare(params: RailExecutionParams): Promise<any> {
    return {
      rail: "x402",
      recipientWallet: params.counterpartyWallet,
      maxAmountUsdc: params.amountUsdc,
      capability: params.capability,
      selectionHash: params.selectionHash,
      clearanceDigest: params.clearanceDigest,
    };
  }

  async execute(params: RailExecutionParams): Promise<NormalizedRailResult> {
    // Assert recipient is not zero address
    if (!params.counterpartyWallet || params.counterpartyWallet === "0x0000000000000000000000000000000000000000") {
      return {
        executionId: params.executionId,
        rail: "x402",
        success: false,
        failureCode: "INVALID_RECIPIENT_WALLET",
        actualSettledAmountUsdc: 0,
        evidenceType: "x402_execution_failure",
      };
    }

    const mockPaymentTx = `0x${Buffer.from(`tx_x402_${params.executionId}`).toString("hex").padEnd(64, "0")}` as `0x${string}`;

    return {
      executionId: params.executionId,
      rail: "x402",
      success: true,
      actualSettledAmountUsdc: params.amountUsdc,
      externalReference: `pay_${params.executionId.slice(0, 12)}`,
      paymentTx: mockPaymentTx,
      evidenceType: "x402_settlement_success",
      rawResult: {
        status: "settled",
        recipient: params.counterpartyWallet,
        amountUsdc: params.amountUsdc,
        capability: params.capability,
      },
    };
  }
}
