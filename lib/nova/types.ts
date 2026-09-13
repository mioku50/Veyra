/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Nova: the personal agent.
 *
 * A person creates Nova with a name and a few interests. Nova watches the part
 * of the world Veyra can actually measure, brings back what changed, and asks
 * before spending anything.
 *
 * Two rules shape every type here.
 *
 * A signal must trace to an observation. Nothing in the brief is generated
 * prose about a topic; every line is a difference between two states Veyra
 * recorded, and the evidence travels with the sentence.
 *
 * Nova never holds money. It can want to spend, and it says so; the spend
 * itself goes through the same selection, clearance and wallet signature as any
 * other Veyra purchase. "Nova wants to investigate" is a request, not a debit.
 */

export const NOVA_SUBJECT_KINDS = ["x402_resource", "github_repository"] as const;
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
] as const;
export type NovaSignalKind = (typeof NOVA_SIGNAL_KINDS)[number];

/** "noise" is a decision Nova made, not a signal it failed to produce. It is
 *  stored and countable, because "4 ignored as noise" has to be inspectable. */
export const NOVA_RELEVANCE = ["high", "medium", "low", "noise"] as const;
export type NovaRelevance = (typeof NOVA_RELEVANCE)[number];

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
  publicId: string;
  name: string;
  interests: string[];
  ownerWallet: string | null;
  arcIdentityAddress: string | null;
  arcIdentityRegisteredAt: string | null;
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
  subjectKind: NovaSubjectKind | null;
  interest: string | null;
  relevance: NovaRelevance;
  relevanceReason: string;
  status: NovaSignalStatus;
  executionPublicId: string | null;
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
export type NovaStanding = {
  verifiedResearch: number;
  veyraDecisions: number;
  observedOutcomes: number;
  /** True once every one of the above is at least one. */
  readyForArcIdentity: boolean;
};

export type NovaBrief = {
  agent: NovaAgent;
  greeting: string;
  worthAttention: NovaSignal[];
  noise: NovaSignal[];
  lastRefresh: NovaRefresh | null;
  whileAway: NovaWhileAway | null;
  /**
   * Set when this visit woke an agent the scheduler had stopped visiting. The
   * brief has to say so: the gap in the record is a fact about Nova, not about
   * a quiet few weeks in the agent economy.
   */
  wokeFromDormancy: boolean;
  memory: NovaMemory[];
  standing: NovaStanding;
};
