/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  discoverMarketplaceCandidates,
  type MarketplaceCandidate,
} from "../counterparty-selection/marketplace-source.ts";
import {
  SUBJECT_LIMITS,
  subjectBudgetFor,
  capabilityQueriesForInterests,
  planRepositorySubjects,
} from "./interests.ts";
import { ARC_FIRST } from "../discovery/offers.ts";
import { loadArcRegistryView, type ArcRegistryView } from "../discovery/arc-registry.ts";
import { repositoryDigest, x402Digest } from "./observation.ts";
import type { SubjectDigest } from "./types.ts";
import { buildRequestBody } from "../x402/request-body.ts";
import type { JsonSchema } from "../seller/json-schema.ts";

/** Catalog and GitHub readers. Curated official publications live in
 * public-sources.ts. Unavailability remains distinct from an empty result.
 */

export type SourceObservation = {
  kind: "x402_resource" | "github_repository" | "official_publication";
  ref: string;
  label: string;
  interest: string;
  digest: SubjectDigest;
  /** Only for catalog entries: the catalog's own last-updated timestamp, which
   *  is what makes a first sighting either news or not. */
  catalogUpdatedAt: string | null;
  /** The subject described in its own words -- provider, description, declared
   *  capabilities -- which is what relevance is scored against. Never Nova's
   *  own sentence about it. */
  subjectText: string;
  /** Kept so an investigation can be priced and routed without re-discovery. */
  context: Record<string, unknown>;
};

export type SourceResult = {
  observations: SourceObservation[];
  /** Human-readable names of sources that could not be read this time. */
  unavailable: string[];
  /**
   * Fetched, and then not understood: {feed label: article count}.
   *
   * A separate number from `unavailable` because it calls for a separate
   * response. A host that does not answer is a coverage failure and the owner
   * is told so; an article whose date is not where the parser looks is a
   * parser that has fallen behind one publisher's markup, and telling the
   * owner their source is unreachable is simply false. LangChain
   * announcements reported the latter as the former on all twelve passes of
   * the D0 epoch, from one undated article in ten.
   */
  unreadable?: Record<string, number>;
};

/* ---- Circle's x402 catalog ---- */

/**
 * A name a person can tell apart from the others.
 *
 * The last path segment alone is not enough: two different Blocksize resources
 * both ended in the same word and the first live brief showed "Blocksize BTC
 * USD" twice, which reads as a bug in Nova rather than as two endpoints. So the
 * label grows leftwards along the path until it is unique within the brief.
 */
function candidateLabel(candidate: MarketplaceCandidate, taken: Set<string>): string {
  const provider = candidate.provider.name?.trim() ?? "";
  let segments: string[] = [];
  try {
    const url = new URL(candidate.resource);
    segments = url.pathname.split("/").filter(Boolean);
    if (segments.length === 0) segments = [url.hostname];
  } catch {
    segments = [candidate.resource.slice(0, 40)];
  }

  for (let depth = 1; depth <= segments.length; depth += 1) {
    const tail = segments.slice(-depth).join(" ").replace(/[-_]+/g, " ").trim();
    const label = [provider, tail].filter(Boolean).join(" ").slice(0, 120);
    if (label && !taken.has(label)) {
      taken.add(label);
      return label;
    }
  }

  // Distinct resources that still collide are separated by the method, and
  // failing that left distinguishable by their position rather than merged.
  const fallback = `${provider || candidate.resource} ${candidate.method}`.trim();
  let unique = fallback;
  let suffix = 2;
  while (taken.has(unique)) unique = `${fallback} (${suffix++})`;
  taken.add(unique);
  return unique;
}

