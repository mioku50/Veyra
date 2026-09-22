/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { normalizeGoal, assessmentOf, type PublicMaterial, type ValueAssessment } from "./value.ts";
import {
  PROJECT_CONTEXT_LIMITS,
  ProjectContextError,
  contextForPrompt,
  normalizeStatement,
  normalizeStatements,
  readingStands,
  type NovaProjectContext,
} from "./project-context.ts";
import { READING_FAILURE_DETAIL, READING_RULES, assessPublicMaterial, type ReadingFailure } from "./free-research.ts";
import { observePublications, publicContext } from "./public-sources.ts";
import { createHash, randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getServerSupabaseConfig } from "../supabase/server-env.ts";
import { assembleBrief, greeting, quietSummary } from "./brief.ts";
import { MAX_INTERESTS, interestKey, keywordsForInterests, normalizeInterests } from "./interests.ts";
import { changesForSubject } from "./observation.ts";
import { categoryPhraseFor, scoreFloorFor, scoreRelevance } from "./relevance.ts";
import { observeRepositories, observeX402Catalog, type SourceObservation } from "./sources.ts";
import { settlementNetworkOf } from "./network.ts";
import { standingFrom } from "./standing.ts";
import { budgetPeriodFor, mandateReadiness, shadowSummaryFrom } from "./autonomy.ts";
import { autonomyMandateFor, shadowDecisionsFor } from "./autonomy-db.ts";
import { isPreviewMandate } from "./autonomy-mandate.ts";
import type {
  NovaAgent,
  NovaBrief,
  NovaFeedback,
  NovaInvestigation,
  NovaMemory,
  NovaPreferences,
  NovaRefresh,
  NovaRelevance,
  NovaArcIdentity,
  NovaRefusal,
  NovaShadowView,
  NovaSignal,
  NovaStanding,
  NovaWhileAway,
  SubjectDigest,
} from "./types.ts";

/**
 * Nova's memory, and the only place it is written.
 *
 * Two properties this layer has to keep, because losing either turns a personal
 * agent into a liability.
 *
 * An owner is proven by a secret they hold, and this table stores only its
 * SHA-256. A leak of the database must not let anyone read someone's brief or
 * learn what their agent knows about them.
 *
 * Nova never holds money and this file contains no signing path. It can record
 * that an investigation was wanted and that one was paid for; the payment
 * itself goes through the existing quote, clearance and wallet-signature route,
 * where the person signs with their own key.
 */

export class NovaError extends Error {
  constructor(message: string, readonly code: string, readonly status = 400) {
    super(message);
    this.name = "NovaError";
  }
}

let client: SupabaseClient | null = null;
/** Shared with the investigation module, which writes the same agent's rows and
 *  must do it through the same service-role client and the same owner check. */
