/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import { BRAND } from "../brand.ts";
import { getByoaClient } from "../byoa/service.ts";
import { ARC_MAINNET_NETWORK } from "../wallet/arc.ts";
import type { OfferSource } from "./offers.ts";

export const ARC_STATE_LISTINGS_WINDOW_DAYS = 7;
export const ARC_STATE_CHECKS_WINDOW_DAYS = 30;
export const ARC_STATE_SQL_PATH = "docs/state-of-arc-x402.sql";
export const ARC_STATE_SQL_GITHUB_URL = `https://github.com/mioku50/Veyra/blob/main/${ARC_STATE_SQL_PATH}`;

const INDEX = "arc_offer_index";
const CHECKS = "arc_offer_checks";
const OBSERVATIONS = "x402_endpoint_observations";
const SNAPSHOTS = "arc_state_snapshots";

const ONE_DAY_MS = 86_400_000;
const PAGE_SIZE = 1_000;
const MAX_ROWS = 50_000;

export type ArcStateListingRow = {
  hostname: string;
  method: "GET" | "POST";
  sources: OfferSource[];
  listed_amount: string;
};

export type ArcStateCheckRow = {
  resource_key: string;
  checked_at: string;
  http_status: number | null;
  arc_challenge: boolean;
  live_amount: string | null;
  live_payee: string | null;
  drift: string[];
  latency_ms?: number | null;
};

export type ArcStatePriorSnapshotPayload = {
  overview: {
    listings: number;
    distinctHosts: number;
    checksInWindow: number;
  };
  liveness: {
    arcChallengeRate: number | null;
  };
  drift: {
    anyRate: number | null;
  };
};

export type ArcStatePriorSnapshot = {
  snapshot_month: string;
  snapshot_at: string;
  payload: ArcStatePriorSnapshotPayload;
};

export type ArcStatePriceBucket = {
  id:
    | "zero_or_dynamic"
    | "under_0_01"
    | "0_01_to_under_0_10"
    | "exact_0_10"
    | "over_0_10_to_1_00"
    | "over_1_00";
  label: string;
  count: number;
  share: number | null;
};

export type ArcStateSourceStats = {
  count: number;
  share: number | null;
};

export type ArcStateLatencyStats = {
  medianMs: number | null;
  sampleSize: number;
  source: "arc_offer_checks" | "x402_endpoint_observations" | "none";
};

export type ArcStateReport = {
  schemaVersion: 1;
  snapshotMonth: string;
  snapshotAt: string;
  windows: {
    listingsDays: typeof ARC_STATE_LISTINGS_WINDOW_DAYS;
    checksDays: typeof ARC_STATE_CHECKS_WINDOW_DAYS;
  };
  overview: {
    listings: number;
    distinctHosts: number;
    checksInWindow: number;
    distinctCheckedEndpoints: number;
  };
  liveness: {
    reachableCount: number;
    reachableRate: number | null;
    http402Count: number;
    http402Rate: number | null;
    arcChallengeCount: number;
    arcChallengeRate: number | null;
  };
  drift: {
    anyCount: number;
    anyRate: number | null;
    paytoChangedCount: number;
    paytoChangedRate: number | null;
    priceChangedCount: number;
    priceChangedRate: number | null;
    railChangedCount: number;
    railChangedRate: number | null;
  };
  changes: {
    withinWindow: {
      endpointsWithMultipleChecks: number;
      payeeChangeEvents: number;
      endpointsWithPayeeChange: number;
      priceChangeEvents: number;
      endpointsWithPriceChange: number;
    };
    sincePriorSnapshot: {
      priorSnapshotMonth: string;
      priorSnapshotAt: string;
      listingsDelta: number;
      distinctHostsDelta: number;
      checksInWindowDelta: number;
      arcChallengeRateDelta: number | null;
      driftAnyRateDelta: number | null;
      payeeChangeEventsSincePrior: number;
      priceChangeEventsSincePrior: number;
      paytoDriftChecksSincePrior: number;
      priceDriftChecksSincePrior: number;
    } | null;
  };
  concentration: {
    top1Host: string | null;
    top1Share: number | null;
    top5Share: number | null;
    top5Hosts: Array<{
      hostname: string;
      listings: number;
      share: number | null;
    }>;
  };
  methods: {
    GET: ArcStateSourceStats;
    POST: ArcStateSourceStats;
  };
  pricing: {
    exactTenCentsCount: number;
    exactTenCentsShare: number | null;
    buckets: ArcStatePriceBucket[];
  };
  sources: {
    circle: ArcStateSourceStats;
    bazaar: ArcStateSourceStats;
    erc8004: ArcStateSourceStats;
    multiSourceCount: number;
  };
  latency: ArcStateLatencyStats;
  methodology: {
    attribution: string;
    checkDefinition: string;
    indexedSources: OfferSource[];
    exclusions: string[];
    limitations: string[];
    sqlQueryPath: string;
    sqlQueryUrl: string;
  };
};

