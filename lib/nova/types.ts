/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import type { NovaProjectContext } from "./project-context.ts";
export type { NovaProjectContext } from "./project-context.ts";

/**
 * Nova: the personal agent.
 *
 * A person creates Nova with a name and a few interests. Nova watches the part
 * of the world Veyra can actually measure, brings back what changed, and asks
 * before spending anything.
 *
 * Two rules shape every type here.
 *
 * A signal must trace to an observation. Public-event interpretations carry
 * source excerpts and the owner goal; payment changes carry their recorded
 * before/after states. Model interpretation is never a financial permission.
 *
 * Nova never holds money. It can want to spend, and it says so; the spend
 * itself goes through the same selection, clearance and wallet signature as any
 * other Veyra purchase. "Nova wants to investigate" is a request, not a debit.
 */

import type { PublicMaterial } from "./value.ts";
import type { NovaDerivedStanding } from "./standing.ts";
import type { NovaArcIdentity } from "./identity.ts";
import type { ShadowRecord, ShadowSummary } from "./autonomy.ts";

export const NOVA_SUBJECT_KINDS = ["x402_resource", "github_repository", "official_publication"] as const;
export type NovaSubjectKind = (typeof NOVA_SUBJECT_KINDS)[number];

export const NOVA_SIGNAL_KINDS = [
  "capability_available",
  "price_changed",
  "payee_changed",
  "endpoint_unreachable",
  "endpoint_recovered",
  "rail_changed",
  "repository_activity",
  "repository_release",
  "official_publication",
] as const;
export type NovaSignalKind = (typeof NOVA_SIGNAL_KINDS)[number];

/** "noise" is a decision Nova made, not a signal it failed to produce. It is
 *  stored and countable, because "4 ignored as noise" has to be inspectable. */
export const NOVA_RELEVANCE = ["high", "medium", "low", "noise"] as const;
export type NovaRelevance = (typeof NOVA_RELEVANCE)[number];

/** Why something Nova looked at did not reach the brief.
 *
 *  Relevance is one of six reasons and, for as long as this panel existed, the
 *  only one anybody could see: a day that filtered twenty-one things reported
 *  "held back as noise: 0", which was true about relevance and false about the
 *  brief. Every reason is counted and openable for the same purpose the noise
 *  list was: a filter nobody can inspect is a claim, not a feature. */
export const NOVA_WITHHOLD_REASONS = [
  "noise",
  "background",
  "not_analyzed",
  "not_significant",
  "duplicate",
  "over_cap",
] as const;
export type NovaWithholdReason = (typeof NOVA_WITHHOLD_REASONS)[number];

export const NOVA_SIGNAL_STATUS = [
  "new",
  "seen",
  "dismissed",
  "investigating",
  "investigated",
] as const;
export type NovaSignalStatus = (typeof NOVA_SIGNAL_STATUS)[number];

/**
 * What a person can say about one item.
 *
 * Dismissal alone could only ever make a brief smaller. Two agents started with
 * the same interests would converge, not diverge, because the only thing either
 * could learn was what to remove -- and both would end up at the same floor.
 * These are the verbs that let a brief be shaped rather than only trimmed.
 *
 *   seen             read, no opinion
 *   useful           more of this category
 *   not_interesting  not this topic -- softer than a ban, and it accumulates
 *   follow           this specific thing matters, whatever the category
 *   ignore_kind      never this category again
 *   investigating    worth paying to look deeper
 */
export const NOVA_FEEDBACK = [
  "seen",
  "useful",
  "not_interesting",
  "follow",
  "ignore_kind",
  "investigating",
] as const;
export type NovaFeedback = (typeof NOVA_FEEDBACK)[number];

/**
 * What Nova has learned, in the form scoring needs it.
 *
 * Ignores carry a weight because a single "not interesting" and a deliberate
 * "never show me this" are different statements, and flattening them would let
 * one impatient click bury a topic forever.
 */
export type NovaPreferences = {
  ignored: Array<{ phrase: string; weight: number }>;
  /** Categories the person has marked useful. */
  favoured: string[];
  /** Subject labels the person asked to follow. */
  followed: string[];
};

export type NovaAgent = {
  goal?: string | null;
  publicId: string;
  name: string;
  interests: string[];
  ownerWallet: string | null;
  /** The ERC-8004 identity, once claimed: a registry and an agent id, never an
   *  address. The owner is a field inside it and may change without the agent
   *  changing -- which is the whole reason it is not stored as an address. */
  arcIdentity: NovaArcIdentity | null;
  lastBriefAt: string | null;
  createdAt: string;
};

/**
 * What the scheduler did between one visit and the next.
 *
 * `lastRefresh` is one pass. This is every scheduled pass since the owner last
 * opened the brief, which is the only honest basis for the sentence "while you
 * were away" -- across two days that is a dozen passes, and reporting the most
 * recent one as if it were the whole absence would undercount the work by an
 * order of magnitude and make a busy week look like a quiet morning.
 *
 * Null when nothing ran unattended: a first visit after creation, or a return
 * inside the refresh interval.
 */
