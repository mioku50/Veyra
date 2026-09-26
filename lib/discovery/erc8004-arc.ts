/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { challengeSchemas, decodePaymentRequiredHeader, parseChallengeAccepts } from "../providers/x402-probe.ts";
import { fetchWithSsrfProtection } from "../seller/ssrf.ts";
import { bazaarBodySchema, bodySchema, offerFromCatalogueItem } from "./catalogues.ts";
import {
  ARC_FIRST,
  normalizeOfferAccept,
  type DiscoveryNetwork,
  type Erc8004Binding,
  type MarketOffer,
  type OfferAccept,
  type OfferInput,
} from "./offers.ts";

/**
 * Sellers found through the ERC-8004 identity registry on Arc mainnet.
 *
 * Registration is permissionless, so a registry entry says only that someone
 * paid gas to publish a file. Of 192 identities on 2026-09-23, 7 declared x402
 * support and two sold standard x402 on Arc -- neither of them in Circle's
 * catalogue or the Bazaar. Many carried template names and no services at all.
 * On 2026-09-26 there were 232 identities and 14 declared x402.
 *
 * What this reads, and nothing else:
 * - the identity registry's `ownerOf` and `tokenURI`, through a reader the
 *   caller supplies (so tests need no chain and the RPC stays the caller's);
 * - each registration file, over HTTPS through the SSRF-safe transport, over
 *   IPFS through a fixed gateway list, or from a `data:` URI parsed locally;
 * - the x402 endpoints the file declares, in the three shapes sellers actually
 *   publish: a Bazaar-style catalogue (`{items: [...]}`), a `/.well-known/x402`
 *   manifest with `routes`, and one with `resources` that carry their accepts;
 *   or an endpoint that is itself paid and answers with a 402;
 * - each offer's own unpaid 402 challenge, when the caller asks for it.
 *
 * A route from a manifest has no accept, so it becomes an offer with a
 * declared price and nothing to sign; only a live challenge can price it.
 * A 402 that is not x402 `exact` (a "send USDC, then retry" API) is never an
 * offer, because nothing binds a plain transfer to the request it pays for.
 */

export const ARC_IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
export const ARC_REGISTRY_REF = `eip155:5042:${ARC_IDENTITY_REGISTRY}`.toLowerCase();

export const ERC8004_LIMITS = {
  maxAgents: 1_000,
  maxFileBytes: 64 * 1024,
  maxCatalogueBytes: 2 * 1024 * 1024,
  maxChallengeBytes: 256 * 1024,
  timeoutMs: 10_000,
  ipfsGateways: ["https://ipfs.io/ipfs/", "https://dweb.link/ipfs/"],
  /** Files and endpoints read at once. Mostly different hosts, so a few at a
   *  time keeps one slow host from holding the whole read. */
  concurrency: 6,
  offersPerEndpoint: 500,
  /** Unpaid challenges per read, and how many at once. */
  challengesPerRead: 150,
  challengeConcurrency: 4,
} as const;

export type IdentityRegistryReader = {
  /** True when the id has an owner; false when `ownerOf` reverts. */
  exists(agentId: number): Promise<boolean>;
  tokenURI(agentId: number): Promise<string | null>;
  /** Many URIs in one call, when the reader can batch (Multicall3). A null
   *  entry is an id whose URI could not be read. */
  tokenURIs?(agentIds: number[]): Promise<Array<string | null>>;
};

export type JsonFetcher = (url: string, maxBytes: number) => Promise<unknown>;

/** HTTPS through the SSRF-safe transport, bounded in time and size. */
export const ssrfJsonFetcher: JsonFetcher = async (url, maxBytes) => {
  const response = await fetchWithSsrfProtection(url, {
    method: "GET",
    headers: { accept: "application/json" },
  }, { maxTimeoutMs: ERC8004_LIMITS.timeoutMs, maxResponseSizeBytes: maxBytes });
  if (!response.ok) throw new Error(`http_${response.status}`);
  return JSON.parse(await response.text());
};

