/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import { getByoaClient } from "../byoa/service.ts";
import { probeX402Resource, X402_PROBE_LIMITS } from "../providers/x402-probe.ts";
import { fetchWithSsrfProtection, validateUrlSsrf } from "../seller/ssrf.ts";
import { ARC_MAINNET_NETWORK, ARC_MAINNET_USDC_ADDRESS } from "../wallet/arc.ts";
import { arcPaymentOptions } from "../x402/trust-api/public-probe.ts";
import { expectationFromAccept, readAccept, resourceKeyFor } from "../x402/trust-api/resource.ts";
import { loadArcRegistryView } from "./arc-registry.ts";
import { CatalogueUnavailableError, readBazaar, readCircleCatalogue } from "./catalogues.ts";
import { isTemplatedResource, normalizeOfferAccept, type OfferAccept, type OfferInput, type OfferSource } from "./offers.ts";

const INDEX = "arc_offer_index";
const CHECKS = "arc_offer_checks";
const INDEX_WINDOW_MS = 7 * 86_400_000;
const SOURCE_ORDER: readonly OfferSource[] = ["circle", "bazaar", "erc8004"];
export const ARC_INDEX_PAGE_SIZE = 30;
export const RESOURCE_KEY_PATTERN = /^[0-9a-f]{64}$/;
const PUBLIC_FIELDS = "resource_key, resource, hostname, method, sources, listed_amount, listed_payee, listed_rail, listed_at, last_checked_at";
const PROBE_FIELDS = "checked_at, http_status, error_category, arc_challenge, live_amount, live_payee, live_rail, listed_amount, listed_payee, drift, failed_checks";

export type ArcOfferListing = {
  resource_key: string;
  resource: string;
  hostname: string;
  method: "GET" | "POST";
  sources: OfferSource[];
  listed_amount: string;
  listed_payee: string;
  listed_rail: OfferAccept["rail"];
  listed_at: string;
  last_checked_at?: string | null;
};

type ClaimedListing = ArcOfferListing & { lease_until: string };

export type ArcOfferCheck = {
  checked_at: string;
  http_status: number | null;
  error_category: string;
  arc_challenge: boolean;
  live_amount: string | null;
  live_payee: string | null;
  live_rail: OfferAccept["rail"] | null;
  listed_amount: string;
  listed_payee: string;
  drift: string[];
  failed_checks: string[];
};

type IndexedInput = Pick<OfferInput, "resource" | "method" | "accepts" | "listing">;

function publicResource(raw: string): URL | null {
  try {
    if (raw.length > 1_500 || isTemplatedResource(raw)) return null;
    const url = new URL(raw);
    url.hash = "";
    // Only stable public URLs. Query-bearing entries and IP literals are not
    // published or probed by the index.
    if (url.username || url.password || url.search || url.port || !/^[a-z0-9.-]+\.[a-z][a-z0-9-]*$/i.test(url.hostname)) return null;
    return validateUrlSsrf(url.href, { allowLocalhost: false });
  } catch {
    return null;
  }
}

export function indexArcListings(inputs: IndexedInput[], seenAt: string): ArcOfferListing[] {
  const byKey = new Map<string, ArcOfferListing>();
  for (const source of SOURCE_ORDER) {
    for (const offer of inputs) {
      if (offer.listing.source !== source) continue;
      const url = publicResource(offer.resource);
      if (!url || (offer.method !== "GET" && offer.method !== "POST")) continue;
      const accepts = offer.accepts.filter((accept) => accept.network === ARC_MAINNET_NETWORK
        && /^0x[0-9a-f]{40}$/.test(accept.payTo) && !/^0x0{40}$/.test(accept.payTo)
        && /^\d{1,30}$/.test(accept.amountAtomic)
        && (accept.rail === "wallet" || accept.rail === "gateway_deposit"));
      const accept = accepts.find((a) => a.rail === "wallet") ?? accepts[0];
      if (!accept) continue;

      const resourceKey = resourceKeyFor(offer.method, url.href);
      const previous = byKey.get(resourceKey);
      if (previous) {
        if (!previous.sources.includes(source)) previous.sources.push(source);
        continue;
      }
      byKey.set(resourceKey, {
        resource_key: resourceKey,
        resource: url.href,
        hostname: url.hostname,
        method: offer.method,
        sources: [source],
        listed_amount: BigInt(accept.amountAtomic).toString(),
        listed_payee: accept.payTo,
        listed_rail: accept.rail,
        listed_at: seenAt,
      });
    }
  }
  return [...byKey.values()];
}

