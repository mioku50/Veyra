/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The ERC-8004 registry on Arc as a daily snapshot, and its offers in Veyra's
 * discovery: the read, the challenge check, the store, the candidates, and
 * what a card says about where a listing came from. Offline: every chain read,
 * file, manifest and challenge is a stub.
 */

process.env.NODE_ENV = "test";
process.env.EXECUTION_ALLOW_MEMORY_STORE = "true";

import assert from "node:assert/strict";
import {
  confirmWithChallenges,
  offersFromResourceManifest,
  readArcErc8004Offers,
  type ChallengeRead,
  type ChallengeReader,
  type IdentityRegistryReader,
  type JsonFetcher,
} from "../lib/discovery/erc8004-arc.ts";
import {
  clearArcRegistryMemory,
  loadArcRegistryView,
  saveArcRegistrySnapshot,
  summarizeArcRegistry,
  takeArcRegistrySnapshot,
  type ArcRegistrySnapshot,
} from "../lib/discovery/arc-registry.ts";
import { mergeOffers, normalizeOfferAccept, offerMatchesTerm, type MarketOffer } from "../lib/discovery/offers.ts";
import { discoverMarketplaceCandidates, registryItemFor } from "../lib/counterparty-selection/marketplace-source.ts";
import { observeX402Catalog, worthWatching } from "../lib/nova/sources.ts";
import { changesForSubject, listedWhere, x402Digest } from "../lib/nova/observation.ts";
import { listingSource } from "../lib/nova/presentation.ts";

const ARC = "eip155:5042";
const BASE = "eip155:8453";
const ARC_USDC = "0x3600000000000000000000000000000000000000";
const GATEWAY = "0x77777777dcc4d5a8b6e418fd04d8997ef11000ee";
const CRA_PAY_TO = "0x33b37c6d7a98b58da3Ccb3F36A4b578053d0Ea74";
const FUCI_PAY_TO = "0x900c41eda7013b1e1c1ad3af3c47188a04a2160a";
const REGISTRY = "eip155:5042:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";

const gatewayAccept = (payTo: string, amount: string, extra: Record<string, unknown> = {}) => ({
  scheme: "exact", network: ARC, asset: ARC_USDC, payTo, amount, maxTimeoutSeconds: 604900,
  extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: GATEWAY, ...extra },
});
const challenge = (accepts: Array<Record<string, unknown>>, resource: Record<string, unknown> = {}, inputSchema: Record<string, unknown> | null = null): ChallengeRead =>
  ({ status: 402, accepts, resource, inputSchema });

// --- accepts: only what the owner's wallet can sign ---
{
  const signable = normalizeOfferAccept(gatewayAccept(CRA_PAY_TO, "500"));
  assert.equal(signable?.quotableByVeyra, true);
  const noVersion = normalizeOfferAccept({ ...gatewayAccept(CRA_PAY_TO, "500"), extra: { name: "GatewayWalletBatched", verifyingContract: GATEWAY } });
  assert.equal(noVersion?.quotableByVeyra, false, "no EIP-712 version, nothing the wallet can sign");
  /* Fuci's manifest names no verifying contract; its live challenge does. */
  assert.equal(normalizeOfferAccept({ ...gatewayAccept(FUCI_PAY_TO, "40000"), extra: { name: "GatewayWalletBatched", version: "1" } }), null);
}

// --- search: what an offer says about itself, never its host ---
{
  const offer = { resource: "https://api.cra-agent.tech/v1/paid/market/prices", provider: "CRA AGENT data", description: "Every pair at once", tags: ["arc", "chain-data"] };
  assert.equal(offerMatchesTerm(offer, "arc"), true, "a tag");
  assert.equal(offerMatchesTerm(offer, "price"), true, "a plural path word");
  assert.equal(offerMatchesTerm(offer, "market data"), true, "every word, from anywhere in it");
  assert.equal(offerMatchesTerm(offer, "tech"), false, "the host is not a description");
  assert.equal(offerMatchesTerm(offer, "search"), false, "no stray substring: 'research' is not 'search'");
  assert.equal(offerMatchesTerm({ ...offer, description: "Deep research" }, "search"), false);
  /* Fuci's agent says what it is about only in its prompt field. */
  const agent = { resource: "https://www.fuci.family/api/agent/run", provider: "Fuci", description: "A Fuci agent answers your question", tags: [],
    inputSchema: { type: "object", properties: { prompt: { type: "string", description: "Your question about Argus launches / Arc markets" } } } };
  assert.equal(offerMatchesTerm(agent, "arc"), true);
  assert.equal(offerMatchesTerm({ ...agent, inputSchema: null }, "arc"), false);
}