/** What an endpoint says when asked without payment. */
export type ChallengeRead = {
  status: number;
  /** The x402 accepts as the endpoint published them. Empty when the 402 is
   *  not x402, or when the answer was not a 402 at all. */
  accepts: Array<Record<string, unknown>>;
  /** x402 v2's resource descriptor: description, serviceName, tags. */
  resource: Record<string, unknown> | null;
  inputSchema: Record<string, unknown> | null;
};

/** Null when the endpoint could not be reached. */
export type ChallengeReader = (url: string, method: "GET" | "POST") => Promise<ChallengeRead | null>;

/**
 * One unpaid request, the same one Veyra's probe makes before any purchase:
 * no payment header, and for a POST an empty JSON body. Nothing is signed.
 */
export const ssrfChallengeReader: ChallengeReader = async (url, method) => {
  const init: RequestInit = method === "POST"
    ? { method, headers: { accept: "application/json", "content-type": "application/json" }, body: "{}" }
    : { method, headers: { accept: "application/json" } };
  let response: Response;
  try {
    response = await fetchWithSsrfProtection(url, init, {
      maxTimeoutMs: ERC8004_LIMITS.timeoutMs,
      maxResponseSizeBytes: ERC8004_LIMITS.maxChallengeBytes,
      label: "erc8004_arc_challenge",
    });
  } catch {
    return null;
  }
  if (response.status !== 402) return { status: response.status, accepts: [], resource: null, inputSchema: null };
  let challenge = decodePaymentRequiredHeader(response.headers.get("payment-required"));
  if (!parseChallengeAccepts(challenge)) {
    try { challenge = JSON.parse(await response.text()); } catch { challenge = null; }
  }
  const accepts = parseChallengeAccepts(challenge) ?? [];
  const body = asRecord(challenge);
  return {
    status: 402,
    accepts,
    resource: asRecord(body?.resource),
    inputSchema: challengeSchemas(accepts).input ?? bazaarBodySchema(body?.extensions),
  };
};

/**
 * How many identities exist. Ids are minted in sequence from zero, so this is
 * the first id `ownerOf` refuses, found by doubling then halving: tens of calls
 * where scanning mint events would take hundreds on a rate-limited RPC.
 */
export async function countIdentities(reader: IdentityRegistryReader, cap: number = ERC8004_LIMITS.maxAgents): Promise<number> {
  if (!(await reader.exists(0))) return 0;
  let low = 0;
  let high = 1;
  while (high < cap && await reader.exists(high)) {
    low = high;
    high = Math.min(high * 2, cap);
  }
  if (high >= cap && await reader.exists(cap - 1)) return cap;
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    if (await reader.exists(mid)) low = mid;
    else high = mid;
  }
  return low + 1;
}

