/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { buildTrustApiRequirements } from "./seller.ts";
import { TRUST_API_PRICING, type TrustApiProduct } from "./pricing.ts";
import { CREDIT_HEADER } from "./credits.ts";

/**
 * Veyra published in the same shape as the catalog it polices.
 *
 * This is the strongest claim the product can make: the trust layer is itself
 * an x402 resource, discoverable and payable by exactly the machinery it spends
 * its time verifying. An agent can probe Veyra the way Veyra probes everyone
 * else, and should — the items below carry a published output schema precisely
 * so that the response can be held to it.
 */

const CAPABILITIES: Record<TrustApiProduct, string[]> = {
  verdict: ["trust_verification", "counterparty_risk", "x402_verification"],
  clearance: ["trust_attestation", "signed_clearance", "erc8004_reputation"],
  history: ["endpoint_reliability", "historical_observations", "api_quality"],
  select: ["counterparty_selection", "service_discovery", "trust_verification"],
  outcomes: ["outcome_reporting", "reputation_feedback"],
};

const OUTPUT_SCHEMAS: Partial<Record<TrustApiProduct, Record<string, unknown>>> = {
  verdict: {
    type: "object",
    properties: {
      decision: { type: "string" },
      granted: { type: "boolean" },
      payTo: { type: "string" },
      priceUsdc: { type: "number" },
      maxExposureUsdc: { type: "number" },
      alerts: { type: "array" },
      explanation: { type: "string" },
    },
    required: ["decision", "granted", "explanation"],
  },
  clearance: {
    type: "object",
    properties: {
      signed: { type: "boolean" },
      decision: { type: "string" },
      clearance: { type: "object" },
    },
    required: ["signed", "decision"],
  },
};

export async function buildTrustApiCatalog(origin: string, lastUpdated = new Date().toISOString()) {
  const items = await Promise.all(
    (Object.keys(TRUST_API_PRICING) as TrustApiProduct[]).map(async (product) => {
      const entry = TRUST_API_PRICING[product];
      const accepts = entry.priceUsdc > 0
        ? await buildTrustApiRequirements(entry.priceUsdc).catch(() => [])
        : [];
      return {
        resource: new URL(entry.path, origin).toString(),
        type: "http" as const,
        x402Version: 2,
        lastUpdated,
        accepts,
        metadata: {
          method: "POST",
          path: entry.path,
          description: entry.description,
          mimeType: "application/json",
          priceUsdc: entry.priceUsdc,
          free: entry.priceUsdc === 0,
          siwx: false,
          supportsVanillax402: false,
          supportsCircleGateway: true,
          output: OUTPUT_SCHEMAS[product] ?? undefined,
          provider: {
            name: "Veyra",
            website: origin,
            docsUrl: new URL("/console/agent-api", origin).toString(),
            description: "Independent trust and policy layer between an agent's intent and its USDC spend.",
            category: "trust",
            tags: CAPABILITIES[product],
          },
        },
      };
    }),
  );

  return {
    x402Version: 2,
    provider: "Veyra",
    description: "Verify before your agent pays.",
    // Said where a buying agent will read it, not only in the docs.
    economics: {
      free: [TRUST_API_PRICING.verdict.path, TRUST_API_PRICING.outcomes.path],
      creditHeader: CREDIT_HEADER,
      creditPolicy: "Report the outcome of a clearance you bought and receive a credit that pays for the next one.",
    },
    items,
    total: items.length,
  };
}
