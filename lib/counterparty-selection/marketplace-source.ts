import { getAddress, isAddress, type Hex } from "viem";
import { hashCanonical, normalizeCapability } from "./canonical.ts";
import { capabilityMatchFor } from "./policy.ts";
import { diversifyByProvider, fundingForAccept, type PaymentFunding } from "./payment-rail.ts";
import type { CapabilityMatch } from "./types.ts";
import {
  DISCOVERY_NETWORKS,
  isDiscoveryNetwork,
  offerMatchesTerm,
  type Erc8004Binding,
  type MarketOffer,
} from "../discovery/offers.ts";

/**
 * Circle x402 service discovery adapter, and the ERC-8004 registry on Arc.
 *
 * This is a *candidate source* for the existing counterparty-selection engine,
 * not a second engine. It answers one question: "which externally published
 * x402 endpoints could serve this capability?" Everything downstream - probing,
 * ranking, policy, clearance - is the same machinery used for ERC-8004
 * counterparties.
 *
 * Circle's catalogue is asked live. The registry's offers come from its daily
 * snapshot (lib/discovery/arc-registry.ts), handed in by the caller, and pass
 * the same normalisation, filters and ranking as a catalogue listing.
 *
 * Deliberately read-only: discovery never authorizes, quotes, or settles.
 */

export const MARKETPLACE_SOURCE = "circle_x402_discovery" as const;
export const MARKETPLACE_SOURCE_VERSION = "veyra-marketplace-source-v1" as const;
export const MARKETPLACE_DISCOVERY_URL = "https://api.circle.com/v2/x402/discovery/resources";

/** How many terms of a capability are searched separately before the union is
 *  considered wide enough. Bounded so a long free-text query cannot fan out
 *  into an unbounded number of upstream requests. */
export const MARKETPLACE_QUERY_TERM_LIMIT = 3;

/** Networks enabled by Veyra's current settlement adapters. Arc mainnet is one
 * since its USDC and Gateway domain are in Veyra's payment tables. */
export const MARKETPLACE_NETWORKS = {
  "eip155:5042": "Arc",
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
  /* How many endpoints one provider may hold in the shortlist before the rest
     of its catalog is deferred behind other sellers. */
  perProviderInShortlist: 3,
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
  /** The provider's own published request shape. Without it Veyra is guessing
   *  what to send, and a guessed body is what turned a live purchase into a
   *  paid HTTP 400. */
  inputSchema: Record<string, unknown> | null;
  /** The provider's own published response shape, kept rather than reduced to
   *  a boolean: it is the only thing a paid response can be held to after the
   *  money has moved. */
  outputSchema: Record<string, unknown> | null;
  siwx: boolean;
  supportsVanillaX402: boolean;
  supportsCircleGateway: boolean;
  /* Which rail the selected accept settles on. Kept next to the accept it was
     derived from so it can never disagree with what will be signed. */
  funding: PaymentFunding;
  accepts: MarketplaceAccept[];
  selectedAccept: MarketplaceAccept;
  priceUsdc: number;
  lastUpdated: string | null;
  capabilities: string[];
  capabilityMatch: CapabilityMatch;
  catalogHash: Hex;
  /** Where Veyra found the listing: Circle's catalogue, or an identity in the
   *  ERC-8004 registry on Arc and the endpoints its registration declares. */
  foundIn: "circle_catalogue" | "erc8004_arc";
  /** The identity in the ERC-8004 registry on Arc that declares this endpoint,
   *  and whether the endpoint names it back. Null when none does. */
  erc8004: Erc8004Binding | null;
};

export type MarketplaceDiscoveryInput = {
  capability: string;
  query?: string;
  /**
   * A candidate that must be in the answer, by id.
   *
   * Discovery is a search, and a search is the right shape when the question is
   * "who could do this". It is the wrong shape when the counterparty is already
   * named -- which is every card Nova builds from a catalogue listing, because
   * the card *is* that endpoint and its price is that endpoint's price.
   *
   * Measured on the live catalogue: searching each card's own display label and
   * then filtering by capability lost the card's own subject in three of five
   * cases, while the capability alone -- the way the catalogue was read when the
   * subject was first seen -- found all five. "Orthogonal patents", "Venice.ai
   * top up" and "twit.sh search" are display names, not search terms, and
   * Circle's search is conjunctive, so each one selected a different slice of
   * the catalogue that happened not to contain the endpoint it was named after.
   * The refusal downstream then read "Veyra could not reach the terms of this
   * endpoint to authorise it", which was true and pointed nowhere.
   *
   * So the named one is fetched rather than hoped for, and is never truncated
   * out of the shortlist. It is still normalized, still price-filtered, and
   * still has to pass every check after this one: this guarantees it is
   * considered, not that it is allowed.
   */
  mustInclude?: string | null;
  network?: string;
  maxPriceUsdc?: number;
  limit?: number;
  requireCircleGateway?: boolean;
  fetchImpl?: typeof fetch;
  /**
   * Offers declared through the ERC-8004 registry on Arc, from its daily
   * snapshot. Used only when the network is Arc. Matched to the query here,
   * term by term, because nobody searches them on Veyra's behalf.
   */
  registryOffers?: readonly MarketOffer[] | null;
  /**
   * Keep only listings that say one of the query's words as a whole word.
   * For a brief, where a card has to be about the interest it sits under; not
   * for a purchase, where the caller has already said what it wants done.
   * See saysItIsAbout. A named counterparty is exempt: it is asked for by id.
   */
  requireWordMatch?: boolean;
};

