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
import { getAddress, isAddress, parseUnits, createPublicClient, http, keccak256, stringToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { getArcPublicClient } from "../../erc8183/client.ts";
import { fetchWithSsrfProtection } from "../../seller/ssrf.ts";
import { CIRCLE_BATCHING_DOMAIN_NAME } from "../../x402/browser-payment.ts";

/* The x402 SDK spells the payment header one way in v2 and another in v1, and
   the SSRF transport drops anything it does not recognise -- silently, which
   would turn a paid call into an unpaid one. Both spellings are named so that
   neither can go missing without the endpoint saying so. */
const X402_PAYMENT_HEADERS = ["payment-signature", "x-payment"];
import { classifyRelayFailure } from "../relay-failure.ts";
import { readAuthorizationUsed } from "../settlement-resolver.ts";
import type { SettlementProof } from "../settlement-proof.ts";
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

    /* Whose money, and whose URL.
     *
     * This path spends a key the server holds, not the wallet named in the
     * mandate, which makes it a canary executor rather than a user's agent. It
     * took its endpoint from params.taskPayload.endpointUrl -- and the execute
     * route passes the whole request body as taskPayload -- so an authenticated
     * caller named the address and Veyra's key paid for whatever answered. The
     * audit reached a loopback URL through it.
     *
     * Two rules now. The payer key is off unless somebody deliberately turned
     * the canary on, and the trust attester is never it: that key signs
     * attestations about counterparties, and a key that both vouches and spends
     * makes a compromise of either a compromise of both. The endpoint comes
     * from the server's own configuration, because the money does.
     */
    const serverPayerEnabled = process.env.EXECUTION_ALLOW_SERVER_PAYER === "true";
    const payerPk = serverPayerEnabled
      ? (process.env.CANARY_DEPLOYER_PRIVATE_KEY as `0x${string}` | undefined)
      : undefined;
    const endpointUrl = process.env.LIVE_X402_TARGET_URL;
    const rpcUrl = process.env.ARC_TESTNET_RPC_URL;

    const callerEndpoint = typeof params.taskPayload?.endpointUrl === "string"
      ? params.taskPayload.endpointUrl.trim()
      : null;
    if (callerEndpoint && callerEndpoint !== endpointUrl) {
      /* Refused rather than ignored. A caller that asked for one address and
         silently got another would read the result as being about the address
         it named. */
      return {
        executionId: params.executionId,
        rail: "x402",
        success: false,
        failureCode: "X402_ENDPOINT_NOT_SERVER_CONFIGURED",
        economicCommitted: false,
        economicSettled: false,
        actualSettledAmountUsdc: 0,
        serviceSucceeded: false,
        evidenceType: "x402_execution_failure",
      };
    }

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
      /* Set the moment the signed authorization leaves this process, and read
         only by the catch below. Everything before the paid request is
         recoverable; after it, whether money moved is the seller's and the
         chain's business, not this function's. */
      let dispatchedContext: NormalizedRailResult["x402Context"] | null = null;
      try {
        const payerAccount = privateKeyToAccount(payerPk);
        const publicClient = createPublicClient({ chain: arcTestnet, transport: http(rpcUrl) });
        const evmSigner = toClientEvmSigner(payerAccount, publicClient);

        const client = new x402Client()
          .register("eip155:5042002", new ExactEvmScheme(evmSigner));
        const httpClient = new x402HTTPClient(client);

        // Step 1: Initial request to endpoint
        const initialRes = await fetchWithSsrfProtection(endpointUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params.taskPayload?.body || { task: params.capability }),
        }, { allowedHeaders: X402_PAYMENT_HEADERS });

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

          const requiredAmountRaw = (selectedOption.maxAmountRequired ?? selectedOption.amount ?? "0").toString();
          const authPayload = (paymentPayload as any)?.payload?.authorization;
          const authSignature = (paymentPayload as any)?.payload?.signature;

          /* Which rail this accept actually is. The EIP-712 domain name is the
             only thing that says so: Circle's batched scheme separates by
             GatewayWalletBatched at the GatewayWallet, a vanilla accept by the
             token's own name at the token. Recorded on the attempt, because
             reconciliation asks the token about the nonce and the token has
             never heard of a batched one. */
          const acceptExtra = (selectedOption as any)?.extra as Record<string, unknown> | undefined;
          const gatewayBatched = String(acceptExtra?.name ?? "") === CIRCLE_BATCHING_DOMAIN_NAME;
          const verifyingContract = typeof acceptExtra?.verifyingContract === "string"
            ? acceptExtra.verifyingContract
            : null;

          const x402Context = {
            payerWallet: payerAccount.address,
            payTo: requiredRecipient as `0x${string}`,
            asset: (requiredAsset || ARC_USDC) as `0x${string}`,
            network: selectedOption.network,
            authorizedAmountUsdc: requiredAmountUsdc,
            authorizedAmountAtomic: requiredAmountRaw,
            authorizationNonce: authPayload?.nonce || null,
            authorizationSignature: authSignature || null,
            authorizationValidBefore: authPayload?.validBefore ? Number(authPayload.validBefore) : null,
            authorizationVerifyingContract: verifyingContract,
            gatewayBatched,
            resource: endpointUrl,
            paymentRequirementsHash: paymentRequiredHeader ? keccak256(stringToBytes(paymentRequiredHeader)) : null,
            facilitatorReference: null,
            requestTimestamp: new Date().toISOString(),
          };

          // Step 4: Retry with standard x402 V2 payment-signature header
          dispatchedContext = x402Context;
          const paidRes = await fetchWithSsrfProtection(endpointUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...signatureHeader,
            },
            body: JSON.stringify(params.taskPayload?.body || { task: params.capability }),
          }, { allowedHeaders: X402_PAYMENT_HEADERS });

          // Check payment-response header
          const paymentResponseHeader =
            paidRes.headers.get("payment-response") ||
            paidRes.headers.get("PAYMENT-RESPONSE");

          const responseData = await paidRes.json().catch(() => ({}));

          if (!paymentResponseHeader) {
            // Payment authorization was sent (HTTP 200) but settlement cannot be independently verified yet
            return {
              executionId: params.executionId,
              rail: "x402",
              success: false,
              economicCommitted: true,
              economicSettled: false,
              actualSettledAmountUsdc: 0,
              serviceSucceeded: true,
              failureCode: "PAYMENT_SETTLEMENT_UNVERIFIED",
              paymentTx: undefined, // NO SYNTHETIC HASH
              evidenceType: "x402_settlement_unverified",
              x402Context,
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

          /* The receipt is the seller's own account of itself. A hash inside it
             is a string in a header that seller wrote, and Veyra used to treat
             it as proof of settlement -- then compute reputation about the
             seller from it.

             One read of the token's authorization bit settles the question. It
             needs no cooperation from the endpoint, costs an eth_call, and is
             the difference between evidence about a counterparty and evidence
             from one. When it cannot be read, the claim stays a claim. */
          const authorizationSpent = paymentTxHash
            ? await readAuthorizationUsed({
                network: selectedOption.network,
                asset: x402Context.asset,
                payer: x402Context.payerWallet,
                nonce: x402Context.authorizationNonce ?? "",
                gatewayBatched,
              })
            : null;
          const settlementProof: SettlementProof = authorizationSpent === true
            ? "onchain_final"
            : "seller_reported";

          if (!paymentTxHash) {
            return {
              executionId: params.executionId,
              rail: "x402",
              success: false,
              economicCommitted: true,
              economicSettled: false,
              actualSettledAmountUsdc: 0,
              serviceSucceeded: true,
              failureCode: "PAYMENT_SETTLEMENT_UNVERIFIED",
              paymentTx: undefined,
              evidenceType: "x402_settlement_unverified",
              x402Context,
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
              settlementProof,
              x402Context,
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
            settlementProof,
            x402Context,
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
        /* Thrown after the authorization was sent. The executor reads
           economicCommitted: false as "release the reservation, nothing moved",
           and that was being said about a signed nonce already in a seller's
           hands. PAYMENT_SETTLEMENT_UNVERIFIED keeps the budget held and sends
           the attempt to reconciliation, which asks the token itself.

           A failure that is positively known to have happened before any byte
           reached the peer keeps the old, cheaper answer. */
        if (dispatchedContext && classifyRelayFailure(err) === "possibly_dispatched") {
          return {
            executionId: params.executionId,
            rail: "x402",
            success: false,
            failureCode: "PAYMENT_SETTLEMENT_UNVERIFIED",
            economicCommitted: true,
            economicSettled: false,
            actualSettledAmountUsdc: 0,
            serviceSucceeded: false,
            evidenceType: "x402_settlement_unverified",
            x402Context: dispatchedContext,
            rawResult: { error: String(err?.message ?? err).slice(0, 300) },
          };
        }
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
