/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { createPublicClient, http, parseAbi } from "viem";
import { getByoaClient } from "../byoa/service.ts";
import { ARC_MAINNET_RPC_URL, arcMainnetChain } from "../wallet/arc.ts";
import {
  ARC_IDENTITY_REGISTRY,
  ARC_REGISTRY_REF,
  confirmWithChallenges,
  readArcErc8004Offers,
  ssrfChallengeReader,
  type ChallengeReader,
  type IdentityRegistryReader,
  type JsonFetcher,
} from "./erc8004-arc.ts";
import { mergeOffers, offerNetworks, type MarketOffer } from "./offers.ts";

/**
 * The ERC-8004 identity registry on Arc mainnet, read once a day and kept.
 *
 * Reading it takes a minute or more:
 * - hundreds of identities;
 * - their registration files, some only on rate-limited IPFS gateways;
 * - the x402 endpoints the files declare;
 * - each offer's own unpaid challenge.
 *
 * None of that belongs inside a brief somebody is waiting for. So a scheduled
 * job reads it and keeps the result, and discovery reads the result. Nova's
 * brief read Circle's catalogue only, so no seller registered on Arc reached
 * the owner, however well it answered.
 *
 * The owner dropped the Coinbase Bazaar from this on 2026-09-26: it lists
 * almost nothing on Arc. Circle's catalogue is still asked live, per query.
 */

export const ARC_REGISTRY_SNAPSHOT_VERSION = "veyra-arc-registry-v1" as const;

export const ARC_REGISTRY_LIMITS = {
  /** No new request starts after this. The job's own limit is 300 s, and the
   *  snapshot still has to be written. */
  budgetMs: 230_000,
  /** Older than this, a snapshot is not used: three missed days means the job
   *  has stopped, and its sellers may have too. */
  maxAgeHours: 72,
  /** How long one server instance keeps what it read. */
  cacheMs: 10 * 60_000,
  maxOffers: 1_000,
} as const;

/** Multicall3 at its usual address, deployed on Arc mainnet (read 2026-09-26). */
export const ARC_MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

export type ArcRegistrySnapshot = {
  version: typeof ARC_REGISTRY_SNAPSHOT_VERSION;
  registry: string;
  takenAt: string;
  /** False when the time budget stopped the read before every identity, file
   *  and endpoint was reached. */
  complete: boolean;
  identities: number;
  filesRead: number;
  filesUnreadable: number;
  declaringX402: number[];
  endpointsUnreadable: number;
  challenges: { confirmed: number; unconfirmed: number; notChecked: number };
  /** Offers with at least one accept on Arc or Base, and no template in the
   *  path. Everything else is counted in `leftOut`. */
  offers: MarketOffer[];
  leftOut: { templated: number; noAccept: number };
};

export async function takeArcRegistrySnapshot(input: {
  reader: IdentityRegistryReader;
  fetchJson?: JsonFetcher;
  readChallenge?: ChallengeReader;
  clock?: () => number;
  budgetMs?: number;
}): Promise<ArcRegistrySnapshot> {
  const clock = input.clock ?? Date.now;
  const started = clock();
  const deadline = started + (input.budgetMs ?? ARC_REGISTRY_LIMITS.budgetMs);
  const readChallenge = input.readChallenge ?? ssrfChallengeReader;

  const read = await readArcErc8004Offers({
    reader: input.reader,
    fetchJson: input.fetchJson,
    readChallenge,
    deadline,
    clock,
  });
  const checked = await confirmWithChallenges(mergeOffers(read.offers), { readChallenge, deadline, clock });

  const leftOut = { templated: 0, noAccept: 0 };
  const offers: MarketOffer[] = [];
  for (const offer of checked.offers) {
    if (offer.templated) leftOut.templated += 1;
    else if (offerNetworks(offer).length === 0) leftOut.noAccept += 1;
    else offers.push(offer);
  }

  return {
    version: ARC_REGISTRY_SNAPSHOT_VERSION,
    registry: ARC_REGISTRY_REF,
    takenAt: new Date(started).toISOString(),
    complete: read.complete,
    identities: read.identities,
    filesRead: read.filesRead,
    filesUnreadable: read.filesUnreadable,
    declaringX402: read.declaringX402,
    endpointsUnreadable: read.endpointsUnreadable,
    challenges: { confirmed: checked.confirmed, unconfirmed: checked.unconfirmed, notChecked: checked.notChecked },
    offers: offers.slice(0, ARC_REGISTRY_LIMITS.maxOffers),
    leftOut,
  };
}

/* ---- the chain ---- */

const REGISTRY_ADDRESS: `0x${string}` = ARC_IDENTITY_REGISTRY;
const REGISTRY_ABI = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)",
]);

