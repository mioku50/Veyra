/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { offerFromCatalogueItem, readBazaar, readCircleCatalogue } from "../lib/discovery/catalogues.ts";
import {
  countIdentities,
  manifestNamesAgent,
  offersFromManifest,
  readArcErc8004Offers,
  readRegistrationFile,
  x402Services,
  type IdentityRegistryReader,
  type JsonFetcher,
} from "../lib/discovery/erc8004-arc.ts";
import {
  isTemplatedResource,
  mergeOffers,
  normalizeOfferAccept,
  offerKey,
  offerNetworks,
  preferredAccept,
  summarizeMarket,
} from "../lib/discovery/offers.ts";

const ARC = "eip155:5042";
const BASE = "eip155:8453";
const ARC_USDC = "0x3600000000000000000000000000000000000000";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const GATEWAY = "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE";
const PAY_TO = "0xB98eF29eb2be19Ae646A8FC0248255B90A332dbC";

/* Exa's search listing as Circle's catalogue returned it on 2026-09-23: a
   wallet accept and a Gateway accept on Arc, the same pair on Base. */
const exa = {
  resource: "https://api.exa.ai/search",
  lastUpdated: "2026-09-22T15:05:07.993Z",
  metadata: { method: "POST", provider: { name: "Exa" }, description: "Search the web." },
  accepts: [
    { scheme: "exact", network: ARC, asset: ARC_USDC, payTo: PAY_TO, amount: "7000", extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: GATEWAY } },
    { scheme: "exact", network: ARC, asset: ARC_USDC, payTo: PAY_TO, amount: "7000", extra: { name: "USDC", version: "2" } },
    { scheme: "exact", network: BASE, asset: BASE_USDC, payTo: PAY_TO, amount: "7000", extra: { name: "USD Coin", version: "2" } },
    { scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", asset: "EPjF", payTo: "12Ec", amount: "7000" },
  ],
};

// --- accepts: Veyra's table decides, never the seller ---
{
  const wallet = normalizeOfferAccept(exa.accepts[1]);
  assert.equal(wallet?.rail, "wallet");
  assert.equal(wallet?.network, ARC);
  /* Arc mainnet USDC is not in Veyra's payment tables yet, so nothing on Arc
     can be quoted, and the record says so rather than implying a purchase. */
  assert.equal(wallet?.quotableByVeyra, false);
  assert.equal(normalizeOfferAccept(exa.accepts[2])?.quotableByVeyra, true);
  assert.equal(normalizeOfferAccept(exa.accepts[0])?.rail, "gateway_deposit");
  assert.equal(normalizeOfferAccept(exa.accepts[3]), null, "non-EVM accepts are out of scope");

  const wrongGateway = { ...exa.accepts[0], extra: { name: "GatewayWalletBatched", verifyingContract: "0x1111111111111111111111111111111111111111" } };
  assert.equal(normalizeOfferAccept(wrongGateway), null, "a Gateway accept must name Circle's GatewayWallet");
  const movedDomain = { ...exa.accepts[1], extra: { name: "USDC", version: "2", verifyingContract: "0x2222222222222222222222222222222222222222" } };
  assert.equal(normalizeOfferAccept(movedDomain), null, "a wallet accept is domain-separated by the token");
  assert.equal(normalizeOfferAccept({ ...exa.accepts[1], asset: BASE_USDC }), null, "another chain's USDC is not USDC here");
  assert.equal(normalizeOfferAccept({ ...exa.accepts[1], network: "eip155:5042002" }), null, "Arc Testnet is not the market");
  assert.equal(normalizeOfferAccept(exa.accepts[1], [BASE]), null, "networks the caller does not allow are dropped");
}

// --- catalogue items ---
{
  const offer = offerFromCatalogueItem(exa, "circle");
  assert.ok(offer);
  assert.equal(offer.method, "POST");
  assert.equal(offer.provider, "Exa");
  assert.equal(offer.accepts.length, 3);
  assert.equal(offerFromCatalogueItem({ ...exa, metadata: { method: "DELETE" } }, "circle"), null);
  assert.equal(offerFromCatalogueItem({ ...exa, resource: "http://api.exa.ai/search" }, "circle"), null);

  /* The Bazaar puts the method in its extension, not in metadata. */
  const bazaarItem = {
    resource: "https://api.insumermodel.com/v1/trust",
    description: "Signed wallet trust facts.",
    extensions: { bazaar: { info: { input: { method: "POST" } } } },
    accepts: [{ scheme: "exact", network: ARC, asset: ARC_USDC, payTo: "0xAd982CB19aCCa2923Df8F687C0614a7700255a23", amount: "150000", extra: { name: "USDC", version: "2" } }],
  };
  const fromBazaar = offerFromCatalogueItem(bazaarItem, "bazaar");
  assert.equal(fromBazaar?.method, "POST");
  assert.equal(fromBazaar?.description, "Signed wallet trust facts.");
}