export async function checkArcListing(
  listing: ArcOfferListing,
  options: { fetchImpl?: (url: string, init: RequestInit) => Promise<Response>; now?: Date } = {},
): Promise<ArcOfferCheck> {
  const gateway = listing.listed_rail === "gateway_deposit";
  const expectation = expectationFromAccept({
    candidateId: listing.resource_key,
    resource: listing.resource,
    method: listing.method,
    accept: {
      scheme: "exact",
      network: ARC_MAINNET_NETWORK,
      asset: ARC_MAINNET_USDC_ADDRESS,
      amountAtomic: listing.listed_amount,
      priceUsdc: Number(listing.listed_amount) / 1_000_000,
      payTo: listing.listed_payee,
      gatewayBatched: gateway,
      maxTimeoutSeconds: null,
    },
  });

  const probeFetch = (url: string, init: RequestInit) => {
    const signal = AbortSignal.timeout(5_000);
    return Promise.race([
      fetchWithSsrfProtection(url, { ...init, signal }, {
        maxTimeoutMs: 4_000,
        maxResponseSizeBytes: X402_PROBE_LIMITS.maxResponseBytes,
        allowLocalhostForTesting: false,
        label: "arc_offer_index",
      }),
      new Promise<never>((_, reject) => signal.addEventListener("abort",
        () => reject(new Error("arc_index_check_timeout")), { once: true })),
    ]);
  };
  let live: ReturnType<typeof readAccept> | undefined;
  const probe = await probeX402Resource(expectation, {
    ...options,
    fetchImpl: options.fetchImpl ?? probeFetch,
    filterAccepts(raw) {
      const arc = arcPaymentOptions(raw)
        .filter((entry) => normalizeOfferAccept(entry, [ARC_MAINNET_NETWORK]) !== null)
        .map((entry) => ({ entry, accept: readAccept(entry) }));
      const rail = arc.filter(({ accept }) => accept.gatewayBatched === gateway);
      const candidates = rail.length ? rail : arc;
      const selected = candidates.find(({ accept }) =>
        accept.payTo.toLowerCase() === listing.listed_payee && BigInt(accept.amountAtomic).toString() === listing.listed_amount)
        ?? candidates.find(({ accept }) => accept.payTo.toLowerCase() === listing.listed_payee)
        ?? candidates[0];
      live = selected?.accept;
      return selected ? [{ ...selected.entry, amount: BigInt(selected.accept.amountAtomic).toString() }] : [];
    },
  });
  const failedChecks = probe.checks.filter((check) => !check.passed).map((check) => check.id);
  const drift = probe.catalogDrift.filter((code) => code !== "price_changed");
  const amount = live ? BigInt(live.amountAtomic).toString() : null;
  if (amount && amount !== "0" && listing.listed_amount !== "0" && amount !== listing.listed_amount) drift.push("price_changed");
  if (live && live.gatewayBatched !== gateway) drift.push("rail_changed");
  if (drift.length && !failedChecks.includes("accepts_matches_catalog")) failedChecks.push("accepts_matches_catalog");

  return {
    checked_at: probe.probedAt,
    http_status: probe.httpStatus,
    error_category: probe.errorCategory,
    arc_challenge: probe.challengeParseable,
    // Empty-body requests can get a zero quote from a per-request pricing API.
    live_amount: amount === "0" ? null : amount,
    live_payee: live?.payTo.toLowerCase() ?? null,
    live_rail: live ? (live.gatewayBatched ? "gateway_deposit" : "wallet") : null,
    listed_amount: listing.listed_amount,
    listed_payee: listing.listed_payee,
    drift,
    failed_checks: failedChecks,
  };
}