/** A registration file from its URI, or null when it cannot be read safely. */
export async function readRegistrationFile(uri: string, fetchJson: JsonFetcher): Promise<Record<string, unknown> | null> {
  try {
    if (uri.startsWith("data:")) {
      const comma = uri.indexOf(",");
      if (comma < 0 || uri.length > ERC8004_LIMITS.maxFileBytes * 2) return null;
      const payload = uri.slice(comma + 1);
      const decoded = uri.slice(0, comma).includes(";base64")
        ? Buffer.from(payload, "base64").toString("utf8")
        : decodeURIComponent(payload);
      if (decoded.length > ERC8004_LIMITS.maxFileBytes) return null;
      return asRecord(JSON.parse(decoded));
    }
    if (uri.startsWith("ipfs://")) {
      const path = uri.slice("ipfs://".length).replace(/^ipfs\//, "");
      if (!/^[A-Za-z0-9]{20,100}(\/[\w.\-/]*)?$/.test(path)) return null;
      for (const gateway of ERC8004_LIMITS.ipfsGateways) {
        try { return asRecord(await fetchJson(`${gateway}${path}`, ERC8004_LIMITS.maxFileBytes)); }
        catch { /* the next gateway */ }
      }
      return null;
    }
    if (uri.startsWith("https://")) return asRecord(await fetchJson(uri, ERC8004_LIMITS.maxFileBytes));
    return null;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown, max = 500): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function originOf(url: string): string | null {
  try { return new URL(url).origin; } catch { return null; }
}

export type DeclaredService = { name: string; endpoint: string };

/** The services a registration file declares that could lead to x402 offers. */
export function x402Services(file: Record<string, unknown>): DeclaredService[] {
  const list = Array.isArray(file.services) ? file.services : Array.isArray(file.endpoints) ? file.endpoints : [];
  const out: DeclaredService[] = [];
  for (const raw of list) {
    const service = asRecord(raw);
    const name = typeof service?.name === "string" ? service.name.trim().toLowerCase() : "";
    const endpoint = typeof service?.endpoint === "string" ? service.endpoint.trim() : "";
    if (!endpoint.startsWith("https://")) continue;
    if (name === "x402" || name === "x402-catalogue") out.push({ name, endpoint });
  }
  return out;
}

/** Whether a manifest names this identity back. */
export function manifestNamesAgent(manifest: Record<string, unknown>, agentId: number): boolean {
  const claim = asRecord(manifest.erc8004);
  if (!claim) return false;
  return String(claim.agentId) === String(agentId)
    && String(claim.agentRegistry ?? "").toLowerCase() === ARC_REGISTRY_REF;
}

/** Routes of a `/.well-known/x402` manifest as offers with a declared price. */
export function offersFromManifest(
  manifest: Record<string, unknown>,
  manifestUrl: string,
  erc8004: Erc8004Binding,
): OfferInput[] {
  const routes = Array.isArray(manifest.routes) ? manifest.routes : [];
  const origin = new URL(manifestUrl).origin;
  const out: OfferInput[] = [];
  for (const raw of routes.slice(0, 200)) {
    const route = asRecord(raw);
    const match = /^(GET|POST)\s+(\/[^\s?#]*)$/.exec(String(route?.pattern ?? "").trim());
    if (!match) continue;
    const price = Number(route?.priceUsd);
    out.push({
      resource: `${origin}${match[2]}`,
      method: match[1] as "GET" | "POST",
      provider: typeof manifest.name === "string" ? manifest.name : null,
      description: typeof route?.description === "string" ? route.description : null,
      accepts: [],
      declaredPriceUsd: Number.isFinite(price) && price >= 0 ? price : null,
      erc8004,
      listing: { source: "erc8004", listedAt: null },
    });
  }
  return out;
}

/**
 * A request schema from the field map some manifests publish instead of one:
 * Fuci's `{"prompt": {"type": "string", "description": "..."}}`. Nothing is
 * marked required, because the manifest does not say so.
 */
function schemaFromFieldMap(value: unknown): Record<string, unknown> | null {
  const fields = asRecord(value);
  if (!fields) return null;
  if (fields.type === "object" && asRecord(fields.properties)) return bodySchema(fields);
  const properties: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(fields).slice(0, 40)) {
    const field = asRecord(raw);
    if (!/^[A-Za-z_][\w-]{0,63}$/.test(name) || !field || typeof field.type !== "string") continue;
    properties[name] = {
      type: field.type,
      ...(typeof field.description === "string" ? { description: field.description.slice(0, 300) } : {}),
    };
  }
  return Object.keys(properties).length > 0 ? { type: "object", properties } : null;
}

/**
 * `resources` of a `/.well-known/x402` manifest, each with its own URL, method,
 * price and accepts: the shape Fuci publishes. APEX's manifest also has a
 * `resources` key, holding bare URL strings; those are skipped here and read
 * from its catalogue instead.
 */
export function offersFromResourceManifest(
  manifest: Record<string, unknown>,
  erc8004: Erc8004Binding,
  networks: readonly DiscoveryNetwork[] = ARC_FIRST,
): OfferInput[] {
  const resources = Array.isArray(manifest.resources) ? manifest.resources : [];
  const out: OfferInput[] = [];
  for (const raw of resources.slice(0, 200)) {
    const entry = asRecord(raw);
    const resource = text(entry?.url, 2_000);
    if (!entry || !resource?.startsWith("https://")) continue;
    const method = String(entry.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "POST") continue;
    const price = Number(String(entry.price ?? "").replace(/^\$/, ""));
    out.push({
      resource,
      method,
      provider: text(manifest.name, 120),
      description: text(entry.description) ?? text(entry.name),
      accepts: (Array.isArray(entry.accepts) ? entry.accepts : [])
        .map((accept) => normalizeOfferAccept(accept, networks))
        .filter((accept): accept is OfferAccept => accept !== null),
      declaredPriceUsd: Number.isFinite(price) && price >= 0 ? price : null,
      erc8004,
      listing: { source: "erc8004", listedAt: null },
      inputSchema: schemaFromFieldMap(entry.input),
    });
  }
  return out;
}

/** An endpoint that is itself paid, as its own challenge describes it. */
export function offerFromChallenge(
  resource: string,
  method: "GET" | "POST",
  challenge: ChallengeRead,
  erc8004: Erc8004Binding | null,
  networks: readonly DiscoveryNetwork[] = ARC_FIRST,
): OfferInput | null {
  if (challenge.status !== 402) return null;
  const accepts = challenge.accepts
    .map((accept) => normalizeOfferAccept(accept, networks))
    .filter((accept): accept is OfferAccept => accept !== null);
  if (accepts.length === 0) return null;
  return {
    resource,
    method,
    provider: text(challenge.resource?.serviceName, 120),
    description: text(challenge.resource?.description),
    accepts,
    declaredPriceUsd: null,
    erc8004,
    listing: { source: "erc8004", listedAt: null },
    tags: strings(challenge.resource?.tags),
    inputSchema: challenge.inputSchema,
  };
}

async function mapLimit<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  }));
}