export type MarketplaceDiscoveryResult = {
  source: typeof MARKETPLACE_SOURCE;
  sourceVersion: typeof MARKETPLACE_SOURCE_VERSION;
  capability: string;
  network: MarketplaceNetwork;
  networkLabel: string;
  query: string;
  catalogTotal: number;
  /** Whether Circle's catalogue answered at least one query. With registry
   *  offers to go on, discovery no longer fails when it does not. */
  circleAnswered: boolean;
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
    /* "arc" means mainnet here: the catalogue lists real sellers, and Arc
       Testnet is not a marketplace network at all. */
    arc: "eip155:5042",
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
  const method = String(metadata.method || "GET").toUpperCase();
  // The execution transport supports these two methods. Rewriting PATCH or
  // DELETE to GET changes what is being discovered, probed and approved.
  if (method !== "GET" && method !== "POST") return null;
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
    inputSchema: inputSchema && typeof inputSchema === "object" && !Array.isArray(inputSchema)
      ? inputSchema as Record<string, unknown>
      : null,
    declaresOutputSchema: Boolean(metadata.output && typeof metadata.output === "object"),
    outputSchema: metadata.output && typeof metadata.output === "object" && !Array.isArray(metadata.output)
      ? metadata.output as Record<string, unknown>
      : null,
    siwx: metadata.siwx === true,
    supportsVanillaX402: metadata.supportsVanillax402 === true,
    supportsCircleGateway: metadata.supportsCircleGateway === true,
    funding: fundingForAccept(selectedAccept),
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
    foundIn: "circle_catalogue",
    erc8004: null,
  };
}

/**
 * Whether a listing says, in its own words, that it is about the term.
 *
 * Circle's catalogue search matches inside words. Asked for "arc" on Arc on
 * 2026-09-26, it returned 206 listings and not one of them said "arc" as a
 * word: they were search engines, matched on "se-arc-h". An owner who chose
 * Arc as an interest was shown Exa search and Parallel search under it, and a
 * seller that really is about Arc was cut from the shortlist by them on price.
 *
 * One word of the term is enough, as one word is enough for the union of
 * per-word searches; it has to be a whole word, in the listing's own name,
 * description, tags, path or request fields.
 */
export function saysItIsAbout(candidate: MarketplaceCandidate, term: string): boolean {
  const offer = {
    resource: candidate.resource,
    provider: candidate.provider.name,
    description: [candidate.description, candidate.provider.description, candidate.provider.category].filter(Boolean).join(" "),
    tags: [...candidate.provider.tags, ...candidate.capabilities],
    inputSchema: candidate.inputSchema,
  };
  return term.split(/[^a-z0-9]+/i)
    .filter((word) => word.length > 2)
    .some((word) => offerMatchesTerm(offer, word));
}

/**
 * An offer from the ERC-8004 registry on Arc, written as a catalogue item so
 * that the same normalisation, ids, capability tokens and hash apply to it as
 * to Circle's own listings. Only the accepts Veyra could sign on this network
 * are carried, and the asset and verifying contract come from Veyra's table,
 * never from the seller.
 */
