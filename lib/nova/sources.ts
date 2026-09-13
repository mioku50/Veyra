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
  capabilityQueriesForInterests,
  planRepositorySubjects,
} from "./interests.ts";
import { repositoryDigest, x402Digest } from "./observation.ts";
import type { SubjectDigest } from "./types.ts";

/**
 * Reading the two things Nova can honestly watch for free.
 *
 * Circle's x402 catalog, which Veyra already reads for every purchase, and
 * public GitHub activity. Nothing else: a feed is only as trustworthy as its
 * thinnest source, and a product that pads a quiet day with a source it cannot
 * verify has spent the credibility of the sources it can.
 *
 * Both readers report unavailability rather than emptiness. "Circle did not
 * answer" and "nothing changed" look identical in a brief and mean opposite
 * things, and a daily product that confuses them tells a small lie every day.
 */

export type SourceObservation = {
  kind: "x402_resource" | "github_repository";
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
}): Promise<SourceResult> {
  const observations: SourceObservation[] = [];
  const seen = new Set<string>();
  const labels = new Set<string>();
  const queries = capabilityQueriesForInterests(input.interests);
  let anySucceeded = false;
  let anyAttempted = false;

  for (const query of queries) {
    if (observations.length >= SUBJECT_LIMITS.perAgent) break;
    anyAttempted = true;
    let result;
    try {
      result = await discoverMarketplaceCandidates({
        capability: query.term,
        limit: input.limitPerQuery ?? SUBJECT_LIMITS.x402PerInterest,
        fetchImpl: input.fetchImpl,
      });
    } catch {
      // One failed query is not a failed source; the loop keeps going and the
      // source is only called unavailable if every query failed.
      continue;
    }
    anySucceeded = true;

    let takenForInterest = 0;
    for (const candidate of result.candidates) {
      if (takenForInterest >= SUBJECT_LIMITS.x402PerInterest) break;
      if (observations.length >= SUBJECT_LIMITS.perAgent) break;
      if (seen.has(candidate.candidateId)) continue;
      seen.add(candidate.candidateId);
      takenForInterest += 1;
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
        },
      });
    }
  }

  return {
    observations,
    unavailable: anyAttempted && !anySucceeded ? ["Circle x402 catalog"] : [],
  };
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
      stars: typeof repository.stargazers_count === "number" ? repository.stargazers_count : 0,
    }),
    catalogUpdatedAt: null,
    subjectText: [input.label, typeof repository.description === "string" ? repository.description : ""]
      .filter(Boolean).join(" "),
    context: {
      url: `https://github.com/${input.ref}`,
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