export function db(): SupabaseClient {
  if (!client) {
    const config = getServerSupabaseConfig();
    client = createClient(config.url, config.key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

const PUBLIC_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function newPublicId(): string {
  const bytes = randomBytes(20);
  let id = "";
  for (const byte of bytes) id += PUBLIC_ID_ALPHABET[byte % PUBLIC_ID_ALPHABET.length];
  return `nva_${id}`;
}

export function newOwnerSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function ownerDigest(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/* ---- rows ---- */

export type AgentRow = {
  goal: string | null;
  agent_id: string;
  public_id: string;
  name: string;
  interests: string[];
  owner_wallet: string | null;
  arc_identity_registry: string | null;
  arc_identity_agent_id: string | null;
  arc_identity_owner: string | null;
  arc_identity_chain_id: number | null;
  arc_identity_tx: string | null;
  arc_identity_registered_at: string | null;
  last_brief_at: string | null;
  last_opened_at: string | null;
  dormant_since: string | null;
  created_at: string;
};

function toAgent(row: AgentRow): NovaAgent {
  return {
    publicId: row.public_id,
    goal: row.goal ?? null,
    name: row.name,
    interests: row.interests ?? [],
    ownerWallet: row.owner_wallet,
    /* Present only when all of it is: a registry without an agent id names
       nothing, and half an identity on screen is worse than none. */
    arcIdentity: row.arc_identity_registry && row.arc_identity_agent_id && row.arc_identity_owner
      ? {
          registry: row.arc_identity_registry,
          agentId: row.arc_identity_agent_id,
          chainId: row.arc_identity_chain_id ?? 5_042_002,
          owner: row.arc_identity_owner,
          transaction: row.arc_identity_tx,
          registeredAt: row.arc_identity_registered_at ?? "",
        }
      : null,
    lastBriefAt: row.last_brief_at,
    createdAt: row.created_at,
  };
}

const AGENT_COLUMNS =
  "agent_id, public_id, name, interests, goal, owner_wallet, arc_identity_registry, arc_identity_agent_id, arc_identity_owner, arc_identity_chain_id, arc_identity_tx, arc_identity_registered_at, last_brief_at, last_opened_at, dormant_since, created_at";

/* ---- creating ---- */

export async function createNova(input: {
  name: string;
  interests: unknown;
  goal?: unknown;
}): Promise<{ agent: NovaAgent; ownerSecret: string }> {
  const name = input.name.trim().replace(/\s+/g, " ").slice(0, 40);
  if (!name) throw new NovaError("Give your agent a name.", "name_required");

  const interests = normalizeInterests(input.interests);
  if (interests.length === 0) {
    throw new NovaError("Choose at least one thing for your agent to care about.", "interests_required");
  }
  if (interests.length > MAX_INTERESTS) {
    throw new NovaError(`Up to ${MAX_INTERESTS} interests.`, "interests_too_many");
  }

  const ownerSecret = newOwnerSecret();
  const { data, error } = await db()
    .from("nova_agents")
    .insert({
      public_id: newPublicId(),
      owner_secret_digest: ownerDigest(ownerSecret),
      name,
      interests,
      goal: checkedGoal(input.goal),
      /* Creating an agent is a visit: somebody was here, choosing a name. Left
         null, the scheduler's dormancy sweep -- which compares last_opened_at
         against a cutoff -- would never match this row, because NULL compares
         false against everything. An agent created and never opened again would
         then be refreshed forever, which is the exact leak dormancy exists to
         prevent. */
      last_opened_at: new Date().toISOString(),
    })
    .select(AGENT_COLUMNS)
    .single();

  if (error || !data) {
    throw new NovaError("Could not create your agent right now.", "database_unavailable", 503);
  }
  return { agent: toAgent(data as AgentRow), ownerSecret };
}

/**
 * Loads an agent only for the holder of its secret.
 *
 * A mismatch is a 404 rather than a 403, because confirming that a public id
 * exists is itself information about somebody else's agent.
 */
export async function loadOwned(publicId: string, ownerSecret: string): Promise<AgentRow> {
  const { data, error } = await db()
    .from("nova_agents")
    .select(`${AGENT_COLUMNS}, owner_secret_digest`)
    .eq("public_id", publicId)
    .maybeSingle();

  if (error) throw new NovaError("Could not reach your agent right now.", "database_unavailable", 503);
  const row = data as (AgentRow & { owner_secret_digest: string }) | null;
  if (!row || row.owner_secret_digest !== ownerDigest(ownerSecret)) {
    throw new NovaError("No such agent.", "not_found", 404);
  }
  return row;
}

export async function getNova(publicId: string, ownerSecret: string): Promise<NovaAgent> {
  return toAgent(await loadOwned(publicId, ownerSecret));
}

/**
 * Changes what an agent cares about, without starting a new one.
 *
 * Interests were fixed at creation, so the only way to follow something else
 * was to abandon the agent and build another -- losing its memory, its standing
 * and every investigation it had paid for, to change one word.
 *
 * Dropping an interest retires the open signals that came in through it. They
 * are dismissed rather than deleted, and only where the status says nobody has
 * spent anything: an investigation, paid or refused, is a receipt, and a
 * receipt does not stop being true because the interest behind it was dropped.
 *
 * Subjects are left alone. `nova_signals.subject_id` is ON DELETE SET NULL, so
 * removing a subject would strip provenance from every signal it ever produced
 * -- including the ones with money attached. An unwatched subject costs one row
 * and no requests, because each refresh re-resolves what to watch from the
 * interests rather than from the table.
 */
export async function updateNova(input: {
  publicId: string;
  ownerSecret: string;
  interests: unknown;
  goal?: unknown;
}): Promise<{ agent: NovaAgent; retiredSignals: number; droppedInterests: string[] }> {
  const agent = await loadOwned(input.publicId, input.ownerSecret);

  const interests = normalizeInterests(input.interests);
  if (interests.length === 0) {
    throw new NovaError("Choose at least one thing for your agent to care about.", "interests_required");
  }
  if (interests.length > MAX_INTERESTS) {
    throw new NovaError(`Up to ${MAX_INTERESTS} interests.`, "interests_too_many");
  }

  const before = agent.interests ?? [];
  const kept = new Set(interests.map(interestKey));
  const droppedInterests = before.filter((entry) => !kept.has(interestKey(entry)));

  const { data, error } = await db()
    .from("nova_agents")
    .update({ interests, ...(input.goal !== undefined ? { goal: checkedGoal(input.goal) } : {}), updated_at: new Date().toISOString() })
    .eq("agent_id", agent.agent_id)
    .select(AGENT_COLUMNS)
    .single();

  if (error || !data) {
    throw new NovaError("Could not save that change right now.", "database_unavailable", 503);
  }

  let retiredSignals = 0;
  if (droppedInterests.length > 0) {
    const { data: subjectRows } = await db()
      .from("nova_subjects")
      .select("subject_id, interest")
      .eq("agent_id", agent.agent_id);

    const orphaned = ((subjectRows ?? []) as Array<{ subject_id: string; interest: string }>)
      .filter((row) => !kept.has(interestKey(row.interest)))
      .map((row) => row.subject_id);

    if (orphaned.length > 0) {
      const { data: retired } = await db()
        .from("nova_signals")
        .update({ status: "dismissed", updated_at: new Date().toISOString() })
        .eq("agent_id", agent.agent_id)
        .in("subject_id", orphaned)
        /* Never an investigation. Money moved, or was signed for, and the card
           recording that is the only place a person can go to check. */
        .in("status", ["new", "seen"])
        .select("signal_id");
      retiredSignals = (retired ?? []).length;
    }
  }

  return { agent: toAgent(data as AgentRow), retiredSignals, droppedInterests };
}

/* ---- refreshing ---- */

type SubjectRow = {
  subject_id: string;
  kind: "x402_resource" | "github_repository" | "official_publication";
  ref: string;
  label: string;
  interest: string;
  last_digest: SubjectDigest | null;
};

/**
 * One pass: look at everything Nova watches, work out what changed, and write
 * down both the changes and the fact that the pass happened.
 *
 * The refresh row is written even when nothing is found, because "Nova checked
 * and nothing moved" is exactly what a person needs on a quiet day, and it
 * cannot be reconstructed after the fact.
 */
export async function refreshNova(input: {
  publicId: string;
  ownerSecret: string;
  trigger: "creation" | "manual" | "scheduled";
  now?: Date;
}): Promise<{ refresh: NovaRefresh; newSignals: number }> {
  const agent = await loadOwned(input.publicId, input.ownerSecret);
  return runRefresh({ agent, trigger: input.trigger, now: input.now });
}

/**
 * The pass itself, for a caller that has already established it may act on this
 * agent.
 *
 * `refreshNova` is the owner's door and checks the secret. The scheduler comes
 * through here instead, holding a row it claimed, because there is no secret to
 * check when there is nobody on the other end -- and inventing one for the
 * scheduler would mean storing something that can impersonate an owner, which
 * is exactly what the digest-only design of this table refuses to do.
 *
 * `fetchImpl` exists for the scheduler: one tick refreshes many agents that
 * nearly all watch the same repositories, and it passes a reader that answers
 * each URL once.
 */
/**
 * How many public readings one pass may spend.
 *
 * A reading is a fetch plus a model call the application pays for, so the
 * number is small -- and while it was small, the order it was spent in decided
 * what a person saw. A publication Nova has not read cannot clear the
 * significance gate, so the publications a short pass never reached were not
 * judged unimportant; they were never judged. The budget is spent on the
 * highest-scoring candidates first, and what it does not reach is reported as
 * unread rather than absent.
 *
 * It came down from three when the reading model changed. A tick serves every
 * agent inside one 300-second function, and a reading that took six seconds
 * now takes twenty at the median and forty at the tail. Reaching fewer events
 * per tick is a cost; a tick killed halfway through, which writes some rows
 * and not others, is a worse one.
 */
export const PUBLIC_READING_BUDGET = 2;

/**
 * And what a pass somebody is waiting on may spend.
 *
 * A scheduled tick serves every agent and nobody is watching it, so it stays
 * frugal. A person who pressed the button is waiting on one agent and has
 * asked for exactly this, so it reads further into the backlog.
 *
 * Further, not far. The route has 180 seconds, and three readings at the
 * measured tail -- forty seconds each, plus the source fetches and the
 * observation pass ahead of them -- already spends most of it. Five would not
 * finish, and a refresh killed by the platform is worse than a smaller one
 * that completes. What used to justify a bigger number here was an owner
 * pressing the button eight times to drain a backlog; they now have a button
 * on the card itself for that.
 */
export const ATTENDED_READING_BUDGET = 3;

/** How much of the backlog is ranked to choose those readings. Large enough
 *  to cover an agent's whole unread history rather than an arbitrary slice of
 *  it, and read through a projection that leaves the article text behind. */
const BACKLOG_POOL = 60;

/**
 * The candidates a reading budget should be spent on, best first: relevance
 * score, then the newest of an equal pair.
 *
 * Both populations go through here together. Ranking the new events and then
 * the unread backlog separately repeated the bug one level up -- a pass with
 * three new items spent the whole budget on them and left a high-relevance
 * event nobody had read yet sitting there, which is how the two Arc cards an
 * owner cared about kept their old reading while three lesser ones got a new
 * one.
 *
 * Ranking them together by band alone was not enough either: a fresh medium
 * outscored a stored medium and the same two cards starved a second time,
 * still showing a judgement made before their owner said where the work was.
 */
export function readingOrder<T extends {
  relevance: NovaRelevance;
  /** A stored reading judged against a goal, a project state or an edition of
   *  the rules the owner has since changed. */
  correction: boolean;
  /** Whether that stored reading is one the owner can see. A reading found
   *  significant is what puts a card on Today; the brief's cap and its
   *  deduplication can still keep it off, so this is "could be on the
   *  screen" rather than a promise that it is. */
  onScreen?: boolean;
  score: number;
  observedAt: string;
}>(entries: T[]): T[] {
  const band: Record<NovaRelevance, number> = { high: 0, medium: 1, low: 2, noise: 3 };
  /* Wrong where it shows, then missing, then wrong where nobody looks.
     Bumping the rules retires every stored reading at once, and when all
     twenty-seven are corrections the flag stops telling them apart: what
     still does is whether the paragraph going stale is one the owner is
     reading. A card held back as insignificant will most likely be held back
     again, and re-reading it changes nothing anybody sees. */
  const priority = (entry: T) => entry.correction ? (entry.onScreen ? 0 : 2) : 1;
  const at = (entry: T) => {
    const parsed = Date.parse(entry.observedAt);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return [...entries].sort((a, b) =>
    band[a.relevance] - band[b.relevance]
    /* Inside a band, by that priority. Across bands the band still wins: a
       stale low does not outrank the most important thing that happened
       today. */
    || priority(a) - priority(b)
    || b.score - a.score
    || at(b) - at(a));
}

export async function runRefresh(input: {
  agent: { agent_id: string; interests: string[] };
  trigger: "creation" | "manual" | "scheduled";
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<{ refresh: NovaRefresh; newSignals: number }> {
  const agent = input.agent;
  const now = input.now ?? new Date();
  const readingBudget = input.trigger === "scheduled" ? PUBLIC_READING_BUDGET : ATTENDED_READING_BUDGET;
  const startedAt = now.toISOString();
  const started = Date.now();

  const { data: goalRow, error: goalError } = await db().from("nova_agents").select("goal").eq("agent_id", agent.agent_id).single();
  if (goalError) throw new NovaError("Could not load your research goal.", "database_unavailable", 503);
  const goal = goalRow?.goal ?? null;
  /* Confirmed statements only. A reading judged against Nova's own unconfirmed
     inference would be reading its own notes back to itself. */
  const projectContext = contextForPrompt(await loadProjectContext(agent.agent_id));
  const contextProposals: Array<{ statement: string; why: string; evidence: Record<string, unknown> }> = [];
  const [catalog, repositories, publications] = await Promise.all([
    observeX402Catalog({ interests: agent.interests, fetchImpl: input.fetchImpl }),
    observeRepositories({ interests: agent.interests, now, fetchImpl: input.fetchImpl }),
    observePublications({ interests: agent.interests, now, fetchImpl: input.fetchImpl }),
  ]);
  const observations = [...publications.observations, ...repositories.observations, ...catalog.observations];
  const sourcesUnavailable = [...catalog.unavailable, ...repositories.unavailable, ...publications.unavailable];
  /* Fetched and not understood. Counted, and deliberately not added to the
     line above: the owner is told a source could not be reached, and this is
     not that. */
  const articlesUnreadable = { ...catalog.unreadable, ...repositories.unreadable, ...publications.unreadable };
  /* Readings attempted against the model, and what came back when nothing
     did. A pass that lost three to a rate limit and a pass that lost three to
     ungrounded answers are different problems; before this they were one
     sentence each, in prose, in a column nobody could count. */
  const readingFailures: Record<string, number> = {};

  const { data: existingRows, error: existingError } = await db()
    .from("nova_subjects")
    .select("subject_id, kind, ref, label, interest, last_digest")
    .eq("agent_id", agent.agent_id);
  if (existingError) throw new NovaError("Could not load source history.", "database_unavailable", 503);
  const existing = new Map<string, SubjectRow>();
  for (const row of (existingRows ?? []) as SubjectRow[]) {
    existing.set(`${row.kind} ${row.ref}`, row);
  }

  const preferences = await loadPreferences(agent.agent_id);
  const keywords = keywordsForInterests(agent.interests);

  const signalRows: Array<Record<string, unknown>> = [];
  /** One observed change, scored, and waiting to be written. The row is held
   *  rather than written immediately because its reading -- if it earns one --
   *  belongs in the same evidence blob, and which changes earn one cannot be
   *  decided until every change in the pass has been scored. */
  type PendingSignal = {
    subjectId: string;
    row: Record<string, unknown>;
    material: PublicMaterial | null;
    score: number;
    /** A publication or release Nova could read for this goal, if the budget
     *  reaches it. */
    readable: boolean;
  };
  const pendingSignals: PendingSignal[] = [];
  const observed: Array<{ subjectId: string; digest: SubjectDigest }> = [];
  let assessments = 0;
  let kept = 0;
  let asNoise = 0;

  for (const observation of observations) {
    const key = `${observation.kind} ${observation.ref}`;
    const previous = existing.get(key) ?? null;
    const subjectId = previous
      ? previous.subject_id
      : await insertSubject(agent.agent_id, observation);
    if (!subjectId) continue;

    const changes = changesForSubject({
      label: observation.label,
      previous: previous?.last_digest ?? null,
      next: observation.digest,
      now,
      catalogUpdatedAt: observation.catalogUpdatedAt,
      commitsAreLowerBound: observation.context.commitsAreLowerBound === true,
    });

    for (const change of changes) {
      const material = (observation.context.publicMaterial as PublicMaterial | undefined) ?? null;
      const verdict = scoreRelevance({
        change,
        keywords,
        subjectText: observation.subjectText,
        subjectLabel: observation.label,
        preferences,
        interest: observation.interest,
      });
      if (verdict.relevance === "noise") asNoise += 1;
      else kept += 1;
      const row = {
        agent_id: agent.agent_id,
        subject_id: subjectId,
        kind: change.kind,
        headline: change.headline,
        detail: change.detail,
        relevance: verdict.relevance,
        relevance_reason: verdict.reason,
        evidence: { ...change.evidence, subject: observation.context, label: observation.label },
        observed_at: change.observedAt,
      };
      signalRows.push(row);
      pendingSignals.push({
        subjectId,
        row,
        material,
        score: verdict.score,
        readable: Boolean(
          goal && material?.text && verdict.relevance !== "noise"
          && (change.kind === "official_publication" || change.kind === "repository_release"),
        ),
      });
    }
    observed.push({ subjectId, digest: observation.digest });
  }

  /* Everything this pass could read, in one list.
     The budget is spent on the best candidates, not on the first ones the
     source list returned and not on the new ones merely for being new. A
     publication with no reading cannot clear the significance gate, so the
     order this is spent in decides the brief. What the budget does not reach
     stays unread, is visible as unread, and is reconsidered next pass.
     Relevance-rejected material is skipped outright -- the brief would drop
     it whatever the reading said. */
  type ReadingCandidate = {
    headline: string;
    relevance: NovaRelevance;
    correction: boolean;
    onScreen: boolean;
    score: number;
    observedAt: string;
    /** The material, fetched only if the budget reaches this candidate. The
     *  pool is ranked on what a light projection says about each row, so the
     *  text nobody is going to read is never loaded. */
    open: () => Promise<PublicMaterial | null>;
    /** Where the reading goes when it comes back: into the row about to be
     *  written, or into the row already stored. */
    apply: (assessment: ValueAssessment) => Promise<void>;
  };
  const candidates: ReadingCandidate[] = [];

  for (const entry of pendingSignals) {
    if (!entry.readable || !entry.material) continue;
    const material = entry.material;
    candidates.push({
      headline: String(entry.row.headline),
      relevance: entry.row.relevance as NovaRelevance,
      correction: false,
      onScreen: false,
      score: entry.score,
      observedAt: String(entry.row.observed_at ?? ""),
      open: async () => material,
      apply: async (valueAssessment) => {
        entry.row.evidence = { ...(entry.row.evidence as Record<string, unknown>), valueAssessment };
      },
    });
  }

  /* Events an earlier pass left unread, and readings judged against a goal or
     a project state that has since changed. A stored signal keeps its band
     and not the number behind it, so it is ranked from the floor of that
     band: pessimistic against a fresh candidate of the same band, and still
     ahead of any weaker one. */
  if (goal) {
    /* The whole backlog, not a dozen of it.
       This read used to take twelve rows ordered by observation time, and an
       agent's first look records every publication it finds in the same
       second. Forty rows tied on that column hand back an arbitrary twelve,
       so the two events an owner actually cared about were never in the set
       that got ranked -- no amount of ranking could reach them. The pool is
       now the backlog, ordered deterministically, and projected down to what
       ranking needs so that forty rows of article text are not loaded to
       choose three. */
    const { data: pending, error: pendingError } = await db().from("nova_signals")
      .select("signal_id,headline,relevance,observed_at,assessedGoal:evidence->valueAssessment->>goal,assessedContext:evidence->valueAssessment->projectContext,assessedRules:evidence->valueAssessment->>rules,assessedSignificant:evidence->valueAssessment->>significant")
      .eq("agent_id", agent.agent_id).in("kind", ["repository_release", "official_publication"])
      .neq("relevance", "noise")
      .in("status", ["new", "seen"])
      .order("observed_at", { ascending: false })
      .order("signal_id", { ascending: true })
      .limit(BACKLOG_POOL);
    if (pendingError) throw new NovaError("Could not load public events.", "database_unavailable", 503);
    for (const row of (pending ?? []) as Array<Record<string, any>>) {
      const assessedGoal = typeof row.assessedGoal === "string" ? row.assessedGoal : null;
      const assessedContext = Array.isArray(row.assessedContext) ? row.assessedContext as string[] : null;
      const assessedRules = Number(row.assessedRules);
      if (readingStands(
        { goal: assessedGoal, context: assessedContext, rules: Number.isFinite(assessedRules) ? assessedRules : null },
        { goal, context: projectContext, rules: READING_RULES },
      )) continue;
      const relevance = (row.relevance ?? "low") as NovaRelevance;
      let evidence: Record<string, any> | null = null;
      candidates.push({
        headline: String(row.headline),
        relevance,
        /* It has a reading, and that reading answers a question about a goal
           or a project state that is gone. Never read at all is a different
           thing and waits its turn with the new events. */
        correction: assessedGoal !== null,
        /* Its stored reading is the reason it is on Today, so its staleness
           is the staleness the owner can actually see. */
        onScreen: row.assessedSignificant === "true",
        score: scoreFloorFor(relevance),
        observedAt: String(row.observed_at ?? ""),
        open: async () => {
          const { data, error } = await db().from("nova_signals").select("evidence")
            .eq("agent_id", agent.agent_id).eq("signal_id", row.signal_id).maybeSingle();
          if (error) throw new NovaError("Could not load public events.", "database_unavailable", 503);
          evidence = (data?.evidence as Record<string, any> | undefined) ?? null;
          const material = (evidence?.publicMaterial ?? evidence?.subject?.publicMaterial) as PublicMaterial | undefined;
          return material?.text ? material : null;
        },
        apply: async (valueAssessment) => {
          const { error } = await db().from("nova_signals").update({ evidence: { ...(evidence ?? {}), valueAssessment }, updated_at: new Date().toISOString() })
            .eq("agent_id", agent.agent_id).eq("signal_id", row.signal_id);
          if (error) throw new NovaError("Could not save public research.", "database_unavailable", 503);
        },
      });
    }
  }

  let opened = 0;
  for (const candidate of readingOrder(candidates)) {
    if (assessments >= readingBudget) break;
    if (!goal) break;
    /* A row whose material never made it to storage costs a lookup, not a
       reading. Bounded anyway, so a backlog of unreadable rows cannot turn
       one pass into forty queries. */
    if (opened >= readingBudget * 3) break;
    opened++;
    const material = await candidate.open();
    if (!material) continue;
    assessments++;
    const context = await publicContext(material, input.fetchImpl);
    let readingFailure: ReadingFailure | null = null;
    let readingDetail: string | undefined;
    const valueAssessment = await assessPublicMaterial({ goal, projectContext, headline: candidate.headline, sources: context.sources, now, onFailure: (reason, detail) => { readingFailure = reason; readingDetail = detail; } });
    if (!valueAssessment) {
      /* Which reading failed and why, rather than one line that says a
         reading failed. A pass that lost three to a rate limit and a pass
         that lost three to ungrounded answers are different problems. */
      const cause: string = readingFailure ?? "upstream_error";
      readingFailures[cause] = (readingFailures[cause] ?? 0) + 1;
      /* Still shown to the owner. A reading that produced nothing is the one
         failure they have to see -- sixteen hours of it once looked exactly
         like a quiet day. */
      const note = `Nova public-source analysis (${cause}${readingDetail ? `: ${readingDetail}` : ""})`;
      if (!sourcesUnavailable.includes(note)) sourcesUnavailable.push(note);
      continue;
    }
    valueAssessment.sourcesUnavailable = context.unavailable;
    await candidate.apply(valueAssessment);
    if (valueAssessment.contextProposal) {
      contextProposals.push({
        statement: valueAssessment.contextProposal.statement,
        why: valueAssessment.contextProposal.why,
        evidence: { headline: candidate.headline, sources: valueAssessment.sources.map((source) => source.url).slice(0, 2), suggestedAt: now.toISOString() },
      });
    }
  }

  for (const { subjectId, digest } of observed) {
    /* The digest is advanced only after its changes have been recorded. If the
       write below fails, the next refresh compares against the same old state
       and reports the change a second time. A repeat is recoverable; a change
       nobody ever saw is not. */
    const pending = pendingSignals.filter(entry => entry.subjectId === subjectId).map(entry => entry.row);
    if (pending.length) {
      const { error } = await db().from("nova_signals").upsert(pending, { onConflict: "agent_id,kind,subject_id,observed_at", ignoreDuplicates: true });
      if (error) throw new NovaError("Could not save observed events.", "database_unavailable", 503);
    }
    const { error: digestError } = await db().from("nova_subjects")
      .update({ last_digest: digest, last_observed_at: now.toISOString() }).eq("subject_id", subjectId);
    if (digestError) throw new NovaError("Could not save source state.", "database_unavailable", 503);
  }


  /* After the observations are written, never before: a suggestion about the
     project is worth less than the pass that produced it, and a failure here
     must not cost the events it was derived from. */
  await proposeProjectContext(agent.agent_id, contextProposals);

  const { data: refreshRow, error: refreshError } = await db()
    .from("nova_refreshes")
    .insert({
      agent_id: agent.agent_id,
      trigger: input.trigger,
      subjects_checked: observations.length,
      signals_found: signalRows.length,
      signals_kept: kept,
      signals_as_noise: asNoise,
      sources_unavailable: sourcesUnavailable,
      articles_unreadable: articlesUnreadable,
      readings_attempted: assessments,
      reading_failures: readingFailures,
      duration_ms: Date.now() - started,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    })
    .select(REFRESH_COLUMNS)
    .single();

  if (refreshError) throw new NovaError("Could not save refresh results.", "database_unavailable", 503);
  const finishedAt = new Date().toISOString();
  const { error: clockError } = await db()
    .from("nova_agents")
    .update({
      last_brief_at: finishedAt,
      updated_at: finishedAt,
      /* Stamped on success only. A pass that threw leaves the old clock, so the
         agent stays due and the next tick retries it rather than silently
         skipping an agent for a full interval on one bad read. */
      ...(input.trigger === "scheduled" ? { last_scheduled_refresh_at: finishedAt } : {}),
    })
    .eq("agent_id", agent.agent_id);

  if (clockError) throw new NovaError("Could not save refresh time.", "database_unavailable", 503);
  return { refresh: toRefresh(refreshRow), newSignals: kept };
}

const REFRESH_COLUMNS =
  "refresh_id, trigger, subjects_checked, signals_found, signals_kept, signals_as_noise, sources_unavailable, started_at, finished_at";

async function insertSubject(agentId: string, observation: SourceObservation): Promise<string | null> {
  const { data, error } = await db()
    .from("nova_subjects")
    .insert({
      agent_id: agentId,
      kind: observation.kind,
      ref: observation.ref,
      label: observation.label,
      interest: observation.interest,
    })
    .select("subject_id")
    .single();
  if (error) throw new NovaError("Could not save a watched source.", "database_unavailable", 503);
  return (data as { subject_id: string } | null)?.subject_id ?? null;
}

function toRefresh(row: Record<string, unknown> | null): NovaRefresh {
  return {
    refreshId: String(row?.refresh_id ?? ""),
    trigger: (row?.trigger as NovaRefresh["trigger"]) ?? "manual",
    subjectsChecked: Number(row?.subjects_checked ?? 0),
    signalsFound: Number(row?.signals_found ?? 0),
    signalsKept: Number(row?.signals_kept ?? 0),
    signalsAsNoise: Number(row?.signals_as_noise ?? 0),
    sourcesUnavailable: (row?.sources_unavailable as string[]) ?? [],
    startedAt: String(row?.started_at ?? new Date().toISOString()),
    finishedAt: (row?.finished_at as string | null) ?? null,
  };
}

/**
 * Everything this person has told Nova, in the shape scoring wants.
 *
 * One read rather than three: preferences are a handful of rows and they are
 * needed together on every single subject of every refresh.
 */
async function loadPreferences(agentId: string): Promise<NovaPreferences> {
  const { data } = await db()
    .from("nova_memory")
    .select("facet, summary, support_count")
    .eq("agent_id", agentId)
    .eq("kind", "preference");

  const rows = (data ?? []) as Array<{ facet: string; summary: string; support_count: number }>;
  const preferences: NovaPreferences = { ignored: [], favoured: [], followed: [] };
  for (const row of rows) {
    if (row.facet === "usually_ignores") {
      preferences.ignored.push({ phrase: row.summary, weight: ignoreWeight(row.support_count) });
    } else if (row.facet === "cares_about") {
      preferences.favoured.push(row.summary);
    } else if (row.facet === "follows") {
      preferences.followed.push(row.summary);
    }
  }
  return preferences;
}

/**
 * How hard a dismissal pushes down.
 *
 * One shrug is not a decision, and treating it as one is how a feed ends up
 * silently missing a whole topic because of a single impatient click on a
 * crowded morning. Repetition is what turns a shrug into a preference, so the
 * weight climbs with it and then stops: past a point, more evidence of the same
 * thing should not keep making the penalty worse.
 *
 * An explicit "never show me this" enters at the ceiling, because it is not an
 * inference at all -- the person said it.
 */
const IGNORE_WEIGHT = { floor: 18, step: 6, ceiling: 30 } as const;
export const EXPLICIT_IGNORE_SUPPORT = 3;

export function ignoreWeight(supportCount: number): number {
  const support = Math.max(1, supportCount || 1);
  return Math.min(IGNORE_WEIGHT.ceiling, IGNORE_WEIGHT.floor + IGNORE_WEIGHT.step * (support - 1));
}

/* ---- project context ---- */

const PROJECT_CONTEXT_COLUMNS = "context_id, statement, status, origin, evidence, updated_at, confirmed_at";

/** How many unanswered proposals may queue up. Past this Nova stops asking:
 *  a list of suggestions nobody answers is not a working memory, and the
 *  owner's silence is not a confirmation to route around. */
const MAX_OPEN_PROPOSALS = 6;

function toProjectContext(row: Record<string, unknown>): NovaProjectContext {
  return {
    contextId: String(row.context_id),
    statement: String(row.statement),
    status: row.status as NovaProjectContext["status"],
    origin: row.origin as NovaProjectContext["origin"],
    evidence: (row.evidence as Record<string, unknown>) ?? {},
    updatedAt: String(row.updated_at),
    confirmedAt: (row.confirmed_at as string | null) ?? null,
  };
}

async function loadProjectContext(agentId: string): Promise<NovaProjectContext[]> {
  const { data, error } = await db()
    .from("nova_project_context")
    .select(PROJECT_CONTEXT_COLUMNS)
    .eq("agent_id", agentId)
    .neq("status", "dismissed")
    .order("updated_at", { ascending: true })
    .limit(40);
  if (error) throw new NovaError("Could not load your project context.", "database_unavailable", 503);
  return ((data ?? []) as Array<Record<string, unknown>>).map(toProjectContext);
}

/** The owner's own view of it, proposals included. */
export async function projectContextFor(input: { publicId: string; ownerSecret: string }): Promise<NovaProjectContext[]> {
  const agent = await loadOwned(input.publicId, input.ownerSecret);
  return loadProjectContext(agent.agent_id);
}

/**
 * Replace the confirmed list with what the owner just wrote.
 *
 * Confirmed rows the owner deleted are deleted: a project fact that is no
 * longer true has to be able to stop being one, and keeping a retired
 * statement "for history" means later readings keep being judged against it.
 * Proposals are left alone -- this button is not an answer to them.
 */
export async function setProjectContext(input: {
  publicId: string;
  ownerSecret: string;
  statements: unknown;
}): Promise<NovaProjectContext[]> {
  const agent = await loadOwned(input.publicId, input.ownerSecret);
  let statements: string[];
  try {
    statements = normalizeStatements(input.statements);
  } catch (error) {
    if (error instanceof ProjectContextError) throw new NovaError(error.message, "project_context_invalid");
    throw error;
  }

  const existing = await loadProjectContext(agent.agent_id);
  const byStatement = new Map(existing.map((entry) => [entry.statement.toLowerCase(), entry]));
  const wanted = new Set(statements.map((statement) => statement.toLowerCase()));
  const now = new Date().toISOString();

  const removed = existing.filter((entry) => entry.status === "confirmed" && !wanted.has(entry.statement.toLowerCase()));
  if (removed.length) {
    const { error } = await db().from("nova_project_context").delete()
      .eq("agent_id", agent.agent_id).in("context_id", removed.map((entry) => entry.contextId));
    if (error) throw new NovaError("Could not save your project context.", "database_unavailable", 503);
  }

  for (const statement of statements) {
    const current = byStatement.get(statement.toLowerCase());
    /* Typing out a sentence Nova proposed is a confirmation of that row, not
       a second copy of the same fact. The origin stays as it was, so "Nova
       suggested this and I agreed" is still distinguishable later. */
    const { error } = current
      ? await db().from("nova_project_context")
        .update({ statement, status: "confirmed", confirmed_at: current.confirmedAt ?? now, updated_at: now })
        .eq("agent_id", agent.agent_id).eq("context_id", current.contextId)
      : await db().from("nova_project_context")
        .insert({ agent_id: agent.agent_id, statement, status: "confirmed", origin: "owner", confirmed_at: now, updated_at: now });
    if (error) throw new NovaError("Could not save your project context.", "database_unavailable", 503);
  }

  return loadProjectContext(agent.agent_id);
}

/** Answer one of Nova's proposals. This is the only path by which a statement
 *  Nova wrote becomes one an assessment may rely on. */
export async function resolveProjectContextProposal(input: {
  publicId: string;
  ownerSecret: string;
  contextId: string;
  action: "confirm" | "dismiss";
}): Promise<NovaProjectContext[]> {
  const agent = await loadOwned(input.publicId, input.ownerSecret);
  const entries = await loadProjectContext(agent.agent_id);
  const target = entries.find((entry) => entry.contextId === input.contextId);
  if (!target) throw new NovaError("That suggestion is no longer there.", "project_context_not_found", 404);
  if (target.status !== "proposed") throw new NovaError("That is already part of your project context.", "project_context_settled");
  if (input.action === "confirm" && entries.filter((entry) => entry.status === "confirmed").length >= PROJECT_CONTEXT_LIMITS.confirmed) {
    throw new NovaError(`Remove a project fact first. ${PROJECT_CONTEXT_LIMITS.confirmed} is the limit.`, "project_context_full");
  }
  const now = new Date().toISOString();
  const { error } = await db().from("nova_project_context")
    .update(input.action === "confirm"
      ? { status: "confirmed", confirmed_at: now, updated_at: now }
      : { status: "dismissed", confirmed_at: null, updated_at: now })
    .eq("agent_id", agent.agent_id).eq("context_id", input.contextId);
  if (error) throw new NovaError("Could not save that answer.", "database_unavailable", 503);
  return loadProjectContext(agent.agent_id);
}

/**
 * Write down what a reading implied about the owner's project, as a question.
 *
 * Never as a fact, and never twice: a statement already confirmed, already
 * queued, or already dismissed is not raised again. Re-asking a dismissed
 * suggestion is how an agent argues with its owner until the owner stops
 * reading, and the dismissal is itself information.
 */
async function proposeProjectContext(agentId: string, proposals: Array<{ statement: string; why: string; evidence: Record<string, unknown> }>): Promise<void> {
  if (!proposals.length) return;
  const { data, error: readError } = await db()
    .from("nova_project_context")
    .select("statement, status")
    .eq("agent_id", agentId)
    .limit(60);
  if (readError) throw new NovaError("Could not load your project context.", "database_unavailable", 503);
  const known = new Set(((data ?? []) as Array<{ statement: string }>).map((row) => row.statement.toLowerCase()));
  let open = ((data ?? []) as Array<{ status: string }>).filter((row) => row.status === "proposed").length;
  const now = new Date().toISOString();
  const rows: Array<Record<string, unknown>> = [];
  for (const proposal of proposals) {
    if (open + rows.length >= MAX_OPEN_PROPOSALS) break;
    let statement: string;
    try {
      statement = normalizeStatement(proposal.statement);
    } catch { continue; }
    const key = statement.toLowerCase();
    if (known.has(key)) continue;
    known.add(key);
    rows.push({
      agent_id: agentId, statement, status: "proposed", origin: "nova_reading",
      evidence: { why: proposal.why, ...proposal.evidence }, confirmed_at: null, updated_at: now,
    });
  }
  if (!rows.length) return;
  const { error } = await db().from("nova_project_context").insert(rows);
  if (error) throw new NovaError("Could not save a project-context suggestion.", "database_unavailable", 503);
}

/* ---- reading ---- */

export async function loadBrief(input: {
  publicId: string;
  ownerSecret: string;
  hourOfDay: number;
}): Promise<NovaBrief> {
  const agent = await loadOwned(input.publicId, input.ownerSecret);

  /* Read before the visit is recorded. Stamping last_opened_at first would
     close the window this query measures and "while you were away" would be
     empty on every visit -- correct-looking, always wrong. */
  const awaySince = agent.last_opened_at ?? agent.created_at;

  const [signalResult, refreshResult, awayResult, memoryResult, researchResult, projectContext] = await Promise.all([
    db().from("nova_signals")
      .select(SIGNAL_COLUMNS)
      .eq("agent_id", agent.agent_id)
      .in("status", ["new", "seen", "investigating", "investigated"])
      .order("observed_at", { ascending: false })
      /* The same total order the reading pass ranks by. A first look records
         every publication it finds in the same second, and two queries that
         break that tie differently disagree about which cards exist: the pass
         re-reads one dozen and the brief shows another, so a correction lands
         on a card nobody is looking at. */
      .order("signal_id", { ascending: true })
      .limit(60),
    db().from("nova_refreshes")
      .select(REFRESH_COLUMNS)
      .eq("agent_id", agent.agent_id)
      .order("started_at", { ascending: false })
      .limit(1),
    /* Only scheduled passes count as absence. The creation pass and any manual
       refresh happened with the person watching; folding those in would tell
       someone who just clicked Refresh that Nova had been busy while they were
       away, seconds after they saw it happen. */
    db().from("nova_refreshes")
      .select("subjects_checked, signals_found, signals_kept, signals_as_noise, sources_unavailable, started_at, finished_at")
      .eq("agent_id", agent.agent_id)
      .eq("trigger", "scheduled")
      .gt("started_at", awaySince)
      .order("started_at", { ascending: true })
      .limit(200),
    db().from("nova_memory")
      .select("memory_id, kind, facet, summary, evidence, support_count, execution_public_id, updated_at")
      .eq("agent_id", agent.agent_id)
      .order("updated_at", { ascending: false })
      .limit(40),
    /* Read here rather than through lib/nova/investigation.ts, which reads this
       module for the owner check. One narrow query is a smaller price than an
       import cycle between the two files that write the same agent's rows. */
    db().from("nova_research")
      .select("research_id, signal_id, status, question, proposal, terms, execution_public_id, paid_usdc, transaction_hash, verification, result, failure, reading, arc_proof, settled_at")
      .eq("agent_id", agent.agent_id)
      .order("created_at", { ascending: false })
      .limit(60),
    /* Read with the brief rather than on demand: the panel that edits it and
       the readings that used it are the same fact, and a page that shows one
       without the other invites somebody to correct a statement they cannot
       see the effect of. */
    loadProjectContext(agent.agent_id),
  ]);

  const signals: NovaSignal[] = ((signalResult.data ?? []) as Array<Record<string, any>>).map((row) => ({
    signalId: row.signal_id,
    subjectId: row.subject_id,
    subjectLabel: row.nova_subjects?.label ?? null,
    subjectRef: row.nova_subjects?.ref ?? null,
    subjectKind: row.nova_subjects?.kind ?? null,
    interest: row.nova_subjects?.interest ?? null,
    settlesOn: settlementNetworkOf(row.nova_subjects?.last_digest),
    kind: row.kind,
    headline: row.headline,
    detail: row.detail,
    evidence: row.evidence ?? {},
    relevance: row.kind === "repository_activity" ? "noise" : row.relevance,
    relevanceReason: row.relevance_reason,
    status: row.status,
    executionPublicId: row.execution_public_id,
    observedAt: row.observed_at,
    refusal: row.refusal ?? null,
  }));

  const { worthAttention, noise, overflow, withheld } = assembleBrief(signals, { goal: agent.goal });
  const memory: NovaMemory[] = ((memoryResult.data ?? []) as Array<Record<string, any>>).map((row) => ({
    memoryId: row.memory_id,
    kind: row.kind,
    facet: row.facet,
    summary: row.summary,
    evidence: row.evidence ?? {},
    supportCount: row.support_count ?? 1,
    executionPublicId: row.execution_public_id,
    updatedAt: row.updated_at,
  }));

  const investigations: NovaInvestigation[] = ((researchResult.data ?? []) as Array<Record<string, any>>)
    .map((row) => ({
      researchId: row.research_id,
      signalId: row.signal_id,
      status: row.status,
      question: row.question,
      proposal: row.proposal ?? {},
      authorisedUsdc: Number(row.terms?.priceAtomic ?? 0) / 1e6 || null,
      provider: row.terms?.provider ?? null,
      executionPublicId: row.execution_public_id,
      paidUsdc: row.paid_usdc === null ? null : Number(row.paid_usdc),
      transaction: row.transaction_hash,
      verification: row.verification ?? null,
      reading: row.reading ?? null,
      arcProof: row.arc_proof ?? null,
      result: row.result ?? null,
      failure: row.failure,
      settledAt: row.settled_at,
    }));

  /* Shadow autonomy. Read after the purchases and kept apart from them: these
     are decisions, the investigations above are receipts, and a page that
     merged them would be counting money that never moved. A failure here costs
     the block on the page and nothing else. */
  const shadow = await shadowViewFor(agent, new Date()).catch(() => offShadow());

  const lastRefreshRow = (refreshResult.data ?? [])[0] as Record<string, unknown> | undefined;
  const whileAway = summariseAway(
    (awayResult.data ?? []) as Array<Record<string, unknown>>,
    awaySince,
  );
  const wokeFromDormancy = agent.dormant_since !== null;

  /* Recording the visit is the last thing that happens, and a failure here is
     deliberately not fatal: a brief that rendered is worth more than a
     perfectly maintained clock. The cost of losing this write is one repeated
     "while you were away", not a lost brief. */
  await db()
    .from("nova_agents")
    .update({ last_opened_at: new Date().toISOString(), dormant_since: null })
    .eq("agent_id", agent.agent_id);

  return {
    agent: toAgent(agent),
    greeting: greeting(input.hourOfDay),
    worthAttention,
    noise,
    watchlist: overflow,
    withheld,
    projectContext,
    lastRefresh: lastRefreshRow ? toRefresh(lastRefreshRow) : null,
    whileAway,
    wokeFromDormancy,
    memory,
    investigations,
    /* From the purchases, not from proxies for them. Counting signals that
       carry an execution id and memory rows that mention one made three
       numbers out of a single fact. */
    standing: standingFrom(investigations),
    shadow,
  };
}

function offShadow(): NovaShadowView {
  return {
    state: "off",
    blocked: "no_mandate",
    summary: shadowSummaryFrom([]),
    decisions: [],
    limits: null,
  };
}

/**
 * What the brief says about unattended work.
 *
 * The limits come off the signed mandate rather than out of a settings row,
 * because the mandate is the only place they are true: a settings row is what
 * Veyra believes, and a signature is what the owner agreed to.
 */
async function shadowViewFor(
  agent: Record<string, any>,
  now: Date,
): Promise<NovaShadowView> {
  const mandate = await autonomyMandateFor({
    ownerWallet: agent.owner_wallet ?? null,
    agentPublicId: agent.public_id,
    now,
  });
  const readiness = mandateReadiness(mandate, now);
  if (!readiness.ready) {
    return { ...offShadow(), blocked: readiness.reason };
  }

  const live = readiness.mandate;
  const period = budgetPeriodFor(now, live.budgetTimezone as string);
  const decisions = await shadowDecisionsFor(agent.agent_id, 20);
  return {
    state: "watching",
    blocked: null,
    summary: shadowSummaryFrom(decisions, { period, dailyBudgetUsdc: live.maxPerDayUsdc }),
    decisions,
    limits: {
      perActionUsdc: live.maxPerTransactionUsdc,
      dailyUsdc: live.maxPerDayUsdc,
      totalUsdc: live.maxTotalUsdc,
      attemptsPerDay: live.maxAutonomousAttemptsPerDay ?? 0,
      minimumTrustScore: live.minimumTrustScore,
      timezone: period.timezone,
      mode: live.mode,
      expiresAt: live.expiresAt,
      signedBy: live.ownerWallet,
      capabilities: [...live.allowedCapabilities],
      /* The same predicate the activation route accepts by, so the panel
         cannot say a mandate is current while the server would refuse it. */
      isCurrentOffer: isPreviewMandate({
        ...live,
        budgetTimezone: live.budgetTimezone ?? period.timezone,
        maxAutonomousAttemptsPerDay: live.maxAutonomousAttemptsPerDay ?? 0,
      } as Parameters<typeof isPreviewMandate>[0]),
    },
  };
}

/**
 * Every scheduled pass since the owner's last visit, added up.
 *
 * Exported for its tests: this addition is what makes "while you were away"
 * a measurement rather than a slogan, and it is the one part of loadBrief that
 * can be checked without a database.
 */
export function summariseAway(
  rows: Array<Record<string, unknown>>,
  since: string,
): NovaWhileAway | null {
  if (rows.length === 0) return null;
  const unavailable = new Set<string>();
  let subjectsChecked = 0;
  let signalsFound = 0;
  let signalsKept = 0;
  let signalsAsNoise = 0;
  let until = since;
  for (const row of rows) {
    subjectsChecked += Number(row.subjects_checked ?? 0);
    signalsFound += Number(row.signals_found ?? 0);
    signalsKept += Number(row.signals_kept ?? 0);
    signalsAsNoise += Number(row.signals_as_noise ?? 0);
    for (const source of (row.sources_unavailable as string[] | null) ?? []) {
      unavailable.add(source);
    }
    const finished = (row.finished_at as string | null) ?? (row.started_at as string | null);
    if (finished && finished > until) until = finished;
  }
  return {
    refreshes: rows.length,
    subjectsChecked,
    signalsFound,
    signalsKept,
    signalsAsNoise,
    /* A source that failed on one pass out of twelve is still named. Eleven
       good reads do not retire the blind spot the twelfth had. */
    sourcesUnavailable: [...unavailable],
    since,
    until,
  };
}


export { quietSummary };

/* ---- teaching ---- */

/**
 * A dismissal is evidence about taste, and it takes more than one to become a
 * belief. A preference asserted from a single click would put sentences into
 * the "what Nova knows about you" list that a person never meant to say.
 */
export const PREFERENCE_THRESHOLD = 3;

/**
 * What each verb does to the item in front of the person.
 *
 * Separate from what it teaches, because the two are not the same decision:
 * following something keeps it on screen, banning a category takes it off, and
 * both write memory. Reading the mapping in one place is how you check that a
 * verb cannot quietly do something its label does not say.
 */
const FEEDBACK_STATUS: Record<NovaFeedback, "seen" | "dismissed" | "investigating"> = {
  seen: "seen",
  useful: "seen",
  follow: "seen",
  not_interesting: "dismissed",
  ignore_kind: "dismissed",
  investigating: "investigating",
};

/**
 * One signal, for the holder of the agent's secret.
 *
 * Separate from loadBrief because pricing an investigation needs the subject
 * behind the signal -- its kind and its label decide what question is worth
 * asking -- and loading the whole brief to answer a question about one line of
 * it would re-read sixty rows to use one.
 */
/** The columns a NovaSignal is built from, named once so two readers of the
 *  same rows cannot drift into reading different ones. */
export const SIGNAL_COLUMNS = "signal_id, subject_id, kind, headline, detail, relevance, relevance_reason, evidence, status, execution_public_id, observed_at, refusal, nova_subjects(label, kind, interest, ref, last_digest)";

/** One signal row, as the rest of the product understands a signal. */
export function signalFromRow(row: Record<string, any>): NovaSignal {
  return {
    signalId: row.signal_id,
    subjectId: row.subject_id,
    subjectLabel: row.nova_subjects?.label ?? null,
    subjectRef: row.nova_subjects?.ref ?? null,
    subjectKind: row.nova_subjects?.kind ?? null,
    interest: row.nova_subjects?.interest ?? null,
    settlesOn: settlementNetworkOf(row.nova_subjects?.last_digest),
    kind: row.kind,
    headline: row.headline,
    detail: row.detail,
    evidence: row.evidence ?? {},
    relevance: row.kind === "repository_activity" ? "noise" : row.relevance,
    relevanceReason: row.relevance_reason,
    status: row.status,
    executionPublicId: row.execution_public_id,
    observedAt: row.observed_at,
    refusal: row.refusal ?? null,
  };
}

export async function loadSignalForOwner(input: {
  publicId: string;
  ownerSecret: string;
  signalId: string;
}): Promise<NovaSignal> {
  const agent = await loadOwned(input.publicId, input.ownerSecret);
  const { data } = await db()
    .from("nova_signals")
    .select(SIGNAL_COLUMNS)
    .eq("agent_id", agent.agent_id)
    .eq("signal_id", input.signalId)
    .maybeSingle();

  if (!data) throw new NovaError("No such item.", "not_found", 404);
  return signalFromRow(data as Record<string, any>);
}

/**
 * What Veyra found when it looked, when what it found was no.
 *
 * Pricing a card probes live endpoints, and the answer is often that none of
 * them can be paid: the subject settles on a rail this wallet cannot reach, or
 * publishes no field a question fits in, or has moved above the ceiling. That
 * is a real answer and it used to live only in the page, so a reload put the
 * card back untouched and the same probe ran again to hear the same thing.
 *
 * Passing null clears it, which is what a later attempt that does produce a
 * proposal must do -- a price moves back, a rail appears, and a stale refusal
 * sitting under a live offer would be the screen contradicting itself.
 */
export async function recordSignalRefusal(input: {
  agentId: string;
  signalId: string;
  refusal: NovaRefusal | null;
}): Promise<void> {
  await db()
    .from("nova_signals")
    .update({ refusal: input.refusal, updated_at: new Date().toISOString() })
    .eq("agent_id", input.agentId)
    .eq("signal_id", input.signalId);
}

/**
 * Records an ERC-8004 identity the owner claimed, after Arc has confirmed it.
 *
 * Written only from a confirmation read off the registry, never from what a
 * browser reported. The owner address is stored beside the pair rather than as
 * the identity, because it is the part expected to change: transferring the
 * token moves ownership and leaves the agent -- its memory, its history, its
 * attestations -- exactly where it was.
 */
export async function recordArcIdentity(input: {
  agentId: string;
  identity: NovaArcIdentity;
}): Promise<void> {
  await db()
    .from("nova_agents")
    .update({
      arc_identity_registry: input.identity.registry,
      arc_identity_agent_id: input.identity.agentId,
      arc_identity_owner: input.identity.owner,
      arc_identity_chain_id: input.identity.chainId,
      arc_identity_tx: input.identity.transaction,
      arc_identity_registered_at: input.identity.registeredAt,
    })
    .eq("agent_id", input.agentId);
}

export async function markSignal(input: {
  publicId: string;
  ownerSecret: string;
  signalId: string;
  feedback: NovaFeedback;
}): Promise<void> {
  const agent = await loadOwned(input.publicId, input.ownerSecret);
  const status = FEEDBACK_STATUS[input.feedback];

  const { data, error: markError } = await db()
    .from("nova_signals")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("agent_id", agent.agent_id)
    .eq("signal_id", input.signalId)
    .select("kind, evidence, nova_subjects(label)")
    .maybeSingle();

  if (markError) throw new NovaError("Could not save your feedback.", "database_unavailable", 503);
  if (!data) throw new NovaError("No such item.", "not_found", 404);
  const row = data as { evidence: Record<string, unknown>; kind: string; nova_subjects?: { label?: string } | null };
  const assessment = assessmentOf({ evidence: row.evidence });
  if (assessment?.goal === agent.goal && (input.feedback === "useful" || input.feedback === "not_interesting")) {
    const { error } = await db().from("nova_value_feedback").upsert({
      signal_id: input.signalId, agent_id: agent.agent_id, assessment_at: assessment.generatedAt,
      goal: assessment.goal, feedback: input.feedback, updated_at: new Date().toISOString(),
    }, { onConflict: "signal_id,assessment_at" });
    if (error) throw new NovaError("Could not save your result rating.", "database_unavailable", 503);
  }
  const category = preferencePhraseFor(row.kind);
  const label = row.nova_subjects?.label?.trim() ?? "";

  switch (input.feedback) {
    case "useful":
      /* Only a category can be marked useful, and only one Nova is willing to
         learn about. The unlearnable kinds are unlearnable in both directions:
         if a payee change cannot be turned off, it must not be possible to
         claim credit for turning it up either. */
      if (category) await rememberPreference(agent.agent_id, "cares_about", category, { learnedFrom: row.kind });
      return;

    case "follow":
      /* A subject, not a category. This is the answer to "I do not care about
         releases in general, I care about this one repository" -- which stated
         interests alone have no way to express. */
      if (label) await rememberPreference(agent.agent_id, "follows", label, { learnedFrom: "follow", kind: row.kind });
      return;

    case "not_interesting":
      /* The topic, not the category. Dismissing one noisy repository should not
         cost the person every release notice they have. Soft, and it
         accumulates: the weight climbs only if they keep saying it. */
      // One unhelpful article is not a request to suppress its entire publisher.
      if (label && row.kind !== "official_publication") await rememberPreference(agent.agent_id, "usually_ignores", label, { learnedFrom: "not_interesting" });
      return;

    case "ignore_kind":
      /* The category, stated outright, so it enters at full weight rather than
         waiting for repetition to prove something already said. */
      if (category) {
        await rememberPreference(
          agent.agent_id,
          "usually_ignores",
          category,
          { learnedFrom: "ignore_kind" },
          EXPLICIT_IGNORE_SUPPORT,
        );
      }
      return;

    default:
      return;
  }
}

/**
 * Writes a preference, or strengthens the one already there.
 *
 * `atLeast` is how an explicit instruction enters at the weight repetition
 * would otherwise take days to reach, without ever weakening something the
 * person has said more often than that.
 */
async function rememberPreference(
  agentId: string,
  facet: "cares_about" | "usually_ignores" | "follows",
  summary: string,
  evidence: Record<string, unknown>,
  atLeast = 1,
): Promise<void> {
  const trimmed = summary.slice(0, 600);
  const { data: current } = await db()
    .from("nova_memory")
    .select("memory_id, support_count")
    .eq("agent_id", agentId)
    .eq("kind", "preference")
    .eq("facet", facet)
    .eq("summary", trimmed)
    .maybeSingle();

  if (current) {
    const row = current as { memory_id: string; support_count: number };
    await db().from("nova_memory")
      .update({
        support_count: Math.max(row.support_count + 1, atLeast),
        updated_at: new Date().toISOString(),
      })
      .eq("memory_id", row.memory_id);
    return;
  }

  await db().from("nova_memory").insert({
    agent_id: agentId,
    kind: "preference",
    facet,
    summary: trimmed,
    evidence,
    support_count: atLeast,
  });
}

/**
 * The phrase a dismissal teaches.
 *
 * The mapping itself lives with the scorer, because scoring has to match a
 * category preference against the same phrase that writing one recorded. Two
 * copies of this drifting apart would mean a person banning a category and
 * Nova going on showing it, with the ban visible in "what Nova knows about
 * you" the whole time -- which is worse than not offering the ban at all.
 */
export const preferencePhraseFor = categoryPhraseFor;

function checkedGoal(value: unknown): string | null {
  try { return normalizeGoal(value); } catch (error) { throw new NovaError((error as Error).message, "invalid_goal"); }
}

/**
 * Owner-authenticated public-material reading. No payment discovery, signer or
 * wallet is called.
 *
 * `reassess` is the owner asking this event to be read again against the
 * project as it stands now. It is a separate act from the scheduled pass and
 * spends none of its budget: a backlog two dozen deep drained a few at a time
 * cannot answer "what does this one mean for me", which is the question
 * somebody with a card open in front of them is actually asking.
 */
export async function researchPublicSources(input: { publicId: string; ownerSecret: string; signalId: string; reassess?: boolean }) {
  const agent = await loadOwned(input.publicId, input.ownerSecret);
  const signal = await loadSignalForOwner(input);
  if (!agent.goal) throw new NovaError("Set a concrete research goal in My Agent first.", "goal_required");
  if (signal.kind !== "repository_release" && signal.kind !== "official_publication") {
    throw new NovaError("This is background activity or an operational alert, not an event that needs research.", "background_activity");
  }
  const projectContext = contextForPrompt(await loadProjectContext(agent.agent_id));
  const current = assessmentOf(signal);
  /* A fresh reading of the same event under the same goal is reused -- unless
     the owner has since said something different about where the work is, in
     which case it is a reading of a project that no longer exists.

     Never when they asked for a reassessment. A button that sometimes returns
     the stored paragraph is a button that sometimes answers yesterday's
     question, and the person pressing it cannot tell which time it did. */
  if (!input.reassess && current && readingStands(
    { goal: current.goal, context: current.projectContext ?? null, rules: current.rules ?? null },
    { goal: agent.goal, context: projectContext, rules: READING_RULES },
  ) && Date.now() - Date.parse(current.generatedAt) < 24 * 3_600_000) return current;
  const subject = signal.evidence.subject as Record<string, unknown> | undefined;
  const material = (signal.evidence.publicMaterial ?? subject?.publicMaterial) as PublicMaterial | undefined;
  if (!material?.text || !material.url) throw new NovaError("No readable public material is stored for this event. Open the original source or look again later.", "source_unavailable");
  const context = await publicContext(material);
  let failure: ReadingFailure | null = null;
  let failureDetail: string | undefined;
  const assessment = await assessPublicMaterial({ goal: agent.goal, projectContext, headline: signal.headline, sources: context.sources, onFailure: (reason, detail) => { failure = reason; failureDetail = detail; } });
  if (assessment) assessment.sourcesUnavailable = context.unavailable;
  /* Named, because the six ways this fails ask for six different things from
     the person reading the card, and "no paid tool was requested" is true of
     all of them. */
  if (!assessment) throw new NovaError(`${READING_FAILURE_DETAIL[(failure ?? "upstream_error") as ReadingFailure]}${failureDetail ? ` (${failureDetail})` : ""} No paid tool was requested; the earlier reading is unchanged.`, `analysis_unavailable_${failure ?? "upstream_error"}`, 503);
  const { error } = await db().from("nova_signals").update({ evidence: { ...signal.evidence, valueAssessment: assessment }, updated_at: new Date().toISOString() })
    .eq("agent_id", agent.agent_id).eq("signal_id", signal.signalId);
  if (error) throw new NovaError("Could not save the analysis.", "database_unavailable", 503);
  if (assessment.contextProposal) {
    await proposeProjectContext(agent.agent_id, [{
      statement: assessment.contextProposal.statement,
      why: assessment.contextProposal.why,
      evidence: { headline: signal.headline, sources: assessment.sources.map((entry) => entry.url).slice(0, 2), suggestedAt: assessment.generatedAt },
    }]);
  }
  return assessment;
}
