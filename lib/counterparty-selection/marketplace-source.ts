import { getAddress, isAddress, type Hex } from "viem";
import { hashCanonical, normalizeCapability } from "./canonical.ts";
import { capabilityMatchFor } from "./policy.ts";
import type { CapabilityMatch } from "./types.ts";

/**
 * Circle x402 service discovery adapter.
 *
 * This is a *candidate source* for the existing counterparty-selection engine,
 * not a second engine. It answers one question: "which externally published
 * x402 endpoints could serve this capability?" Everything downstream - probing,
 * ranking, policy, clearance - is the same machinery used for ERC-8004
 * counterparties.
 *
 * Deliberately read-only: discovery never authorizes, quotes, or settles.
 */

export const MARKETPLACE_SOURCE = "circle_x402_discovery" as const;
export const MARKETPLACE_SOURCE_VERSION = "veyra-marketplace-source-v1" as const;
export const MARKETPLACE_DISCOVERY_URL = "https://api.circle.com/v2/x402/discovery/resources";

/** Networks the Circle marketplace actually settles on. Arc is absent by design:
 *  the catalog publishes zero Arc resources, so pretending otherwise would
 *  produce empty results with a misleading error. */
export const MARKETPLACE_NETWORKS = {
  "eip155:8453": "Base",
  "eip155:137": "Polygon",
  "eip155:1": "Ethereum",
  "eip155:42161": "Arbitrum",
  "eip155:10": "Optimism",
  "eip155:43114": "Avalanche",
  "eip155:130": "Unichain",
  "eip155:146": "Sonic",
  "eip155:480": "World Chain",
  "eip155:1329": "Sei",
  "eip155:999": "HyperEVM",
} as const;

export type MarketplaceNetwork = keyof typeof MARKETPLACE_NETWORKS;
export const MARKETPLACE_DEFAULT_NETWORK: MarketplaceNetwork = "eip155:8453";

export const MARKETPLACE_DISCOVERY_LIMITS = {
  maxLimit: 25,
  defaultLimit: 10,
  maxUsdPrice: 100,
  requestTimeoutMs: 15_000,
  maxResponseBytes: 4 * 1024 * 1024,
} as const;

export class MarketplaceDiscoveryError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 502,
  ) {
    super(code);
    this.name = "MarketplaceDiscoveryError";
  }
}

export type MarketplaceAccept = {
  scheme: string;
  network: string;
  asset: string;
  payTo: string;
  amountAtomic: string;
  priceUsdc: number;
  maxTimeoutSeconds: number | null;
  gatewayBatched: boolean;
};

export type MarketplaceProvider = {
  name: string | null;
  website: string | null;
  docsUrl: string | null;
  description: string | null;
  category: string | null;
  tags: string[];
};

export type MarketplaceCandidate = {
  candidateId: string;
  resource: string;
  origin: string;
  method: "GET" | "POST";
  provider: MarketplaceProvider;
  description: string | null;
  mimeType: string | null;
  declaresInputSchema: boolean;
  declaresOutputSchema: boolean;
  siwx: boolean;
  supportsVanillaX402: boolean;
  supportsCircleGateway: boolean;
  accepts: MarketplaceAccept[];
  selectedAccept: MarketplaceAccept;
  priceUsdc: number;
  lastUpdated: string | null;
  capabilities: string[];
  capabilityMatch: CapabilityMatch;
  catalogHash: Hex;
};

export type MarketplaceDiscoveryInput = {
  capability: string;
  query?: string;
  network?: string;
  maxPriceUsdc?: number;
  limit?: number;
  requireCircleGateway?: boolean;
  fetchImpl?: typeof fetch;
};