export type NovaWhileAway = {
  refreshes: number;
  subjectsChecked: number;
  signalsFound: number;
  signalsKept: number;
  signalsAsNoise: number;
  /** Named sources that could not be read on at least one pass. */
  sourcesUnavailable: string[];
  /** The owner's previous visit, and the last pass inside this window. */
  since: string;
  until: string;
};

export type NovaSubject = {
  subjectId: string;
  kind: NovaSubjectKind;
  /** Stable identity of the watched thing: a resource key, or "owner/name". */
  ref: string;
  label: string;
  interest: string;
  lastDigest: SubjectDigest | null;
  lastObservedAt: string | null;
};

/**
 * The state of one subject at one moment, reduced to the fields whose change is
 * worth a person's attention.
 *
 * Deliberately small. A digest holding everything would make every refresh a
 * "change", and a brief that reports every byte is the same as no brief.
 */
export type SubjectDigest =
  | { kind: "official_publication"; material: PublicMaterial }
  | {
      kind: "x402_resource";
      /** Atomic USDC, as a string: a price is money, never a float. */
      priceAtomic: string;
      payTo: string | null;
      reachable: boolean;
      provider: string | null;
      network: string | null;
      /** Which rail it settles on. A provider moving from the wallet rail to a
       *  Circle Gateway deposit does not change the price, but it changes
       *  whether this person can pay at all. */
      funding: "wallet" | "gateway_deposit";
    }
  | {
      kind: "github_repository";
      lastCommitAt: string | null;
      commitsInWindow: number;
      contributorCount: number;
      latestRelease: string | null;
      releaseMaterial?: PublicMaterial | null;
      stars: number;
    };

/** A change Nova found, before anyone decided whether it matters. */
export type ObservedChange = {
  kind: NovaSignalKind;
  headline: string;
  detail: string;
  evidence: Record<string, unknown>;
  observedAt: string;
};

export type NovaSignal = ObservedChange & {
  signalId: string;
  subjectId: string | null;
  subjectLabel: string | null;
  /** The subject's own identifier in the source it came from -- for a paid
   *  capability, its id in Circle's catalogue. It is what lets an
   *  investigation ask the endpoint the signal is actually about. */
  subjectRef?: string | null;
  subjectKind: NovaSubjectKind | null;
  interest: string | null;
  /** The chain this signal's money moves on, named the way a person names it,
   *  for signals that are about money at all. The interest label above a price
   *  is not a network, and letting it read as one put "ARC" over a payment that
   *  settles on Base. */
  settlesOn?: string | null;
  relevance: NovaRelevance;
  relevanceReason: string;
  status: NovaSignalStatus;
  executionPublicId: string | null;
  /** Why Veyra looked and would not price this, when that is what happened.
   *  Stored rather than held in the page, because the alternative is a card
   *  that forgets on every reload and offers the same live probe to reach the
   *  same no. */
  refusal?: NovaRefusal | null;
};

/**
 * Veyra having looked and declined. Not a failure and not a payment: nothing
 * was spent to learn it, which is exactly why it is worth keeping.
 */
export type NovaRefusal = {
  /** The machine-readable cause, the same one the route returns. */
  reason: string;
  /** What to tell the person, in the words the card will show. */
  detail: string;
  at: string;
};

export type NovaMemory = {
  memoryId: string;
  kind: "preference" | "learning";
  /** For a preference: "cares_about" | "usually_ignores". */
  facet: string;
  summary: string;
  evidence: Record<string, unknown>;
  supportCount: number;
  executionPublicId: string | null;
  updatedAt: string;
};

export type NovaRefresh = {
  refreshId: string;
  trigger: "creation" | "manual" | "scheduled";
  subjectsChecked: number;
  signalsFound: number;
  signalsKept: number;
  signalsAsNoise: number;
  /** A source that could not be read is named. A quiet day and a blind day are
   *  different facts, and presenting the second as the first is a lie a daily
   *  product would tell every day. */
  sourcesUnavailable: string[];
  startedAt: string;
  finishedAt: string | null;
};

/**
 * What Nova has earned the right to do.
 *
 * An on-chain identity registered at signup certifies nothing: it says an
 * account was created. These counts are the alternative — identity is offered
 * once there is a history for it to point at.
 */
/** Derived in lib/nova/standing.ts from the settled purchases themselves.
 *  Type-only, so the cycle between the two files costs nothing at runtime. */
export type { NovaDerivedStanding as NovaStanding, NovaProviderRecord } from "./standing.ts";
export type { NovaArcIdentity } from "./identity.ts";
export type { ShadowRecord, ShadowSummary, AutonomyCheck } from "./autonomy.ts";