export function registryItemFor(offer: MarketOffer, network: MarketplaceNetwork): Record<string, unknown> | null {
  if (offer.templated || !isDiscoveryNetwork(network)) return null;
  const facts = DISCOVERY_NETWORKS[network];
  const accepts = offer.accepts
    .filter((accept) => accept.network === network && accept.quotableByVeyra)
    .map((accept) => ({
      scheme: "exact",
      network,
      asset: facts.usdc,
      payTo: accept.payTo,
      amount: accept.amountAtomic,
      extra: accept.rail === "gateway_deposit"
        ? { name: "GatewayWalletBatched", version: "1", verifyingContract: facts.gatewayWallet }
        : {},
    }));
  if (accepts.length === 0) return null;
  let path: string;
  try { path = new URL(offer.resource).pathname; } catch { return null; }
  return {
    resource: offer.resource,
    lastUpdated: offer.listings.find((listing) => listing.listedAt)?.listedAt ?? null,
    accepts,
    metadata: {
      method: offer.method,
      description: offer.description,
      path,
      provider: { name: offer.provider, tags: offer.tags },
      ...(offer.inputSchema ? { input: { body: offer.inputSchema } } : {}),
      supportsVanillax402: accepts.some((accept) => !accept.extra.name),
      supportsCircleGateway: accepts.some((accept) => accept.extra.name === "GatewayWalletBatched"),
    },
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

  /* Circle's discovery search is conjunctive: every term must appear. Measured
     against the live catalog, `market` returns 50 resources and `research`
     returns 50, but `market research` returns zero — so every multi-word
     capability, including the one this screen offers first, discovered nothing
     and the product's default path always answered "Undecided".
     Each term is therefore searched on its own and the results unioned; the
     capability, price and schema filters below already decide what survives, so
     widening the search cannot loosen the verdict. */
  const terms = MARKETPLACE_QUERY_TERM_LIMIT > 0
    ? Array.from(new Set(query.split(/\s+/).filter((term) => term.length > 2)))
      .slice(0, MARKETPLACE_QUERY_TERM_LIMIT)
    : [];
  const queries = terms.length > 1 ? terms : [query];

  const doFetch = input.fetchImpl ?? fetch;

  async function fetchQuery(term: string) {
    const url = buildMarketplaceDiscoveryUrl({
      query: term,
      network,
      maxPriceUsdc,
      limit,
      requireCircleGateway: input.requireCircleGateway,
    });
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("marketplace_discovery_timeout")),
      MARKETPLACE_DISCOVERY_LIMITS.requestTimeoutMs,
    );
    try {
      const response = await doFetch(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw new MarketplaceDiscoveryError("marketplace_discovery_unavailable", 502);
      return await response.json() as Record<string, unknown>;
    } catch (error) {
      if (error instanceof MarketplaceDiscoveryError) throw error;
      throw new MarketplaceDiscoveryError("marketplace_discovery_unavailable", 502);
    } finally {
      clearTimeout(timeout);
    }
  }

  /* The ERC-8004 registry on Arc, matched to the same terms Circle is asked.
     Circle searches its own catalogue; nobody searches these on Veyra's behalf,
     so a term is matched against what each offer says about itself. */
  const registry = network === "eip155:5042"
    ? (input.registryOffers ?? []).filter((offer) => !offer.templated)
    : [];
  const registryItems = registry
    .filter((offer) => queries.some((term) => offerMatchesTerm(offer, term)))
    /* What Circle's own filter does for its listings, done here for these. */
    .filter((offer) => !input.requireCircleGateway
      || offer.accepts.some((accept) => accept.network === network && accept.rail === "gateway_deposit"))
    .map((offer) => ({ offer, item: registryItemFor(offer, network) }))
    .filter((entry): entry is { offer: MarketOffer; item: Record<string, unknown> } => entry.item !== null);

  /* One term timing out must not lose the other terms' results: the union is a
     widening, so a partial union is still strictly better than the single
     conjunctive query it replaced. Discovery only fails when nothing answers:
     not Circle, and not the registry either. */
  const settled = await Promise.allSettled(queries.map(fetchQuery));
  const payloads = settled
    .filter((outcome): outcome is PromiseFulfilledResult<Record<string, unknown>> =>
      outcome.status === "fulfilled")
    .map((outcome) => outcome.value);
  if (payloads.length === 0 && registryItems.length === 0) {
    throw new MarketplaceDiscoveryError("marketplace_discovery_unavailable", 502);
  }

  const items: unknown[] = [];
  let catalogTotal = 0;
  for (const payload of payloads) {
    if (Array.isArray(payload.items)) items.push(...payload.items);
    const pagination = (payload.pagination && typeof payload.pagination === "object"
      ? payload.pagination
      : {}) as Record<string, unknown>;
    catalogTotal += Number(pagination.total) || (Array.isArray(payload.items) ? payload.items.length : 0);
  }

  const seen = new Set<string>();
  const candidates: MarketplaceCandidate[] = [];
  function eligibleItem(item: unknown): MarketplaceCandidate | null {
    const candidate = normalizeMarketplaceItem(item, { capability, network });
    if (!candidate || candidate.capabilityMatch === "none") return null;
    if (maxPriceUsdc !== undefined && candidate.priceUsdc > maxPriceUsdc) return null;
    if (!isAddress(candidate.selectedAccept.payTo)) return null;
    return candidate;
  }
  for (const item of items) {
    const candidate = eligibleItem(item);
    if (!candidate) continue;
    if (input.requireWordMatch && !queries.some((term) => saysItIsAbout(candidate, term))) continue;
    if (seen.has(candidate.candidateId)) continue;
    seen.add(candidate.candidateId);
    candidates.push(candidate);
  }
  const fromRegistry = (offer: MarketOffer, item: Record<string, unknown>): MarketplaceCandidate | null => {
    const candidate = eligibleItem(item);
    return candidate ? { ...candidate, foundIn: "erc8004_arc", erc8004: offer.erc8004 } : null;
  };
  for (const { offer, item } of registryItems) {
    const candidate = fromRegistry(offer, item);
    if (!candidate) continue;
    /* Listed by Circle as well: one candidate, which also carries the identity
       that declares it. */
    const listed = candidates.find((existing) => existing.candidateId === candidate.candidateId);
    if (listed) {
      listed.erc8004 ??= candidate.erc8004;
      continue;
    }
    seen.add(candidate.candidateId);
    candidates.push(candidate);
    catalogTotal += 1;
  }

  candidates.sort((left, right) => {
    const order = { exact: 0, related: 1, generic: 2, none: 3 } as const;
    return order[left.capabilityMatch] - order[right.capabilityMatch]
      || left.priceUsdc - right.priceUsdc
      || left.candidateId.localeCompare(right.candidateId);
  });

  /* A live "web search" discovery returned nine endpoints from one provider at
     an identical price, which filled the shortlist and pushed out a resource
     that cost half as much on a rail the buyer could actually pay. Ties in
     capability and price leave catalog order intact, so endpoint sprawl reads
     as a market. Later entries from the same provider are deferred, never
     dropped, and nothing is promoted above a better match. */
  const shortlist = diversifyByProvider(
    candidates,
    (candidate) => candidate.provider.name?.toLowerCase() || candidate.origin,
    MARKETPLACE_DISCOVERY_LIMITS.perProviderInShortlist,
  );

  let top = shortlist.slice(0, limit);

  const wanted = input.mustInclude?.trim() || null;
  if (wanted && !top.some((candidate) => candidate.candidateId === wanted)) {
    /* Search the bounded fallback response BEFORE cutting its shortlist.
       Recursing through discovery previously lost a named seller behind cheap
       alternatives, even when Circle had returned that exact seller. The same
       normalization and price filters apply; a changed payee changes its id. */
    let named = candidates.find((candidate) => candidate.candidateId === wanted) ?? null;
    /* A card named after an offer the registry declares is that offer,
       whatever the search term: looked up by id, before asking Circle again. */
    for (const offer of named ? [] : registry) {
      const item = registryItemFor(offer, network);
      const candidate = item ? fromRegistry(offer, item) : null;
      if (candidate?.candidateId === wanted) {
        named = candidate;
        break;
      }
    }
    if (!named && payloads.length > 0) {
      const fallbackQuery = capability.replace(/_/g, " ");
      const fallbackTerms = Array.from(new Set(fallbackQuery.split(/\s+/).filter(term => term.length > 2)))
        .slice(0, MARKETPLACE_QUERY_TERM_LIMIT);
      const fallbackQueries = fallbackTerms.length > 1 ? fallbackTerms : [fallbackQuery];
      const responses = await Promise.allSettled(fallbackQueries.map(fetchQuery));
      for (const response of responses) {
        if (response.status !== "fulfilled" || !Array.isArray(response.value.items)) continue;
        named = response.value.items.map(eligibleItem).find(candidate => candidate?.candidateId === wanted) ?? null;
        if (named) break;
      }
    }

    /* First, and the rest trimmed around it rather than after it. Appending
       inside a sliced list would put it back at the mercy of the same limit. */
    if (named) top = [named, ...top.filter((c) => c.candidateId !== wanted)].slice(0, limit);
  }

  return {
    source: MARKETPLACE_SOURCE,
    sourceVersion: MARKETPLACE_SOURCE_VERSION,
    capability,
    network,
    networkLabel: MARKETPLACE_NETWORKS[network],
    query,
    catalogTotal,
    circleAnswered: payloads.length > 0,
    candidates: top,
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
