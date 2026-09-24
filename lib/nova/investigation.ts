/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { getAddress, isAddress } from "viem";
import {
  asTransferAuthorization,
  asX402Accept,
  settleX402Call,
  type X402Quote,
} from "../x402/execution.ts";
import {
  ownerQuestionFor,
  researchRequestFor,
  revalidateResearch,
  type NovaResearchPlan,
  type NovaResearchProposal,
} from "./research.ts";
import { paidResearchReadiness, assessmentOf } from "./value.ts";
import { loadSignalForOwner } from "./service.ts";
import { hashTerms, type NovaResearchTerms, type TermsChange } from "./research-terms.ts";
import { db, loadOwned, NovaError } from "./service.ts";
import type { NovaInvestigation } from "./types.ts";
import { readResult, type NovaReading } from "./synthesis.ts";
import { novaRequestHash, recordPurchaseOnArc, type NovaArcProof } from "./arc-proof.ts";

/**
 * One investigation, from a price on a brief to a result underneath it.
 *
 * The whole point of this file is the order of operations, so it is worth
 * stating plainly:
 *
 *   propose    read-only. Nothing is authorised; a clearance here would mean
 *              reading your own brief produced permission to spend.
 *   approve    the live 402 challenge is raised again for the exact endpoint
 *              and the exact body that was priced, and the seven facts are
 *              compared against what the card actually said. Only if they
 *              match -- or the person has explicitly accepted the difference --
 *              is a clearance signed, for that exact amount.
 *   sign       in the owner's wallet, with the owner's key. Veyra holds none.
 *   settle     the signature is relayed, and the answer is checked against what
 *              the endpoint declared it returns.
 *   learn      only after that check passes.
 *
 * The last line is the one that costs something to honour. A purchase that was
 * paid for and failed its verification is a real and not especially rare
 * outcome, and it gets its own terminal state rather than being rounded up into
 * a success the receipt does not support.
 */

export type NovaResearchStatus = NovaInvestigation["status"];

type ResearchRow = {
  research_id: string;
  agent_id: string;
  signal_id: string;
  status: NovaResearchStatus;
  question: string;
  terms: NovaResearchTerms;
  terms_hash: string;
  request_body: unknown;
  request_method: "GET" | "POST";
  input_schema: Record<string, unknown> | null;
  output_schema: Record<string, unknown> | null;
  verification_required: boolean;
  proposal: NovaResearchProposal;
  approval: ApprovalRecord | null;
  payer_wallet: string | null;
  clearance_digest: string | null;
  selection_id: string | null;
  execution_public_id: string | null;
  paid_usdc: string | number | null;
  transaction_hash: string | null;
  verification: { verdict: string; summary: string } | null;
  reading: NovaReading | null;
  result: unknown;
  failure: string | null;
  settled_at: string | null;
};

type ApprovalRecord = {
  quote: X402Quote;
  candidateId: string;
  selectionId: string;
  decision: string;
  verificationRequired: boolean;
  outputSchema: Record<string, unknown> | null;
  capability: string;
  selectionHash: string;
};

const ROW_COLUMNS =
  "research_id, agent_id, signal_id, status, question, terms, terms_hash, request_body, request_method, input_schema, output_schema, verification_required, proposal, approval, payer_wallet, clearance_digest, selection_id, execution_public_id, paid_usdc, transaction_hash, verification, result, failure, reading, arc_proof, settled_at";

function toInvestigation(row: ResearchRow): NovaInvestigation {
  return {
    /* The terms that were cleared, not the ones first proposed: a person
       re-confirming a changed price agreed to this number, and a card that
       reports a refusal has to name the amount they signed for or it cannot be
       checked against a wallet. */
    authorisedUsdc: Number(row.terms?.priceAtomic ?? 0) / 1e6 || null,
    provider: row.terms?.provider ?? null,
    researchId: row.research_id,
    signalId: row.signal_id,
    status: row.status,
    question: row.question,
    proposal: row.proposal,
    executionPublicId: row.execution_public_id,
    paidUsdc: row.paid_usdc === null ? null : Number(row.paid_usdc),
    transaction: row.transaction_hash,
    verification: row.verification,
    arcProof: (row as Record<string, any>).arc_proof ?? null,
    reading: row.reading ? { ...row.reading, writtenBy: null } : null,
    result: row.result,
    failure: row.failure,
    settledAt: row.settled_at,
  };
}