/** Exact rational rounding to 4 decimal places matching PostgreSQL ROUND(numeric, 4). */
function roundRate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  const scaled = BigInt(numerator) * 10_000n;
  const den = BigInt(denominator);
  const quotient = scaled / den;
  const remainder = scaled % den;
  const rounded = remainder * 2n >= den ? quotient + 1n : quotient;
  return Number(rounded) / 10_000;
}

function round4Delta(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  return Math.round((current - previous) * 10_000) / 10_000;
}

function medianMs(values: ReadonlyArray<number>): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const raw = sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
  return Math.round(raw * 10) / 10;
}

export function buildArcStateMethodology(): ArcStateReport["methodology"] {
  return {
    attribution: `Observed by ${BRAND.name}`,
    checkDefinition:
      "Each check is one unpaid HTTP request using the catalogued method, with no payment header and no USDC spent. It inspects only the live HTTP 402 payment challenge and says nothing about whether a seller delivers results after payment.",
    indexedSources: ["circle", "bazaar", "erc8004"],
    exclusions: [
      "Templated URLs, query-bearing URLs, IP literals, non-HTTPS endpoints, and private or local hosts.",
      "Listings without an Arc Mainnet (eip155:5042) USDC payment option or with a zero burn address.",
      "Empty-request live quotes returning 0 atomic units are treated as dynamic per-request pricing rather than price drift.",
    ],
    limitations: [
      "Unpaid checks run on a leased queue capped at 72 endpoints per batch and 24 endpoints per host per batch, on a 72-hour recheck interval.",
      "Catalog drift measures divergence between catalogued payment terms and live HTTP 402 responses; it can reflect stale catalog metadata as well as endpoint changes.",
      "Per-check latency on arc_offer_checks was introduced in November 2026; when that window column has zero samples, median latency falls back transparently to Arc Mainnet probes in x402_endpoint_observations.",
    ],
    sqlQueryPath: ARC_STATE_SQL_PATH,
    sqlQueryUrl: ARC_STATE_SQL_GITHUB_URL,
  };
}