export async function observeX402Catalog(input: {
  interests: string[];
  fetchImpl?: typeof fetch;
  limitPerQuery?: number;
  /** The ERC-8004 registry on Arc as of its last daily read. Read from the
   *  store when not given. */
  registry?: ArcRegistryView;
}): Promise<SourceResult> {
  /* Sellers registered on Arc, alongside Circle's catalogue. The brief read
     Circle's alone, so an agent that registered on Arc and sold there reached
     nobody's brief however well it answered. */
  const registry = input.registry ?? await loadArcRegistryView();
  const observations: SourceObservation[] = [];
  const seen = new Set<string>();
  const labels = new Set<string>();
  const takenPerInterest = new Map<string, number>();
  const takenPerProvider = new Map<string, number>();
  const budget = subjectBudgetFor(input.interests.length);
  const queries = capabilityQueriesForInterests(input.interests);
  let anySucceeded = false;
  let anyAttempted = false;

  /* Arc first, Base additional (the owner's order of 2026-09-23). The read
     asked for Base alone, so Arc sellers never reached a brief however many
     Circle listed there. One endpoint sold on both is one card, on the network
     read first; which network is paid is still decided at purchase time from
     the live challenge, and a mandate naming Base does not stretch to Arc. */
  const passes = queries.flatMap((query) => ARC_FIRST.map((network) => ({ ...query, network })));
  const seenResources = new Set<string>();

  for (const query of passes) {
    if (observations.length >= budget) break;
    anyAttempted = true;
    let result;
    try {
      result = await discoverMarketplaceCandidates({
        capability: query.term,
        network: query.network,
        /* Ask for more than will be kept. Three were requested and three were
           kept, so any filter applied afterwards -- a templated path, a schema
           with nowhere to put a question, a seller already holding its share --
           came out of the interest's own share rather than out of the surplus,
           and an interest whose first three all failed got nothing at all. */
        limit: input.limitPerQuery ?? SUBJECT_LIMITS.candidatesPerQuery,
        fetchImpl: input.fetchImpl,
        registryOffers: registry.offers,
        /* A card is about the interest it sits under. See saysItIsAbout. */
        requireWordMatch: true,
      });
    } catch {
      // One failed query is not a failed source; the loop keeps going and the
      // source is only called unavailable if every query failed.
      continue;
    }
    if (result.circleAnswered) anySucceeded = true;

    /* Per interest, not per query. It reset on every capability term, so an
       interest with three terms could take three times its share while the
       interest after it took none. */
    let takenForInterest = takenPerInterest.get(query.interest) ?? 0;
    for (const candidate of result.candidates) {
      if (takenForInterest >= SUBJECT_LIMITS.x402PerInterest) break;
      if (observations.length >= budget) break;
      if (seen.has(candidate.candidateId)) continue;
      seen.add(candidate.candidateId);
      const resourceKey = `${candidate.method} ${candidate.resource}`;
      if (seenResources.has(resourceKey)) continue;
      /* Watch only what could be bought from a brief.
         Three per interest were taken by catalogue rank, and rank says nothing
         about whether a person could ever press the button: of 148 listings
         reachable through this vocabulary, 22 are published as path templates
         and 47 declare no field a question fits in. Both are decidable from the
         listing itself, without a request, and a card offering neither an
         answer nor a reason is worse than no card. */
      if (!worthWatching(candidate)) continue;
      /* One seller may not be the whole brief.
         Ranking is per query and a provider with a large catalogue wins it
         repeatedly: Research & search came back as three Orthogonal endpoints
         and Agent payments as three more, so an agent watching five interests
         was really watching two sellers. Variety is not a nicety here -- the
         point of the brief is that a person sees the market, and a market with
         one name in it is a catalogue page. */
      const provider = candidate.provider?.name ?? "unknown";
      const held = takenPerProvider.get(provider) ?? 0;
      if (held >= SUBJECT_LIMITS.perProvider) continue;
      takenPerProvider.set(provider, held + 1);
      seenResources.add(resourceKey);
      takenForInterest += 1;
      takenPerInterest.set(query.interest, takenForInterest);
      observations.push({
        kind: "x402_resource",
        ref: candidate.candidateId,
        label: candidateLabel(candidate, labels),
        interest: query.interest,
        digest: x402Digest({
          priceAtomic: candidate.selectedAccept.amountAtomic,
          payTo: candidate.selectedAccept.payTo,
          // The catalog listing alone does not prove the endpoint answers; only
          // a probe does, and that is the investigation the person pays for.
          reachable: true,
          provider: candidate.provider.name,
          network: candidate.selectedAccept.network,
          funding: candidate.funding,
        }),
        catalogUpdatedAt: candidate.lastUpdated,
        /* The URL is deliberately left out. Hostnames are where the false
           matches come from -- every .ai domain reads as an interest in AI --
           and a provider's own words are the honest description of it. */
        subjectText: [
          candidate.provider.name,
          candidate.description,
          candidate.capabilities.join(" "),
          candidate.provider.tags.join(" "),
        ].filter(Boolean).join(" "),
        context: {
          resource: candidate.resource,
          method: candidate.method,
          capability: query.term,
          priceUsdc: candidate.priceUsdc,
          /* The chain the price is on. Absent, the only thing naming a network
             on the card was the interest that matched, which is not one. */
          network: candidate.selectedAccept.network,
          funding: candidate.funding,
          provider: candidate.provider.name,
          docsUrl: candidate.provider.docsUrl,
          description: candidate.description,
          /* Where it was found and who declares it, for the card to say. A
             registry entry alone proves nothing about who runs an endpoint;
             one the endpoint's own manifest names back does. */
          foundIn: candidate.foundIn,
          erc8004: candidate.erc8004
            ? { agentId: candidate.erc8004.agentId, binding: candidate.erc8004.binding }
            : null,
        },
      });
    }
  }

  const unavailable: string[] = [];
  if (anyAttempted && !anySucceeded) unavailable.push("Circle x402 catalog");
  /* Named when it has not been read in three days, or never: a blind spot is
     said, not shown as a quiet market. */
  if (anyAttempted && registry.state !== "fresh") unavailable.push("ERC-8004 registry on Arc");
  return { observations, unavailable };
}

