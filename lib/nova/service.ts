/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getServerSupabaseConfig } from "../supabase/server-env.ts";
import { assembleBrief, greeting, quietSummary } from "./brief.ts";
import { MAX_INTERESTS, interestKey, keywordsForInterests, normalizeInterests } from "./interests.ts";
import { changesForSubject } from "./observation.ts";
import { categoryPhraseFor, scoreRelevance } from "./relevance.ts";
import { observeRepositories, observeX402Catalog, type SourceObservation } from "./sources.ts";
import { settlementNetworkOf } from "./network.ts";
import { standingFrom } from "./standing.ts";
import type {
  NovaAgent,
  NovaBrief,
  NovaFeedback,
  NovaInvestigation,
  NovaMemory,
  NovaPreferences,
  NovaRefresh,
  NovaArcIdentity,
  NovaRefusal,
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
  "agent_id, public_id, name, interests, owner_wallet, arc_identity_registry, arc_identity_agent_id, arc_identity_owner, arc_identity_chain_id, arc_identity_tx, arc_identity_registered_at, last_brief_at, last_opened_at, dormant_since, created_at";

/* ---- creating ---- */

export async function createNova(input: {
  name: string;
  interests: unknown;
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
    .update({ interests, updated_at: new Date().toISOString() })
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
  kind: "x402_resource" | "github_repository";
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
export async function runRefresh(input: {
  agent: { agent_id: string; interests: string[] };
  trigger: "creation" | "manual" | "scheduled";
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<{ refresh: NovaRefresh; newSignals: number }> {
  const agent = input.agent;
  const now = input.now ?? new Date();
  const startedAt = now.toISOString();
  const started = Date.now();

  const [catalog, repositories] = await Promise.all([
    observeX402Catalog({ interests: agent.interests, fetchImpl: input.fetchImpl }),
    observeRepositories({ interests: agent.interests, now, fetchImpl: input.fetchImpl }),
  ]);
  const observations = [...catalog.observations, ...repositories.observations];
  const sourcesUnavailable = [...catalog.unavailable, ...repositories.unavailable];

  const { data: existingRows } = await db()
    .from("nova_subjects")
    .select("subject_id, kind, ref, label, interest, last_digest")
    .eq("agent_id", agent.agent_id);
  const existing = new Map<string, SubjectRow>();
  for (const row of (existingRows ?? []) as SubjectRow[]) {
    existing.set(`${row.kind} ${row.ref}`, row);
  }

  const preferences = await loadPreferences(agent.agent_id);
  const keywords = keywordsForInterests(agent.interests);

  const signalRows: Array<Record<string, unknown>> = [];
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
      signalRows.push({
        agent_id: agent.agent_id,
        subject_id: subjectId,
        kind: change.kind,
        headline: change.headline,
        detail: change.detail,
        relevance: verdict.relevance,
        relevance_reason: verdict.reason,
        evidence: { ...change.evidence, subject: observation.context, label: observation.label },
        observed_at: change.observedAt,
      });
    }

    /* The digest is advanced only after its changes have been recorded. If the
       write below fails, the next refresh compares against the same old state
       and reports the change a second time. A repeat is recoverable; a change
       nobody ever saw is not. */
    await db()
      .from("nova_subjects")
      .update({ last_digest: observation.digest, last_observed_at: now.toISOString() })
      .eq("subject_id", subjectId);
  }

  if (signalRows.length > 0) {
    // Duplicates are ignored rather than rejected: two refreshes in the same
    // second must neither fail nor double-report.
    await db().from("nova_signals").upsert(signalRows, {
      onConflict: "agent_id,kind,subject_id,observed_at",
      ignoreDuplicates: true,
    });
  }

  const { data: refreshRow } = await db()
    .from("nova_refreshes")
    .insert({
      agent_id: agent.agent_id,
      trigger: input.trigger,
      subjects_checked: observations.length,
      signals_found: signalRows.length,
      signals_kept: kept,
      signals_as_noise: asNoise,
      sources_unavailable: sourcesUnavailable,
      duration_ms: Date.now() - started,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    })
    .select(REFRESH_COLUMNS)
    .single();

  const finishedAt = new Date().toISOString();
  await db()
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

  return { refresh: toRefresh(refreshRow), newSignals: kept };
}

const REFRESH_COLUMNS =
  "refresh_id, trigger, subjects_checked, signals_found, signals_kept, signals_as_noise, sources_unavailable, started_at, finished_at";

async function insertSubject(agentId: string, observation: SourceObservation): Promise<string | null> {
  const { data } = await db()
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

  const [signalResult, refreshResult, awayResult, memoryResult, researchResult] = await Promise.all([
    db().from("nova_signals")
      .select("signal_id, subject_id, kind, headline, detail, relevance, relevance_reason, evidence, status, execution_public_id, observed_at, refusal, nova_subjects(label, kind, interest, ref, last_digest)")
      .eq("agent_id", agent.agent_id)
      .in("status", ["new", "seen", "investigating", "investigated"])
      .order("observed_at", { ascending: false })
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
    relevance: row.relevance,
    relevanceReason: row.relevance_reason,
    status: row.status,
    executionPublicId: row.execution_public_id,
    observedAt: row.observed_at,
    refusal: row.refusal ?? null,
  }));

  const { worthAttention, noise, overflow } = assembleBrief(signals);
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
    lastRefresh: lastRefreshRow ? toRefresh(lastRefreshRow) : null,
    whileAway,
    wokeFromDormancy,
    memory,
    investigations,
    /* From the purchases, not from proxies for them. Counting signals that
       carry an execution id and memory rows that mention one made three
       numbers out of a single fact. */
    standing: standingFrom(investigations),
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
export async function loadSignalForOwner(input: {
  publicId: string;
  ownerSecret: string;
  signalId: string;
}): Promise<NovaSignal> {
  const agent = await loadOwned(input.publicId, input.ownerSecret);
  const { data } = await db()
    .from("nova_signals")
    .select("signal_id, subject_id, kind, headline, detail, relevance, relevance_reason, evidence, status, execution_public_id, observed_at, refusal, nova_subjects(label, kind, interest, ref, last_digest)")
    .eq("agent_id", agent.agent_id)
    .eq("signal_id", input.signalId)
    .maybeSingle();

  if (!data) throw new NovaError("No such item.", "not_found", 404);
  const row = data as Record<string, any>;
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
    relevance: row.relevance,
    relevanceReason: row.relevance_reason,
    status: row.status,
    executionPublicId: row.execution_public_id,
    observedAt: row.observed_at,
    refusal: row.refusal ?? null,
  };
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

  const { data } = await db()
    .from("nova_signals")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("agent_id", agent.agent_id)
    .eq("signal_id", input.signalId)
    .select("kind, nova_subjects(label)")
    .maybeSingle();

  if (!data) return;
  const row = data as { kind: string; nova_subjects?: { label?: string } | null };
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
      if (label) await rememberPreference(agent.agent_id, "usually_ignores", label, { learnedFrom: "not_interesting" });
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
