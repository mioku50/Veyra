/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import { decodeEventLog, parseAbi, zeroAddress, type Hex } from "viem";
import { BRAND } from "../brand.ts";
import { ARC_IDENTITY_REGISTRY } from "../discovery/erc8004-arc.ts";
import { ARC_OPENAPI_PATH, ARC_TRUST_API, VEYRA_ARC_PAY_TO } from "../x402/trust-api/arc-mainnet.ts";

/**
 * Veyra's own identity on Arc mainnet, under ERC-8004.
 *
 * The identity is a token in Arc's canonical IdentityRegistry. A registrant
 * wallet of Veyra's own holds it: a developer-controlled Circle wallet, which
 * is neither the owner's wallet nor an attester key. The token points at the
 * file below, and the file names the token back, so either can be checked
 * against the other.
 *
 * The file says what Veyra does on Arc mainnet today and nothing more. What
 * Veyra records about a seller is Veyra's claim. Until Veyra has a wallet to
 * be paid to on Arc, it sells nothing there, and the file says so.
 */

export const VEYRA_ORIGIN = "https://agent-commerce-six.vercel.app";
/** The agentURI written on chain. It does not change; the file behind it does. */
export const VEYRA_AGENT_URI = `${VEYRA_ORIGIN}/.well-known/agent-registration.json`;
export const VEYRA_AGENT_REGISTRY = `eip155:5042:${ARC_IDENTITY_REGISTRY}`;
/** How the script finds the registrant wallet again among the owner's Circle wallets. */
export const VEYRA_REGISTRANT_REF = "veyra-erc8004-registrant";

/** Veyra's agentId on Arc mainnet, as the registry minted it to the
 *  registrant on 27 September, in transaction 0xd770ed6a…05b4. Before the
 *  mint it was null, and the file listed no registration. */
export const VEYRA_ARC_AGENT_ID: number | null = 298;

export function veyraRegistrationFile(
  agentId: number | null = VEYRA_ARC_AGENT_ID,
  payTo: string | null = VEYRA_ARC_PAY_TO,
) {
  const selling = payTo !== null;
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: BRAND.name,
    description: [
      `${BRAND.name} is a trust and policy layer between an AI agent's intent and a USDC payment.`,
      "Before a paid call it checks the seller, including whether the seller's ERC-8004 identity declares the endpoint being paid.",
      "It prices the exact request, then decides whether to pay, whom, and how much.",
      "The person who owns the agent approves and signs every payment. Veyra spends nothing on its own.",
      "What Veyra records about a seller is Veyra's own claim, not independent truth.",
      selling
        ? `On Arc mainnet it sells two answers, paid in USDC through Circle Gateway: what it has observed of an endpoint (${ARC_TRUST_API.history.priceUsdc} USDC) and a ranked choice of sellers for a task (${ARC_TRUST_API.select.priceUsdc} USDC). It signs no clearance there: its TrustGate is on Arc Testnet only.`
        : `${BRAND.name} sells no paid service on Arc mainnet yet. Its paid Trust API runs on testnets only.`,
    ].join(" "),
    image: `${VEYRA_ORIGIN}/icon.svg`,
    services: [
      { name: "web", endpoint: `${VEYRA_ORIGIN}/` },
      ...(selling
        ? [
          { name: "x402", endpoint: `${VEYRA_ORIGIN}/.well-known/x402` },
          { name: "OpenAPI", endpoint: `${VEYRA_ORIGIN}${ARC_OPENAPI_PATH}` },
        ]
        : []),
    ],
    x402Support: selling,
    active: true,
    registrations: agentId === null ? [] : [{ agentId, agentRegistry: VEYRA_AGENT_REGISTRY }],
    supportedTrust: ["reputation"],
  };
}

export type VeyraRegistrationFile = ReturnType<typeof veyraRegistrationFile>;

/**
 * The owner's Circle credentials, checked but never shown. Arc mainnet wallets
 * need a mainnet (LIVE) key, and a testnet key would fail only at the first
 * call, with a less useful error.
 */