/**
 * Whether a listing could ever be the subject of a purchase from the brief.
 *
 * Two disqualifications, both readable off the catalogue entry:
 *
 * A templated path -- x402.api.agentmail.to/v0/domains/{domain_id} -- is an
 * endpoint for a caller that already knows which record it means. A brief does
 * not, and the braces are published literally.
 *
 * A schema with nowhere to put a question cannot be asked one. Alchemy's
 * token-price call declares `addresses` and nothing else, so the body built
 * from it is `{}` -- valid, and carrying not one word of what was asked. That
 * cost a real tenth of a cent before it was caught at purchase time; caught
 * here, the card is never drawn.
 *
 * Neither check costs a request, which is why both belong at the point where
 * subjects are chosen rather than at the point where money is.
 *
 * A GET is the third. Veyra sends a GET without a body, and the quote refuses
 * a GET that would need one rather than drop the question in silence
 * (lib/x402/execution.ts), so Nova can never ask a GET anything: the purchase
 * path skips it every time. On 2026-09-26, 30 of the 82 listings the owner's
 * agent had been shown in thirty days were GETs, and so were 67 of the 68
 * offers the ERC-8004 registry on Arc declared. They come back once a GET's
 * parameters can be bound into the URL the owner approves.
 */
export function worthWatching(candidate: { resource: string; method: "GET" | "POST"; inputSchema?: unknown }): boolean {
  if (candidate.method === "GET") return false;
  if (/[{}]/.test(candidate.resource)) return false;
  const plan = buildRequestBody({
    intent: "what is this for",
    capability: "research",
    inputSchema: (candidate.inputSchema ?? null) as JsonSchema | null,
  });
  return plan.guessed || plan.intentField !== null;
}

/* ---- GitHub ---- */

const GITHUB_API = "https://api.github.com";
export const PULSE_WINDOW_HOURS = 168;

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "Veyra-Nova/1.0",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export type GithubReadFailure = "rate_limited" | "unavailable" | null;

/**
 * Reads one GitHub endpoint and says how it failed, not just that it did.
 *
 * Being rate-limited is not a partial read. Unauthenticated GitHub allows sixty
 * requests an hour for the whole deployment, and when that runs out every
 * repository disappears from the brief at once -- which was observed here: the
 * best item in a live brief vanished and the run still reported every source as
 * available. A brief that quietly drops its strongest source is worse than one
 * that says it could not look.
 */
