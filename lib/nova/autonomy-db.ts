/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { getExecutionMandate, listExecutionMandatesByOwner } from "../execution/db.ts";
import type { ExecutionMandate } from "../execution/types.ts";
import { db } from "./service.ts";
import {
  budgetPeriodFor, mandateReadiness,
  type AutonomyCheck, type AutonomyUsage, type BudgetPeriod, type ShadowDecision,
  type ShadowRecord,
} from "./autonomy.ts";

/**
 * Reading and writing what Nova would have done.
 *
 * Separate from lib/nova/autonomy.ts on purpose: that file decides and this one
 * remembers, and the deciding half is worth keeping free of I/O so it can be
 * exercised exhaustively without a database.
 */

export type { ShadowRecord } from "./autonomy.ts";

/**
 * The mandate a Nova is running under, if any.
 *
 * Mandates are keyed by the owner's wallet and the subject agent, which for a
 * Nova is its public id. Newest usable one wins: an owner who tightened their
 * limits yesterday should not have last month's looser mandate apply because it
 * happened to be found first.
 */
export async function autonomyMandateFor(input: {
  ownerWallet: string | null;
  agentPublicId: string;
  now: Date;
}): Promise<ExecutionMandate | null> {
  if (!input.ownerWallet) return null;
  const all = await listExecutionMandatesByOwner(input.ownerWallet);
  const mine = all
    .filter((entry) => entry.subjectAgentId === input.agentPublicId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  /* Readiness, not just existence. A revoked or expired mandate is still a row;
     returning it and letting the caller forget to check is how a revocation
     becomes advisory. */
  return mine.find((entry) => mandateReadiness(entry, input.now).ready) ?? mine[0] ?? null;
}

/** Everything decided under this mandate inside one budget day. */
export async function usageFor(input: {
  agentId: string;
  mandateHash: string;
  period: BudgetPeriod;
}): Promise<AutonomyUsage> {
  const { data, error } = await db()
    .from("nova_autonomy_decisions")
    .select("verdict, would_spend_usdc, budget_period_start")
    .eq("agent_id", input.agentId)
    .eq("mandate_hash", input.mandateHash);
  if (error) throw new Error(`Nova autonomy usage read failed: ${error.message}`);

  const rows = data ?? [];
  const inPeriod = rows.filter(
    (row) => new Date(row.budget_period_start as string).toISOString() === input.period.start,
  );
  /* Only allowances count. A denial never reached the point where an
     authorization would have been built, so charging the day for it would let
     a mandate too strict to allow anything exhaust itself on its own refusals. */
  const allowed = inPeriod.filter((row) => row.verdict === "WOULD_ALLOW");
  const allowedEver = rows.filter((row) => row.verdict === "WOULD_ALLOW");
  const sum = (entries: typeof rows) =>
    entries.reduce((total, row) => total + Number(row.would_spend_usdc ?? 0), 0);

  return {
    spentUsdc: sum(allowed),
    spentTotalUsdc: sum(allowedEver),
    attempts: allowed.length,
  };
}

/**
 * Whether this signal has already been ruled on today under these terms.
 *
 * The scheduler asks before doing any of the expensive work -- discovery,
 * probing, a model writing a question -- because the point of a backoff is to
 * not pay for the same answer four times a night. The database enforces it
 * again with a unique index, so a race between two ticks ends as a rejected
 * insert rather than as two identical rows.
 */
export async function alreadyDecided(input: {
  agentId: string;
  signalId: string;
  mandateHash: string;
  period: BudgetPeriod;
}): Promise<boolean> {
  const { data, error } = await db()
    .from("nova_autonomy_decisions")
    .select("decision_id")
    .eq("agent_id", input.agentId)
    .eq("signal_id", input.signalId)
    .eq("mandate_hash", input.mandateHash)
    .eq("budget_period_start", input.period.start)
    .limit(1);
  if (error) throw new Error(`Nova autonomy backoff read failed: ${error.message}`);
  return (data ?? []).length > 0;
}

export type ShadowWrite = {
  agentId: string;
  signalId: string;
  mandateId: string;
  mandateHash: string;
  decision: ShadowDecision;
  question: string;
  capability: string;
  provider: string | null;
  resource: string | null;
  rail: string;
  network: string | null;
  trustScore: number | null;
};

/**
 * Writes one decision, or discovers somebody else already did.
 *
 * A duplicate is not an error worth failing a tick over. Two schedulers racing
 * on the same agent is exactly what the unique index is for, and the loser's
 * correct behaviour is to move on.
 */
export async function recordShadowDecision(
  input: ShadowWrite,
): Promise<{ written: boolean; decisionId: string | null }> {
  const { decision } = input;
  const { data, error } = await db()
    .from("nova_autonomy_decisions")
    .insert({
      agent_id: input.agentId,
      signal_id: input.signalId,
      mandate_id: input.mandateId,
      mandate_hash: input.mandateHash,
      verdict: decision.verdict,
      question: input.question.slice(0, 400),
      capability: input.capability,
      provider: input.provider,
      resource: input.resource,
      rail: input.rail,
      network: input.network,
      trust_score: input.trustScore,
      would_spend_usdc: decision.wouldSpendUsdc,
      checks: decision.checks,
      failed_codes: decision.failed,
      attempt_number: decision.attemptNumber,
      budget_period_start: decision.period.start,
      budget_period_end: decision.period.end,
      budget_timezone: decision.period.timezone,
    })
    .select("decision_id")
    .maybeSingle();

  if (error) {
    if (error.code === "23505") return { written: false, decisionId: null };
    throw new Error(`Nova autonomy decision write failed: ${error.message}`);
  }
  return { written: true, decisionId: (data?.decision_id as string) ?? null };
}

function toRecord(row: Record<string, unknown>): ShadowRecord {
  return {
    decisionId: row.decision_id as string,
    signalId: row.signal_id as string,
    mandateHash: (row.mandate_hash as string | null) ?? "",
    verdict: row.verdict as ShadowRecord["verdict"],
    question: row.question as string,
    capability: row.capability as string,
    provider: (row.provider as string | null) ?? null,
    resource: (row.resource as string | null) ?? null,
    rail: row.rail as string,
    network: (row.network as string | null) ?? null,
    trustScore: row.trust_score === null || row.trust_score === undefined
      ? null : Number(row.trust_score),
    wouldSpendUsdc: Number(row.would_spend_usdc ?? 0),
    checks: (row.checks as AutonomyCheck[]) ?? [],
    failed: (row.failed_codes as string[]) ?? [],
    attemptNumber: Number(row.attempt_number ?? 1),
    period: {
      start: new Date(row.budget_period_start as string).toISOString(),
      end: new Date(row.budget_period_end as string).toISOString(),
      timezone: row.budget_timezone as string,
    },
    ownerFeedback: (row.owner_feedback as ShadowRecord["ownerFeedback"]) ?? null,
    decidedAt: new Date(row.decided_at as string).toISOString(),
  };
}

/** The decisions a brief shows: this agent's, newest first. */
export async function shadowDecisionsFor(
  agentId: string,
  limit = 20,
): Promise<ShadowRecord[]> {
  const { data, error } = await db()
    .from("nova_autonomy_decisions")
    .select("*")
    .eq("agent_id", agentId)
    .order("decided_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Nova autonomy decisions read failed: ${error.message}`);
  return (data ?? []).map((row) => toRecord(row as Record<string, unknown>));
}

/**
 * What the owner made of a decision.
 *
 * The half of this experiment a database cannot produce. Limits can be
 * calibrated from the numbers; whether Nova's judgement was worth funding can
 * only be answered by the person who would have paid for it.
 */
export async function setOwnerFeedback(input: {
  agentId: string;
  decisionId: string;
  feedback: "useful" | "not_worth_it";
  at: Date;
}): Promise<boolean> {
  const { data, error } = await db()
    .from("nova_autonomy_decisions")
    .update({ owner_feedback: input.feedback, owner_feedback_at: input.at.toISOString() })
    .eq("decision_id", input.decisionId)
    .eq("agent_id", input.agentId)
    .select("decision_id");
  if (error) throw new Error(`Nova autonomy feedback write failed: ${error.message}`);
  return (data ?? []).length > 0;
}

export { budgetPeriodFor, getExecutionMandate };