export async function refreshArcOfferIndex() {
  const deadline = AbortSignal.timeout(135_000);
  const boundedFetch: typeof fetch = (url, init) => fetch(url, {
    ...init,
    redirect: "error",
    signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
  });
  const options = { networks: [ARC_MAINNET_NETWORK], inventory: true, fetchImpl: boundedFetch } as const;
  const [circle, bazaar, registry] = await Promise.allSettled([
    readCircleCatalogue({ ...options, signal: deadline }),
    readBazaar(options),
    loadArcRegistryView(),
  ]);
  const state = (result: PromiseSettledResult<{ complete: boolean }>) =>
    result.status === "rejected" ? "unavailable" : result.value.complete ? "complete" : "partial";
  const counts = {
    circle: state(circle),
    bazaar: state(bazaar),
    erc8004: registry.status === "fulfilled" && registry.value.state === "fresh" ? state(registry) : "unavailable",
  };
  const inputs: IndexedInput[] = [];
  if (circle.status === "fulfilled") inputs.push(...circle.value.offers);
  if (bazaar.status === "fulfilled") inputs.push(...bazaar.value.offers);
  if (registry.status === "fulfilled" && registry.value.state === "fresh") {
    for (const offer of registry.value.offers) {
      const listing = offer.listings.find((entry) => entry.source === "erc8004");
      if (listing) inputs.push({ ...offer, listing });
    }
  }
  const rows = indexArcListings(inputs, new Date().toISOString());
  const db = getByoaClient();
  for (let start = 0; start < rows.length; start += 200) {
    // Absent listings age out. A partial source read cannot delete another
    // catalogue's rows or reset a probe lease.
    const { error } = await db.from(INDEX).upsert(rows.slice(start, start + 200), { onConflict: "resource_key" })
      .abortSignal(AbortSignal.timeout(5_000));
    if (error) throw new Error("arc_index_write_failed");
  }
  const circlePageFailures = circle.status === "fulfilled"
    ? circle.value.pageFailures
    : circle.reason instanceof CatalogueUnavailableError
      ? [{ network: ARC_MAINNET_NETWORK, offset: 0, status: circle.reason.status, reason: circle.reason.reason }]
      : [];
  const circleRetries = circle.status === "fulfilled" ? circle.value.retries : 0;
  return {
    sources: counts,
    indexed: rows.length,
    available: Object.values(counts).some((value) => value !== "unavailable"),
    ...(circlePageFailures.length ? { circlePageFailures } : {}),
    ...(circleRetries ? { circleRetries } : {}),
  };
}

export async function runArcOfferChecks() {
  const db = getByoaClient();
  const claim = await db.rpc("claim_arc_offer_checks").abortSignal(AbortSignal.timeout(5_000));
  if (claim.error) throw new Error("arc_index_claim_failed");
  const rows = (claim.data ?? []) as ClaimedListing[];
  const byHost = new Map<string, ClaimedListing[]>();
  for (const row of rows) {
    const group = byHost.get(row.hostname) ?? [];
    group.push(row);
    byHost.set(row.hostname, group);
  }
  const hosts = [...byHost.values()];
  let checked = 0;
  const worker = async () => {
    for (let group = hosts.pop(); group; group = hosts.pop()) {
      for (const listing of group) {
        try {
          if (!publicResource(listing.resource)) continue;
          const check = await checkArcListing(listing);
          const saved = await db.rpc("save_arc_offer_check", {
            p_key: listing.resource_key,
            p_lease: listing.lease_until,
            p_check: check,
          }).abortSignal(AbortSignal.timeout(3_000));
          if (!saved.error && saved.data === true) checked += 1;
        } catch {
          // The lease makes an interrupted check eligible again.
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, hosts.length) }, worker));
  const { error } = await db.from(CHECKS).delete().lt("checked_at", new Date(Date.now() - 30 * 86_400_000).toISOString())
    .abortSignal(AbortSignal.timeout(5_000));
  return { claimed: rows.length, checked, failed: rows.length - checked, pruned: !error };
}

function since(ms: number) {
  return new Date(Date.now() - ms).toISOString();
}

export async function listArcOfferIndex(page: number, term: string) {
  try {
    let query = getByoaClient().from(INDEX).select(PUBLIC_FIELDS)
      .gte("listed_at", since(INDEX_WINDOW_MS))
      .order("resource_key", { ascending: true });
    if (term) query = query.ilike("resource", `%${term}%`);
    const start = (page - 1) * ARC_INDEX_PAGE_SIZE;
    const { data, error } = await query.range(start, start + ARC_INDEX_PAGE_SIZE).abortSignal(AbortSignal.timeout(3_000));
    if (error) return null;
    const rows = data as ArcOfferListing[];
    return { items: rows.slice(0, ARC_INDEX_PAGE_SIZE), more: rows.length > ARC_INDEX_PAGE_SIZE };
  } catch {
    return null;
  }
}

