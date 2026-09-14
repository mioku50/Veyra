/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { proposeResearch } from "./research.ts";
import { db, signalFromRow, SIGNAL_COLUMNS } from "./service.ts";
import { recentLearnings } from "./investigation.ts";
import {
  asCaip2, budgetPeriodFor, evaluateShadow, mandateReadiness, consumesAttempt, spendOf,
  type AutonomyBlock, type AutonomyUsage, type ShadowDecision,
} from "./autonomy.ts";
import { alreadyDecided, autonomyMandateFor, recordShadowDecision, usageFor } from "./autonomy-db.ts";
import type { NovaSignal } from "./types.ts";

/**
 * The unattended pass, stopped one step short.
 *
 * Everything here is the real path. The signals are the ones the refresh just
 * found, the question is written by the same model that writes it on the page,
 * discovery and the quote are live, and the trust decision is Veyra's own. The
 * only thing that does not happen is the thing that costs money: no payment
 * authorization is built, no EIP-3009 signature is produced, and this module
 * imports nothing that could produce one.
 *
 * Three restraints, and they are the reason this is worth running at all.
 *
 *   A decision costs requests even when it costs no USDC. Discovery probes
 *   endpoints and a model writes a question, so the same unchanged signal must
 *   not be re-decided on every pass. One decision per signal per mandate per
 *   budget day, checked before the work and enforced again by a unique index.
 *
 *   Usage moves inside a tick. Two candidates in one pass both reading
 *   "nothing spent today" would each be allowed against the whole daily budget,
 *   which is the double-spend this is supposed to be learning how to prevent.
 *   The running total is carried forward between candidates here.
 *
 *   A proposal that could not be priced is not a denial. Veyra refusing to
 *   quote and Veyra deciding against a quote are different facts, and folding
 *   the first into the second would make a morning brief report refusals that
 *   never happened.
 */

/** At most this many decisions per agent per pass. Discovery is the expensive
 *  part, and a brief nobody finishes is worse than a brief with two good items
 *  in it. */
export const MAX_DECISIONS_PER_PASS = 2;

export type ShadowPass = {
  ran: boolean;
  /** Why nothing ran, when nothing ran. */
  blocked: AutonomyBlock | null;
  considered: number;
  decided: number;
  wouldAllow: number;
  wouldDeny: number;
  /** Candidates Veyra could not put a price on, which is not a refusal. */
  unpriced: number;
  /** Already ruled on today under these terms. */
  skipped: number;
  wouldSpendUsdc: number;
};

const EMPTY: ShadowPass = {
  ran: false, blocked: null, considered: 0, decided: 0, wouldAllow: 0,
  wouldDeny: 0, unpriced: 0, skipped: 0, wouldSpendUsdc: 0,
};

/** Worth deciding about, in the order Nova would care. */
const RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

async function candidatesFor(agentId: string, limit: number): Promise<NovaSignal[]> {
  const { data, error } = await db()
    .from("nova_signals")
    .select(SIGNAL_COLUMNS)
    .eq("agent_id", agentId)
    /* Never one already paid for or being paid for. An investigation that
       exists is a decision the owner already made, and shadowing it would ask
       the market to price something that has been bought. */
    .in("status", ["new", "seen"])
    .neq("relevance", "noise")
    .order("observed_at", { ascending: false })
    .limit(40);
  if (error) throw new Error(`Nova shadow candidates read failed: ${error.message}`);

  return (data ?? [])
    .map((row) => signalFromRow(row as Record<string, unknown>))
    .sort((left, right) => {
      const byRank = (RANK[left.relevance] ?? 9) - (RANK[right.relevance] ?? 9);
      return byRank !== 0 ? byRank : right.observedAt.localeCompare(left.observedAt);
    })
    .slice(0, limit);
}

