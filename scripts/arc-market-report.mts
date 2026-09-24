/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The x402 market on Arc and Base, as Veyra's discovery sees it. Read-only.
 *
 *   npm run --silent arc:market [-- --no-bazaar] [--no-erc8004]
 *
 * Reads Circle's catalogue per network (Arc first), the Coinbase Bazaar and
 * the ERC-8004 identity registry on Arc mainnet, merges them into one record
 * per offer and prints a summary. It sends no payment header, probes nothing,
 * writes nothing and needs no credentials. ARC_MAINNET_RPC_URL overrides the
 * public RPC.
 */

import { createPublicClient, defineChain, http, parseAbi } from "viem";
import { readBazaar, readCircleCatalogue } from "../lib/discovery/catalogues.ts";
import { ARC_IDENTITY_REGISTRY, readArcErc8004Offers, type IdentityRegistryReader } from "../lib/discovery/erc8004-arc.ts";
import { ARC_FIRST, mergeOffers, preferredAccept, summarizeMarket, type OfferInput } from "../lib/discovery/offers.ts";

const args = new Set(process.argv.slice(2));
const rpcUrl = process.env.ARC_MAINNET_RPC_URL || "https://rpc.mainnet.arc.io";

const arcMainnet = defineChain({
  id: 5042,
  name: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const client = createPublicClient({ chain: arcMainnet, transport: http(rpcUrl, { timeout: 30_000, retryCount: 2 }) });
const registryAbi = parseAbi([
  "function ownerOf(uint256) view returns (address)",
  "function tokenURI(uint256) view returns (string)",
]);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/* The public RPC rate-limits; one call at a time, with a pause, and a longer
   one on a 429. A revert is an answer (no such id), a rate limit is not. */
async function call<T>(fn: () => Promise<T>): Promise<T | null> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await pause(250);
    try { return await fn(); }
    catch (error) {
      if (/rate limit|429/i.test(String((error as Error)?.message))) { await pause(3_000); continue; }
      return null;
    }
  }
  throw new Error("arc_rpc_rate_limited");
}

const reader: IdentityRegistryReader = {
  exists: async (id) => (await call(() => client.readContract({
    address: ARC_IDENTITY_REGISTRY, abi: registryAbi, functionName: "ownerOf", args: [BigInt(id)],
  }))) !== null,
  tokenURI: async (id) => call(() => client.readContract({
    address: ARC_IDENTITY_REGISTRY, abi: registryAbi, functionName: "tokenURI", args: [BigInt(id)],
  })),
};

const inputs: OfferInput[] = [];
const circle = await readCircleCatalogue({ networks: ARC_FIRST });
inputs.push(...circle.offers);
const report: Record<string, unknown> = { readAt: new Date().toISOString(), circleListed: circle.listed };

if (!args.has("--no-bazaar")) {
  const bazaar = await readBazaar({ networks: ARC_FIRST });
  inputs.push(...bazaar.offers);
  report.bazaar = { scanned: bazaar.scanned, complete: bazaar.complete };
}
if (!args.has("--no-erc8004")) {
  const erc8004 = await readArcErc8004Offers({ reader });
  inputs.push(...erc8004.offers);
  report.erc8004 = {
    identities: erc8004.identities,
    filesRead: erc8004.filesRead,
    filesUnreadable: erc8004.filesUnreadable,
    declaringX402: erc8004.declaringX402,
  };
}

const offers = mergeOffers(inputs);
report.summary = summarizeMarket(offers);
report.arcWalletOffers = offers
  .filter((offer) => !offer.templated && preferredAccept(offer, ["eip155:5042"])?.rail === "wallet")
  .map((offer) => ({
    offer: offer.key,
    usdc: Number(preferredAccept(offer, ["eip155:5042"])!.amountAtomic) / 1e6,
    sources: offer.listings.map((l) => l.source),
  }));
report.erc8004Offers = offers
  .filter((offer) => offer.erc8004)
  .map((offer) => ({ offer: offer.key, agentId: offer.erc8004!.agentId, binding: offer.erc8004!.binding, declaredPriceUsd: offer.declaredPriceUsd }))
  .slice(0, 50);
console.log(JSON.stringify(report, null, 2));