export function circleCredentials(env: Record<string, string | undefined>):
  | { ok: true; apiKey: string; entitySecret: string }
  | { ok: false; problems: string[] } {
  const apiKey = env.CIRCLE_API_KEY?.trim() ?? "";
  const entitySecret = env.CIRCLE_ENTITY_SECRET?.trim() ?? "";
  const problems: string[] = [];
  if (!apiKey) problems.push("CIRCLE_API_KEY is not set.");
  else if (!apiKey.startsWith("LIVE_API_KEY:")) problems.push("CIRCLE_API_KEY is not a mainnet key (LIVE_API_KEY:…). Arc mainnet wallets need one.");
  if (!entitySecret) problems.push("CIRCLE_ENTITY_SECRET is not set. Create it with: npm run veyra-identity -- entity-secret");
  else if (/^(LIVE|TEST)_CLIENT_KEY:/.test(entitySecret)) problems.push("CIRCLE_ENTITY_SECRET holds a client key (…_CLIENT_KEY:…), not the entity secret. Remove that line, then create the secret with: npm run veyra-identity -- entity-secret");
  else if (/^(LIVE|TEST)_API_KEY:/.test(entitySecret)) problems.push("CIRCLE_ENTITY_SECRET holds an API key, not the entity secret. Remove that line, then create the secret with: npm run veyra-identity -- entity-secret");
  else if (/^0x[0-9a-f]{64}$/i.test(entitySecret)) problems.push("CIRCLE_ENTITY_SECRET starts with 0x. Write the 64 hex characters without it.");
  else if (!/^[0-9a-f]{64}$/i.test(entitySecret)) problems.push("CIRCLE_ENTITY_SECRET is not 32 bytes of hex (64 characters, 0-9 and a-f).");
  return problems.length > 0 ? { ok: false, problems } : { ok: true, apiKey, entitySecret };
}

const TRANSFER = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"]);

/** The agentId a registration minted to `owner`, read from its receipt's logs. */
export function mintedAgentId(logs: ReadonlyArray<{ address: string; topics: readonly Hex[]; data: Hex }>, owner: string): number | null {
  for (const log of logs) {
    if (log.address.toLowerCase() !== ARC_IDENTITY_REGISTRY.toLowerCase() || log.topics.length === 0) continue;
    try {
      const event = decodeEventLog({ abi: TRANSFER, topics: log.topics as [Hex, ...Hex[]], data: log.data });
      if (event.args.from === zeroAddress && event.args.to.toLowerCase() === owner.toLowerCase()) return Number(event.args.tokenId);
    } catch {
      /* Another event from the registry: the metadata it sets on a mint. */
    }
  }
  return null;
}

/** What the registrant script found before it may send the one transaction. */
export type RegistrantState = {
  address: string | null;
  /** Arc's native balance, which is USDC. */
  balanceUsdc: number | null;
  /** Circle's high fee estimate for the call, in USDC. */
  feeUsdc: number | null;
  /** Identities the registrant already holds in the registry. */
  identitiesHeld: number | null;
  /** The registrant's Circle transactions that have not reached a final state. */
  inFlight: number | null;
  /** The file at the agentURI is exactly this code's file. Before the mint,
   *  that file names no registration. */
  fileMatches: boolean;
  /** The id a call from the registrant would mint now, from eth_call. */
  wouldMint: number | null;
};

/** Every reason not to register now. Empty means the call may be sent. */
export function registrationRefusals(state: RegistrantState): string[] {
  const refusals: string[] = [];
  if (!state.address) refusals.push("There is no registrant wallet yet. Run the wallet step first.");
  if (!state.fileMatches) refusals.push(`The file at ${VEYRA_AGENT_URI} is not this code's file. Deploy first.`);
  if (state.identitiesHeld === null) refusals.push("Could not read how many identities the registrant holds.");
  else if (state.identitiesHeld > 0) refusals.push(`The registrant already holds ${state.identitiesHeld === 1 ? "an identity" : `${state.identitiesHeld} identities`}. Veyra registers once.`);
  if (state.inFlight === null) refusals.push("Could not read the registrant's Circle transactions.");
  else if (state.inFlight > 0) refusals.push(`${state.inFlight} of the registrant's transactions are still in flight.`);
  if (state.wouldMint === null) refusals.push("A dry call of register() from the registrant did not succeed.");
  if (state.feeUsdc === null) refusals.push("Circle gave no fee estimate.");
  if (state.balanceUsdc === null) refusals.push("Could not read the registrant's balance.");
  else if (state.feeUsdc !== null && state.balanceUsdc < state.feeUsdc) {
    refusals.push(`The registrant holds ${state.balanceUsdc} USDC, and the call may cost up to ${state.feeUsdc}. Send it at least 0.10 USDC on Arc.`);
  }
  return refusals;
}