// --- a manifest whose resources carry their own accepts ---
{
  const manifest = {
    name: "Fuci",
    resources: [
      { url: "https://www.fuci.family/api/agent/run", method: "POST", price: "$0.04",
        input: { prompt: { type: "string", description: "Your question about Argus launches / Arc markets" } },
        accepts: [gatewayAccept(FUCI_PAY_TO, "40000")] },
      { url: "https://www.fuci.family/api/x402/fucus/oracle", method: "GET", price: "$0.0005", input: null, accepts: [] },
      { url: "http://insecure.example/x", method: "GET" },
      { url: "https://www.fuci.family/api/x", method: "DELETE" },
      "https://apexfaucet.xyz/api/x402/token/abc",
    ],
  };
  const binding = { agentId: "193", registry: REGISTRY, binding: "registry_only" as const };
  const offers = offersFromResourceManifest(manifest, binding);
  assert.equal(offers.length, 2, "https, GET or POST, objects only");
  assert.equal(offers[0].method, "POST");
  assert.equal(offers[0].declaredPriceUsd, 0.04);
  assert.equal(offers[0].accepts.length, 1);
  assert.deepEqual(offers[0].inputSchema, { type: "object", properties: { prompt: { type: "string", description: "Your question about Argus launches / Arc markets" } } });
  assert.equal(offers[1].inputSchema, null);
}