export async function runShadowPass(input: {
  agent: {
    agentId: string;
    publicId: string;
    name: string;
    interests: string[];
    ownerWallet: string | null;
  };
  now?: Date;
  fetchImpl?: typeof fetch;
  maxDecisions?: number;
}): Promise<ShadowPass> {
  const now = input.now ?? new Date();
  const mandate = await autonomyMandateFor({
    ownerWallet: input.agent.ownerWallet,
    agentPublicId: input.agent.publicId,
    now,
  });

  const readiness = mandateReadiness(mandate, now);
  if (!readiness.ready) return { ...EMPTY, blocked: readiness.reason };
  const verified = readiness.mandate;

  /* Non-null past readiness, which refuses a mandate without a usable zone
     rather than measuring somebody's budget day in a zone they did not sign. */
  const period = budgetPeriodFor(now, verified.budgetTimezone as string);
  const usage: AutonomyUsage = await usageFor({
    agentId: input.agent.agentId,
    mandateHash: verified.canonicalHash,
    period,
  });

  const memory = await recentLearnings(input.agent.agentId).catch(() => [] as string[]);
  const candidates = await candidatesFor(
    input.agent.agentId,
    (input.maxDecisions ?? MAX_DECISIONS_PER_PASS) * 4,
  );

  const pass: ShadowPass = { ...EMPTY, ran: true };
  let running = { ...usage };

  for (const signal of candidates) {
    if (pass.decided >= (input.maxDecisions ?? MAX_DECISIONS_PER_PASS)) break;
    pass.considered += 1;

    if (await alreadyDecided({
      agentId: input.agent.agentId,
      signalId: signal.signalId,
      mandateHash: verified.canonicalHash,
      period,
    })) {
      pass.skipped += 1;
      continue;
    }

    const outcome = await proposeResearch({
      signal,
      wallet: input.agent.ownerWallet,
      agentName: input.agent.name,
      interests: input.agent.interests,
      memory,
      now,
      fetchImpl: input.fetchImpl,
    }).catch(() => ({ ok: false as const, reason: "unavailable", detail: "" }));

    if (!outcome.ok) {
      pass.unpriced += 1;
      continue;
    }

    /* The network as the mandate spells it, which is CAIP-2.
       `signal.settlesOn` is the display name -- "Base" -- because it is written
       for a person, and comparing it against `eip155:8453` is false for every
       chain there is. It was doing exactly that: every priced signal would have
       been denied for a network mismatch, whichever chain the mandate named.
       The quote knows the real one. */
    const settlesOn = asCaip2(outcome.plan.terms.network);
    const decision: ShadowDecision = evaluateShadow({
      mandate: verified,
      proposal: outcome.proposal,
      usage: running,
      period,
      network: settlesOn,
    });

    const written = await recordShadowDecision({
      agentId: input.agent.agentId,
      signalId: signal.signalId,
      mandateId: verified.mandateId,
      mandateHash: verified.canonicalHash,
      decision,
      question: outcome.proposal.question,
      capability: outcome.proposal.capability,
      provider: outcome.proposal.provider ?? null,
      resource: outcome.proposal.resource ?? null,
      rail: "x402",
      network: settlesOn,
      trustScore: outcome.proposal.trustScore,
    });

    /* Lost a race with another tick. The row that exists is as good as the one
       this pass would have written, and the day's usage already counts it. */
    if (!written.written) {
      pass.skipped += 1;
      continue;
    }

    pass.decided += 1;
    if (decision.verdict === "WOULD_ALLOW") pass.wouldAllow += 1;
    else pass.wouldDeny += 1;
    pass.wouldSpendUsdc += spendOf(decision);

    /* Carried forward, not re-read. Two allowances in one pass must see each
       other, or the daily budget is only ever enforced between passes. */
    if (consumesAttempt(decision)) {
      running = {
        spentUsdc: running.spentUsdc + spendOf(decision),
        spentTotalUsdc: running.spentTotalUsdc + spendOf(decision),
        attempts: running.attempts + 1,
      };
    }
  }

  return pass;
}