export type Erc8004ReadResult = {
  identities: number;
  filesRead: number;
  filesUnreadable: number;
  declaringX402: number[];
  /** Declared x402 endpoints that could not be read, or read as no offer. */
  endpointsUnreadable: number;
  offers: OfferInput[];
  /** False when the deadline stopped the read before every file and endpoint
   *  was reached. What was read is still returned. */
  complete: boolean;
};

type EndpointBody =
  | { kind: "json"; body: Record<string, unknown> }
  | { kind: "challenge"; challenge: ChallengeRead }
  | { kind: "unreadable" };

export async function readArcErc8004Offers(input: {
  reader: IdentityRegistryReader;
  fetchJson?: JsonFetcher;
  /** For a declared endpoint that is itself paid. Without it such an endpoint
   *  counts as unreadable. */
  readChallenge?: ChallengeReader;
  networks?: readonly DiscoveryNetwork[];
  maxAgents?: number;
  /** Epoch milliseconds after which no new request starts. */
  deadline?: number;
  clock?: () => number;
}): Promise<Erc8004ReadResult> {
  const fetchJson = input.fetchJson ?? ssrfJsonFetcher;
  const networks = input.networks ?? ARC_FIRST;
  const clock = input.clock ?? Date.now;
  let complete = true;
  const late = () => {
    if (input.deadline === undefined || clock() <= input.deadline) return false;
    complete = false;
    return true;
  };

  const identities = await countIdentities(input.reader, Math.min(input.maxAgents ?? ERC8004_LIMITS.maxAgents, ERC8004_LIMITS.maxAgents));
  const result: Erc8004ReadResult = {
    identities, filesRead: 0, filesUnreadable: 0, declaringX402: [], endpointsUnreadable: 0, offers: [], complete: true,
  };
  const ids = Array.from({ length: identities }, (_, id) => id);

  /* Every URI first: through Multicall3 a few calls cover every identity,
     where one call per id took most of five minutes on the public RPC. */
  const uris: Array<string | null> = new Array(identities).fill(null);
  if (input.reader.tokenURIs) {
    for (let start = 0; start < identities && !late(); start += 100) {
      const batch = ids.slice(start, start + 100);
      const read = await input.reader.tokenURIs(batch);
      batch.forEach((id, index) => { uris[id] = read[index] ?? null; });
    }
  } else {
    for (const id of ids) {
      if (late()) break;
      uris[id] = await input.reader.tokenURI(id);
    }
  }

  /* One file is often shared by many identities; each is read once. */
  const files = new Map<string, Record<string, unknown> | null>();
  const distinctUris = [...new Set(uris.filter((uri): uri is string => Boolean(uri)))];
  await mapLimit(distinctUris, ERC8004_LIMITS.concurrency, async (uri) => {
    if (late()) return;
    files.set(uri, await readRegistrationFile(uri, fetchJson));
  });

  const declared = new Map<number, { name: string | null; services: DeclaredService[] }>();
  for (const id of ids) {
    const uri = uris[id];
    const file = uri ? files.get(uri) ?? null : null;
    if (!file) { result.filesUnreadable += 1; continue; }
    result.filesRead += 1;
    if (file.x402Support === true) result.declaringX402.push(id);
    const services = x402Services(file);
    if (services.length > 0) declared.set(id, { name: text(file.name, 120), services });
  }

  /* One endpoint is often declared by many identities (nine of Fuci's point at
     one manifest); each is read once. */
  const bodies = new Map<string, EndpointBody>();
  const endpoints = [...new Set([...declared.values()].flatMap((agent) => agent.services.map((s) => s.endpoint)))];
  await mapLimit(endpoints, ERC8004_LIMITS.concurrency, async (endpoint) => {
    if (late()) return;
    try {
      const body = asRecord(await fetchJson(endpoint, ERC8004_LIMITS.maxCatalogueBytes));
      bodies.set(endpoint, body ? { kind: "json", body } : { kind: "unreadable" });
    } catch (error) {
      /* APEX's watchtower declares a paid endpoint as its x402 service: the
         answer is a 402, and the challenge is the offer. */
      const challenge = error instanceof Error && error.message === "http_402" && input.readChallenge
        ? await input.readChallenge(endpoint, "GET")
        : null;
      bodies.set(endpoint, challenge?.status === 402 ? { kind: "challenge", challenge } : { kind: "unreadable" });
    }
  });

  for (const [agentId, agent] of declared) {
    /* Both ways only for an endpoint on an origin whose own manifest names
       this identity back. A catalogue can list anyone's URLs, and a manifest
       that names an identity speaks for its own host, nobody else's. */
    const naming = new Set<string>();
    for (const service of agent.services) {
      const read = bodies.get(service.endpoint);
      if (read?.kind === "json" && manifestNamesAgent(read.body, agentId)) {
        const origin = originOf(service.endpoint);
        if (origin) naming.add(origin);
      }
    }
    const bindingFor = (resource: string): Erc8004Binding => ({
      agentId: String(agentId),
      registry: ARC_REGISTRY_REF,
      binding: naming.has(originOf(resource) ?? "") ? "both_ways" : "registry_only",
    });
    const own = (offer: OfferInput): OfferInput => ({
      ...offer,
      /* APEX's catalogue names no seller; its registration does. */
      provider: offer.provider ?? agent.name,
      erc8004: bindingFor(offer.resource),
    });

    for (const service of agent.services) {
      const read = bodies.get(service.endpoint);
      if (!read || read.kind === "unreadable") { result.endpointsUnreadable += 1; continue; }
      const before = result.offers.length;
      if (read.kind === "challenge") {
        const offer = offerFromChallenge(service.endpoint, "GET", read.challenge, null, networks);
        if (offer) result.offers.push(own(offer));
      } else if (Array.isArray(read.body.items)) {
        for (const item of read.body.items.slice(0, ERC8004_LIMITS.offersPerEndpoint)) {
          const offer = offerFromCatalogueItem(item, "erc8004", networks);
          if (offer) result.offers.push(own(offer));
        }
      } else if (Array.isArray(read.body.routes)) {
        for (const offer of offersFromManifest(read.body, service.endpoint, bindingFor(service.endpoint))) result.offers.push(own(offer));
      } else if (Array.isArray(read.body.resources)) {
        for (const offer of offersFromResourceManifest(read.body, bindingFor(service.endpoint), networks)) result.offers.push(own(offer));
      }
      if (result.offers.length === before) result.endpointsUnreadable += 1;
    }
  }
  result.complete = complete;
  return result;
}