// --- the registry read: batched, shared endpoints once, binding by origin ---
const files: Record<string, unknown> = {
  "https://cra-agent.tech/agent.json": { name: "CRA AGENT", x402Support: true, services: [{ name: "x402", endpoint: "https://api.cra-agent.tech/.well-known/x402" }] },
  "https://api.cra-agent.tech/.well-known/x402": {
    name: "CRA AGENT data",
    erc8004: { agentId: 0, agentRegistry: REGISTRY },
    routes: [{ pattern: "GET /v1/paid/fees/estimate", priceUsd: "0.0005" }, { pattern: "POST /v1/paid/ask", priceUsd: "0.002" }],
  },
  "https://fuci.example/card-a.json": { name: "Fuci", x402Support: true, services: [{ name: "x402", endpoint: "https://fuci.example/.well-known/x402" }] },
  "https://fuci.example/card-b.json": { name: "Duke", x402Support: true, services: [{ name: "x402", endpoint: "https://fuci.example/.well-known/x402" }] },
  "https://fuci.example/.well-known/x402": {
    name: "Fuci",
    resources: [{ url: "https://fuci.example/api/agent/run", method: "POST", price: "$0.04", input: { prompt: { type: "string", description: "Your question about Argus launches / Arc markets" } }, accepts: [gatewayAccept(FUCI_PAY_TO, "40000")] }],
  },
  "https://apex.example/agent.json": { name: "APEX Faucet", x402Support: true, services: [
    { name: "x402-catalogue", endpoint: "https://apex.example/discovery/resources" },
    { name: "x402", endpoint: "https://apex.example/api/x402/watch" },
  ] },
  /* A catalogue can list anyone's URLs; it names nobody back. */
  "https://apex.example/discovery/resources": { items: [
    { resource: "https://apex.example/api/x402/web-read", accepts: [gatewayAccept(CRA_PAY_TO, "3000")], extensions: { bazaar: { info: { input: { method: "GET" }, output: { description: "Read web pages as clean text" } } } } },
    { resource: "https://api.cra-agent.tech/v1/paid/claimed-by-apex", metadata: { method: "POST" }, accepts: [gatewayAccept(CRA_PAY_TO, "3000")] },
  ] },
};
const fetched: string[] = [];
const fetchJson: JsonFetcher = async (url) => {
  fetched.push(url);
  if (url === "https://apex.example/api/x402/watch") throw new Error("http_402");
  if (!(url in files)) throw new Error("http_404");
  return files[url];
};
const uris = [
  "https://cra-agent.tech/agent.json",
  "https://fuci.example/card-a.json",
  "https://fuci.example/card-b.json",
  "https://apex.example/agent.json",
  "https://gone.example/agent.json",
];
let batched = 0;
const reader: IdentityRegistryReader = {
  exists: async (id) => id >= 0 && id < uris.length,
  tokenURI: async () => { throw new Error("one at a time is not used when a batch reader exists"); },
  tokenURIs: async (ids) => { batched += 1; return ids.map((id) => uris[id] ?? null); },
};
const challenges: Record<string, ChallengeRead | null> = {
  "GET https://apex.example/api/x402/watch": challenge([gatewayAccept(CRA_PAY_TO, "5000")], { description: "Who answers, hourly", tags: ["erc8004"] }),
};
const readChallenge: ChallengeReader = async (url, method) => challenges[`${method} ${url}`] ?? null;
{
  const read = await readArcErc8004Offers({ reader, fetchJson, readChallenge });
  assert.equal(batched, 1, "every URI in one batch");
  assert.equal(read.identities, 5);
  assert.equal(read.filesRead, 4);
  assert.equal(read.filesUnreadable, 1);
  assert.deepEqual(read.declaringX402, [0, 1, 2, 3]);
  assert.equal(read.complete, true);
  assert.equal(fetched.filter((url) => url === "https://fuci.example/.well-known/x402").length, 1, "one manifest, declared by two identities, read once");

  const merged = mergeOffers(read.offers);
  const find = (resource: string) => merged.find((offer) => offer.resource === resource);
  assert.equal(find("https://api.cra-agent.tech/v1/paid/fees/estimate")?.erc8004?.binding, "both_ways");
  assert.equal(find("https://api.cra-agent.tech/v1/paid/claimed-by-apex")?.erc8004?.agentId, "3",
    "APEX's catalogue lists a URL on CRA's host");
  assert.equal(find("https://api.cra-agent.tech/v1/paid/claimed-by-apex")?.erc8004?.binding, "registry_only",
    "and CRA's manifest names CRA, not APEX: a claim about someone else's host is one-way");
  assert.equal(find("https://apex.example/api/x402/web-read")?.provider, "APEX Faucet", "a nameless catalogue item takes the registration's name");
  assert.equal(find("https://apex.example/api/x402/web-read")?.description, "Read web pages as clean text");
  assert.equal(find("https://apex.example/api/x402/watch")?.accepts[0]?.amountAtomic, "5000", "a declared endpoint that answers 402 is itself the offer");
  const run = find("https://fuci.example/api/agent/run");
  assert.equal(run?.erc8004?.agentId, "1", "the first identity to declare it");
  assert.equal(run?.inputSchema !== null, true);

  let now = 1_000;
  const late = await readArcErc8004Offers({ reader, fetchJson, readChallenge, deadline: 1_500, clock: () => (now += 400) });
  assert.equal(late.complete, false, "a read the clock cut short says so");
}

