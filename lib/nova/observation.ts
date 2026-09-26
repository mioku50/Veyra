/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ObservedChange, SubjectDigest } from "./types.ts";

/**
 * Turning two observations of the same thing into something worth saying.
 *
 * The trap this module exists to avoid: on the first refresh Nova has never
 * seen any subject before, so a naive implementation reports everything as new
 * and the very first brief -- the one that decides whether a person comes back
 * -- is entirely false news.
 *
 * The fix is that a first sighting is not a change. What makes the first brief
 * real is that the subjects themselves carry timestamps: a commit landed four
 * hours ago, a release was cut on Tuesday, a catalog entry was updated
 * yesterday. Those facts are true no matter when Nova started watching, so the
 * first brief reports recent change in the world rather than novelty to Nova.
 *
 * Everything here is pure. Given the same two digests it returns the same
 * sentences, which is what makes the brief auditable rather than generated.
 */

/** How recent something has to be to count as news on a first look. */
export const FIRST_LOOK_WINDOW = {
  /* A week, not a day. Measured across the seed repositories: a 48-hour window
     found activity in two of seven, a seven-day window in four, and the two
     quiet Circle repositories stayed quiet in both -- so the wider window adds
     real work rather than manufacturing it. */
  commitHours: 168,
  releaseDays: 21,
} as const;

function hoursSince(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return null;
  return (now.getTime() - time) / 3_600_000;
}

