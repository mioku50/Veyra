/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
} from "@x402/core/http";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";
import { getAddress, isAddress, parseUnits, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { getArcPublicClient } from "../../erc8183/client.ts";
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
        economicCommitted: false,
        economicSettled: false,
        actualSettledAmountUsdc: 0,
        serviceSucceeded: false,
        evidenceType: "x402_execution_failure",
      };
    }

    const endpointUrl = params.taskPayload?.endpointUrl || process.env.LIVE_X402_TARGET_URL;
    const payerPk = (process.env.CANARY_DEPLOYER_PRIVATE_KEY ||
      process.env.VEYRA_TRUST_ATTESTER_PRIVATE_KEY) as `0x${string}` | undefined;
    const rpcUrl = process.env.ARC_TESTNET_RPC_URL;

    // Controlled deterministic harness for explicit unit/negative test mode only
    if (isTestMode) {
      const mockPaymentTx = `0x${Buffer.from(`tx_x402_${params.executionId}`).toString("hex").padEnd(64, "0")}` as `0x${string}`;
      return {
        executionId: params.executionId,
        rail: "x402",
        success: true,
        economicCommitted: true,
        economicSettled: true,
        actualSettledAmountUsdc: params.amountUsdc,
        serviceSucceeded: true,
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

    // Real Execution Path against live x402 V2 endpoint
    if (endpointUrl && payerPk && rpcUrl) {
      try {
        const payerAccount = privateKeyToAccount(payerPk);
        const publicClient = createPublicClient({ chain: arcTestnet, transport: http(rpcUrl) });
        const evmSigner = toClientEvmSigner(payerAccount, publicClient);

        const client = new x402Client()
          .register("eip155:5042002", new ExactEvmScheme(evmSigner));
        const httpClient = new x402HTTPClient(client);

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
            economicCommitted: false,
            economicSettled: false,
            actualSettledAmountUsdc: 0,
            serviceSucceeded: true,
            externalReference: `x402_free_${params.executionId.slice(0, 10)}`,
            evidenceType: "x402_settlement_success",
            rawResult: body,
          };
        }

        // Step 2: Handle HTTP 402 Payment Required per x402 V2 specification
        if (initialRes.status === 402) {
          let paymentRequired: any = null;

          const paymentRequiredHeader =
            initialRes.headers.get("payment-required") ||
            initialRes.headers.get("PAYMENT-REQUIRED");

          if (paymentRequiredHeader) {
            try {
              paymentRequired = decodePaymentRequiredHeader(paymentRequiredHeader);
            } catch {
              paymentRequired = null;
            }
          }

          if (!paymentRequired) {
            const body = await initialRes.json().catch(() => ({}));
            paymentRequired = body.paymentRequired || body;
          }

          if (!paymentRequired || Object.keys(paymentRequired).length === 0) {
            return {
              executionId: params.executionId,
              rail: "x402",
              success: false,
              failureCode: "X402_INVALID_PAYMENT_REQUIRED_HEADER",
              economicCommitted: false,
              economicSettled: false,
              actualSettledAmountUsdc: 0,
              serviceSucceeded: false,
              evidenceType: "x402_execution_failure",
            };
          }

          // Select supported payment option from accepts[]
          const accepts = paymentRequired.accepts ?? [paymentRequired]; // backward compat
          const selectedOption = accepts.find(
            (opt: { scheme?: string; network?: string }) =>
              opt.scheme === "exact" && opt.network === "eip155:5042002"
          );
          
          if (!selectedOption) {
            return {
              executionId: params.executionId,
              rail: "x402",
              success: false,
              failureCode: "X402_NO_SUPPORTED_PAYMENT_OPTION",
              economicCommitted: false,
              economicSettled: false,
              actualSettledAmountUsdc: 0,
              serviceSucceeded: false,
              evidenceType: "x402_execution_failure",
            };
          }

          // Extract from selected option
          const requiredAmountUsdc = Number(selectedOption.maxAmountRequired ?? selectedOption.amount ?? 0) / 1_000_000;
          const requiredRecipient = selectedOption.payTo ?? selectedOption.recipient;
          const requiredAsset = selectedOption.asset;

          // Validate network
          if (selectedOption.network !== "eip155:5042002") {
            return {
              executionId: params.executionId,
              rail: "x402",
              success: false,
              failureCode: "X402_WRONG_NETWORK",
              economicCommitted: false,
              economicSettled: false,
              actualSettledAmountUsdc: 0,
              serviceSucceeded: false,
              evidenceType: "x402_execution_failure",
            };
          }

          // Validate recipient matches counterparty
          if (!requiredRecipient || requiredRecipient.toLowerCase() !== params.counterpartyWallet.toLowerCase()) {
            return {
              executionId: params.executionId,
              rail: "x402",
              success: false,
              failureCode: "X402_RECIPIENT_MISMATCH",
              economicCommitted: false,
              economicSettled: false,
              actualSettledAmountUsdc: 0,
              serviceSucceeded: false,
              evidenceType: "x402_execution_failure",
            };
          }

          // Validate asset is USDC
          const ARC_USDC = "0x3600000000000000000000000000000000000000";
          if (requiredAsset && requiredAsset.toLowerCase() !== ARC_USDC.toLowerCase()) {
            return {
              executionId: params.executionId,
              rail: "x402",
              success: false,
              failureCode: "X402_WRONG_ASSET",
              economicCommitted: false,
              economicSettled: false,
              actualSettledAmountUsdc: 0,
              serviceSucceeded: false,
              evidenceType: "x402_execution_failure",
            };
          }

          // Validate amount within budget bounds
          if (requiredAmountUsdc > params.amountUsdc) {
            return {
              executionId: params.executionId,
              rail: "x402",
              success: false,
              failureCode: "X402_AMOUNT_EXCEEDS_MANDATE",
              economicCommitted: false,
              economicSettled: false,
              actualSettledAmountUsdc: 0,
              serviceSucceeded: false,
              evidenceType: "x402_execution_failure",
            };
          }

          // Step 3: Construct signed x402 V2 payment payload using SDK
          const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
          const signatureHeader = httpClient.encodePaymentSignatureHeader(paymentPayload);

          // Step 4: Retry with standard x402 V2 payment-signature header
          const paidRes = await fetch(endpointUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...signatureHeader,
            },
            body: JSON.stringify(params.taskPayload?.body || { task: params.capability }),
          });

          // Check payment-response header
          const paymentResponseHeader =
            paidRes.headers.get("payment-response") ||
            paidRes.headers.get("PAYMENT-RESPONSE");

          const responseData = await paidRes.json().catch(() => ({}));

          if (!paymentResponseHeader) {
            // Payment succeeded (HTTP 200) but settlement cannot be independently verified
            return {
              executionId: params.executionId,
              rail: "x402",
              success: true,
              economicCommitted: true,
              economicSettled: false,  // Cannot verify without PAYMENT-RESPONSE
              actualSettledAmountUsdc: requiredAmountUsdc,
              serviceSucceeded: true,
              failureCode: "PAYMENT_SETTLEMENT_UNVERIFIED",
              paymentTx: undefined,  // NO SYNTHETIC HASH
              evidenceType: "x402_execution_failure",
              rawResult: responseData,
            };
          }

          let settleResponse: any = null;
          try {
            settleResponse = decodePaymentResponseHeader(paymentResponseHeader);
          } catch {
            settleResponse = null;
          }

          const paymentTxHash = settleResponse?.transaction ?? settleResponse?.txHash;

          if (!paymentTxHash) {
            return {
              executionId: params.executionId,
              rail: "x402",
              success: true,
              economicCommitted: true,
              economicSettled: false,
              actualSettledAmountUsdc: requiredAmountUsdc,
              serviceSucceeded: true,
              failureCode: "PAYMENT_SETTLEMENT_UNVERIFIED",
              paymentTx: undefined,
              evidenceType: "x402_execution_failure",
              rawResult: responseData,
            };
          }

          if (!paidRes.ok) {
            // Money was committed/settled by the resource server, but service delivery failed
            return {
              executionId: params.executionId,
              rail: "x402",
              success: false,
              failureCode: "X402_SERVICE_DELIVERY_FAILED",
              economicCommitted: true,
              economicSettled: true,
              actualSettledAmountUsdc: requiredAmountUsdc,
              serviceSucceeded: false,
              paymentTx: paymentTxHash,
              evidenceType: "x402_execution_failure",
              rawResult: { status: paidRes.status },
            };
          }

          return {
            executionId: params.executionId,
            rail: "x402",
            success: true,
            economicCommitted: true,
            economicSettled: true,
            actualSettledAmountUsdc: requiredAmountUsdc,
            serviceSucceeded: true,
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
          economicCommitted: false,
          economicSettled: false,
          actualSettledAmountUsdc: 0,
          serviceSucceeded: false,
          evidenceType: "x402_execution_failure",
        };
      } catch (err: any) {
        return {
          executionId: params.executionId,
          rail: "x402",
          success: false,
          failureCode: `X402_EXECUTION_ERROR: ${err.message}`,
          economicCommitted: false,
          economicSettled: false,
          actualSettledAmountUsdc: 0,
          serviceSucceeded: false,
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
      economicCommitted: false,
      economicSettled: false,
      actualSettledAmountUsdc: 0,
      serviceSucceeded: false,
      evidenceType: "x402_execution_failure",
    };
  }
}