// --- each offer against its own challenge ---
{
  const offer = (resource: string, extra: Partial<MarketOffer> = {}): MarketOffer => ({
    key: `GET ${resource}`, resource, method: "GET", provider: null, description: "listed", listings: [{ source: "erc8004", listedAt: null }],
    accepts: [], declaredPriceUsd: 0.001, erc8004: null, templated: false, tags: [], inputSchema: null, ...extra,
  });
  const listedAccept = normalizeOfferAccept(gatewayAccept(CRA_PAY_TO, "1000"))!;
  const offers = [
    offer("https://a.example/priced"),
    offer("https://a.example/not-x402", { accepts: [listedAccept] }),
    offer("https://a.example/gone", { accepts: [listedAccept] }),
    offer("https://a.example/wants-params", { accepts: [listedAccept] }),
    offer("https://a.example/unreachable", { accepts: [listedAccept] }),
    offer("https://a.example/{id}", { templated: true, accepts: [listedAccept] }),
  ];
  const answers: Record<string, ChallengeRead | null> = {
    "https://a.example/priced": challenge(
      [gatewayAccept(CRA_PAY_TO, "500"), gatewayAccept(CRA_PAY_TO, "500"), { scheme: "exact", network: "solana:x", asset: "EPj", payTo: "26S", amount: "500" }],
      { description: "Cost of a transaction", serviceName: "CRA AGENT data", tags: ["Arc", "gas"] },
      { type: "object", properties: { gas: { type: "integer" } } },
    ),
    "https://a.example/not-x402": { status: 402, accepts: [], resource: null, inputSchema: null },
    "https://a.example/gone": { status: 404, accepts: [], resource: null, inputSchema: null },
    "https://a.example/wants-params": { status: 400, accepts: [], resource: null, inputSchema: null },
    "https://a.example/unreachable": null,
  };
  const asked: string[] = [];
  const checked = await confirmWithChallenges(offers, { readChallenge: async (url) => { asked.push(url); return answers[url] ?? null; } });
  const by = (resource: string) => checked.offers.find((o) => o.resource === resource)!;
  assert.deepEqual(by("https://a.example/priced").accepts.map((a) => a.amountAtomic), ["500"], "the endpoint's own terms, once each, on Arc or Base only");
  assert.equal(by("https://a.example/priced").description, "Cost of a transaction");
  assert.equal(by("https://a.example/priced").provider, "CRA AGENT data");
  assert.deepEqual(by("https://a.example/priced").tags, ["arc", "gas"]);
  assert.deepEqual(by("https://a.example/priced").inputSchema, { type: "object", properties: { gas: { type: "integer" } } });
  assert.equal(by("https://a.example/not-x402").accepts.length, 0, "a 402 that is not x402 is not an offer");
  assert.equal(by("https://a.example/gone").accepts.length, 0);
  assert.equal(by("https://a.example/wants-params").accepts.length, 1, "a 400 does not say the listing is wrong");
  assert.equal(by("https://a.example/unreachable").accepts.length, 1);
  assert.equal(asked.includes("https://a.example/{id}"), false, "a template is never called");
  assert.deepEqual([checked.confirmed, checked.unconfirmed, checked.notChecked], [3, 2, 0]);
  assert.equal(offers[1].accepts.length, 1, "the input is not changed in place");

  const capped = await confirmWithChallenges(offers, { readChallenge: async () => null, max: 2 });
  assert.equal(capped.notChecked, 3);
}

