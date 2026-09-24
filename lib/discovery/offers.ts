/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { gatewayContextForChain } from "../x402/gateway-deposit.ts";
import { isUsdcAsset } from "../x402/usdc-assets.ts";

/**
 * One record per paid offer, whichever catalogue listed it.
 *
 * Veyra's discovery read Circle's catalogue for Base only and did not know Arc
 * mainnet as a network at all, so "no sellers on Arc" was a fact about Veyra.
 * Asked for Arc, the same catalogue listed 482 offers; the Coinbase Bazaar and
 * the ERC-8004 registry on Arc added sellers Circle's catalogue does not have
 * (docs/audits/2026-09-23-arc-first-market-and-discovery.md).
 *
 * This module says who might sell something and what they last asked. It never
 * says what will be paid: a listing is a claim by the seller or an indexer,
 * and the only terms that can be signed are the ones `quoteX402Call` reads from
 * the live challenge for the exact request body. Nothing here quotes, decides
 * or pays.
 */

export type DiscoveryNetwork = "eip155:5042" | "eip155:8453";

type NetworkFacts = {
  name: string;
  chainId: number;
  usdc: `0x${string}`;
  gatewayWallet: `0x${string}`;
};

/* Arc first, Base additional: the order is the owner's decision of 2026-09-23.
   The addresses are Veyra's own, read from Arc's documentation, the chains and
   Circle's Gateway facilitator -- never from a seller's accept. */
export const DISCOVERY_NETWORKS: Readonly<Record<DiscoveryNetwork, NetworkFacts>> = {
  "eip155:5042": {
    name: "Arc",
    chainId: 5042,
    usdc: "0x3600000000000000000000000000000000000000",
    gatewayWallet: "0x77777777dcc4d5a8b6e418fd04d8997ef11000ee",
  },
  "eip155:8453": {
    name: "Base",
    chainId: 8453,
    usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    gatewayWallet: "0x77777777dcc4d5a8b6e418fd04d8997ef11000ee",
  },
};

export const ARC_FIRST: readonly DiscoveryNetwork[] = ["eip155:5042", "eip155:8453"];

export function isDiscoveryNetwork(value: unknown): value is DiscoveryNetwork {
  return typeof value === "string" && value in DISCOVERY_NETWORKS;
}

export type OfferSource = "circle" | "bazaar" | "erc8004";

export type OfferRail = "wallet" | "gateway_deposit";

/** One way to pay an offer, as listed. */
export type OfferAccept = {
  network: DiscoveryNetwork;
  rail: OfferRail;
  amountAtomic: string;
  payTo: `0x${string}`;
  /** Whether Veyra can quote this accept today. False on Arc until Arc mainnet
   *  USDC is in Veyra's payment tables: said here, so a card never implies a
   *  purchase the quote step would refuse. */
  quotableByVeyra: boolean;
};

export type OfferListing = {
  source: OfferSource;
  /** When the source says the listing last changed, if it says. */
  listedAt: string | null;
};

export type Erc8004Binding = {
  agentId: string;
  registry: string;
  /** "both_ways" when the registration names the endpoint and the endpoint's
   *  own manifest names the identity back; "registry_only" when only the
   *  registration speaks. Only the first is evidence of who operates it. */
  binding: "both_ways" | "registry_only";
};

export type MarketOffer = {
  key: string;
  resource: string;
  method: "GET" | "POST";
  provider: string | null;
  description: string | null;
  listings: OfferListing[];
  accepts: OfferAccept[];
  /** A price the seller published without an x402 accept (an ERC-8004
   *  manifest route). Informational: it cannot be signed against. */
  declaredPriceUsd: number | null;
  erc8004: Erc8004Binding | null;
  /** The path still holds a template (`{mint}`, `:id`). It cannot be called,
   *  priced or paid as listed; it says what the seller sells, nothing more. */
  templated: boolean;
};

export function isTemplatedResource(resource: string): boolean {
  try {
    const path = decodeURIComponent(new URL(resource).pathname);
    return /[{}]/.test(path) || /\/:[A-Za-z_]/.test(path);
  } catch {
    return true;
  }
}

