/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import { VEYRA_ORIGIN } from "../../erc8004/veyra-registration.ts";
import { BRAND } from "../../brand.ts";
import { ARC_MAINNET_NETWORK, ARC_TRUST_API, type ArcTrustApiProduct } from "./arc-mainnet.ts";

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
        "A request that cannot be served is refused before any payment is taken.",
        "What Veyra says about a seller is its own claim, not independent truth.",
      ].join(" "),
    },
    servers: [{ url: VEYRA_ORIGIN }],
    paths: Object.fromEntries(products.map((product) => {
      const entry = ARC_TRUST_API[product];
      return [entry.path, {
        post: {
          operationId: `arc_${product}`,
          summary: entry.description,
          requestBody: {
            required: true,
            content: { "application/json": { schema: entry.schema.input } },
          },
          responses: {
            200: {
              description: "The answer, after the payment settled.",
              content: { "application/json": { schema: entry.schema.output } },
            },
            400: { description: "The request was refused. No payment was taken." },
            402: {
              description: `Payment required: ${entry.priceUsdc} USDC on Arc mainnet through Circle Gateway. The terms are in the PAYMENT-REQUIRED header.`,
            },
            503: { description: `${BRAND.name} cannot take payment or answer right now. Nothing was charged.` },
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