// --- the snapshot, and the store ---
const craRoute: ChallengeRead = challenge([gatewayAccept(CRA_PAY_TO, "500")], { description: "Cost of a transaction", tags: ["arc", "gas"] });
const fuciRun: ChallengeRead = challenge([gatewayAccept(FUCI_PAY_TO, "40000")], { description: "Pay-per-prompt: a Fuci agent answers your question" });
const snapshotChallenges: ChallengeReader = async (url, method) => ({
  "GET https://api.cra-agent.tech/v1/paid/fees/estimate": craRoute,
  "POST https://api.cra-agent.tech/v1/paid/ask": challenge([gatewayAccept(CRA_PAY_TO, "2000")], { description: "Ask about Arc gas" }, { type: "object", properties: { question: { type: "string" } } }),
  "POST https://fuci.example/api/agent/run": fuciRun,
  "GET https://apex.example/api/x402/watch": challenges["GET https://apex.example/api/x402/watch"],
  "GET https://apex.example/api/x402/web-read": { status: 404, accepts: [], resource: null, inputSchema: null },
} as Record<string, ChallengeRead | null>)[`${method} ${url}`] ?? null;
let snapshot: ArcRegistrySnapshot;
{
  let clock = Date.parse("2026-09-26T02:43:00.000Z");
  snapshot = await takeArcRegistrySnapshot({ reader, fetchJson, readChallenge: snapshotChallenges, clock: () => clock++ });
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.takenAt, "2026-09-26T02:43:00.000Z");
  const resources = snapshot.offers.map((offer) => offer.resource).sort();
  assert.deepEqual(resources, [
    "https://apex.example/api/x402/watch",
    "https://api.cra-agent.tech/v1/paid/ask",
    "https://api.cra-agent.tech/v1/paid/claimed-by-apex",
    "https://api.cra-agent.tech/v1/paid/fees/estimate",
    "https://fuci.example/api/agent/run",
  ], "web-read answered 404 and was left out");
  assert.equal(snapshot.leftOut.noAccept, 1);
  const summary = summarizeArcRegistry(snapshot);
  assert.equal(summary.onArc, 5);
  assert.equal(summary.bothWays, 2);
  assert.deepEqual(summary.sellers.map((seller) => [seller.agentId, seller.offers, seller.bothWays]), [["0", 2, true], ["1", 1, false], ["3", 2, false]]);

  clearArcRegistryMemory();
  assert.equal((await loadArcRegistryView()).state, "missing");
  assert.deepEqual(await saveArcRegistrySnapshot(snapshot), { saved: true });
  const fresh = await loadArcRegistryView({ now: new Date("2026-09-27T02:43:00.000Z") });
  assert.equal(fresh.state, "fresh");
  assert.equal(fresh.offers.length, 5);
  const stale = await loadArcRegistryView({ now: new Date("2026-09-29T03:00:00.000Z") });
  assert.equal(stale.state, "stale", "three days without a read");
  assert.equal(stale.offers.length, 0, "and a stale snapshot lends nothing");

  /* A newer read the clock cut short does not hide yesterday's whole one. */
  await saveArcRegistrySnapshot({ ...snapshot, takenAt: "2026-09-27T02:43:00.000Z", complete: false, offers: snapshot.offers.slice(0, 1) });
  const preferred = await loadArcRegistryView({ now: new Date("2026-09-27T03:00:00.000Z") });
  assert.equal(preferred.takenAt, "2026-09-26T02:43:00.000Z");
  assert.equal(preferred.offers.length, 5);
}