// --- merging, Arc first ---
{
  const circle = offerFromCatalogueItem(exa, "circle")!;
  const bazaar = offerFromCatalogueItem({ ...exa, resource: "https://api.exa.ai/search/" }, "bazaar")!;
  const merged = mergeOffers([circle, bazaar]);
  assert.equal(merged.length, 1, "one endpoint, however many indexers list it");
  assert.deepEqual(merged[0].listings.map((l) => l.source), ["circle", "bazaar"]);
  assert.equal(merged[0].accepts.length, 3, "identical accepts are not duplicated");
  assert.deepEqual(offerNetworks(merged[0]), [ARC, BASE]);
  assert.equal(preferredAccept(merged[0])?.network, ARC);
  assert.equal(preferredAccept(merged[0])?.rail, "wallet", "a wallet payment before a Gateway deposit");
  assert.equal(preferredAccept(merged[0], [BASE])?.network, BASE, "only networks the mandate names");
  assert.equal(offerKey("https://a.example/x?q=1#frag", "get"), "GET https://a.example/x?q=1");
  assert.equal(offerKey("http://a.example/x", "GET"), null);
  assert.equal(merged[0].templated, false);
  assert.equal(isTemplatedResource("https://apexfaucet.xyz/api/x402/token/%7Bmint%7D"), true);
  assert.equal(isTemplatedResource("https://clawg.network/v1/token/:id"), true);
  assert.equal(isTemplatedResource("https://api.exa.ai/search"), false);

  const summary = summarizeMarket(merged);
  assert.deepEqual(summary.byNetwork[ARC], { offers: 1, wallet: 1, gateway: 1, quotableByVeyra: 0 });
  assert.deepEqual(summary.byNetwork[BASE], { offers: 1, wallet: 1, gateway: 0, quotableByVeyra: 1 });
}

// --- catalogue readers: bounded, per network ---
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
{
  const asked: string[] = [];
  const fetchImpl = (async (url: string) => {
    asked.push(url);
    const network = new URL(url).searchParams.get("network");
    return jsonResponse({ items: network === ARC ? [exa] : [], pagination: { total: network === ARC ? 1 : 0 } });
  }) as typeof fetch;
  const circle = await readCircleCatalogue({ fetchImpl });
  assert.equal(new URL(asked[0]).searchParams.get("network"), ARC, "Arc is asked first");
  assert.equal(new URL(asked[1]).searchParams.get("network"), BASE);
  assert.equal(new URL(asked[0]).searchParams.get("siwx"), "false");
  assert.equal(circle.offers.length, 1);
  /* Found by asking for Arc, so only its Arc accepts count here; Base is
     counted when Base is asked. */
  assert.deepEqual(circle.offers[0].accepts.map((a) => a.network), [ARC, ARC]);

  const pages: number[] = [];
  const bazaarFetch = (async (url: string) => {
    const offset = Number(new URL(url).searchParams.get("offset"));
    pages.push(offset);
    return jsonResponse({ items: offset === 0 ? [exa, { resource: "https://x.example/y", accepts: [] }] : [], pagination: { total: 5_000 } });
  }) as typeof fetch;
  const bazaar = await readBazaar({ fetchImpl: bazaarFetch, maxPages: 3 });
  assert.equal(bazaar.offers.length, 1);
  assert.equal(bazaar.complete, true, "the catalogue ended before the cap");
  assert.deepEqual(pages, [0], "a short page ends the read");

  const fullPage = Array.from({ length: 1_000 }, () => ({ resource: "https://x.example/y", accepts: [] }));
  const capped = await readBazaar({ fetchImpl: (async () => jsonResponse({ items: fullPage, pagination: { total: 5_000 } })) as typeof fetch, maxPages: 2 });
  assert.equal(capped.scanned, 2_000);
  assert.equal(capped.complete, false, "a capped read says it is a sample");

  await assert.rejects(
    readCircleCatalogue({ fetchImpl: (async () => jsonResponse({}, 503)) as typeof fetch }),
    /circle_catalogue_unavailable_503/,
  );
}

