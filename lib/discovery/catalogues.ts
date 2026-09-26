/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ARC_FIRST,
  normalizeOfferAccept,
  type DiscoveryNetwork,
  type OfferInput,
  type OfferSource,
} from "./offers.ts";

/**
 * The two x402 catalogues, read per network and bounded.
 *
 * Circle's Discovery API filters by network, so it is asked once per network
 * the caller allows, Arc first. The Coinbase Bazaar has no network filter and
 * holds about seventeen thousand listings, so it is read page by page up to a
 * cap and filtered here; a caller that needs it often should keep a snapshot
 * rather than download it per request.
 *
 * Both hosts are fixed, first-party indexers. What they return is still a
 * seller's claim relayed by a third party, and is treated as such downstream.
 */

export const CIRCLE_DISCOVERY_URL = "https://api.circle.com/v2/x402/discovery/resources";
export const BAZAAR_DISCOVERY_URL = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";

export const CATALOGUE_LIMITS = {
  circlePageSize: 200,
  circleMaxPages: 5,
  bazaarPageSize: 1_000,
  bazaarMaxPages: 20,
  timeoutMs: 30_000,
} as const;

export class CatalogueUnavailableError extends Error {
  constructor(readonly source: OfferSource, readonly status: number | null) {
    super(`${source}_catalogue_unavailable${status ? `_${status}` : ""}`);
    this.name = "CatalogueUnavailableError";
  }
}

type Fetch = typeof fetch;