/* ---- proposing ---- */

/**
 * Records what was put in front of somebody.
 *
 * An earlier offer on the same item that nobody acted on is removed rather than
 * kept: it authorised nothing, and leaving a row that says "proposed" next to a
 * newer one that says the same makes "which terms did they agree to" a question
 * with two answers.
 */
export async function recordProposal(input: {
  agentId: string;
  signalId: string;
  proposal: NovaResearchProposal;
  plan: NovaResearchPlan;
}): Promise<string> {
  await db()
    .from("nova_research")
    .delete()
    .eq("agent_id", input.agentId)
    .eq("signal_id", input.signalId)
    .eq("status", "proposed");

  const { data, error } = await db()
    .from("nova_research")
    .insert({
      agent_id: input.agentId,
      signal_id: input.signalId,
      status: "proposed",
      question: input.proposal.question.slice(0, 400),
      terms: input.plan.terms,
      terms_hash: input.proposal.termsHash,
      request_body: input.plan.requestBody ?? {},
      request_method: input.plan.method,
      input_schema: input.plan.inputSchema,
      output_schema: input.plan.outputSchema,
      verification_required: input.plan.verificationRequired,
      proposal: input.proposal,
    })
    .select("research_id")
    .maybeSingle();

  if (error || !data) throw new NovaError("Could not record that proposal.", "database_unavailable", 503);
  return (data as { research_id: string }).research_id;
}