export type MarketplaceDiscoveryResult = {
  source: typeof MARKETPLACE_SOURCE;
  sourceVersion: typeof MARKETPLACE_SOURCE_VERSION;
  capability: string;
  network: MarketplaceNetwork;
  networkLabel: string;
  query: string;
  catalogTotal: number;
  candidates: MarketplaceCandidate[];
  queriedAt: string;
  readOnly: true;
  paymentCreated: false;
};

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function normalizeMarketplaceNetwork(value: unknown): MarketplaceNetwork {
  const raw = String(value || MARKETPLACE_DEFAULT_NETWORK).trim().toLowerCase();
  const aliases: Record<string, MarketplaceNetwork> = {
    base: "eip155:8453",
    polygon: "eip155:137",
    matic: "eip155:137",
    ethereum: "eip155:1",
    arbitrum: "eip155:42161",
    optimism: "eip155:10",
    avalanche: "eip155:43114",
    unichain: "eip155:130",
  };
  const resolved = (aliases[raw] ?? raw) as MarketplaceNetwork;
  if (!(resolved in MARKETPLACE_NETWORKS)) {
    throw new MarketplaceDiscoveryError("marketplace_network_unsupported", 400);
  }
  return resolved;
}

/** USDC atomic units (6 decimals) -> USD. Never floats through the wire value. */
export function atomicToUsdc(amount: unknown): number {
  const raw = String(amount ?? "").trim();
  if (!/^\d{1,30}$/.test(raw)) return Number.NaN;
  return Number(BigInt(raw)) / 1_000_000;
}

/**
 * Derives capability tokens from catalog metadata so marketplace candidates can
 * be matched by the same `capabilityMatchFor` used for seller-registry services.
 */
export function marketplaceCapabilities(item: {
  category?: string | null;
  tags?: string[];
  path?: string | null;
  providerName?: string | null;
}): string[] {
  const tokens = [
    item.category,
    ...(item.tags || []),
    item.providerName,
    ...String(item.path || "").split("/").filter(Boolean),
  ];
  const normalized = tokens
    .map((token) => String(token || "").trim().toLowerCase().replace(/[\s-]+/g, "_"))
    .filter((token) => /^[a-z0-9][a-z0-9_]{1,79}$/.test(token));
  return Array.from(new Set(normalized));
}

export function marketplaceCandidateId(resource: string, payTo: string, network: string): string {
  return `x402:${hashCanonical({ resource, payTo: payTo.toLowerCase(), network }).slice(2, 26)}`;
}

function normalizeAccept(raw: unknown, network: MarketplaceNetwork): MarketplaceAccept | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (String(value.network || "").toLowerCase() !== network) return null;
  const payTo = textOrNull(value.payTo);
  const asset = textOrNull(value.asset);
  if (!payTo || !asset) return null;
  const priceUsdc = atomicToUsdc(value.amount);
  if (!Number.isFinite(priceUsdc)) return null;
  const scheme = textOrNull(value.scheme) || "exact";
  const extra = (value.extra && typeof value.extra === "object" ? value.extra : {}) as Record<string, unknown>;
  const timeout = Number(value.maxTimeoutSeconds);
  return {
    scheme,
    network,
    asset,
    payTo,
    amountAtomic: String(value.amount ?? ""),
    priceUsdc,
    maxTimeoutSeconds: Number.isFinite(timeout) ? timeout : null,
    // Real sellers mark the Circle Gateway scheme via `extra.name`, e.g.
    // `{"name":"GatewayWalletBatched","verifyingContract":"0x7777...","version":"1"}`.
    gatewayBatched: /gateway/i.test(scheme)
      || /gateway/i.test(String(extra.name ?? ""))
      || Boolean(extra.gatewayWallet),
  };
}

