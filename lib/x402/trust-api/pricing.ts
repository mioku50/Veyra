/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What Veyra sells to other agents, and what it gives away.
 *
 * The verdict is free on purpose. Anyone can probe an endpoint once; an opinion
 * about it is not scarce, and charging for it would only slow down the thing
 * that makes the whole network safer. What is scarce is the signature: an
 * EIP-712 clearance that `VeyraTrustGate.consumeClearance` accepts onchain can
 * only be issued by the attester Veyra controls. That is the product.
 *
 * Reporting an outcome is free and earns a credit, because an endpoint Veyra
 * has watched ten times is worth more than one it has met once — and the only
 * way to learn what happened after a payment is from the agent that made it.
 *
 * Each paid endpoint publishes its own request and response schema here, and
 * the seller puts them in the 402 challenge. Veyra penalises endpoints that do
 * not (`declares_input_schema`, `declares_output_schema`) and it was failing
 * both of its own checks: 75/100 against its own probe. An auditor that cannot
 * pass its own audit is not evidence of anything.
 */

/** Veyra's own machine-readable index of what it sells. */
export const TRUST_API_DOCS_PATH = "/api/x402/v1/catalog";

/** A verdict request, which every paid endpoint but `select` takes. */
const RESOURCE_QUERY = {
  type: "object",
  properties: {
    resource: { type: "string", description: "The x402 resource URL to assess." },
    method: { type: "string", enum: ["GET", "POST"], description: "HTTP method the resource is called with. Defaults to POST." },
  },
  required: ["resource"],
} as const;

/** Everything a verdict answers with, whichever endpoint returned it. */
const VERDICT_RESPONSE = {
  type: "object",
  properties: {
    resource: { type: "string" },
    decision: { type: "string", description: "ALLOW, REQUIRE_EVALUATOR, REVIEW_REQUIRED or BLOCK." },
    granted: { type: "boolean" },
    priceUsdc: { type: "number" },
    maxExposureUsdc: { type: "number" },
    evidenceHash: { type: "string" },
    issuedAt: { type: "string" },
    expiresAt: { type: "string" },
  },
  // Only what every answer carries, including a refusal. Declaring more would
  // make Veyra's own post-call check fail its own honest responses.
  required: ["resource", "decision", "granted", "issuedAt"],
} as const;
export const TRUST_API_PRICING = {
  verdict: {
    path: "/api/x402/v1/verdict",
    priceUsdc: 0,
    description: "Pay or do not pay: one verdict on one x402 endpoint, with the evidence behind it.",
  },
  clearance: {
    path: "/api/x402/v1/clearance",
    priceUsdc: 0.01,
    description: "The same verdict, plus an EIP-712 clearance signed by Veyra's attester and verified on Arc.",
    schema: {
      input: {
        type: "object",
        properties: {
          ...RESOURCE_QUERY.properties,
          capability: { type: "string", description: "Capability the counterparty is being cleared for." },
          budgetUsdc: { type: "number", description: "Ceiling the clearance may authorize. Defaults to 1." },
          requesterWallet: { type: "string", description: "Wallet the clearance authorizes. Defaults to the paying wallet." },
        },
        required: ["resource"],
      },
      output: {
        type: "object",
        properties: {
          ...VERDICT_RESPONSE.properties,
          signed: { type: "boolean", description: "False when Veyra refuses to sign; the reasons are in the verdict." },
          clearance: { type: ["object", "null"], description: "The EIP-712 clearance, when one was signed." },
        },
        required: [...VERDICT_RESPONSE.required, "signed"],
      },
    },
  },
  history: {
    path: "/api/x402/v1/history",
    priceUsdc: 0.005,
    description: "Everything Veyra has observed of an endpoint: latency and price distributions, payee changes, uptime.",
    schema: {
      input: RESOURCE_QUERY,
      output: {
        type: "object",
        properties: {
          resource: { type: "string" },
          resourceKey: { type: "string" },
          method: { type: "string" },
          observations: { type: "number", description: "How many times Veyra has measured this endpoint." },
          firstObservedAt: { type: ["string", "null"] },
          lastObservedAt: { type: ["string", "null"] },
          statisticalEvidenceAvailable: { type: "boolean", description: "False below ten observations, where the quality engine refuses to score." },
          availability: { type: "object" },
          latencyMs: { type: "object" },
        },
        required: ["resource", "resourceKey", "observations", "statisticalEvidenceAvailable"],
      },
    },
  },
  select: {
    path: "/api/x402/v1/select",
    priceUsdc: 0.02,
    description: "Discover, probe and rank counterparties for a capability, and clear the winner.",
    schema: {
      input: {
        type: "object",
        properties: {
          capability: { type: "string", description: "What the agent needs done, e.g. web_research." },
          budgetUsdc: { type: "number", description: "Ceiling for the purchase this selection leads to." },
          maxPriceUsdc: { type: "number", description: "Refuse candidates above this price." },
          requesterWallet: { type: "string", description: "Wallet the clearance authorizes. Defaults to the paying wallet." },
        },
        required: ["capability", "budgetUsdc"],
      },
      /* The answer as the route sends it. This used to describe a flat
         `selectionId`, `candidates` and `winner` that no answer ever had; the
         owner's first paid call on Arc, on 27 September, failed it. */
      output: {
        type: "object",
        properties: {
          selection: {
            type: "object",
            properties: {
              selectionId: { type: "string" },
              network: { type: "string", description: "Where the sellers are paid, as CAIP-2." },
              candidates: { type: "array", description: "Every seller probed, ranked, with its trust decision and evidence." },
              recommendation: {
                type: "object",
                description: "The seller to buy from, or why there is none.",
                properties: {
                  granted: { type: "boolean", description: "True only when a clearance was signed." },
                  reason: { type: "string" },
                  candidateId: { type: ["string", "null"] },
                  resource: { type: ["string", "null"] },
                  payTo: { type: ["string", "null"] },
                  priceUsdc: { type: ["number", "null"] },
                  decision: { type: ["string", "null"], description: "The recommended seller's trust decision, such as ALLOW_WITH_LIMITS." },
                  maxExposureUsdc: { type: "number" },
                },
                required: ["granted", "reason", "candidateId", "decision", "maxExposureUsdc"],
              },
              clearance: { type: ["object", "null"], description: "The signed EIP-712 clearance, or null when none was signed." },
              expiresAt: { type: "string" },
            },
            required: ["selectionId", "network", "candidates", "recommendation", "clearance", "expiresAt"],
          },
          note: { type: "string", description: "Why no clearance was signed, when none was." },
        },
        required: ["selection"],
      },
    },
  },
  outcomes: {
    path: "/api/x402/v1/outcomes",
    priceUsdc: 0,
    description: "Report what happened after a clearance. Earns a credit that pays for one clearance.",
  },
} as const;

export type TrustApiProduct = keyof typeof TRUST_API_PRICING;