async function githubJson<T>(
  path: string,
  fetchImpl: typeof fetch,
  outcome: { failure: GithubReadFailure },
): Promise<T | null> {
  try {
    const response = await fetchImpl(`${GITHUB_API}${path}`, {
      headers: githubHeaders(),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      const exhausted = response.headers.get("x-ratelimit-remaining") === "0";
      if ((response.status === 403 || response.status === 429) && exhausted) {
        outcome.failure = "rate_limited";
      } else if (outcome.failure === null && response.status >= 500) {
        outcome.failure = "unavailable";
      }
      return null;
    }
    return await response.json() as T;
  } catch {
    if (outcome.failure === null) outcome.failure = "unavailable";
    return null;
  }
}

/**
 * Three requests per repository, not fifteen.
 *
 * The existing due-diligence snapshot walks 30, 90 and 180-day commit windows
 * and costs well over a dozen calls. Unauthenticated GitHub allows sixty an
 * hour for the whole deployment, so reusing it here would exhaust the budget on
 * a single person's refresh and every later brief would silently be blind.
 * A daily pulse needs recent commits, contributors and the latest release --
 * and nothing else.
 */
export async function observeRepositoryPulse(input: {
  ref: string;
  label: string;
  interest: string;
  now: Date;
  fetchImpl?: typeof fetch;
  outcome?: { failure: GithubReadFailure };
}): Promise<SourceObservation | null> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const outcome = input.outcome ?? { failure: null as GithubReadFailure };
  const [owner, name] = input.ref.split("/");
  if (!owner || !name) return null;

  const since = new Date(input.now.getTime() - PULSE_WINDOW_HOURS * 3_600_000).toISOString();
  const [repository, commits, release] = await Promise.all([
    githubJson<Record<string, unknown>>(`/repos/${owner}/${name}`, fetchImpl, outcome),
    githubJson<Array<Record<string, any>>>(
      `/repos/${owner}/${name}/commits?since=${encodeURIComponent(since)}&per_page=100`,
      fetchImpl,
      outcome,
    ),
    githubJson<Record<string, unknown>>(`/repos/${owner}/${name}/releases/latest`, fetchImpl, outcome),
  ]);

  // The repository read is the one that cannot be missing: without it there is
  // no evidence at all, and a digest built from two thirds of nothing would
  // register as a change on the next refresh.
  if (!repository) return null;

  const commitList = Array.isArray(commits) ? commits : [];
  /* One page is the cap, so a full page means "at least this many". Foundry
     returns exactly 100 over a week; printing that as the total would quietly
     understate the busiest repositories every time. */
  const commitsAreLowerBound = commitList.length >= 100;
  const authors = new Set<string>();
  let lastCommitAt: string | null = null;
  for (const commit of commitList) {
    const at = commit?.commit?.committer?.date ?? commit?.commit?.author?.date ?? null;
    if (typeof at === "string" && (!lastCommitAt || at > lastCommitAt)) lastCommitAt = at;
    const author = commit?.author?.login ?? commit?.commit?.author?.name;
    if (typeof author === "string" && author.trim()) authors.add(author.trim());
  }

  const pushedAt = typeof repository.pushed_at === "string" ? repository.pushed_at : null;

  const releaseMaterial = typeof release?.body === "string" && typeof release?.html_url === "string"
    && release.html_url.startsWith(`https://github.com/${input.ref}/releases/`)
    && typeof release?.published_at === "string"
    ? { id: release.html_url, url: release.html_url, title: String(release.name || release.tag_name).slice(0, 160),
        text: release.body.slice(0, 6000), publishedAt: release.published_at, fetchedAt: input.now.toISOString() }
    : null;

  return {
    kind: "github_repository",
    ref: input.ref,
    label: input.label,
    interest: input.interest,
    digest: repositoryDigest({
      lastCommitAt: lastCommitAt ?? pushedAt,
      commitsInWindow: commitList.length,
      contributorCount: authors.size,
      latestRelease: typeof release?.tag_name === "string" ? release.tag_name : null,
      releaseMaterial,
      stars: typeof repository.stargazers_count === "number" ? repository.stargazers_count : 0,
    }),
    catalogUpdatedAt: null,
    subjectText: [input.label, typeof repository.description === "string" ? repository.description : ""]
      .filter(Boolean).join(" "),
    context: {
      url: `https://github.com/${input.ref}`,
      publicMaterial: releaseMaterial,
      description: typeof repository.description === "string" ? repository.description : null,
      windowHours: PULSE_WINDOW_HOURS,
      commitsAreLowerBound,
    },
  };
}

export async function observeRepositories(input: {
  interests: string[];
  now: Date;
  fetchImpl?: typeof fetch;
}): Promise<SourceResult> {
  const planned = planRepositorySubjects(input.interests);
  if (planned.length === 0) return { observations: [], unavailable: [] };

  const outcome = { failure: null as GithubReadFailure };
  const results = await Promise.all(planned.map((subject) =>
    observeRepositoryPulse({
      ref: subject.ref,
      label: subject.label,
      interest: subject.interest,
      now: input.now,
      fetchImpl: input.fetchImpl,
      outcome,
    })));

  const observations = results.filter((result): result is SourceObservation => result !== null);

  /* Rate limiting is named even when some repositories came back. Sixty
     requests an hour is the whole deployment's budget without a token, and when
     it runs out repositories stop appearing one by one -- so a run that saw
     three of four after a 403 is not a quiet day for the fourth, it is a blind
     spot, and the person is told rather than shown a shorter list. */
  const unavailable: string[] = [];
  if (outcome.failure === "rate_limited") {
    unavailable.push("GitHub (hourly request limit reached)");
  } else if (observations.length === 0 && planned.length > 0) {
    unavailable.push("GitHub");
  }
  return { observations, unavailable };
}
