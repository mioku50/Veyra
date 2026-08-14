/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { createWalletClient, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { getArcPublicClient } from "../../erc8183/client.ts";
import type { ExecutionRailAdapter, NormalizedRailResult, RailExecutionParams } from "./types.ts";

const ARC_USDC_ABI = [
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

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
      serviceEndpoint: params.taskPayload?.endpointUrl || null,
    };
  }

  async execute(params: RailExecutionParams): Promise<NormalizedRailResult> {
    const isTestMode = process.env.NODE_ENV === "test" && process.env.EXECUTION_ALLOW_TEST_FALLBACK === "true";

    // Validate recipient
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

    const endpointUrl = params.taskPayload?.endpointUrl || process.env.LIVE_X402_TARGET_URL;
    const payerPk = (process.env.CANARY_DEPLOYER_PRIVATE_KEY ||
      process.env.VEYRA_TRUST_ATTESTER_PRIVATE_KEY) as `0x${string}` | undefined;
    const usdcAddress = (process.env.NEXT_PUBLIC_USDC_CONTRACT_ADDRESS ||
      "0x3600000000000000000000000000000000000000") as `0x${string}`;
    const rpcUrl = process.env.ARC_TESTNET_RPC_URL;

    // Controlled deterministic harness for explicit unit/negative test mode only
    if (isTestMode) {
      const mockPaymentTx = `0x${Buffer.from(`tx_x402_${params.executionId}`).toString("hex").padEnd(64, "0")}` as `0x${string}`;
      return {
        executionId: params.executionId,
        rail: "x402",
        success: true,
        actualSettledAmountUsdc: params.amountUsdc,
        externalReference: `pay_test_${params.executionId.slice(0, 8)}`,
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

    // Real Execution Path against live x402 endpoint
    if (endpointUrl && payerPk && rpcUrl) {
      try {
        // Step 1: Initial request to endpoint
        const initialRes = await fetch(endpointUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params.taskPayload?.body || { task: params.capability }),
        });

        // If free or sponsored endpoint returns 200 directly
        if (initialRes.status === 200) {
          const body = await initialRes.json().catch(() => ({}));
          return {
            executionId: params.executionId,
            rail: "x402",
            success: true,
            actualSettledAmountUsdc: 0,
            externalReference: `x402_free_${params.executionId.slice(0, 10)}`,
            evidenceType: "x402_settlement_success",
            rawResult: body,
          };
        }

        // Step 2: Handle HTTP 402 Payment Required
        if (initialRes.status === 402) {
          const challenge = await initialRes.json().catch(() => ({}));
          const requiredAmountUsdc = Number(challenge.amountUsdc || challenge.maxAmount || params.amountUsdc);
          const requiredRecipient = (challenge.recipient || params.counterpartyWallet) as `0x${string}`;

          // Validate bounds
          if (requiredAmountUsdc > params.amountUsdc) {
            return {
              executionId: params.executionId,
              rail: "x402",
              success: false,
              failureCode: `X402_AMOUNT_EXCEEDS_MANDATE: ${requiredAmountUsdc} > ${params.amountUsdc}`,
              actualSettledAmountUsdc: 0,
              evidenceType: "x402_execution_failure",
            };
          }

          if (requiredRecipient.toLowerCase() !== params.counterpartyWallet.toLowerCase()) {
            return {
              executionId: params.executionId,
              rail: "x402",
              success: false,
              failureCode: `X402_RECIPIENT_MISMATCH: ${requiredRecipient} !== ${params.counterpartyWallet}`,
              actualSettledAmountUsdc: 0,
              evidenceType: "x402_execution_failure",
            };
          }

          // Step 3: Dispatch Real Payment on Arc Testnet
          const publicClient = getArcPublicClient(rpcUrl);
          const payerAccount = privateKeyToAccount(payerPk);
          const walletClient = createWalletClient({
            account: payerAccount,
            chain: arcTestnet,
            transport: http(rpcUrl),
          });

          const amountAtomic = parseUnits(requiredAmountUsdc.toFixed(6), 6);
          const paymentTxHash = await walletClient.writeContract({
            address: usdcAddress,
            abi: ARC_USDC_ABI,
            functionName: "transfer",
            args: [requiredRecipient, amountAtomic],
          });

          const receipt = await publicClient.waitForTransactionReceipt({ hash: paymentTxHash });
          if (receipt.status !== "success") {
            return {
              executionId: params.executionId,
              rail: "x402",
              success: false,
              failureCode: "X402_PAYMENT_TX_REVERTED",
              actualSettledAmountUsdc: 0,
              evidenceType: "x402_execution_failure",
            };
          }

          // Step 4: Paid Retry with Proof Header
          const paidRes = await fetch(endpointUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `L402 ${paymentTxHash}:${payerAccount.address}`,
              "x-402-payment": paymentTxHash,
            },
            body: JSON.stringify(params.taskPayload?.body || { task: params.capability }),
          });

          if (!paidRes.ok) {
            return {
              executionId: params.executionId,
              rail: "x402",
              success: false,
              failureCode: `X402_PAID_RETRY_FAILED_HTTP_${paidRes.status}`,
              actualSettledAmountUsdc: requiredAmountUsdc,
              paymentTx: paymentTxHash,
              evidenceType: "x402_execution_failure",
            };
          }

          const responseData = await paidRes.json().catch(() => ({}));

          return {
            executionId: params.executionId,
            rail: "x402",
            success: true,
            actualSettledAmountUsdc: requiredAmountUsdc,
            externalReference: paymentTxHash,
            paymentTx: paymentTxHash,
            evidenceType: "x402_settlement_success",
            rawResult: responseData,
          };
        }

        return {
          executionId: params.executionId,
          rail: "x402",
          success: false,
          failureCode: `X402_UNEXPECTED_STATUS_${initialRes.status}`,
          actualSettledAmountUsdc: 0,
          evidenceType: "x402_execution_failure",
        };
      } catch (err: any) {
        return {
          executionId: params.executionId,
          rail: "x402",
          success: false,
          failureCode: `X402_EXECUTION_ERROR: ${err.message}`,
          actualSettledAmountUsdc: 0,
          evidenceType: "x402_execution_failure",
        };
      }
    }

    // Fail closed in production when endpoint or payment keys are unavailable
    return {
      executionId: params.executionId,
      rail: "x402",
      success: false,
      failureCode: "X402_ENDPOINT_OR_PAYER_UNAVAILABLE",
      actualSettledAmountUsdc: 0,
      evidenceType: "x402_execution_failure",
    };
  }
}
