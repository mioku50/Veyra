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
 */
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
  },
  history: {
    path: "/api/x402/v1/history",
    priceUsdc: 0.005,
    description: "Everything Veyra has observed of an endpoint: latency and price distributions, payee changes, uptime.",
  },
  select: {
    path: "/api/x402/v1/select",
    priceUsdc: 0.02,
    description: "Discover, probe and rank counterparties for a capability, and clear the winner.",
  },
  outcomes: {
    path: "/api/x402/v1/outcomes",
    priceUsdc: 0,
    description: "Report what happened after a clearance. Earns a credit that pays for one clearance.",
  },
} as const;

export type TrustApiProduct = keyof typeof TRUST_API_PRICING;
