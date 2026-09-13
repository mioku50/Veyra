/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getServerSupabaseConfig } from "../supabase/server-env.ts";
import { assembleBrief, greeting, quietSummary } from "./brief.ts";
import { MAX_INTERESTS, keywordsForInterests, normalizeInterests } from "./interests.ts";
import { changesForSubject } from "./observation.ts";
import { scoreRelevance } from "./relevance.ts";
import { observeRepositories, observeX402Catalog, type SourceObservation } from "./sources.ts";
import type {
  NovaAgent,
  NovaBrief,
  NovaMemory,
  NovaRefresh,
  NovaSignal,
  NovaStanding,
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
function db(): SupabaseClient {
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

type AgentRow = {
  agent_id: string;
  public_id: string;
  name: string;
  interests: string[];
  owner_wallet: string | null;
  arc_identity_address: string | null;
  arc_identity_registered_at: string | null;
  last_brief_at: string | null;
  created_at: string;
};

function toAgent(row: AgentRow): NovaAgent {
  return {
    publicId: row.public_id,
    name: row.name,
    interests: row.interests ?? [],
    ownerWallet: row.owner_wallet,
    arcIdentityAddress: row.arc_identity_address,
    arcIdentityRegisteredAt: row.arc_identity_registered_at,
    lastBriefAt: row.last_brief_at,
    createdAt: row.created_at,
  };
}

const AGENT_COLUMNS =
  "agent_id, public_id, name, interests, owner_wallet, arc_identity_address, arc_identity_registered_at, last_brief_at, created_at";

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
async function loadOwned(publicId: string, ownerSecret: string): Promise<AgentRow> {
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
  const now = input.now ?? new Date();
  const startedAt = now.toISOString();
  const started = Date.now();

  const [catalog, repositories] = await Promise.all([
    observeX402Catalog({ interests: agent.interests }),
    observeRepositories({ interests: agent.interests, now }),
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

  const ignoredPhrases = await loadIgnoredPhrases(agent.agent_id);
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
        ignoredPhrases,
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

  await db()
    .from("nova_agents")
    .update({ last_brief_at: new Date().toISOString(), updated_at: new Date().toISOString() })
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

async function loadIgnoredPhrases(agentId: string): Promise<string[]> {
  const { data } = await db()
    .from("nova_memory")
    .select("summary")
    .eq("agent_id", agentId)
    .eq("kind", "preference")
    .eq("facet", "usually_ignores");
  return ((data ?? []) as Array<{ summary: string }>).map((row) => row.summary);
}

/* ---- reading ---- */

export async function loadBrief(input: {
  publicId: string;
  ownerSecret: string;
  hourOfDay: number;
}): Promise<NovaBrief> {
  const agent = await loadOwned(input.publicId, input.ownerSecret);

  const [signalResult, refreshResult, memoryResult] = await Promise.all([
    db().from("nova_signals")
      .select("signal_id, subject_id, kind, headline, detail, relevance, relevance_reason, evidence, status, execution_public_id, observed_at, nova_subjects(label, kind, interest)")
      .eq("agent_id", agent.agent_id)
      .in("status", ["new", "seen", "investigating", "investigated"])
      .order("observed_at", { ascending: false })
      .limit(60),
    db().from("nova_refreshes")
      .select(REFRESH_COLUMNS)
      .eq("agent_id", agent.agent_id)
      .order("started_at", { ascending: false })
      .limit(1),
    db().from("nova_memory")
      .select("memory_id, kind, facet, summary, evidence, support_count, execution_public_id, updated_at")
      .eq("agent_id", agent.agent_id)
      .order("updated_at", { ascending: false })
      .limit(40),
  ]);

  const signals: NovaSignal[] = ((signalResult.data ?? []) as Array<Record<string, any>>).map((row) => ({
    signalId: row.signal_id,
    subjectId: row.subject_id,
    subjectLabel: row.nova_subjects?.label ?? null,
    subjectKind: row.nova_subjects?.kind ?? null,
    interest: row.nova_subjects?.interest ?? null,
    kind: row.kind,
    headline: row.headline,
    detail: row.detail,
    evidence: row.evidence ?? {},
    relevance: row.relevance,
    relevanceReason: row.relevance_reason,
    status: row.status,
    executionPublicId: row.execution_public_id,
    observedAt: row.observed_at,
  }));

  const { worthAttention, noise } = assembleBrief(signals);
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

  const lastRefreshRow = (refreshResult.data ?? [])[0] as Record<string, unknown> | undefined;

  return {
    agent: toAgent(agent),
    greeting: greeting(input.hourOfDay),
    worthAttention,
    noise,
    lastRefresh: lastRefreshRow ? toRefresh(lastRefreshRow) : null,
    memory,
    standing: standingFrom(signals, memory),
  };
}

/**
 * What Nova has earned.
 *
 * Registering an on-chain identity at signup certifies that an account was
 * created and nothing else. These three counts are the alternative: identity is
 * offered once there is a history for it to point at.
 */
export function standingFrom(signals: NovaSignal[], memory: NovaMemory[]): NovaStanding {
  const verifiedResearch = memory.filter((entry) => entry.kind === "learning").length;
  const veyraDecisions = signals.filter((signal) => signal.executionPublicId !== null).length;
  const observedOutcomes = signals.filter((signal) => signal.status === "investigated").length;
  return {
    verifiedResearch,
    veyraDecisions,
    observedOutcomes,
    readyForArcIdentity: verifiedResearch >= 1 && veyraDecisions >= 1 && observedOutcomes >= 1,
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

export async function markSignal(input: {
  publicId: string;
  ownerSecret: string;
  signalId: string;
  status: "seen" | "dismissed";
}): Promise<void> {
  const agent = await loadOwned(input.publicId, input.ownerSecret);
  const { data } = await db()
    .from("nova_signals")
    .update({ status: input.status, updated_at: new Date().toISOString() })
    .eq("agent_id", agent.agent_id)
    .eq("signal_id", input.signalId)
    .select("kind")
    .maybeSingle();

  if (input.status !== "dismissed" || !data) return;

  const phrase = preferencePhraseFor((data as { kind: string }).kind);
  if (!phrase) return;

  const { data: current } = await db()
    .from("nova_memory")
    .select("memory_id, support_count")
    .eq("agent_id", agent.agent_id)
    .eq("kind", "preference")
    .eq("facet", "usually_ignores")
    .eq("summary", phrase)
    .maybeSingle();

  if (current) {
    const row = current as { memory_id: string; support_count: number };
    await db().from("nova_memory")
      .update({ support_count: row.support_count + 1, updated_at: new Date().toISOString() })
      .eq("memory_id", row.memory_id);
    return;
  }

  await db().from("nova_memory").insert({
    agent_id: agent.agent_id,
    kind: "preference",
    facet: "usually_ignores",
    summary: phrase,
    evidence: { learnedFrom: (data as { kind: string }).kind },
    support_count: 1,
  });
}

/**
 * The phrase a dismissal teaches.
 *
 * Derived from the signal kind rather than from its wording, so what lands in
 * "what Nova knows about you" is a category a person would recognise instead of
 * a fragment of a sentence they happened to scroll past.
 */
export function preferencePhraseFor(kind: string): string | null {
  switch (kind) {
    case "repository_activity": return "commits";
    case "repository_release": return "releases";
    case "capability_available": return "new capabilities";
    case "price_changed": return "price changes";
    case "endpoint_recovered": return "recoveries";
    /* A changed payee is never learned away, and neither is a rail change or an
       endpoint going dark. Where someone's money goes is not a matter of taste,
       and a product where three impatient clicks switch that warning off has
       quietly become a different product. */
    default: return null;
  }
}
