/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import { VEYRA_ORIGIN } from "../../erc8004/veyra-registration.ts";
import { BRAND } from "../../brand.ts";
import { ARC_MAINNET_NETWORK, ARC_TRUST_API, type ArcTrustApiProduct } from "./arc-mainnet.ts";

const requestIdHeader = {
  description: `${BRAND.name} request identifier for support and payment reconciliation.`,
  schema: { type: "string", format: "uuid" },
};

const paidResponseHeaders = {
  "X-Veyra-Request-Id": requestIdHeader,
  "X-Veyra-Paid-With": {
    description: "Present when Circle Gateway reported successful settlement.",
    schema: { type: "string", const: "usdc" },
  },
  "PAYMENT-RESPONSE": {
    description: "Base64-encoded x402 settlement response containing success, transaction, network and payer.",
    schema: { type: "string", contentEncoding: "base64" },
  },
};

const paymentsUnavailable = {
  description: `${BRAND.name} could not offer payment terms before settlement. No payment was taken.`,
  headers: { "X-Veyra-Request-Id": requestIdHeader },
  content: {
    "application/json": {
      example: { error: "payments_unavailable", message: `${BRAND.name} cannot currently accept payment for this resource. The free verdict endpoint is unaffected.` },
    },
  },
};

/**
 * The OpenAPI document for Veyra's Trust API on Arc mainnet.
 *
 * Built from the same definitions the routes and their 402 challenges use, so
 * it cannot describe a request the endpoint would refuse. Circle's Agent
 * Marketplace asks for one with every listing.
 */
export function arcTrustApiOpenApi() {
  const products = Object.keys(ARC_TRUST_API) as ArcTrustApiProduct[];
  return {
    openapi: "3.1.0",
    info: {
      title: `${BRAND.name} Trust API on Arc`,
      version: "1.0.0",
      description: [
        `${BRAND.name} checks x402 sellers before an agent pays them.`,
        `These routes are paid per call with x402 v2, in USDC on Arc mainnet (${ARC_MAINNET_NETWORK}), through Circle Gateway.`,
        "A request without payment is answered 402, with the price and payment terms in the PAYMENT-REQUIRED header.",
        "A GET is answered with the same 402 and is never charged: the answer takes a POST.",
        "Pay by sending the signed payment in the PAYMENT-SIGNATURE header.",
        "Request validation runs before settlement. The answer is generated after settlement and can still fail.",
        "The API has no idempotency key. If the outcome is uncertain, reconcile the original payment before sending a new authorization.",
        "What Veyra says about a seller is its own claim, not independent truth.",
      ].join(" "),
    },
    servers: [{ url: VEYRA_ORIGIN }],
    paths: Object.fromEntries(products.map((product) => {
      const entry = ARC_TRUST_API[product];
      const challengeResponse = {
        description: `Payment required. The PAYMENT-REQUIRED header quotes ${entry.priceUsdc} USDC on Arc mainnet through Circle Gateway.`,
        headers: {
          "X-Veyra-Request-Id": requestIdHeader,
          "PAYMENT-REQUIRED": {
            description: "Base64-encoded x402 v2 challenge with the resource and accepted payment terms.",
            schema: { type: "string", contentEncoding: "base64" },
          },
        },
      };
      return [entry.path, {
        get: {
          operationId: `arc_${product}_challenge`,
          summary: "Read the payment terms",
          responses: {
            402: challengeResponse,
            405: {
              description: "A GET carrying a payment signature is refused before settlement. Send payments with POST.",
              headers: {
                Allow: { schema: { type: "string", const: "POST" } },
                "X-Veyra-Request-Id": requestIdHeader,
              },
            },
            503: paymentsUnavailable,
          },
        },
        post: {
          operationId: `arc_${product}`,
          summary: entry.description,
          parameters: [{
            name: "PAYMENT-SIGNATURE",
            in: "header",
            description: "Base64-encoded signed x402 v2 payment. Omit to request payment terms.",
            schema: { type: "string", contentEncoding: "base64" },
          }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: entry.schema.input } },
          },
          responses: {
            200: {
              description: "The answer, after Circle Gateway accepted settlement.",
              headers: paidResponseHeaders,
              content: { "application/json": { schema: entry.schema.output } },
            },
            400: { description: "The payment header or request body failed validation before settlement." },
            402: {
              ...challengeResponse,
              description: `${challengeResponse.description} A rejected payment can also return 402 without a new challenge. Check the error code.`,
            },
            502: {
              description: "Payment processing failed with an uncertain outcome. Reconcile the original payment before sending a new authorization.",
              headers: { "X-Veyra-Request-Id": requestIdHeader },
            },
            503: {
              description: "Payment terms were unavailable before settlement, or the answer failed after settlement. Check the error body and payment headers before retrying.",
              headers: paidResponseHeaders,
              content: {
                "application/json": {
                  examples: {
                    beforeSettlement: {
                      summary: "Before settlement. No payment was taken.",
                      value: paymentsUnavailable.content["application/json"].example,
                    },
                    afterSettlement: {
                      summary: "After settlement. PAYMENT-RESPONSE and X-Veyra-Paid-With accompany this response.",
                      value: { error: { code: "unavailable", message: "The Trust API cannot answer right now." } },
                    },
                  },
                },
              },
            },
          },
          "x-payment-info": {
            protocol: "x402",
            x402Version: 2,
            network: ARC_MAINNET_NETWORK,
            asset: "USDC",
            priceUsdc: entry.priceUsdc,
            settledBy: "Circle Gateway",
          },
        },
      }];
    })),
  };
}