/** Maps one raw discovery item onto a candidate, or null when it is unusable. */
export function normalizeMarketplaceItem(
  raw: unknown,
  input: { capability: string; network: MarketplaceNetwork },
): MarketplaceCandidate | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const resource = textOrNull(item.resource);
  if (!resource) return null;
  let origin: string;
  try {
    const url = new URL(resource);
    if (url.protocol !== "https:") return null;
    origin = url.origin;
  } catch {
    return null;
  }

  const metadata = (item.metadata && typeof item.metadata === "object" ? item.metadata : {}) as Record<string, unknown>;
  const providerRaw = (metadata.provider && typeof metadata.provider === "object" ? metadata.provider : {}) as Record<string, unknown>;
  const acceptsRaw = Array.isArray(item.accepts) ? item.accepts : [];
  const accepts = acceptsRaw
    .map((accept) => normalizeAccept(accept, input.network))
    .filter((accept): accept is MarketplaceAccept => accept !== null);
  if (accepts.length === 0) return null;

  const selectedAccept = [...accepts].sort((left, right) =>
    left.priceUsdc - right.priceUsdc || left.payTo.localeCompare(right.payTo))[0];

  const tags = Array.isArray(providerRaw.tags)
    ? providerRaw.tags.map((tag) => String(tag)).filter(Boolean)
    : [];
  const provider: MarketplaceProvider = {
    name: textOrNull(providerRaw.name),
    website: textOrNull(providerRaw.website),
    docsUrl: textOrNull(providerRaw.docsUrl),
    description: textOrNull(providerRaw.description),
    category: textOrNull(providerRaw.category),
    tags,
  };
  const capabilities = marketplaceCapabilities({
    category: provider.category,
    tags,
    path: textOrNull(metadata.path),
    providerName: provider.name,
  });
  const method = String(metadata.method || "GET").toUpperCase() === "POST" ? "POST" : "GET";
  const inputSchema = metadata.input && typeof metadata.input === "object"
    ? (metadata.input as Record<string, unknown>).body
    : undefined;

  return {
    candidateId: marketplaceCandidateId(resource, selectedAccept.payTo, input.network),
    resource,
    origin,
    method,
    provider,
    description: textOrNull(metadata.description),
    mimeType: textOrNull(metadata.mimeType),
    declaresInputSchema: Boolean(inputSchema && typeof inputSchema === "object"),
    declaresOutputSchema: Boolean(metadata.output && typeof metadata.output === "object"),
    siwx: metadata.siwx === true,
    supportsVanillaX402: metadata.supportsVanillax402 === true,
    supportsCircleGateway: metadata.supportsCircleGateway === true,
    accepts,
    selectedAccept,
    priceUsdc: selectedAccept.priceUsdc,
    lastUpdated: textOrNull(item.lastUpdated),
    capabilities,
    capabilityMatch: capabilityMatchFor(input.capability, capabilities),
    catalogHash: hashCanonical({
      resource,
      accepts: accepts.map((accept) => ({
        network: accept.network,
        asset: accept.asset.toLowerCase(),
        payTo: accept.payTo.toLowerCase(),
        amountAtomic: accept.amountAtomic,
        scheme: accept.scheme,
      })),
      method,
      siwx: metadata.siwx === true,
    }),
  };
}

export function buildMarketplaceDiscoveryUrl(input: {
  query: string;
  network: MarketplaceNetwork;
  maxPriceUsdc?: number;
  limit: number;
  requireCircleGateway?: boolean;
}): string {
  const url = new URL(MARKETPLACE_DISCOVERY_URL);
  if (input.query) url.searchParams.set("query", input.query);
  url.searchParams.set("network", input.network);
  url.searchParams.set("type", "http");
  // SIWX endpoints need interactive browser auth and can never be paid
  // programmatically, so they are excluded at the source.
  url.searchParams.set("siwx", "false");
  if (input.maxPriceUsdc !== undefined) {
    url.searchParams.set("maxUsdPrice", String(input.maxPriceUsdc));
  }
  if (input.requireCircleGateway) {
    url.searchParams.set("supportsCircleGateway", "true");
  }
  // Over-fetch so post-filtering (capability match, price, schema) still has
  // enough material to return `limit` usable candidates.
  url.searchParams.set("limit", String(Math.min(200, Math.max(input.limit * 5, 50))));
  return url.toString();
}