function usdc(atomic: string): string {
  const value = Number(atomic) / 1e6;
  if (!Number.isFinite(value)) return atomic;
  return `$${value.toFixed(value < 0.01 ? 4 : 2)}`;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function describeAge(hours: number): string {
  if (hours < 1) return "in the last hour";
  if (hours < 24) return `${Math.round(hours)}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/* ---- digests ---- */

export function x402Digest(input: {
  priceAtomic: string;
  payTo: string | null;
  reachable: boolean;
  provider: string | null;
  network: string | null;
  funding: "wallet" | "gateway_deposit";
}): SubjectDigest {
  return {
    kind: "x402_resource",
    priceAtomic: input.priceAtomic,
    payTo: input.payTo ? input.payTo.toLowerCase() : null,
    reachable: input.reachable,
    provider: input.provider,
    network: input.network,
    funding: input.funding,
  };
}

export function repositoryDigest(input: {
  lastCommitAt: string | null;
  commitsInWindow: number;
  contributorCount: number;
  latestRelease: string | null;
  releaseMaterial?: import("./value.ts").PublicMaterial | null;
  stars: number;
}): SubjectDigest {
  return {
    kind: "github_repository",
    lastCommitAt: input.lastCommitAt,
    commitsInWindow: Math.max(0, Math.trunc(input.commitsInWindow)),
    contributorCount: Math.max(0, Math.trunc(input.contributorCount)),
    latestRelease: input.latestRelease,
    releaseMaterial: input.releaseMaterial ?? null,
    stars: Math.max(0, Math.trunc(input.stars)),
  };
}

/* ---- changes ---- */

export type ChangeInput = {
  label: string;
  previous: SubjectDigest | null;
  next: SubjectDigest;
  now: Date;
  /** The catalog's own "last updated", used only on a first look. */
  catalogUpdatedAt?: string | null;
  /** True when the commit count hit the API's page size and is therefore a
   *  floor. Wording only -- it must never enter the digest, or a repository
   *  crossing the cap would register as a change in its own right. */
  commitsAreLowerBound?: boolean;
  /** Where a paid listing was found, and the ERC-8004 identity that declares
   *  it: the observation's own context. Wording only, like the two above. */
  listing?: { foundIn?: unknown; erc8004?: unknown } | null;
};

export function changesForSubject(input: ChangeInput): ObservedChange[] {
  if (input.next.kind === "official_publication") {
    if (input.previous?.kind === "official_publication") return [];
    const material = input.next.material;
    const age = input.now.getTime() - Date.parse(material.publishedAt ?? "");
    if (!Number.isFinite(age) || age < 0 || age > 21 * 86400_000) return [];
    return [{ kind: "official_publication", headline: material.title, detail: material.text.slice(0, 580),
      evidence: { publicMaterial: material }, observedAt: input.now.toISOString() }];
  }
  if (input.next.kind === "x402_resource") {
    const previous = input.previous?.kind === "x402_resource" ? input.previous : null;
    return previous
      ? x402Changes(input.label, previous, input.next, input.now)
      : x402FirstLook(input.label, input.next, input.now, input.catalogUpdatedAt ?? null, input.listing ?? null);
  }
  const previous = input.previous?.kind === "github_repository" ? input.previous : null;
  const floor = input.commitsAreLowerBound === true;
  return previous
    ? repositoryChanges(input.label, previous, input.next, input.now, floor)
    : repositoryFirstLook(input.label, input.next, input.now, floor);
}

/** "100 new commits" is what one page of the commits API holds, so at the cap
 *  it is a floor rather than a total. Printing the cap as an exact count
 *  understates the busiest repositories every single time, which is the one
 *  place a reader would most notice being wrong. */
function commitPhrase(count: number, isLowerBound: boolean): string {
  const noun = count === 1 ? "new commit" : "new commits";
  return isLowerBound ? `at least ${count} ${noun}` : `${count} ${noun}`;
}

function x402Changes(
  label: string,
  previous: Extract<SubjectDigest, { kind: "x402_resource" }>,
  next: Extract<SubjectDigest, { kind: "x402_resource" }>,
  now: Date,
): ObservedChange[] {
  const changes: ObservedChange[] = [];
  const observedAt = now.toISOString();

  /* The payee first, and on its own. Everything else here is commerce; this is
     the one change that can mean the endpoint a person trusted is now paying
     somebody else, and it must never be buried under a price line. */
  if (previous.payTo && next.payTo && previous.payTo !== next.payTo) {
    changes.push({
      kind: "payee_changed",
      headline: `${label} is paying a different address`,
      detail: `The address receiving payment changed from ${previous.payTo} to ${next.payTo}. The endpoint is the same; the recipient is not.`,
      evidence: { previousPayTo: previous.payTo, payTo: next.payTo },
      observedAt,
    });
  }

  if (previous.priceAtomic !== next.priceAtomic) {
    const before = BigInt(previous.priceAtomic);
    const after = BigInt(next.priceAtomic);
    const direction = after > before ? "rose" : "fell";
    changes.push({
      kind: "price_changed",
      headline: `${label} ${direction} to ${usdc(next.priceAtomic)}`,
      detail: `Priced at ${usdc(previous.priceAtomic)} when Nova last looked, now ${usdc(next.priceAtomic)} per call.`,
      evidence: {
        previousPriceAtomic: previous.priceAtomic,
        priceAtomic: next.priceAtomic,
        direction: after > before ? "increase" : "decrease",
      },
      observedAt,
    });
  }

  /* A rail change costs nothing and shows nowhere, and it decides whether this
     person can pay this endpoint at all: the batched scheme spends a Circle
     Gateway deposit, so a wallet full of USDC is refused. Finding that out at
     the signature is the failure the router exists to prevent; finding out here
     is a day's warning. */
  if (previous.funding !== next.funding) {
    const toDeposit = next.funding === "gateway_deposit";
    changes.push({
      kind: "rail_changed",
      headline: toDeposit
        ? `${label} now needs a Circle Gateway deposit`
        : `${label} is now payable from your wallet`,
      detail: toDeposit
        ? "It used to settle straight from a wallet balance. It now settles through a Gateway deposit, so a funded wallet alone will be refused."
        : "It used to require a Circle Gateway deposit and now settles straight from a wallet balance.",
      evidence: { previousFunding: previous.funding, funding: next.funding },
      observedAt,
    });
  }

  if (previous.reachable && !next.reachable) {
    changes.push({
      kind: "endpoint_unreachable",
      headline: `${label} stopped answering`,
      detail: "The endpoint answered when Nova last checked and does not now. Worth knowing before you route a payment to it.",
      evidence: { reachable: false },
      observedAt,
    });
  } else if (!previous.reachable && next.reachable) {
    changes.push({
      kind: "endpoint_recovered",
      headline: `${label} is answering again`,
      detail: "The endpoint was unreachable when Nova last checked and is responding now.",
      evidence: { reachable: true },
      observedAt,
    });
  }

  return changes;
}

/**
 * Where a listing was found, as the card says it.
 *
 * Anyone can register an ERC-8004 identity that names any endpoint, so a
 * registration alone says nothing about who runs it. When the endpoint's own
 * manifest names the identity back, the two point at each other, and that is
 * said too.
 */
export function listedWhere(listing: { foundIn?: unknown; erc8004?: unknown } | null | undefined): string {
  const identity = listing?.erc8004 && typeof listing.erc8004 === "object"
    ? listing.erc8004 as { agentId?: unknown; binding?: unknown }
    : null;
  const agent = identity && typeof identity.agentId === "string" ? `agent #${identity.agentId}` : null;
  const declared = agent
    ? identity!.binding === "both_ways"
      ? `declared by ${agent} in the ERC-8004 registry on Arc, and the endpoint names that agent back`
      : `declared by ${agent} in the ERC-8004 registry on Arc; the endpoint does not name that agent back`
    : null;
  if (listing?.foundIn === "erc8004_arc") return declared ? `Not in Circle's catalog: ${declared}` : "Found in the ERC-8004 registry on Arc";
  return declared ? `Listed in Circle's catalog, and ${declared}` : "Listed in Circle's catalog";
}

function x402FirstLook(
  label: string,
  next: Extract<SubjectDigest, { kind: "x402_resource" }>,
  now: Date,
  catalogUpdatedAt: string | null,
  listing: { foundIn?: unknown; erc8004?: unknown } | null,
): ObservedChange[] {
  /* A finding, and worded as one.
   *
   * The obvious move here is to call a first sighting "new" and let the
   * catalog's lastUpdated decide how new. Measured against the live catalog,
   * that does not survive contact: of 1139 resources not one was fresher than
   * 11.9 days and the median was 32, so the field cannot support the claim, and
   * widening the window until it fires would only mean calling month-old
   * listings new.
   *
   * What is true on a first look is that this capability exists, costs this, and
   * settles on this rail -- which is also the thing a person cannot find out
   * without Veyra. So that is what gets said. */
  return [{
    kind: "capability_available",
    headline: `${label} is available for ${usdc(next.priceAtomic)}`,
    detail: `A paid capability matching your interests${next.provider ? `, from ${next.provider}` : ""}. ${
      next.reachable ? listedWhere(listing) : "Listed, but not answering"
    }${catalogUpdatedAt ? `, last updated ${describeAge(hoursSince(catalogUpdatedAt, now) ?? 0)}` : ""}.`,
    evidence: {
      priceAtomic: next.priceAtomic,
      provider: next.provider,
      network: next.network,
      funding: next.funding,
      catalogUpdatedAt,
      firstLook: true,
    },
    observedAt: now.toISOString(),
  }];
}

function repositoryChanges(
  label: string,
  previous: Extract<SubjectDigest, { kind: "github_repository" }>,
  next: Extract<SubjectDigest, { kind: "github_repository" }>,
  now: Date,
  commitsAreLowerBound: boolean,
): ObservedChange[] {
  const changes: ObservedChange[] = [];
  const observedAt = now.toISOString();

  if (next.latestRelease && next.latestRelease !== previous.latestRelease) {
    changes.push({
      kind: "repository_release",
      headline: `${label} released ${next.latestRelease}`,
      detail: previous.latestRelease
        ? `Previous release was ${previous.latestRelease}.`
        : "First release Nova has seen on this repository.",
      evidence: { release: next.latestRelease, previousRelease: previous.latestRelease },
      observedAt,
    });
  }

  /* Commits only count when the newest one is newer than the one Nova recorded.
     Comparing counts alone would re-report the same work every refresh, because
     a rolling window keeps counting the commits already reported. */
  const movedOn = next.lastCommitAt && next.lastCommitAt !== previous.lastCommitAt;
  if (movedOn && next.commitsInWindow > 0) {
    const age = hoursSince(next.lastCommitAt, now);
    const contributors = next.contributorCount;
    changes.push({
      kind: "repository_activity",
      headline: `${label}: ${commitPhrase(next.commitsInWindow, commitsAreLowerBound)}`,
      detail: `${plural(contributors, "contributor")} active, most recent commit ${age === null ? "recently" : describeAge(age)}.`,
      evidence: {
        commits: next.commitsInWindow,
        commitsAreLowerBound,
        contributors,
        lastCommitAt: next.lastCommitAt,
        previousCommitAt: previous.lastCommitAt,
      },
      observedAt,
    });
  }

  return changes;
}

function repositoryFirstLook(
  label: string,
  next: Extract<SubjectDigest, { kind: "github_repository" }>,
  now: Date,
  commitsAreLowerBound: boolean,
): ObservedChange[] {
  const changes: ObservedChange[] = [];
  const observedAt = now.toISOString();
  const commitAge = hoursSince(next.lastCommitAt, now);
  const releaseAge = hoursSince(next.releaseMaterial?.publishedAt ?? null, now);
  if (next.latestRelease && releaseAge !== null && releaseAge >= 0 && releaseAge <= FIRST_LOOK_WINDOW.releaseDays * 24) {
    changes.push({ kind: "repository_release", headline: `${label} released ${next.latestRelease}`.slice(0,160),
      detail: next.releaseMaterial!.text.slice(0,580), evidence: { release: next.latestRelease, firstLook: true }, observedAt });
  }


  if (commitAge !== null && commitAge >= 0 && commitAge <= FIRST_LOOK_WINDOW.commitHours && next.commitsInWindow > 0) {
    changes.push({
      kind: "repository_activity",
      headline: `${label}: ${commitPhrase(next.commitsInWindow, commitsAreLowerBound)}`,
      detail: `${plural(next.contributorCount, "contributor")} active, most recent commit ${describeAge(commitAge)}.`,
      evidence: {
        commits: next.commitsInWindow,
        commitsAreLowerBound,
        contributors: next.contributorCount,
        lastCommitAt: next.lastCommitAt,
        firstLook: true,
      },
      observedAt,
    });
  }

  return changes;
}
