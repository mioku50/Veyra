/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { fetchWithSsrfProtection } from "../seller/ssrf.ts";
import { offerFromCatalogueItem } from "./catalogues.ts";
import { ARC_FIRST, type DiscoveryNetwork, type Erc8004Binding, type OfferInput } from "./offers.ts";

/**
 * Sellers found through the ERC-8004 identity registry on Arc mainnet.
 *
 * Registration is permissionless, so a registry entry says only that someone
 * paid gas to publish a file. Of 192 identities on 2026-09-23, 7 declared x402
 * support and two sold standard x402 on Arc -- neither of them in Circle's
 * catalogue or the Bazaar. Many carried template names and no services at all.
 *
 * What this reads, and nothing else:
 * - the identity registry's `ownerOf` and `tokenURI`, through a reader the
 *   caller supplies (so tests need no chain and the RPC stays the caller's);
 * - each registration file, over HTTPS through the SSRF-safe transport, over
 *   IPFS through a fixed gateway list, or from a `data:` URI parsed locally;
 * - the x402 endpoints the file declares, in the two shapes sellers actually
 *   publish: a Bazaar-style catalogue (`{items: [...]}`), and a
 *   `/.well-known/x402` manifest with `routes`.
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
  timeoutMs: 10_000,
  ipfsGateways: ["https://ipfs.io/ipfs/", "https://dweb.link/ipfs/"],
} as const;

export type IdentityRegistryReader = {
  /** True when the id has an owner; false when `ownerOf` reverts. */
  exists(agentId: number): Promise<boolean>;
  tokenURI(agentId: number): Promise<string | null>;
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

export type Erc8004ReadResult = {
  identities: number;
  filesRead: number;
  filesUnreadable: number;
  declaringX402: number[];
  offers: OfferInput[];
};

export async function readArcErc8004Offers(input: {
  reader: IdentityRegistryReader;
  fetchJson?: JsonFetcher;
  networks?: readonly DiscoveryNetwork[];
  maxAgents?: number;
}): Promise<Erc8004ReadResult> {
  const fetchJson = input.fetchJson ?? ssrfJsonFetcher;
  const networks = input.networks ?? ARC_FIRST;
  const identities = await countIdentities(input.reader, Math.min(input.maxAgents ?? ERC8004_LIMITS.maxAgents, ERC8004_LIMITS.maxAgents));
  const result: Erc8004ReadResult = { identities, filesRead: 0, filesUnreadable: 0, declaringX402: [], offers: [] };
  /* One file is often shared by many identities; read each once. */
  const files = new Map<string, Record<string, unknown> | null>();

  for (let agentId = 0; agentId < identities; agentId += 1) {
    const uri = await input.reader.tokenURI(agentId);
    if (!uri) { result.filesUnreadable += 1; continue; }
    if (!files.has(uri)) files.set(uri, await readRegistrationFile(uri, fetchJson));
    const file = files.get(uri) ?? null;
    if (!file) { result.filesUnreadable += 1; continue; }
    result.filesRead += 1;
    if (file.x402Support === true) result.declaringX402.push(agentId);

    for (const service of x402Services(file)) {
      let body: Record<string, unknown> | null = null;
      try { body = asRecord(await fetchJson(service.endpoint, ERC8004_LIMITS.maxCatalogueBytes)); }
      catch { body = null; }
      if (!body) continue;
      const bothWays = manifestNamesAgent(body, agentId);
      const erc8004: Erc8004Binding = {
        agentId: String(agentId),
        registry: ARC_REGISTRY_REF,
        binding: bothWays ? "both_ways" : "registry_only",
      };
      if (Array.isArray(body.items)) {
        for (const item of body.items.slice(0, 500)) {
          const offer = offerFromCatalogueItem(item, "erc8004", networks);
          if (offer) result.offers.push({ ...offer, erc8004 });
        }
      } else if (Array.isArray(body.routes)) {
        result.offers.push(...offersFromManifest(body, service.endpoint, erc8004));
      }
    }
  }
  return result;
}
