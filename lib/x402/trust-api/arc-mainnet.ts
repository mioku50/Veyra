/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import { ARC_MAINNET_NETWORK } from "../../wallet/arc.ts";
import { TRUST_API_PRICING } from "./pricing.ts";

/**
 * Veyra's Trust API on Arc mainnet.
 *
 * On 26 September the owner chose what Veyra sells here:
 * - two products, `history` and `select`, at their testnet prices;
 * - paid only on Arc, through Circle's mainnet Gateway;
 * - paid to Veyra's own Circle wallet, the same one that registers its
 *   ERC-8004 identity.
 *
 * These are their own routes, not the testnet ones with Arc added:
 * - **Credits.** The testnet routes take credits, and a credit is earned with
 *   a clearance paid in faucet USDC. A credit spent here would buy mainnet
 *   work with testnet money.
 * - **No clearance.** `select` here signs none. The TrustGate that verifies a
 *   clearance exists on Arc Testnet only, until audited contracts reach
 *   mainnet.
 *
 * Nothing is sold until `VEYRA_ARC_PAY_TO` names the payout wallet. It is in
 * the code, not the environment: every 402 challenge publishes it anyway, and
 * changing where Veyra is paid should take a reviewed commit.
 */

export const ARC_MAINNET_GATEWAY_URL = "https://gateway-api.circle.com";
export { ARC_MAINNET_NETWORK };

/** Veyra's Circle wallet on Arc, which the owner chose to be paid to. The
 *  owner created it on 27 September with the identity script's wallet step:
 *  a developer-controlled EOA, the registrant of Veyra's ERC-8004 identity. */
export const VEYRA_ARC_PAY_TO: `0x${string}` | null = "0x8F8E0C9Fa2F67AED5b16e04f2716022aeB200eD6";

/** The OpenAPI document for these routes, which Circle's marketplace asks for. */
export const ARC_OPENAPI_PATH = "/openapi/veyra-arc-trust-api.json";

const SELECT_INPUT = TRUST_API_PRICING.select.schema.input;

export const ARC_TRUST_API = {
  history: {
    path: "/api/x402/v1/arc/history",
    priceUsdc: TRUST_API_PRICING.history.priceUsdc,
    description: TRUST_API_PRICING.history.description,
    schema: TRUST_API_PRICING.history.schema,
  },
  select: {
    path: "/api/x402/v1/arc/select",
    priceUsdc: TRUST_API_PRICING.select.priceUsdc,
    description: "Discover, probe and rank counterparties for a capability. On Arc mainnet, no clearance is signed.",
    schema: {
      input: {
        type: "object",
        properties: {
          capability: SELECT_INPUT.properties.capability,
          budgetUsdc: SELECT_INPUT.properties.budgetUsdc,
          maxPriceUsdc: SELECT_INPUT.properties.maxPriceUsdc,
          network: {
            type: "string",
            description: `Where the counterparty is paid. Defaults to Arc mainnet (${ARC_MAINNET_NETWORK}).`,
          },
        },
        required: SELECT_INPUT.required,
      },
      output: TRUST_API_PRICING.select.schema.output,
    },
  },
} as const;

export type ArcTrustApiProduct = keyof typeof ARC_TRUST_API;