/**
 * One paid investigation, as the brief shows it.
 *
 * `status` is the honest part. A payment that went through and whose answer
 * failed the check its own tier demanded is `paid_unverified`, not a completed
 * research with a caveat: the money is gone and the result is not trustworthy,
 * and those are two facts a person is entitled to read separately.
 */
export type NovaInvestigation = {
  researchId: string;
  signalId: string;
  status: "proposed" | "approved" | "verified" | "paid_unverified" | "unpaid";
  question: string;
  proposal: Record<string, unknown>;
  /** What the owner authorised, from the terms that were cleared rather than
   *  the ones first shown. Present even when nothing moved. */
  authorisedUsdc: number | null;
  provider: string | null;
  executionPublicId: string | null;
  paidUsdc: number | null;
  transaction: string | null;
  verification: { verdict: string; summary: string; responseHash?: string } | null;
  /** Prose a model wrote about what was bought. Kept apart from `verification`,
   *  which is a check Veyra ran itself: one is a reading, the other is evidence,
   *  and a screen that blends them teaches people to trust the wrong half. */
  reading: {
    whatChanged: string;
    whyItMatters: string;
    watchNext: string;
    provenance: string;
    writtenBy: string | null;
    generatedAt: string;
  } | null;
  /** Where Arc recorded this purchase, once it passed its check. Absent when
   *  the chain could not be reached -- which never costs the purchase. */
  arcProof: {
    receiptId: string;
    /** Null where the registration is on Arc but its transaction could not be
     *  located. The proof exists; the pointer to it does not. */
    transaction: string | null;
    chainId: number;
    registry: string;
    attester: string | null;
    explorerUrl: string;
    registeredAt: string;
    source: "written" | "recovered" | "present";
  } | null;
  result: unknown;
  failure: string | null;
  settledAt: string | null;
};

export type NovaBrief = {
  agent: NovaAgent;
  greeting: string;
  worthAttention: NovaSignal[];
  noise: NovaSignal[];
  /** Relevant, over the brief's cap, and reachable under My Agent. The brief
   *  stays short because a brief nobody finishes is worse than no brief; the
   *  market it was drawn from should still have a page. */
  watchlist: NovaSignal[];
  /** The same rows as `noise` and `watchlist`, grouped by the reason they did
   *  not reach the brief, so the filtering a person cannot see is the
   *  filtering a person can open. */
  withheld: Record<NovaWithholdReason, NovaSignal[]>;
  /** What the owner says is already true about the work, plus anything Nova
   *  has asked them to confirm. A goal says where they are going; this says
   *  where they are, and without it a reading can only report that a thing
   *  exists. */
  projectContext: NovaProjectContext[];
  lastRefresh: NovaRefresh | null;
  whileAway: NovaWhileAway | null;
  /**
   * Set when this visit woke an agent the scheduler had stopped visiting. The
   * brief has to say so: the gap in the record is a fact about Nova, not about
   * a quiet few weeks in the agent economy.
   */
  wokeFromDormancy: boolean;
  memory: NovaMemory[];
  /** What has been paid for against these signals, so a result appears under
   *  the card that produced it after a reload and not only in the session that
   *  bought it. */
  investigations: NovaInvestigation[];
  standing: NovaDerivedStanding;
  /** What Nova would have bought while nobody was watching, and what Veyra
   *  would have ruled. Decisions only: no row behind this moved money, and the
   *  type has no field that could say otherwise. */
  shadow: NovaShadowView;
};

/**
 * Shadow autonomy, as the brief shows it.
 *
 * `blocked` is not an error. Most agents are in it -- nothing signed, or a
 * mandate that predates unattended limits -- and a page that treated the
 * ordinary state as a fault would alarm everybody about the default.
 */
export type NovaShadowView = {
  state: "off" | "watching";
  blocked: string | null;
  summary: ShadowSummary;
  decisions: ShadowRecord[];
  /** The limits in force, read off the signed mandate rather than a setting. */
  limits: {
    perActionUsdc: number;
    dailyUsdc: number;
    totalUsdc: number;
    attemptsPerDay: number;
    minimumTrustScore: number;
    timezone: string;
    /** PREVIEW while this is a rehearsal. The screen says "no money can move",
     *  and that sentence is only true of this mode, so it is carried rather
     *  than assumed. */
    mode: string;
    expiresAt: string;
    signedBy: string;
    /** What this signature actually authorises, in the capability vocabulary.
     *  Shown rather than described, because the panel used to print a fixed
     *  sentence beside a signed list and the two were free to disagree. */
    capabilities: string[];
    /** Whether these are still the terms this page offers. False after the
     *  offer changes, which is the only signal an owner gets that there is a
     *  new mandate worth signing -- a signature cannot be updated in place, so
     *  without this the old terms simply stay in force for ever. */
    isCurrentOffer: boolean;
  } | null;
};