export async function discoverMarketplaceCandidates(
  input: MarketplaceDiscoveryInput,
): Promise<MarketplaceDiscoveryResult> {
  const capability = normalizeCapability(input.capability);
  const network = normalizeMarketplaceNetwork(input.network);
  const limit = input.limit === undefined
    ? MARKETPLACE_DISCOVERY_LIMITS.defaultLimit
    : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MARKETPLACE_DISCOVERY_LIMITS.maxLimit) {
    throw new MarketplaceDiscoveryError("marketplace_limit_invalid", 400);
  }
  const maxPriceUsdc = input.maxPriceUsdc === undefined ? undefined : Number(input.maxPriceUsdc);
  if (
    maxPriceUsdc !== undefined
    && (!Number.isFinite(maxPriceUsdc)
      || maxPriceUsdc <= 0
      || maxPriceUsdc > MARKETPLACE_DISCOVERY_LIMITS.maxUsdPrice)
  ) {
    throw new MarketplaceDiscoveryError("marketplace_max_price_invalid", 400);
  }
  const query = (input.query ?? capability.replace(/_/g, " ")).trim().slice(0, 120);

  const url = buildMarketplaceDiscoveryUrl({
    query,
    network,
    maxPriceUsdc,
    limit,
    requireCircleGateway: input.requireCircleGateway,
  });
  const doFetch = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("marketplace_discovery_timeout")),
    MARKETPLACE_DISCOVERY_LIMITS.requestTimeoutMs,
  );
  let payload: Record<string, unknown>;
  try {
    const response = await doFetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new MarketplaceDiscoveryError("marketplace_discovery_unavailable", 502);
    payload = await response.json() as Record<string, unknown>;
  } catch (error) {
    if (error instanceof MarketplaceDiscoveryError) throw error;
    throw new MarketplaceDiscoveryError("marketplace_discovery_unavailable", 502);
  } finally {
    clearTimeout(timeout);
  }

  const items = Array.isArray(payload.items) ? payload.items : [];
  const pagination = (payload.pagination && typeof payload.pagination === "object"
    ? payload.pagination
    : {}) as Record<string, unknown>;

  const seen = new Set<string>();
  const candidates: MarketplaceCandidate[] = [];
  for (const item of items) {
    const candidate = normalizeMarketplaceItem(item, { capability, network });
    if (!candidate) continue;
    if (candidate.capabilityMatch === "none") continue;
    if (maxPriceUsdc !== undefined && candidate.priceUsdc > maxPriceUsdc) continue;
    if (!isAddress(candidate.selectedAccept.payTo)) continue;
    if (seen.has(candidate.candidateId)) continue;
    seen.add(candidate.candidateId);
    candidates.push(candidate);
  }

  candidates.sort((left, right) => {
    const order = { exact: 0, related: 1, generic: 2, none: 3 } as const;
    return order[left.capabilityMatch] - order[right.capabilityMatch]
      || left.priceUsdc - right.priceUsdc
      || left.candidateId.localeCompare(right.candidateId);
  });

  return {
    source: MARKETPLACE_SOURCE,
    sourceVersion: MARKETPLACE_SOURCE_VERSION,
    capability,
    network,
    networkLabel: MARKETPLACE_NETWORKS[network],
    query,
    catalogTotal: Number(pagination.total) || items.length,
    candidates: candidates.slice(0, limit),
    queriedAt: new Date().toISOString(),
    readOnly: true,
    paymentCreated: false,
  };
}

/** Checksummed payTo for the winning accept, or null when the catalog is malformed. */
export function marketplacePayToAddress(candidate: MarketplaceCandidate): `0x${string}` | null {
  return isAddress(candidate.selectedAccept.payTo)
    ? getAddress(candidate.selectedAccept.payTo)
    : null;
}