function lower(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isAddress(value: string): value is `0x${string}` {
  return /^0x[0-9a-f]{40}$/.test(value);
}

/**
 * One raw accept, or null when it is not a USDC payment Veyra recognises on an
 * allowed network. The asset and the verifying contract are compared with
 * Veyra's table, so a listing cannot move a signature to a contract of the
 * seller's choosing: a Gateway accept must name Circle's GatewayWallet, a
 * wallet accept must be domain-separated by the USDC contract itself.
 */
export function normalizeOfferAccept(
  raw: unknown,
  networks: readonly DiscoveryNetwork[] = ARC_FIRST,
): OfferAccept | null {
  if (!raw || typeof raw !== "object") return null;
  const accept = raw as Record<string, unknown>;
  if (lower(accept.scheme || "exact") !== "exact") return null;
  const network = lower(accept.network);
  if (!isDiscoveryNetwork(network) || !networks.includes(network)) return null;
  const facts = DISCOVERY_NETWORKS[network];
  if (lower(accept.asset) !== facts.usdc) return null;
  const payTo = lower(accept.payTo);
  if (!isAddress(payTo)) return null;
  const amount = String(accept.amount ?? accept.maxAmountRequired ?? "").trim();
  if (!/^\d{1,30}$/.test(amount)) return null;

  const extra = (accept.extra && typeof accept.extra === "object" ? accept.extra : {}) as Record<string, unknown>;
  const gateway = String(extra.name ?? "") === "GatewayWalletBatched";
  const verifying = lower(extra.verifyingContract);
  if (gateway && verifying !== facts.gatewayWallet) return null;
  if (!gateway && verifying && verifying !== facts.usdc) return null;

  return {
    network,
    rail: gateway ? "gateway_deposit" : "wallet",
    amountAtomic: amount,
    payTo,
    /* The same two tables the quote step reads: without them the quote refuses
       as asset_not_usdc or no_payable_accept, which is Arc's state today. */
    quotableByVeyra: isUsdcAsset(facts.chainId, facts.usdc)
      && (!gateway || gatewayContextForChain(facts.chainId) !== null),
  };
}

/** A URL as the merge key sees it: no fragment, no trailing slash on the path. */
export function offerKey(resource: string, method: string): string | null {
  try {
    const url = new URL(resource);
    if (url.protocol !== "https:") return null;
    url.hash = "";
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
    return `${method.toUpperCase()} ${url.origin}${path}${url.search}`;
  } catch {
    return null;
  }
}

export type OfferInput = Omit<MarketOffer, "key" | "listings" | "templated"> & { listing: OfferListing };

/**
 * Many listings of one offer become one record.
 *
 * The same endpoint appears in Circle's catalogue and the Bazaar, once per
 * network, sometimes with different payees per rail (Exa lists one payee on
 * Base's legacy accept and another on its Circle accepts). Accepts are kept
 * side by side rather than reconciled: which one is paid is decided by the
 * live challenge, not by which indexer spoke last.
 */
export function mergeOffers(inputs: OfferInput[]): MarketOffer[] {
  const byKey = new Map<string, MarketOffer>();
  for (const input of inputs) {
    const key = offerKey(input.resource, input.method);
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        key,
        resource: input.resource,
        method: input.method,
        provider: input.provider,
        description: input.description,
        listings: [input.listing],
        accepts: [...input.accepts],
        declaredPriceUsd: input.declaredPriceUsd,
        erc8004: input.erc8004,
        templated: isTemplatedResource(input.resource),
      });
      continue;
    }
    if (!existing.listings.some((l) => l.source === input.listing.source)) existing.listings.push(input.listing);
    for (const accept of input.accepts) {
      const same = existing.accepts.some((a) => a.network === accept.network && a.rail === accept.rail
        && a.payTo === accept.payTo && a.amountAtomic === accept.amountAtomic);
      if (!same) existing.accepts.push(accept);
    }
    existing.provider ??= input.provider;
    existing.description ??= input.description;
    existing.declaredPriceUsd ??= input.declaredPriceUsd;
    /* A two-way binding outranks a one-way claim, never the reverse. */
    if (input.erc8004 && (!existing.erc8004 || input.erc8004.binding === "both_ways")) {
      existing.erc8004 = input.erc8004;
    }
  }
  return [...byKey.values()];
}

/** Networks an offer can be paid on, Arc first. */
export function offerNetworks(offer: MarketOffer): DiscoveryNetwork[] {
  return ARC_FIRST.filter((network) => offer.accepts.some((a) => a.network === network));
}

/**
 * The accept a card shows first, under the owner's network order.
 *
 * Only a preference among what the seller offers. It is not a fallback: when
 * Veyra refuses a seller on one network, the refusal stands, and paying the
 * same seller on another network is a new decision under a mandate that names
 * that network. That rule lives where decisions are made; this function never
 * sees a refusal and cannot route around one.
 */
export function preferredAccept(
  offer: MarketOffer,
  allowed: readonly DiscoveryNetwork[] = ARC_FIRST,
): OfferAccept | null {
  for (const network of ARC_FIRST) {
    if (!allowed.includes(network)) continue;
    const onNetwork = offer.accepts.filter((a) => a.network === network);
    if (onNetwork.length === 0) continue;
    /* From a wallet before a Gateway deposit: the wallet rail needs nothing set
       up first, and a Gateway deposit is spendable in full by one burn intent. */
    return onNetwork.find((a) => a.rail === "wallet") ?? onNetwork[0];
  }
  return null;
}

export type MarketSummary = {
  offers: number;
  bySource: Record<OfferSource, number>;
  byNetwork: Record<DiscoveryNetwork, { offers: number; wallet: number; gateway: number; quotableByVeyra: number }>;
  erc8004BothWays: number;
};

export function summarizeMarket(offers: MarketOffer[]): MarketSummary {
  const bySource: Record<OfferSource, number> = { circle: 0, bazaar: 0, erc8004: 0 };
  const byNetwork = Object.fromEntries(ARC_FIRST.map((n) => [n, { offers: 0, wallet: 0, gateway: 0, quotableByVeyra: 0 }])) as MarketSummary["byNetwork"];
  for (const offer of offers) {
    for (const listing of offer.listings) bySource[listing.source] += 1;
    for (const network of offerNetworks(offer)) {
      const accepts = offer.accepts.filter((a) => a.network === network);
      const row = byNetwork[network];
      row.offers += 1;
      if (accepts.some((a) => a.rail === "wallet")) row.wallet += 1;
      if (accepts.some((a) => a.rail === "gateway_deposit")) row.gateway += 1;
      if (accepts.some((a) => a.quotableByVeyra)) row.quotableByVeyra += 1;
    }
  }
  return {
    offers: offers.length,
    bySource,
    byNetwork,
    erc8004BothWays: offers.filter((o) => o.erc8004?.binding === "both_ways").length,
  };
}