/**
 * Each offer checked against what its endpoint says now, without paying.
 *
 * A registration file, a manifest and a catalogue are the seller's claims, and
 * they disagree with the endpoint more often than a catalogue does: CRA's
 * manifest lists prices and no accepts at all, and Fuci's lists a Gateway
 * accept that names no verifying contract while its live challenge names
 * Circle's GatewayWallet. So the endpoint's own challenge decides:
 * - a 402 with x402 accepts replaces the listed accepts, and lends its
 *   description, tags and request schema;
 * - a 402 that is not x402, or a 404 or 410, leaves no accepts, and the offer
 *   is dropped;
 * - anything else (a 400 for missing parameters, a 405, a timeout) leaves the
 *   listing as it was, because it does not say the listing is wrong.
 *
 * This is not a substitute for the probe before a purchase. The terms that can
 * be signed are still read from the live challenge for the exact request.
 */
export async function confirmWithChallenges(offers: MarketOffer[], input: {
  readChallenge: ChallengeReader;
  networks?: readonly DiscoveryNetwork[];
  max?: number;
  deadline?: number;
  clock?: () => number;
}): Promise<{ offers: MarketOffer[]; confirmed: number; unconfirmed: number; notChecked: number }> {
  const networks = input.networks ?? ARC_FIRST;
  const clock = input.clock ?? Date.now;
  const max = Math.min(input.max ?? ERC8004_LIMITS.challengesPerRead, ERC8004_LIMITS.challengesPerRead);
  const out = offers.map((offer) => ({ ...offer, accepts: [...offer.accepts], tags: [...offer.tags] }));
  const due = out.filter((offer) => !offer.templated);
  const counts = { confirmed: 0, unconfirmed: 0, notChecked: Math.max(0, due.length - max) };

  await mapLimit(due.slice(0, max), ERC8004_LIMITS.challengeConcurrency, async (offer) => {
    if (input.deadline !== undefined && clock() > input.deadline) { counts.notChecked += 1; return; }
    const challenge = await input.readChallenge(offer.resource, offer.method);
    if (!challenge) { counts.unconfirmed += 1; return; }
    if (challenge.status === 404 || challenge.status === 410) {
      counts.confirmed += 1;
      offer.accepts = [];
      return;
    }
    if (challenge.status !== 402) { counts.unconfirmed += 1; return; }
    counts.confirmed += 1;
    const accepts: OfferAccept[] = [];
    for (const raw of challenge.accepts) {
      const accept = normalizeOfferAccept(raw, networks);
      if (!accept) continue;
      if (accepts.some((a) => a.network === accept.network && a.rail === accept.rail
        && a.payTo === accept.payTo && a.amountAtomic === accept.amountAtomic)) continue;
      accepts.push(accept);
    }
    offer.accepts = accepts;
    offer.description = text(challenge.resource?.description) ?? offer.description;
    offer.provider ??= text(challenge.resource?.serviceName, 120);
    offer.tags = [...new Set([...offer.tags, ...strings(challenge.resource?.tags).map((tag) => tag.trim().toLowerCase()).filter(Boolean)])].slice(0, 20);
    offer.inputSchema = challenge.inputSchema ?? offer.inputSchema;
  });
  return { offers: out, ...counts };
}