// --- registry offers in discovery ---
const circleDown = (async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch;
const circleEmpty = (async () => Response.json({ items: [], pagination: { total: 0 } })) as unknown as typeof fetch;
{
  const found = await discoverMarketplaceCandidates({ capability: "gas", network: ARC, fetchImpl: circleEmpty, registryOffers: snapshot.offers, limit: 10 });
  assert.deepEqual(found.candidates.map((c) => c.resource).sort(), [
    "https://api.cra-agent.tech/v1/paid/ask",
    "https://api.cra-agent.tech/v1/paid/fees/estimate",
  ], "matched on the term, locally");
  const estimate = found.candidates.find((c) => c.resource.endsWith("/fees/estimate"))!;
  assert.equal(estimate.foundIn, "erc8004_arc");
  assert.equal(estimate.erc8004?.binding, "both_ways");
  assert.equal(estimate.funding, "gateway_deposit");
  assert.equal(estimate.selectedAccept.asset, ARC_USDC, "the asset from Veyra's table");
  assert.equal(found.circleAnswered, true);
  assert.equal(found.catalogTotal, 2);

  const onBase = await discoverMarketplaceCandidates({ capability: "gas", network: BASE, fetchImpl: circleEmpty, registryOffers: snapshot.offers });
  assert.equal(onBase.candidates.length, 0, "the registry's snapshot is about Arc");

  const withoutCircle = await discoverMarketplaceCandidates({ capability: "gas", network: ARC, fetchImpl: circleDown, registryOffers: snapshot.offers });
  assert.equal(withoutCircle.circleAnswered, false);
  assert.equal(withoutCircle.candidates.length, 2, "Circle being down does not hide the registry");
  await assert.rejects(
    discoverMarketplaceCandidates({ capability: "weather", network: ARC, fetchImpl: circleDown, registryOffers: snapshot.offers }),
    /marketplace_discovery_unavailable/,
    "nothing answered: the same refusal as before",
  );

  /* A card is named after its endpoint, and the endpoint is found by id
     whatever the search term. */
  const runItem = registryItemFor(snapshot.offers.find((o) => o.resource.endsWith("/agent/run"))!, ARC)!;
  const runId = (await discoverMarketplaceCandidates({ capability: "prompt", network: ARC, fetchImpl: circleEmpty, registryOffers: snapshot.offers }))
    .candidates.find((c) => c.resource.endsWith("/agent/run"))?.candidateId;
  assert.ok(runItem && runId);
  const named = await discoverMarketplaceCandidates({ capability: "weather", network: ARC, fetchImpl: circleEmpty, registryOffers: snapshot.offers, mustInclude: runId });
  assert.equal(named.candidates[0]?.candidateId, runId);
  assert.equal(named.candidates[0]?.inputSchema !== null, true, "the manifest's request schema travels with it");

  /* Listed by Circle as well: one candidate, which also names the identity. */
  const sameInCircle = (async () => Response.json({ items: [{
    resource: "https://api.cra-agent.tech/v1/paid/fees/estimate",
    accepts: [{ scheme: "exact", network: ARC, asset: ARC_USDC, payTo: CRA_PAY_TO, amount: "500", extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: GATEWAY } }],
    metadata: { method: "GET", provider: { name: "CRA", tags: ["gas"] } },
  }], pagination: { total: 1 } })) as unknown as typeof fetch;
  const both = await discoverMarketplaceCandidates({ capability: "gas", network: ARC, fetchImpl: sameInCircle, registryOffers: snapshot.offers, limit: 10 });
  const estimates = both.candidates.filter((c) => c.resource.endsWith("/fees/estimate"));
  assert.equal(estimates.length, 1);
  assert.equal(estimates[0].foundIn, "circle_catalogue");
  assert.equal(estimates[0].erc8004?.agentId, "0");

  /* Circle's search matches inside words: "arc" finds "search". A brief asks
     for whole words; a purchase does not. */
  const substring = (async () => Response.json({ items: [{
    resource: "https://api.exa.ai/search",
    accepts: [{ scheme: "exact", network: ARC, asset: ARC_USDC, payTo: CRA_PAY_TO, amount: "7000", extra: { name: "USDC", version: "2" } }],
    metadata: { method: "POST", description: "Search the web with Exa", provider: { name: "Exa", tags: ["search"] } },
  }], pagination: { total: 1 } })) as unknown as typeof fetch;
  const loose = await discoverMarketplaceCandidates({ capability: "arc", network: ARC, fetchImpl: substring, registryOffers: [] });
  assert.equal(loose.candidates.length, 1, "Circle's answer, as it was");
  const strict = await discoverMarketplaceCandidates({ capability: "arc", network: ARC, fetchImpl: substring, registryOffers: [], requireWordMatch: true });
  assert.equal(strict.candidates.length, 0, "a search engine is not about Arc");
  const worded = await discoverMarketplaceCandidates({ capability: "search", network: ARC, fetchImpl: substring, registryOffers: [], requireWordMatch: true });
  assert.equal(worded.candidates.length, 1, "and it is about search");

  const walletOnly = await discoverMarketplaceCandidates({ capability: "gas", network: ARC, fetchImpl: circleEmpty, registryOffers: snapshot.offers, requireCircleGateway: true });
  assert.equal(walletOnly.candidates.length, 2, "Gateway offers stay when only Gateway is wanted");
  const unsignable: MarketOffer = { ...snapshot.offers[0], accepts: snapshot.offers[0].accepts.map((a) => ({ ...a, quotableByVeyra: false })) };
  assert.equal(registryItemFor(unsignable, ARC), null, "an accept the wallet cannot sign is not carried");
}