async function getJson(url: string, source: OfferSource, fetchImpl: Fetch): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("catalogue_timeout")), CATALOGUE_LIMITS.timeoutMs);
  try {
    const response = await fetchImpl(url, { headers: { accept: "application/json" }, signal: controller.signal });
    if (!response.ok) throw new CatalogueUnavailableError(source, response.status);
    const body = await response.json();
    if (!body || typeof body !== "object") throw new CatalogueUnavailableError(source, null);
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof CatalogueUnavailableError) throw error;
    throw new CatalogueUnavailableError(source, null);
  } finally {
    clearTimeout(timer);
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * One catalogue item as an offer, or null when it cannot be one: not HTTPS,
 * not GET or POST (Veyra's transport sends only those, and an unpaid DELETE is
 * not a probe), or no USDC accept Veyra recognises on an allowed network.
 */
export function offerFromCatalogueItem(
  raw: unknown,
  source: OfferSource,
  networks: readonly DiscoveryNetwork[] = ARC_FIRST,
): OfferInput | null {
  const item = asRecord(raw);
  const resource = text(item.resource);
  if (!resource || !resource.startsWith("https://")) return null;
  const metadata = asRecord(item.metadata);
  const bazaarInfo = asRecord(asRecord(asRecord(item.extensions).bazaar).info);
  const bazaarInput = asRecord(bazaarInfo.input);
  const method = String(metadata.method ?? bazaarInput.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "POST") return null;
  const accepts = (Array.isArray(item.accepts) ? item.accepts : [])
    .map((accept) => normalizeOfferAccept(accept, networks))
    .filter((accept): accept is NonNullable<typeof accept> => accept !== null);
  if (accepts.length === 0) return null;
  const provider = asRecord(metadata.provider);
  return {
    resource,
    method,
    provider: text(provider.name) ?? text(metadata.provider) ?? null,
    /* APEX's catalogue says what a route does only in the Bazaar extension's
       output description. */
    description: text(metadata.description) ?? text(item.description) ?? text(asRecord(bazaarInfo.output).description),
    accepts,
    declaredPriceUsd: null,
    erc8004: null,
    listing: { source, listedAt: text(item.lastUpdated) },
    tags: [...strings(provider.tags), ...strings(metadata.tags)],
    inputSchema: bodySchema(asRecord(metadata.input).body) ?? bazaarBodySchema(item.extensions),
  };
}

/** The Bazaar extension's JSON schema for a request body. Its `info.input.body`
 *  is an example, not a schema. */
export function bazaarBodySchema(extensions: unknown): Record<string, unknown> | null {
  const schema = asRecord(asRecord(asRecord(extensions).bazaar).schema);
  return bodySchema(asRecord(asRecord(asRecord(schema.properties).input).properties).body);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** A request schema only when it names fields: `{}` promises nothing. */
export function bodySchema(value: unknown): Record<string, unknown> | null {
  const schema = asRecord(value);
  return Object.keys(asRecord(schema.properties)).length > 0 ? schema : null;
}

export async function readCircleCatalogue(input: {
  networks?: readonly DiscoveryNetwork[];
  query?: string;
  fetchImpl?: Fetch;
  maxPages?: number;
}): Promise<{ offers: OfferInput[]; listed: Record<string, number> }> {
  const networks = input.networks ?? ARC_FIRST;
  const fetchImpl = input.fetchImpl ?? fetch;
  const maxPages = Math.min(input.maxPages ?? CATALOGUE_LIMITS.circleMaxPages, CATALOGUE_LIMITS.circleMaxPages);
  const offers: OfferInput[] = [];
  const listed: Record<string, number> = {};
  for (const network of networks) {
    for (let page = 0; page < maxPages; page += 1) {
      const url = new URL(CIRCLE_DISCOVERY_URL);
      url.searchParams.set("network", network);
      url.searchParams.set("type", "http");
      url.searchParams.set("siwx", "false");
      if (input.query) url.searchParams.set("query", input.query);
      url.searchParams.set("limit", String(CATALOGUE_LIMITS.circlePageSize));
      url.searchParams.set("offset", String(page * CATALOGUE_LIMITS.circlePageSize));
      const body = await getJson(url.toString(), "circle", fetchImpl);
      const items = Array.isArray(body.items) ? body.items : [];
      listed[network] = Number(asRecord(body.pagination).total) || listed[network] || items.length;
      /* Only this network's accepts: a listing found by asking for Arc still
         carries its Base accepts, and those are counted when Base is asked. */
      for (const item of items) {
        const offer = offerFromCatalogueItem(item, "circle", [network]);
        if (offer) offers.push(offer);
      }
      if (items.length < CATALOGUE_LIMITS.circlePageSize) break;
    }
  }
  return { offers, listed };
}

export async function readBazaar(input: {
  networks?: readonly DiscoveryNetwork[];
  fetchImpl?: Fetch;
  maxPages?: number;
}): Promise<{ offers: OfferInput[]; scanned: number; complete: boolean }> {
  const networks = input.networks ?? ARC_FIRST;
  const fetchImpl = input.fetchImpl ?? fetch;
  const maxPages = Math.min(input.maxPages ?? CATALOGUE_LIMITS.bazaarMaxPages, CATALOGUE_LIMITS.bazaarMaxPages);
  const offers: OfferInput[] = [];
  let scanned = 0;
  let total = Number.POSITIVE_INFINITY;
  for (let page = 0; page < maxPages && scanned < total; page += 1) {
    const url = new URL(BAZAAR_DISCOVERY_URL);
    url.searchParams.set("limit", String(CATALOGUE_LIMITS.bazaarPageSize));
    url.searchParams.set("offset", String(page * CATALOGUE_LIMITS.bazaarPageSize));
    const body = await getJson(url.toString(), "bazaar", fetchImpl);
    const items = Array.isArray(body.items) ? body.items : [];
    total = Number(asRecord(body.pagination).total) || scanned + items.length;
    scanned += items.length;
    for (const item of items) {
      const offer = offerFromCatalogueItem(item, "bazaar", networks);
      if (offer) offers.push(offer);
    }
    /* A short page is the end, whatever the total said a moment earlier:
       the catalogue grows while it is being read. */
    if (items.length < CATALOGUE_LIMITS.bazaarPageSize) { total = scanned; break; }
  }
  /* Said, not implied: a capped read of a growing catalogue is a sample. */
  return { offers, scanned, complete: scanned >= total };
}