/** The newest offer on this item that has not reached a terminal state. */
async function loadOpen(agentId: string, signalId: string): Promise<ResearchRow> {
  const { data } = await db()
    .from("nova_research")
    .select(ROW_COLUMNS)
    .eq("agent_id", agentId)
    .eq("signal_id", signalId)
    .in("status", ["proposed", "approved"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) {
    throw new NovaError(
      "There is nothing priced to approve here. Ask for a fresh look first.",
      "not_found",
      404,
    );
  }
  return data as ResearchRow;
}

async function loadById(agentId: string, researchId: string): Promise<ResearchRow> {
  const { data } = await db()
    .from("nova_research")
    .select(ROW_COLUMNS)
    .eq("agent_id", agentId)
    .eq("research_id", researchId)
    .maybeSingle();
  if (!data) throw new NovaError("No such investigation.", "not_found", 404);
  return data as ResearchRow;
}

/* ---- approving ---- */

export type NovaApproval =
  | {
      ok: true;
      researchId: string;
      /** Everything the wallet needs, and nothing it does not. The accept stays
       *  on the server; only its signable shape travels. */
      accept: X402Quote["accept"];
      nonce: string;
      costUsdc: number;
      payTo: string;
      provider: string;
      clearanceDigest: string;
      verifiedAfterPaying: boolean;
    }
  | {
      ok: false;
      reason: "market_changed";
      changes: TermsChange[];
      /** The hash of what is true now. Sent back on the confirming call, so a
       *  price that moves twice cannot be approved by a click that saw once. */
      termsHash: string;
      costUsdc: number;
      detail: string;
    }
  | { ok: false; reason: string; detail: string };

export async function approveResearch(input: {
  publicId: string;
  ownerSecret: string;
  signalId: string;
  wallet: string;
  acknowledged?: string | null;
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<NovaApproval> {
  if (!isAddress(input.wallet)) {
    throw new NovaError("Connect a wallet before approving a payment.", "wallet_required", 400);
  }
  const agent = await loadOwned(input.publicId, input.ownerSecret);
  const row = await loadOpen(agent.agent_id, input.signalId);

  /* Re-derived from the signal rather than stored, because it is a pure
     function of it. The discovery query decides which listings come back at
     all, so using a different one here would report an endpoint as withdrawn
     when it was only looked for under another name. */
  const signal = await loadSignalForOwner({
    publicId: input.publicId,
    ownerSecret: input.ownerSecret,
    signalId: input.signalId,
  });
  if (row.proposal.askedBy === "owner") {
    /* The owner's question, put to a listed tool. Its reason is the question
       itself, which is on the row; what is re-checked is that it is still a
       listed tool and still a question the owner could have asked of it. */
    const asked = ownerQuestionFor(signal, row.question);
    if (!asked?.ok) return { ok: false, reason: asked?.reason ?? "owner_question_invalid", detail: asked?.detail ?? "That question can no longer be asked here." };
  } else {
    const readiness = paidResearchReadiness(signal, agent.goal, input.now);
    if (!readiness.ready) return { ok: false, reason: readiness.reason, detail: readiness.detail };
    const assessment = assessmentOf(signal)!;
    if (row.proposal.researchNeed?.goal !== agent.goal || row.question !== assessment.gap?.question) {
      return { ok: false, reason: "research_need_changed", detail: "Your goal or research question changed. Review a new proposal before paying." };
    }
  }
  const { query } = researchRequestFor(signal);

  const outcome = await revalidateResearch({
    /* The terms as recorded when the card was drawn, never the ones a client
       sends. The whole check is worthless if the thing being compared against
       can be supplied by the page asking for approval. */
    shown: row.terms,
    acknowledged: input.acknowledged ?? null,
    requestBody: row.request_body,
    inputSchema: row.input_schema,
    method: row.request_method,
    query,
    wallet: input.wallet,
    signalId: input.signalId,
    now: input.now,
    fetchImpl: input.fetchImpl,
  });

  if (!outcome.ok) {
    if (outcome.reason === "market_changed") {
      return {
        ok: false,
        reason: "market_changed",
        changes: outcome.changes,
        termsHash: outcome.termsHash,
        costUsdc: outcome.costUsdc,
        detail: outcome.detail,
      };
    }
    return { ok: false, reason: outcome.reason, detail: outcome.detail };
  }

  const approval: ApprovalRecord = {
    quote: outcome.quote,
    candidateId: outcome.candidateId,
    selectionId: outcome.selectionId,
    decision: outcome.decision,
    verificationRequired: outcome.verificationRequired,
    outputSchema: outcome.outputSchema,
    capability: row.terms.capability,
    selectionHash: outcome.clearance.selectionHash,
  };

  const { error } = await db()
    .from("nova_research")
    .update({
      status: "approved",
      /* The terms that were actually cleared, which may be the ones the person
         re-confirmed rather than the ones first shown. Writing them is what
         makes the settled row an account of what was agreed. */
      terms: outcome.terms,
      terms_hash: outcome.termsHash,
      verification_required: outcome.verificationRequired,
      approval,
      payer_wallet: getAddress(input.wallet),
      clearance_digest: outcome.clearance.clearanceDigest,
      selection_id: outcome.selectionId,
      approved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("research_id", row.research_id);
  if (error) throw new NovaError("Could not record that approval.", "database_unavailable", 503);

  return {
    ok: true,
    researchId: row.research_id,
    accept: outcome.quote.accept,
    nonce: outcome.quote.nonce,
    costUsdc: Number(outcome.quote.accept.amountAtomic) / 1e6,
    payTo: outcome.quote.accept.payTo,
    provider: outcome.terms.provider,
    clearanceDigest: outcome.clearance.clearanceDigest,
    verifiedAfterPaying: outcome.verificationRequired,
  };
}

/* ---- settling ---- */

export type NovaSettlement = {
  status: NovaResearchStatus;
  investigation: NovaInvestigation;
};

export async function settleResearch(input: {
  publicId: string;
  ownerSecret: string;
  researchId: string;
  authorization: unknown;
  signature: string;
  /** The relay, injectable the way every other boundary in this codebase is.
   *  The three terminal states below differ only in what came back from the
   *  seller, and the two that matter most -- money moved and the answer failed,
   *  money did not move at all -- cannot be reached on purpose against a live
   *  endpoint without either spending or getting lucky. */
  settleImpl?: typeof settleX402Call;
  /** The reading model, injectable the way the relay is: a test must be able to
   *  reach the verified branch without a network and without a bill. */
  generateImpl?: Parameters<typeof readResult>[0]["generate"];
}): Promise<NovaSettlement> {
  const agent = await loadOwned(input.publicId, input.ownerSecret);
  const row = await loadById(agent.agent_id, input.researchId);

  if (row.status !== "approved" || !row.approval) {
    throw new NovaError(
      "That investigation has not been approved, or has already been settled.",
      "not_approved",
      409,
    );
  }

  /* The cleared challenge, read back from this row rather than from the
     request. A page that had substituted one would be relaying a payment Veyra
     never authorised, and every consistency check downstream would pass. */
  const accept = asX402Accept(row.approval.quote.accept);
  if (!accept) throw new NovaError("The cleared payment terms are unreadable.", "accept_invalid", 500);

  const authorization = asTransferAuthorization(input.authorization);
  if (!authorization) {
    throw new NovaError("A complete signed authorization is required.", "authorization_invalid", 400);
  }
  /* The wallet that approved is the wallet that pays. Otherwise a clearance
     issued for one person authorises a signature from another. */
  if (
    !row.payer_wallet
    || authorization.from.toLowerCase() !== row.payer_wallet.toLowerCase()
  ) {
    throw new NovaError(
      "That signature is from a different wallet than the one this was cleared for.",
      "wallet_mismatch",
      409,
    );
  }

  /* The quote the approval step wrote, and nothing else.
   *
   * Every field that used to be passed here -- the endpoint, the method, the
   * accept, the descriptor, the tier, the selection, the clearance, the
   * counterparty, the capability -- is read by settle from the quote and the
   * decision it is bound to. Nova had been careful about them and stored them
   * honestly on its own row; the point is that being careful was the only thing
   * standing between a caller and a payment Veyra never decided on, and care is
   * not a mechanism. The tier in particular now comes from the decision
   * re-taken at approval, which is where Nova was already reading it from. */
  const quoteId = typeof row.approval?.quote?.quoteId === "string" ? row.approval.quote.quoteId : "";
  if (!quoteId) {
    throw new NovaError(
      "This approval predates Veyra's quote records and cannot be paid. Ask for a fresh look.",
      "quote_missing",
      409,
    );
  }
  const relay = input.settleImpl ?? settleX402Call;
  const outcome = await relay({
    quoteId,
    ownerWallet: getAddress(row.payer_wallet),
    requestBody: row.request_body,
    authorization,
    signature: signature(input.signature),
  });

  if (outcome.kind === "refused") {
    return finish(row, {
      status: "unpaid",
      failure: outcome.message,
    });
  }

  if (outcome.kind === "payment_rejected") {
    /* The seller said why, in its own words, and those words were being thrown
       away. "The endpoint rejected the signed payment" is true and useless: it
       cost an hour of forensics against the chain to learn what one line of the
       response already said. It is kept and shown now, including the raw body,
       because a refusal nobody can act on is a dead end with a receipt.

       "unpaid" is what a refusal usually means and not what it always means. A
       seller can redeem the authorization and still answer 402, and the ledger
       now grades the refusal against the token rather than the answer -- so
       this reads the graded state instead of assuming the generous one. Saying
       "unpaid" about money that is gone is the one mistake here that costs
       somebody something. */
    const moneyLeft = outcome.executionState === "SETTLED_SERVICE_FAILED";
    const unresolved = outcome.executionState === "SETTLEMENT_UNVERIFIED";
    return finish(row, {
      status: moneyLeft || unresolved ? "paid_unverified" : "unpaid",
      executionPublicId: outcome.executionId,
      paidUsdc: outcome.paidUsdc,
      result: outcome.body || null,
      failure: `${outcome.message} ${sellerReason(outcome.body)}`.trim(),
    });
  }

  const settled = outcome.result;
  const verification = {
    verdict: settled.verification.verdict,
    summary: settled.verification.summary,
    /* Kept because Arc commits to it. The registry records a hash of what came
       back, and a hash Veyra cannot re-derive from its own row is a commitment
       nobody can check later -- which is the opposite of what a proof is for. */
    responseHash: settled.verification.responseHash,
  };
  /* Two facts, kept apart. `paid` is what the seller receipted; `settled` folds
     in the verification verdict. Money can move and the answer still fail, and
     that row must not be filed as a completed investigation. */
  const moneyMoved = settled.paid === true || settled.paidUsdc > 0;

  if (settled.settled) {
    /* Only here. A reading of something that failed its check would be a model
       explaining material Veyra just said could not be trusted, printed in the
       same place a reader looks for what they bought. */
    const reading = await readResult({
      agentName: agent.name,
      interests: agent.interests ?? [],
      memory: await recentLearnings(agent.agent_id),
      question: row.question,
      provider: row.terms.provider,
      resource: row.terms.resource,
      paidUsdc: settled.paidUsdc,
      verdict: verification.verdict,
      verificationSummary: verification.summary,
      executionPublicId: settled.executionId,
      transaction: settled.transaction,
      result: settled.result ?? settled.body,
      generate: input.generateImpl,
    }).catch(() => null);

    /* And it goes on Arc. Until now a verified purchase existed only in
       Postgres, where Veyra is the only witness -- the one arrangement a trust
       product cannot defend, since the party making the claim also owns the
       record. Written after the reading and before the row is closed, so a
       chain that is down costs nothing but the proof. */
    const arcProof = await recordPurchaseOnArc({
      executionPublicId: settled.executionId ?? row.research_id,
      resource: row.terms.resource,
      buyer: row.payer_wallet ?? "",
      seller: row.terms.payTo,
      amountAtomic: BigInt(Math.round(settled.paidUsdc * 1_000_000)),
      requestHash: novaRequestHash({
        method: row.request_method ?? "POST",
        resource: row.terms.resource,
        body: row.request_body,
      }),
      responseHash: settled.verification.responseHash,
    }).catch(() => null);

    return finish(row, {
      status: "verified",
      executionPublicId: settled.executionId,
      paidUsdc: settled.paidUsdc,
      transaction: settled.transaction,
      verification,
      result: settled.result ?? settled.body,
      reading,
      arcProof,
    });
  }

  return finish(row, {
    status: moneyMoved ? "paid_unverified" : "unpaid",
    executionPublicId: settled.executionId,
    paidUsdc: moneyMoved ? settled.paidUsdc : 0,
    transaction: settled.transaction,
    verification,
    result: settled.result ?? settled.body,
    /* The seller's own words, on the branch where they matter most. A refused
       payment already carried them; a *successful* payment followed by a
       failed delivery did not, which is the one case where the money is gone
       and the reader has to decide what to do about it. */
    failure: moneyMoved
      ? `The payment went through and the answer did not pass ${"Veyra"}'s check: ${settled.verification.summary} ${sellerReason(settled.result ?? settled.body)}`.trim()
      : `${settled.verification.summary || "The endpoint did not answer with a usable result."} ${sellerReason(settled.result ?? settled.body)}`.trim(),
  });
}

/**
 * What this agent has already learned about its owner, as plain sentences.
 *
 * The context is what makes a reading Nova's rather than anyone else's. One
 * model serves every agent; individuality comes from these interests, this
 * memory and this history, not from a model of its own. A failure to read it is
 * not a failure to buy, so it falls back to knowing nothing in particular.
 */
export async function recentLearnings(agentId: string): Promise<string[]> {
  try {
    const { data } = await db()
      .from("nova_memory")
      .select("summary")
      .eq("agent_id", agentId)
      .order("updated_at", { ascending: false })
      .limit(8);
    return ((data ?? []) as Array<{ summary?: unknown }>)
      .map((row) => (typeof row.summary === "string" ? row.summary.trim() : ""))
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * What the seller actually said, in a sentence.
 *
 * x402 sellers answer a refused payment with a JSON body carrying their own
 * error and reason. Neither is written for a reader, so the raw body is stored
 * whole and this pulls out the part worth putting on a card.
 */
function sellerReason(body: unknown): string {
  if (body === null || body === undefined) return "";
  let parsed: unknown = body;
  if (typeof body === "string") {
    if (!body.trim()) return "";
    try { parsed = JSON.parse(body); } catch { return `The endpoint said: ${body.slice(0, 200)}`; }
  }
  if (!parsed || typeof parsed !== "object") return "";
  const record = parsed as Record<string, unknown>;
  /* `detail` is FastAPI's field, and fal.ai answers through it. Reading only
     `error` and `message` threw away "User is locked. Reason: Exhausted
     balance." -- a seller telling us, in one sentence, that it had taken the
     payment and could not deliver because its own upstream account was empty.
     That sentence is the whole explanation of the charge, and the card showed
     the reader a check id instead. */
  for (const key of ["error", "message", "detail", "reason"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return `The endpoint said: ${value.slice(0, 300)}`;
    }
  }
  return "";
}

function signature(value: string): `0x${string}` {
  return (typeof value === "string" ? value : "0x") as `0x${string}`;
}

/**
 * Writes the terminal state, and -- only for a verified one -- the learning.
 *
 * `nova_memory` is what a person reads as "what Nova knows about you", and a
 * learning carries the execution it came from. That is the difference between a
 * claim and a receipt, which is why nothing writes one without an execution id
 * and a verification that passed.
 */
async function finish(row: ResearchRow, outcome: {
  status: NovaResearchStatus;
  executionPublicId?: string | null;
  paidUsdc?: number | null;
  transaction?: string | null;
  verification?: { verdict: string; summary: string; responseHash?: string } | null;
  result?: unknown;
  failure?: string | null;
  /** Written only for a verified result, and only if a model answered. */
  reading?: NovaReading | null;
  /** Where Arc recorded it, when Arc could be reached. */
  arcProof?: NovaArcProof | null;
}): Promise<NovaSettlement> {
  const now = new Date().toISOString();
  const { data } = await db()
    .from("nova_research")
    .update({
      status: outcome.status,
      execution_public_id: outcome.executionPublicId ?? null,
      paid_usdc: outcome.paidUsdc ?? null,
      transaction_hash: outcome.transaction ?? null,
      verification: outcome.verification ?? null,
      arc_proof: outcome.arcProof ?? null,
      result: outcome.result ?? null,
      reading: outcome.reading ?? null,
      failure: outcome.failure ? outcome.failure.slice(0, 600) : null,
      settled_at: now,
      updated_at: now,
    })
    .eq("research_id", row.research_id)
    .select(ROW_COLUMNS)
    .maybeSingle();

  const updated = (data as ResearchRow | null) ?? row;

  /* Only a verified result marks the signal, and it marks it with both facts at
     once. The brief counts Veyra decisions off this column, so filing a payment
     whose answer failed its check -- or one the seller refused outright --
     would inflate a number a person reads as "things Veyra saw through".
     Nothing is lost by leaving it off: the money, the execution and the
     transaction are all on the nova_research row either way, which is where an
     account of what was spent belongs. */
  const signalUpdate: Record<string, unknown> = { updated_at: now };
  if (outcome.status === "verified") {
    signalUpdate.status = "investigated";
    if (outcome.executionPublicId) signalUpdate.execution_public_id = outcome.executionPublicId;
  }
  await db()
    .from("nova_signals")
    .update(signalUpdate)
    .eq("agent_id", row.agent_id)
    .eq("signal_id", row.signal_id);

  if (outcome.status === "verified" && outcome.executionPublicId) {
    await db().from("nova_memory").insert({
      agent_id: row.agent_id,
      kind: "learning",
      facet: "verified_research",
      summary: learningSummary(row, outcome.paidUsdc ?? 0),
      evidence: {
        researchId: row.research_id,
        provider: row.terms.provider,
        resource: row.terms.resource,
        capability: row.terms.capability,
        costUsdc: outcome.paidUsdc ?? 0,
        verdict: outcome.verification?.verdict ?? "PASS",
        transaction: outcome.transaction ?? null,
      },
      signal_id: row.signal_id,
      execution_public_id: outcome.executionPublicId,
      support_count: 1,
    });
  }

  return { status: outcome.status, investigation: toInvestigation(updated) };
}

/** What the memory list says about a paid answer. Factual on purpose: nothing
 *  here summarises the content, because nothing here has read it. */
function learningSummary(row: ResearchRow, paidUsdc: number): string {
  return `${row.question} — answered by ${row.terms.provider} for $${paidUsdc.toFixed(4)}, checked against what that endpoint declares it returns.`
    .slice(0, 600);
}

/* ---- reading ---- */

/** Every investigation attached to this agent's current brief, so a result
 *  appears under the card that produced it after a reload rather than only in
 *  the session that paid for it. */
export async function investigationsFor(agentId: string): Promise<NovaInvestigation[]> {
  const { data } = await db()
    .from("nova_research")
    .select(ROW_COLUMNS)
    .eq("agent_id", agentId)
    .order("created_at", { ascending: false })
    .limit(60);
  return ((data ?? []) as ResearchRow[]).map(toInvestigation);
}

export { hashTerms };