// --- the brief: an askable registry offer becomes a card, and says where from ---
{
  assert.equal(worthWatching({ resource: "https://a.example/x", method: "GET", inputSchema: null }), false, "a GET cannot be asked anything");
  assert.equal(worthWatching({ resource: "https://a.example/x", method: "POST", inputSchema: { type: "object", properties: { question: { type: "string" } } } }), true);

  const view = await loadArcRegistryView({ now: new Date("2026-09-27T03:00:00.000Z") });
  const result = await observeX402Catalog({ interests: ["Arc"], fetchImpl: circleEmpty, registry: view });
  const cards = result.observations.map((o) => o.context.resource).sort();
  assert.deepEqual(cards, ["https://api.cra-agent.tech/v1/paid/ask", "https://fuci.example/api/agent/run"],
    "the POST offers with somewhere to put a question");
  assert.equal(cards.includes("https://api.cra-agent.tech/v1/paid/fees/estimate"), false, "a GET is not a card");
  for (const observation of result.observations) {
    assert.equal(observation.context.foundIn, "erc8004_arc");
    assert.ok(observation.context.erc8004);
  }
  assert.deepEqual(result.unavailable, []);

  const staleView = { state: "stale" as const, takenAt: "2026-09-20T00:00:00.000Z", complete: true, offers: [] };
  const blind = await observeX402Catalog({ interests: ["Arc"], fetchImpl: circleEmpty, registry: staleView });
  assert.deepEqual(blind.unavailable, ["ERC-8004 registry on Arc"], "a registry not read in three days is said to be unread");
  const down = await observeX402Catalog({ interests: ["Arc"], fetchImpl: circleDown, registry: view });
  assert.ok(down.unavailable.includes("Circle x402 catalog"), "Circle down is still said, even when the registry answered");
}

// --- what the card says ---
{
  assert.equal(listedWhere(null), "Listed in Circle's catalog");
  assert.equal(
    listedWhere({ foundIn: "erc8004_arc", erc8004: { agentId: "186", binding: "both_ways" } }),
    "Not in Circle's catalog: declared by agent #186 in the ERC-8004 registry on Arc, and the endpoint names that agent back",
  );
  assert.match(listedWhere({ foundIn: "erc8004_arc", erc8004: { agentId: "193", binding: "registry_only" } }), /does not name that agent back$/);
  assert.match(listedWhere({ foundIn: "circle_catalogue", erc8004: { agentId: "186", binding: "both_ways" } }), /^Listed in Circle's catalog, and declared by agent #186/);

  const [change] = changesForSubject({
    label: "Fuci agent run",
    previous: null,
    next: x402Digest({ priceAtomic: "40000", payTo: FUCI_PAY_TO, reachable: true, provider: "Fuci", network: ARC, funding: "gateway_deposit" }),
    now: new Date("2026-09-26T12:00:00.000Z"),
    listing: { foundIn: "erc8004_arc", erc8004: { agentId: "193", binding: "registry_only" } },
  });
  assert.match(change.detail, /from Fuci\. Not in Circle's catalog: declared by agent #193 in the ERC-8004 registry on Arc; the endpoint does not name that agent back\.$/);

  const card = (subject: Record<string, unknown> | undefined) => listingSource({ evidence: subject ? { subject } : {} });
  assert.equal(card({ resource: "https://x.example", foundIn: "erc8004_arc", erc8004: { agentId: "186", binding: "both_ways" } }), "ERC-8004 #186 · confirmed both ways");
  assert.equal(card({ resource: "https://x.example", foundIn: "erc8004_arc", erc8004: { agentId: "193", binding: "registry_only" } }), "ERC-8004 #193 · not confirmed by the endpoint");
  assert.equal(card({ resource: "https://x.example" }), "Circle catalogue", "a card from before the registry was read came from Circle");
  assert.equal(card({ url: "https://github.com/x/y" }), null, "not a paid listing");
  assert.equal(card(undefined), null);
}

console.log("PASS arc registry: batched read, binding by origin, each offer checked against its own challenge, a daily snapshot that goes stale, registry offers in discovery and in the brief, and cards that say where a listing came from.");