export async function readArcOfferDetail(key: string) {
  if (!RESOURCE_KEY_PATTERN.test(key)) return { state: "missing" } as const;
  try {
    const db = getByoaClient();
    const record = await db.from(INDEX).select(PUBLIC_FIELDS)
      .eq("resource_key", key).gte("listed_at", since(INDEX_WINDOW_MS))
      .abortSignal(AbortSignal.timeout(3_000)).maybeSingle();
    if (record.error) return { state: "unavailable" } as const;
    if (!record.data) return { state: "missing" } as const;
    const history = await db.from(CHECKS).select(PROBE_FIELDS)
      .eq("resource_key", key).order("checked_at", { ascending: false }).limit(30)
      .abortSignal(AbortSignal.timeout(3_000));
    return {
      state: "found",
      listing: record.data as ArcOfferListing,
      checks: history.error ? null : (history.data ?? []) as ArcOfferCheck[],
    } as const;
  } catch {
    return { state: "unavailable" } as const;
  }
}

export type ArcOfferIndexSummary = {
  listings: number;
  hosts: number;
  checks7d: number;
  arcChallengeChecks7d: number;
  arcChallengeRate7d: number | null;
  asOf: string;
};

export function summarizeArcOfferIndex(
  listings: ReadonlyArray<{ hostname: string }>,
  checks: ReadonlyArray<{ arc_challenge: boolean }>,
  asOf: string,
): ArcOfferIndexSummary {
  const hosts = new Set<string>();
  for (const listing of listings) {
    if (listing.hostname) hosts.add(listing.hostname);
  }
  const checks7d = checks.length;
  const arcChallengeChecks7d = checks.filter((check) => check.arc_challenge === true).length;
  return {
    listings: listings.length,
    hosts: hosts.size,
    checks7d,
    arcChallengeChecks7d,
    arcChallengeRate7d: checks7d > 0 ? arcChallengeChecks7d / checks7d : null,
    asOf,
  };
}

async function readWindowRows<T>(
  readPage: (start: number, end: number) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<T[] | null> {
  const rows: T[] = [];
  for (let start = 0; start < 25_000; start += 500) {
    const { data, error } = await readPage(start, start + 499);
    if (error || !Array.isArray(data)) return null;
    rows.push(...(data as T[]));
    if (data.length < 500) break;
  }
  return rows;
}

export async function readArcOfferIndexSummary(now = new Date()): Promise<ArcOfferIndexSummary | null> {
  try {
    const db = getByoaClient();
    const cutoff = new Date(now.getTime() - INDEX_WINDOW_MS).toISOString();
    const [listings, checks] = await Promise.all([
      readWindowRows<{ hostname: string }>((start, end) =>
        db.from(INDEX).select("hostname")
          .gte("listed_at", cutoff)
          .order("resource_key", { ascending: true })
          .range(start, end)
          .abortSignal(AbortSignal.timeout(4_000)),
      ),
      readWindowRows<{ arc_challenge: boolean }>((start, end) =>
        db.from(CHECKS).select("arc_challenge")
          .gte("checked_at", cutoff)
          .order("checked_at", { ascending: false })
          .order("resource_key", { ascending: true })
          .range(start, end)
          .abortSignal(AbortSignal.timeout(4_000)),
      ),
    ]);
    if (!listings || !checks) return null;
    return summarizeArcOfferIndex(listings, checks, now.toISOString());
  } catch {
    return null;
  }
}

export async function sitemapArcOffers() {
  try {
    const db = getByoaClient();
    const offers: { resource_key: string; last_checked_at: string }[] = [];
    const checkedAfter = since(3 * 86_400_000);
    for (let start = 0; start < 5_000; start += 500) {
      const { data, error } = await db.from(INDEX).select("resource_key,last_checked_at")
        .gte("listed_at", since(INDEX_WINDOW_MS)).gte("last_checked_at", checkedAfter)
        .order("resource_key").range(start, start + 499).abortSignal(AbortSignal.timeout(3_000));
      if (error) break;
      for (const row of data) {
        if (row.last_checked_at && RESOURCE_KEY_PATTERN.test(row.resource_key)) {
          offers.push({ resource_key: row.resource_key, last_checked_at: row.last_checked_at });
        }
      }
      if (data.length < 500) break;
    }
    return offers;
  } catch {
    return [];
  }
}