// --- ERC-8004 on Arc ---
{
  const ids = (n: number): IdentityRegistryReader => ({ exists: async (id) => id >= 0 && id < n, tokenURI: async () => null });
  assert.equal(await countIdentities(ids(0)), 0);
  assert.equal(await countIdentities(ids(1)), 1);
  assert.equal(await countIdentities(ids(192)), 192);
  assert.equal(await countIdentities(ids(5_000), 1_000), 1_000, "capped");

  const dataUri = `data:application/json;base64,${Buffer.from(JSON.stringify({ name: "A", services: [] })).toString("base64")}`;
  assert.deepEqual(await readRegistrationFile(dataUri, async () => { throw new Error("no network"); }), { name: "A", services: [] });
  assert.equal(await readRegistrationFile("http://insecure.example/a.json", async () => ({})), null);
  assert.equal(await readRegistrationFile("ipfs://not a cid", async () => ({})), null);
  const gateways: string[] = [];
  const viaIpfs = await readRegistrationFile("ipfs://bafkreibdi6623n3xpf7ymk62ckb4bo75o3qemwkpfvp5i25j66itxvsoei", async (url) => {
    gateways.push(url);
    if (gateways.length === 1) throw new Error("http_429");
    return { name: "B" };
  });
  assert.deepEqual(viaIpfs, { name: "B" });
  assert.equal(gateways.length, 2, "a rate-limited gateway falls through to the next");

  assert.deepEqual(
    x402Services({ services: [
      { name: "web", endpoint: "https://cra-agent.tech" },
      { name: "x402", endpoint: "https://api.cra-agent.tech/.well-known/x402" },
      { name: "kleos-http-402", endpoint: "https://kleos.network/api/agents/ledger-scribe" },
      { name: "x402-catalogue", endpoint: "http://insecure.example/discovery" },
    ] }).map((s) => s.name),
    ["x402"],
    "only standard x402 services over HTTPS",
  );

  /* CRA's manifest, which names its identity back. */
  const manifest = {
    name: "CRA AGENT",
    erc8004: { agentId: 186, agentRegistry: "eip155:5042:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" },
    routes: [
      { pattern: "GET /v1/paid/rpc/health", priceUsd: "0.0005", description: "RPC health" },
      { pattern: "DELETE /v1/paid/x", priceUsd: "1" },
      { pattern: "GET https://elsewhere.example/steal", priceUsd: "1" },
    ],
  };
  assert.equal(manifestNamesAgent(manifest, 186), true);
  assert.equal(manifestNamesAgent(manifest, 185), false);
  assert.equal(manifestNamesAgent({ erc8004: { agentId: 186, agentRegistry: "eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" } }, 186), false);
  const routes = offersFromManifest(manifest, "https://api.cra-agent.tech/.well-known/x402", { agentId: "186", registry: "r", binding: "both_ways" });
  assert.equal(routes.length, 1, "only GET/POST paths on the manifest's own origin");
  assert.equal(routes[0].resource, "https://api.cra-agent.tech/v1/paid/rpc/health");
  assert.equal(routes[0].declaredPriceUsd, 0.0005);
  assert.equal(routes[0].accepts.length, 0, "a declared price is nothing to sign");

  const files: Record<string, unknown> = {
    "https://cra-agent.tech/agent.json": { x402Support: true, services: [{ name: "x402", endpoint: "https://api.cra-agent.tech/.well-known/x402" }] },
    /* Id 0 in this registry, and its manifest says so. */
    "https://api.cra-agent.tech/.well-known/x402": { ...manifest, erc8004: { ...manifest.erc8004, agentId: 0 } },
    "https://apex.example/agent.json": { x402Support: true, services: [{ name: "x402-catalogue", endpoint: "https://apex.example/discovery/resources" }] },
    "https://apex.example/discovery/resources": { items: [{ ...exa, resource: "https://apex.example/api/x402/chain-status", metadata: { method: "GET" } }] },
  };
  const fetchJson: JsonFetcher = async (url) => {
    if (!(url in files)) throw new Error("http_404");
    return files[url];
  };
  const uris = ["https://cra-agent.tech/agent.json", "https://apex.example/agent.json", "https://gone.example/agent.json"];
  const read = await readArcErc8004Offers({
    reader: { exists: async (id) => id < 3, tokenURI: async (id) => uris[id] },
    fetchJson,
  });
  assert.equal(read.identities, 3);
  assert.equal(read.filesRead, 2);
  assert.equal(read.filesUnreadable, 1);
  assert.deepEqual(read.declaringX402, [0, 1]);
  const merged = mergeOffers(read.offers);
  const cra = merged.find((o) => o.resource.includes("cra-agent"));
  const apex = merged.find((o) => o.resource.includes("apex"));
  assert.equal(cra?.erc8004?.binding, "both_ways");
  assert.equal(apex?.erc8004?.binding, "registry_only", "a catalogue that does not name the identity back is one-way");
  assert.equal(apex?.accepts.length, 3);
}

console.log("PASS market discovery: accepts checked against Veyra's own table, one record per offer, Arc first without fallback, bounded catalogue reads, ERC-8004 read with two-way binding.");