export function computeArcStateReport(input: {
  snapshotAt: Date;
  listings: ReadonlyArray<ArcStateListingRow>;
  checks: ReadonlyArray<ArcStateCheckRow>;
  fallbackLatenciesMs?: ReadonlyArray<number>;
  priorSnapshot?: ArcStatePriorSnapshot | null;
}): ArcStateReport {
  const snapshotIso = input.snapshotAt.toISOString();
  const snapshotMonth = snapshotIso.slice(0, 7) + "-01";
  const listingCount = input.listings.length;

  const hostCounts = new Map<string, number>();
  let getCount = 0;
  let postCount = 0;
  let exactTenCentsCount = 0;
  let bucketZero = 0;
  let bucketUnder001 = 0;
  let bucket001ToUnder010 = 0;
  let bucketExact010 = 0;
  let bucketOver010To100 = 0;
  let bucketOver100 = 0;
  let sourceCircle = 0;
  let sourceBazaar = 0;
  let sourceErc8004 = 0;
  let multiSourceCount = 0;

  for (const row of input.listings) {
    if (row.hostname) {
      hostCounts.set(row.hostname, (hostCounts.get(row.hostname) ?? 0) + 1);
    }
    if (row.method === "GET") getCount += 1;
    else if (row.method === "POST") postCount += 1;

    if (row.listed_amount === "100000") exactTenCentsCount += 1;
    const amount = BigInt(row.listed_amount);
    if (amount === 0n) bucketZero += 1;
    else if (amount < 10_000n) bucketUnder001 += 1;
    else if (amount < 100_000n) bucket001ToUnder010 += 1;
    else if (amount === 100_000n) bucketExact010 += 1;
    else if (amount <= 1_000_000n) bucketOver010To100 += 1;
    else bucketOver100 += 1;

    if (row.sources.includes("circle")) sourceCircle += 1;
    if (row.sources.includes("bazaar")) sourceBazaar += 1;
    if (row.sources.includes("erc8004")) sourceErc8004 += 1;
    if (row.sources.length > 1) multiSourceCount += 1;
  }

  const sortedHosts = [...hostCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const top5Hosts = sortedHosts.slice(0, 5).map(([hostname, listings]) => ({
    hostname,
    listings,
    share: roundRate(listings, listingCount),
  }));
  const top1Listings = top5Hosts[0]?.listings ?? 0;
  const top5Listings = top5Hosts.reduce((sum, host) => sum + host.listings, 0);

  const checkCount = input.checks.length;
  const checksByKey = new Map<string, ArcStateCheckRow[]>();
  const checkLatencies: number[] = [];

  let reachableCount = 0;
  let http402Count = 0;
  let arcChallengeCount = 0;
  let anyCount = 0;
  let paytoChangedCount = 0;
  let priceChangedCount = 0;
  let railChangedCount = 0;

  for (const check of input.checks) {
    const group = checksByKey.get(check.resource_key) ?? [];
    group.push(check);
    checksByKey.set(check.resource_key, group);

    if (check.http_status !== null) reachableCount += 1;
    if (check.http_status === 402) http402Count += 1;
    if (check.arc_challenge === true) arcChallengeCount += 1;

    const drift = Array.isArray(check.drift) ? check.drift : [];
    if (drift.length > 0) anyCount += 1;
    if (drift.includes("payto_changed")) paytoChangedCount += 1;
    if (drift.includes("price_changed")) priceChangedCount += 1;
    if (drift.includes("rail_changed")) railChangedCount += 1;

    if (typeof check.latency_ms === "number" && Number.isFinite(check.latency_ms) && check.latency_ms >= 0) {
      checkLatencies.push(check.latency_ms);
    }
  }

  let endpointsWithMultipleChecks = 0;
  const payeeTransitionsMs: number[] = [];
  const priceTransitionsMs: number[] = [];
  let endpointsWithPayeeChange = 0;
  let endpointsWithPriceChange = 0;

  for (const group of checksByKey.values()) {
    if (group.length >= 2) endpointsWithMultipleChecks += 1;
    const chronological = [...group].sort(
      (left, right) => Date.parse(left.checked_at) - Date.parse(right.checked_at),
    );
    let previousPayee: string | null = null;
    let previousAmount: string | null = null;
    let payeeChangedForEndpoint = false;
    let priceChangedForEndpoint = false;

    for (const check of chronological) {
      const checkedMs = Date.parse(check.checked_at);
      if (check.live_payee) {
        const normalizedPayee = check.live_payee.toLowerCase();
        if (previousPayee !== null && normalizedPayee !== previousPayee) {
          payeeTransitionsMs.push(checkedMs);
          payeeChangedForEndpoint = true;
        }
        previousPayee = normalizedPayee;
      }
      if (check.live_amount && check.live_amount !== "0") {
        if (previousAmount !== null && check.live_amount !== previousAmount) {
          priceTransitionsMs.push(checkedMs);
          priceChangedForEndpoint = true;
        }
        previousAmount = check.live_amount;
      }
    }

    if (payeeChangedForEndpoint) endpointsWithPayeeChange += 1;
    if (priceChangedForEndpoint) endpointsWithPriceChange += 1;
  }

  const reachableRate = roundRate(reachableCount, checkCount);
  const http402Rate = roundRate(http402Count, checkCount);
  const arcChallengeRate = roundRate(arcChallengeCount, checkCount);
  const anyRate = roundRate(anyCount, checkCount);
  const paytoChangedRate = roundRate(paytoChangedCount, checkCount);
  const priceChangedRate = roundRate(priceChangedCount, checkCount);
  const railChangedRate = roundRate(railChangedCount, checkCount);

  let sincePriorSnapshot: ArcStateReport["changes"]["sincePriorSnapshot"] = null;
  if (input.priorSnapshot) {
    const prior = input.priorSnapshot;
    const priorAtIso = new Date(prior.snapshot_at).toISOString();
    const priorAtMs = Date.parse(priorAtIso);
    let paytoDriftChecksSincePrior = 0;
    let priceDriftChecksSincePrior = 0;
    for (const check of input.checks) {
      if (Date.parse(check.checked_at) > priorAtMs) {
        if (check.drift.includes("payto_changed")) paytoDriftChecksSincePrior += 1;
        if (check.drift.includes("price_changed")) priceDriftChecksSincePrior += 1;
      }
    }
    sincePriorSnapshot = {
      priorSnapshotMonth: prior.snapshot_month,
      priorSnapshotAt: priorAtIso,
      listingsDelta: listingCount - (prior.payload.overview?.listings ?? 0),
      distinctHostsDelta: hostCounts.size - (prior.payload.overview?.distinctHosts ?? 0),
      checksInWindowDelta: checkCount - (prior.payload.overview?.checksInWindow ?? 0),
      arcChallengeRateDelta: round4Delta(arcChallengeRate, prior.payload.liveness?.arcChallengeRate ?? null),
      driftAnyRateDelta: round4Delta(anyRate, prior.payload.drift?.anyRate ?? null),
      payeeChangeEventsSincePrior: payeeTransitionsMs.filter((ts) => ts > priorAtMs).length,
      priceChangeEventsSincePrior: priceTransitionsMs.filter((ts) => ts > priorAtMs).length,
      paytoDriftChecksSincePrior,
      priceDriftChecksSincePrior,
    };
  }

  const validFallbackLatencies = (input.fallbackLatenciesMs ?? []).filter(
    (value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
  );
  const latency: ArcStateLatencyStats = checkLatencies.length > 0
    ? {
        medianMs: medianMs(checkLatencies),
        sampleSize: checkLatencies.length,
        source: "arc_offer_checks",
      }
    : validFallbackLatencies.length > 0
      ? {
          medianMs: medianMs(validFallbackLatencies),
          sampleSize: validFallbackLatencies.length,
          source: "x402_endpoint_observations",
        }
      : {
          medianMs: null,
          sampleSize: 0,
          source: "none",
        };

  return {
    schemaVersion: 1,
    snapshotMonth,
    snapshotAt: snapshotIso,
    windows: {
      listingsDays: ARC_STATE_LISTINGS_WINDOW_DAYS,
      checksDays: ARC_STATE_CHECKS_WINDOW_DAYS,
    },
    overview: {
      listings: listingCount,
      distinctHosts: hostCounts.size,
      checksInWindow: checkCount,
      distinctCheckedEndpoints: checksByKey.size,
    },
    liveness: {
      reachableCount,
      reachableRate,
      http402Count,
      http402Rate,
      arcChallengeCount,
      arcChallengeRate,
    },
    drift: {
      anyCount,
      anyRate,
      paytoChangedCount,
      paytoChangedRate,
      priceChangedCount,
      priceChangedRate,
      railChangedCount,
      railChangedRate,
    },
    changes: {
      withinWindow: {
        endpointsWithMultipleChecks,
        payeeChangeEvents: payeeTransitionsMs.length,
        endpointsWithPayeeChange,
        priceChangeEvents: priceTransitionsMs.length,
        endpointsWithPriceChange,
      },
      sincePriorSnapshot,
    },
    concentration: {
      top1Host: top5Hosts[0]?.hostname ?? null,
      top1Share: listingCount > 0 ? roundRate(top1Listings, listingCount) : null,
      top5Share: listingCount > 0 ? roundRate(top5Listings, listingCount) : null,
      top5Hosts,
    },
    methods: {
      GET: { count: getCount, share: roundRate(getCount, listingCount) },
      POST: { count: postCount, share: roundRate(postCount, listingCount) },
    },
    pricing: {
      exactTenCentsCount,
      exactTenCentsShare: roundRate(exactTenCentsCount, listingCount),
      buckets: [
        {
          id: "zero_or_dynamic",
          label: "0 USDC (dynamic / per-request)",
          count: bucketZero,
          share: roundRate(bucketZero, listingCount),
        },
        {
          id: "under_0_01",
          label: "Under $0.01 USDC",
          count: bucketUnder001,
          share: roundRate(bucketUnder001, listingCount),
        },
        {
          id: "0_01_to_under_0_10",
          label: "$0.01 to <$0.10 USDC",
          count: bucket001ToUnder010,
          share: roundRate(bucket001ToUnder010, listingCount),
        },
        {
          id: "exact_0_10",
          label: "Exactly $0.10 USDC",
          count: bucketExact010,
          share: roundRate(bucketExact010, listingCount),
        },
        {
          id: "over_0_10_to_1_00",
          label: ">$0.10 to $1.00 USDC",
          count: bucketOver010To100,
          share: roundRate(bucketOver010To100, listingCount),
        },
        {
          id: "over_1_00",
          label: "Over $1.00 USDC",
          count: bucketOver100,
          share: roundRate(bucketOver100, listingCount),
        },
      ],
    },
    sources: {
      circle: { count: sourceCircle, share: roundRate(sourceCircle, listingCount) },
      bazaar: { count: sourceBazaar, share: roundRate(sourceBazaar, listingCount) },
      erc8004: { count: sourceErc8004, share: roundRate(sourceErc8004, listingCount) },
      multiSourceCount,
    },
    latency,
    methodology: buildArcStateMethodology(),
  };
}

async function readWindowRows<T>(
  readPage: (start: number, end: number) => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>,
): Promise<{ rows: T[]; error: { code?: string; message?: string } | null }> {
  const rows: T[] = [];
  for (let start = 0; start < MAX_ROWS; start += PAGE_SIZE) {
    const { data, error } = await readPage(start, start + PAGE_SIZE - 1);
    if (error) return { rows: [], error };
    if (!Array.isArray(data)) return { rows: [], error: { message: "invalid_response" } };
    rows.push(...(data as T[]));
    if (data.length < PAGE_SIZE) break;
  }
  return { rows, error: null };
}

function isMissingColumnError(error: { code?: string; message?: string } | null, column: string) {
  if (!error) return false;
  return error.code === "42703"
    || error.code === "PGRST204"
    || Boolean(error.message?.includes(column));
}

export async function readLiveArcStateReport(now = new Date()): Promise<ArcStateReport | null> {
  try {
    const db = getByoaClient();
    const snapshotIso = now.toISOString();
    const currentMonthStart = snapshotIso.slice(0, 7) + "-01";
    const listingsCutoff = new Date(now.getTime() - ARC_STATE_LISTINGS_WINDOW_DAYS * ONE_DAY_MS).toISOString();
    const checksCutoff = new Date(now.getTime() - ARC_STATE_CHECKS_WINDOW_DAYS * ONE_DAY_MS).toISOString();

    const listingsResult = await readWindowRows<ArcStateListingRow>((start, end) =>
      db.from(INDEX)
        .select("hostname, method, sources, listed_amount")
        .gte("listed_at", listingsCutoff)
        .lte("listed_at", snapshotIso)
        .order("resource_key", { ascending: true })
        .range(start, end)
        .abortSignal(AbortSignal.timeout(5_000)),
    );
    if (listingsResult.error) return null;

    let checksResult = await readWindowRows<ArcStateCheckRow>((start, end) =>
      db.from(CHECKS)
        .select("resource_key, checked_at, http_status, arc_challenge, live_amount, live_payee, drift, latency_ms")
        .gte("checked_at", checksCutoff)
        .lte("checked_at", snapshotIso)
        .order("checked_at", { ascending: true })
        .order("resource_key", { ascending: true })
        .range(start, end)
        .abortSignal(AbortSignal.timeout(5_000)),
    );
    if (isMissingColumnError(checksResult.error, "latency_ms")) {
      checksResult = await readWindowRows<ArcStateCheckRow>((start, end) =>
        db.from(CHECKS)
          .select("resource_key, checked_at, http_status, arc_challenge, live_amount, live_payee, drift")
          .gte("checked_at", checksCutoff)
          .lte("checked_at", snapshotIso)
          .order("checked_at", { ascending: true })
          .order("resource_key", { ascending: true })
          .range(start, end)
          .abortSignal(AbortSignal.timeout(5_000)),
      );
    }
    if (checksResult.error) return null;

    const hasCheckLatencies = checksResult.rows.some(
      (check) => typeof check.latency_ms === "number" && Number.isFinite(check.latency_ms) && check.latency_ms >= 0,
    );

    let fallbackLatenciesMs: number[] = [];
    if (!hasCheckLatencies) {
      const obsResult = await readWindowRows<{ latency_ms: number | null }>((start, end) =>
        db.from(OBSERVATIONS)
          .select("latency_ms")
          .eq("network", ARC_MAINNET_NETWORK)
          .not("latency_ms", "is", null)
          .gte("probed_at", checksCutoff)
          .lte("probed_at", snapshotIso)
          .order("probed_at", { ascending: false })
          .range(start, end)
          .abortSignal(AbortSignal.timeout(4_000)),
      );
      if (!obsResult.error) {
        fallbackLatenciesMs = obsResult.rows
          .map((row) => row.latency_ms)
          .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
      }
    }

    let priorSnapshot: ArcStatePriorSnapshot | null = null;
    const priorResult = await db.from(SNAPSHOTS)
      .select("snapshot_month, snapshot_at, payload")
      .lt("snapshot_month", currentMonthStart)
      .order("snapshot_month", { ascending: false })
      .limit(1)
      .abortSignal(AbortSignal.timeout(3_000));
    if (!priorResult.error && Array.isArray(priorResult.data) && priorResult.data[0]) {
      priorSnapshot = priorResult.data[0] as ArcStatePriorSnapshot;
    }

    return computeArcStateReport({
      snapshotAt: now,
      listings: listingsResult.rows,
      checks: checksResult.rows,
      fallbackLatenciesMs,
      priorSnapshot,
    });
  } catch {
    return null;
  }
}

export async function saveMonthlyArcStateSnapshot(report: ArcStateReport) {
  const db = getByoaClient();
  const { error } = await db.from(SNAPSHOTS).upsert({
    snapshot_month: report.snapshotMonth,
    snapshot_at: report.snapshotAt,
    window_days: report.windows.checksDays,
    listings: report.overview.listings,
    distinct_hosts: report.overview.distinctHosts,
    checks_in_window: report.overview.checksInWindow,
    payload: report,
  }, { onConflict: "snapshot_month" }).abortSignal(AbortSignal.timeout(5_000));
  if (error) {
    throw new Error(`arc_state_snapshot_write_failed:${error.code ?? error.message}`);
  }
  return {
    snapshotMonth: report.snapshotMonth,
    snapshotAt: report.snapshotAt,
    listings: report.overview.listings,
    distinctHosts: report.overview.distinctHosts,
    checksInWindow: report.overview.checksInWindow,
  };
}