/**
 * The registry read through Multicall3.
 *
 * `exists` goes through Multicall3 too, with failures allowed: a revert then
 * comes back as a failed call, and anything else (a timeout, a rate limit)
 * throws. Read one call at a time, a rate limit that looked like "no such
 * identity" would cut the count short and lose every seller after it.
 */
export function arcRegistryReader(options: { rpcUrl?: string } = {}): IdentityRegistryReader {
  const rpcUrl = options.rpcUrl || process.env.ARC_MAINNET_RPC_URL?.trim() || ARC_MAINNET_RPC_URL;
  const client = createPublicClient({
    chain: arcMainnetChain,
    transport: http(rpcUrl, { timeout: 20_000, retryCount: 3, retryDelay: 1_000 }),
  });
  const call = (functionName: "ownerOf" | "tokenURI", agentIds: number[]) => client.multicall({
    multicallAddress: ARC_MULTICALL3,
    allowFailure: true,
    contracts: agentIds.map((agentId) => ({
      address: REGISTRY_ADDRESS,
      abi: REGISTRY_ABI,
      functionName,
      args: [BigInt(agentId)],
    })),
  });
  return {
    async exists(agentId) {
      const [result] = await call("ownerOf", [agentId]);
      return result?.status === "success";
    },
    async tokenURI(agentId) {
      const [result] = await call("tokenURI", [agentId]);
      return result?.status === "success" && typeof result.result === "string" ? result.result : null;
    },
    async tokenURIs(agentIds) {
      const results = await call("tokenURI", agentIds);
      return results.map((result) => result.status === "success" && typeof result.result === "string" ? result.result : null);
    },
  };
}

/* ---- the store ---- */

const TABLE = "arc_registry_snapshots";

export type ArcRegistryView = {
  /** fresh: a snapshot within the age limit. stale: only older ones.
   *  missing: none, or the store could not be read. Only a fresh one lends
   *  offers. */
  state: "fresh" | "stale" | "missing";
  takenAt: string | null;
  complete: boolean;
  offers: MarketOffer[];
};

/* Test doubles on the same terms as the execution ledger's: only under an
   explicit test flag, so a misconfigured deployment never reads process
   memory as the market. */
const memorySnapshots: ArcRegistrySnapshot[] = [];
let cached: { view: ArcRegistryView; at: number } | null = null;

function memoryAllowed(): boolean {
  return process.env.NODE_ENV === "test" && process.env.EXECUTION_ALLOW_MEMORY_STORE === "true";
}

export function clearArcRegistryMemory(): void {
  if (memoryAllowed()) memorySnapshots.length = 0;
  cached = null;
}

export async function saveArcRegistrySnapshot(snapshot: ArcRegistrySnapshot): Promise<{ saved: boolean; reason?: string }> {
  cached = null;
  if (memoryAllowed()) {
    memorySnapshots.unshift(snapshot);
    return { saved: true };
  }
  try {
    const { error } = await getByoaClient().from(TABLE).insert({
      version: snapshot.version,
      registry: snapshot.registry,
      taken_at: snapshot.takenAt,
      complete: snapshot.complete,
      identities: snapshot.identities,
      files_read: snapshot.filesRead,
      files_unreadable: snapshot.filesUnreadable,
      declaring_x402: snapshot.declaringX402,
      endpoints_unreadable: snapshot.endpointsUnreadable,
      challenges_confirmed: snapshot.challenges.confirmed,
      challenges_unconfirmed: snapshot.challenges.unconfirmed,
      challenges_not_checked: snapshot.challenges.notChecked,
      left_out_templated: snapshot.leftOut.templated,
      left_out_no_accept: snapshot.leftOut.noAccept,
      offers: snapshot.offers,
    });
    return error ? { saved: false, reason: error.code || "insert_failed" } : { saved: true };
  } catch {
    return { saved: false, reason: "store_unavailable" };
  }
}

function isOffer(value: unknown): value is MarketOffer {
  const offer = value as Partial<MarketOffer> | null;
  return Boolean(offer)
    && typeof offer!.resource === "string"
    && (offer!.method === "GET" || offer!.method === "POST")
    && Array.isArray(offer!.accepts)
    && Array.isArray(offer!.listings);
}

function offersFrom(raw: unknown): MarketOffer[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isOffer).slice(0, ARC_REGISTRY_LIMITS.maxOffers).map((offer) => ({
    ...offer,
    tags: Array.isArray(offer.tags) ? offer.tags : [],
    inputSchema: offer.inputSchema ?? null,
    erc8004: offer.erc8004 ?? null,
  }));
}

/**
 * The registry as of its last daily read. Never throws: a store that cannot
 * be read is a missing snapshot, and discovery goes on with Circle's catalogue.
 */
export async function loadArcRegistryView(input: { now?: Date } = {}): Promise<ArcRegistryView> {
  const now = input.now ?? new Date();
  if (!memoryAllowed() && cached && now.getTime() - cached.at < ARC_REGISTRY_LIMITS.cacheMs) return cached.view;

  let rows: Array<{ taken_at: string; complete: boolean; offers: unknown }>;
  if (memoryAllowed()) {
    rows = memorySnapshots.map((snapshot) => ({ taken_at: snapshot.takenAt, complete: snapshot.complete, offers: snapshot.offers }));
  } else {
    try {
      const { data, error } = await getByoaClient().from(TABLE)
        .select("taken_at, complete, offers")
        .order("taken_at", { ascending: false })
        .limit(3);
      if (error) return { state: "missing", takenAt: null, complete: false, offers: [] };
      rows = (data ?? []) as typeof rows;
    } catch {
      return { state: "missing", takenAt: null, complete: false, offers: [] };
    }
  }

  const maxAgeMs = ARC_REGISTRY_LIMITS.maxAgeHours * 3_600_000;
  const recent = rows.filter((row) => {
    const age = now.getTime() - Date.parse(row.taken_at);
    return Number.isFinite(age) && age >= -60_000 && age <= maxAgeMs;
  });
  /* The latest complete read, else the latest read: a read the clock cut
     short still holds what it reached, and yesterday's may hold more. */
  const pick = recent.find((row) => row.complete) ?? recent[0] ?? null;
  const view: ArcRegistryView = pick
    ? { state: "fresh", takenAt: pick.taken_at, complete: pick.complete, offers: offersFrom(pick.offers) }
    : rows[0]
      ? { state: "stale", takenAt: rows[0].taken_at, complete: rows[0].complete, offers: [] }
      : { state: "missing", takenAt: null, complete: false, offers: [] };
  if (!memoryAllowed()) cached = { view, at: now.getTime() };
  return view;
}

/* ---- the daily job ---- */

export type ArcRegistrySummary = {
  takenAt: string;
  complete: boolean;
  identities: number;
  filesRead: number;
  filesUnreadable: number;
  declaringX402: number;
  endpointsUnreadable: number;
  challenges: ArcRegistrySnapshot["challenges"];
  leftOut: ArcRegistrySnapshot["leftOut"];
  offers: number;
  onArc: number;
  bothWays: number;
  /** Offers per declaring identity: ids and seller names are public. */
  sellers: Array<{ agentId: string; provider: string | null; offers: number; bothWays: boolean }>;
};

export function summarizeArcRegistry(snapshot: ArcRegistrySnapshot): ArcRegistrySummary {
  const sellers = new Map<string, ArcRegistrySummary["sellers"][number]>();
  for (const offer of snapshot.offers) {
    const agentId = offer.erc8004?.agentId ?? "?";
    const seller = sellers.get(agentId) ?? { agentId, provider: offer.provider, offers: 0, bothWays: false };
    seller.offers += 1;
    seller.bothWays ||= offer.erc8004?.binding === "both_ways";
    sellers.set(agentId, seller);
  }
  return {
    takenAt: snapshot.takenAt,
    complete: snapshot.complete,
    identities: snapshot.identities,
    filesRead: snapshot.filesRead,
    filesUnreadable: snapshot.filesUnreadable,
    declaringX402: snapshot.declaringX402.length,
    endpointsUnreadable: snapshot.endpointsUnreadable,
    challenges: snapshot.challenges,
    leftOut: snapshot.leftOut,
    offers: snapshot.offers.length,
    onArc: snapshot.offers.filter((offer) => offerNetworks(offer).includes("eip155:5042")).length,
    bothWays: snapshot.offers.filter((offer) => offer.erc8004?.binding === "both_ways").length,
    sellers: [...sellers.values()].sort((a, b) => Number(a.agentId) - Number(b.agentId)),
  };
}

/** Read the registry and keep the result: the scheduled job's whole work. */
export async function refreshArcRegistrySnapshot(input: {
  reader?: IdentityRegistryReader;
  budgetMs?: number;
} = {}): Promise<{ saved: boolean; reason?: string; summary: ArcRegistrySummary }> {
  const snapshot = await takeArcRegistrySnapshot({
    reader: input.reader ?? arcRegistryReader(),
    budgetMs: input.budgetMs,
  });
  const saved = await saveArcRegistrySnapshot(snapshot);
  return { ...saved, summary: summarizeArcRegistry(snapshot) };
}
