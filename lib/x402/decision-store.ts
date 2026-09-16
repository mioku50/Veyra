/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from "node:crypto";
import { getByoaClient } from "../byoa/service.ts";

/**
 * The two envelopes a browser x402 payment must be bound to, and the only code
 * that writes them.
 *
 * Everything policy-bearing about a purchase used to arrive in the settle
 * request body: which decision authorized it, up to what ceiling, whether the
 * tier demanded verification. The server checked the shape of those fields and
 * believed their contents, because marketplace selection is computed in memory
 * and returned -- there was no stored decision to check them against.
 *
 * So there is one now. `recordSelection` is called where the verdict is
 * reached; `createQuote` refuses to write a quote that is not bound to a live
 * one; `claimQuote` lets exactly one settle relay it.
 *
 * Nothing here takes a policy input from a caller. A selection records what the
 * engine decided, and a quote copies its resource and method from the selection
 * rather than from whoever is asking.
 */

export type X402Decision = "ALLOW" | "ALLOW_WITH_LIMITS" | "REQUIRE_EVALUATOR";

export type X402QuoteState =
  | "QUOTED"
  | "CLAIMED"
  | "DISPATCHED"
  | "SETTLED"
  | "SETTLEMENT_UNVERIFIED"
  | "SETTLEMENT_FAILED"
  | "EXPIRED";

export interface X402SelectionRecord {
  selectionId: string;
  tenantKey: string;
  ownerWallet: `0x${string}`;
  requesterAgentId?: string | null;
  candidateId: string;
  resource: string;
  method: "GET" | "POST";
  capability: string;
  payTo: `0x${string}`;
  settlementNetwork: string;
  asset: `0x${string}`;
  maxExposureAtomic: string;
  decision: X402Decision;
  verificationRequired: boolean;
  policyVersion: string;
  evidenceHash?: string | null;
  selectionHash: string;
  /** The digest, which is evidence. Never the signature, which is authority:
   *  only consumeClearance needs one and this rail never calls it. */
  clearanceDigest?: string | null;
  createdAt: string;
  expiresAt: string;
}

/** Everything the live 402 said, as Veyra saw it. Public seller data only. */
export interface X402QuoteChallenge {
  accept: Record<string, unknown>;
  resourceDescriptor?: unknown;
  inputSchema?: unknown;
  outputSchema?: unknown;
}

export interface X402QuoteRecord {
  quoteId: string;
  selectionId: string;
  ownerWallet: `0x${string}`;
  resource: string;
  method: "GET" | "POST";
  requestBodyHash: string;
  amountAtomic: string;
  payTo: `0x${string}`;
  asset: `0x${string}`;
  network: string;
  verifyingContract: `0x${string}`;
  gatewayBatched: boolean;
  paymentRequirementsHash?: string | null;
  authorizationNonce: string;
  /** The live challenge this price came from, kept whole so settle rebuilds
   *  every term -- including the declared output schema the post-call check
   *  measures a delivery against -- instead of taking them back from the
   *  browser. */
  challenge: X402QuoteChallenge;
  state: X402QuoteState;
  executionId?: string | null;
  quotedAt: string;
  expiresAt: string;
}

/* Test doubles, on the same terms as the execution ledger's: only under an
   explicit test flag, so a misconfigured production can never quietly satisfy a
   policy check from process memory. */
const memorySelections = new Map<string, X402SelectionRecord>();
const memoryQuotes = new Map<string, X402QuoteRecord>();

function memoryAllowed(): boolean {
  return process.env.NODE_ENV === "test" && process.env.EXECUTION_ALLOW_MEMORY_STORE === "true";
}

export function clearX402DecisionMemory(): void {
  if (memoryAllowed()) {
    memorySelections.clear();
    memoryQuotes.clear();
  }
}

export function newQuoteId(): string {
  return `vq_${randomBytes(16).toString("hex")}`;
}

/**
 * Records the decision, at the moment it is made.
 *
 * Failure is reported rather than thrown. A selection that could not be stored
 * is still a perfectly good piece of advice to show someone -- what it is not
 * is something a payment may later be authorized against, and the quote route
 * refuses on exactly that ground. The advisory surface keeps working; the
 * paying one stops. That is the correct way round.
 */
export async function recordX402Selection(
  record: X402SelectionRecord,
): Promise<{ stored: boolean; reason?: string }> {
  if (memoryAllowed()) {
    memorySelections.set(record.selectionId, record);
    return { stored: true };
  }
  try {
    const { error } = await getByoaClient().from("x402_selections").insert({
      selection_id: record.selectionId,
      tenant_key: record.tenantKey,
      owner_wallet: record.ownerWallet,
      requester_agent_id: record.requesterAgentId ?? null,
      candidate_id: record.candidateId,
      resource: record.resource,
      method: record.method,
      capability: record.capability,
      pay_to: record.payTo,
      settlement_network: record.settlementNetwork,
      asset: record.asset,
      max_exposure_atomic: record.maxExposureAtomic,
      decision: record.decision,
      verification_required: record.verificationRequired,
      policy_version: record.policyVersion,
      evidence_hash: record.evidenceHash ?? null,
      selection_hash: record.selectionHash,
      clearance_digest: record.clearanceDigest ?? null,
      created_at: record.createdAt,
      expires_at: record.expiresAt,
    });
    if (error) return { stored: false, reason: error.code || "insert_failed" };
    return { stored: true };
  } catch (error) {
    return { stored: false, reason: error instanceof Error ? error.name : "unknown_error" };
  }
}

export async function fetchX402Selection(selectionId: string): Promise<X402SelectionRecord | null> {
  if (memoryAllowed() && memorySelections.has(selectionId)) {
    return memorySelections.get(selectionId) ?? null;
  }
  const { data, error } = await getByoaClient()
    .from("x402_selections")
    .select("*")
    .eq("selection_id", selectionId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    selectionId: data.selection_id,
    tenantKey: data.tenant_key,
    ownerWallet: data.owner_wallet,
    requesterAgentId: data.requester_agent_id,
    candidateId: data.candidate_id,
    resource: data.resource,
    method: data.method,
    capability: data.capability,
    payTo: data.pay_to,
    settlementNetwork: data.settlement_network,
    asset: data.asset,
    maxExposureAtomic: String(data.max_exposure_atomic),
    decision: data.decision,
    verificationRequired: data.verification_required === true,
    policyVersion: data.policy_version,
    evidenceHash: data.evidence_hash,
    selectionHash: data.selection_hash,
    clearanceDigest: data.clearance_digest,
    createdAt: data.created_at,
    expiresAt: data.expires_at,
  };
}

export type CreateQuoteResult =
  | { ok: true; quoteId: string; resource: string; method: "GET" | "POST"; verificationRequired: boolean; decision: X402Decision; expiresAt: string }
  | { ok: false; reason: string };

/**
 * Writes a quote, or explains why the decision does not permit one.
 *
 * Every check lives in `create_x402_quote`, in the same transaction as the
 * insert, so there is no window in which a quote exists unbound and no second
 * implementation of the rules to drift from the first.
 */
export async function createX402Quote(input: {
  selectionId: string;
  ownerWallet: `0x${string}`;
  requestBodyHash: string;
  amountAtomic: string;
  payTo: `0x${string}`;
  asset: `0x${string}`;
  network: string;
  verifyingContract: `0x${string}`;
  gatewayBatched: boolean;
  paymentRequirementsHash?: string | null;
  authorizationNonce: string;
  challenge: X402QuoteChallenge;
  expiresAt: string;
}): Promise<CreateQuoteResult> {
  const quoteId = newQuoteId();

  if (memoryAllowed()) {
    const selection = memorySelections.get(input.selectionId);
    if (!selection) return { ok: false, reason: "SELECTION_NOT_FOUND" };
    if (selection.ownerWallet.toLowerCase() !== input.ownerWallet.toLowerCase()) {
      return { ok: false, reason: "SELECTION_NOT_OWNED" };
    }
    if (Date.parse(selection.expiresAt) <= Date.now()) return { ok: false, reason: "SELECTION_EXPIRED" };
    if (selection.payTo.toLowerCase() !== input.payTo.toLowerCase()) return { ok: false, reason: "PAYEE_NOT_DECIDED" };
    if (selection.asset.toLowerCase() !== input.asset.toLowerCase()) return { ok: false, reason: "ASSET_NOT_DECIDED" };
    if (selection.settlementNetwork !== input.network) return { ok: false, reason: "NETWORK_NOT_DECIDED" };
    if (BigInt(input.amountAtomic) > BigInt(selection.maxExposureAtomic)) {
      return { ok: false, reason: "AMOUNT_ABOVE_DECIDED_CEILING" };
    }
    if (Date.parse(input.expiresAt) > Date.parse(selection.expiresAt)) {
      return { ok: false, reason: "QUOTE_OUTLIVES_SELECTION" };
    }
    memoryQuotes.set(quoteId, {
      quoteId,
      selectionId: input.selectionId,
      ownerWallet: input.ownerWallet,
      resource: selection.resource,
      method: selection.method,
      requestBodyHash: input.requestBodyHash,
      amountAtomic: input.amountAtomic,
      payTo: input.payTo,
      asset: input.asset,
      network: input.network,
      verifyingContract: input.verifyingContract,
      gatewayBatched: input.gatewayBatched,
      paymentRequirementsHash: input.paymentRequirementsHash ?? null,
      authorizationNonce: input.authorizationNonce,
      challenge: input.challenge,
      state: "QUOTED",
      quotedAt: new Date().toISOString(),
      expiresAt: input.expiresAt,
    });
    return {
      ok: true,
      quoteId,
      resource: selection.resource,
      method: selection.method,
      verificationRequired: selection.verificationRequired,
      decision: selection.decision,
      expiresAt: input.expiresAt,
    };
  }

  const { data, error } = await getByoaClient().rpc("create_x402_quote", {
    p_quote_id: quoteId,
    p_selection_id: input.selectionId,
    p_owner_wallet: input.ownerWallet,
    p_request_body_hash: input.requestBodyHash,
    p_amount_atomic: input.amountAtomic,
    p_pay_to: input.payTo,
    p_asset: input.asset,
    p_network: input.network,
    p_verifying_contract: input.verifyingContract,
    p_gateway_batched: input.gatewayBatched,
    p_payment_requirements_hash: input.paymentRequirementsHash ?? null,
    p_authorization_nonce: input.authorizationNonce,
    p_challenge: input.challenge,
    p_expires_at: input.expiresAt,
  });

  if (error) return { ok: false, reason: "QUOTE_STORE_UNAVAILABLE" };
  const result = data as { success?: boolean; reason?: string; resource?: string; method?: "GET" | "POST"; verification_required?: boolean; decision?: X402Decision; expires_at?: string } | null;
  if (!result?.success) return { ok: false, reason: result?.reason || "QUOTE_NOT_CREATED" };
  return {
    ok: true,
    quoteId,
    resource: String(result.resource),
    method: result.method === "GET" ? "GET" : "POST",
    verificationRequired: result.verification_required === true,
    decision: (result.decision ?? "ALLOW_WITH_LIMITS") as X402Decision,
    expiresAt: String(result.expires_at ?? input.expiresAt),
  };
}

export type ClaimQuoteResult =
  | { ok: true; quote: X402QuoteRecord }
  | { ok: false; reason: string; state?: X402QuoteState };

/** Exactly one settle wins a quote. Everyone else is told which state it is in
 *  and relays nothing. */
export async function claimX402Quote(
  quoteId: string,
  ownerWallet: `0x${string}`,
): Promise<ClaimQuoteResult> {
  if (memoryAllowed()) {
    const quote = memoryQuotes.get(quoteId);
    if (!quote) return { ok: false, reason: "QUOTE_NOT_FOUND" };
    if (quote.ownerWallet.toLowerCase() !== ownerWallet.toLowerCase()) {
      return { ok: false, reason: "QUOTE_NOT_OWNED" };
    }
    if (quote.state !== "QUOTED") return { ok: false, reason: "QUOTE_ALREADY_CLAIMED", state: quote.state };
    if (Date.parse(quote.expiresAt) <= Date.now()) {
      memoryQuotes.set(quoteId, { ...quote, state: "EXPIRED" });
      return { ok: false, reason: "QUOTE_EXPIRED" };
    }
    memoryQuotes.set(quoteId, { ...quote, state: "CLAIMED" });
    return { ok: true, quote };
  }

  const { data, error } = await getByoaClient().rpc("claim_x402_quote", {
    p_quote_id: quoteId,
    p_owner_wallet: ownerWallet,
  });
  if (error) return { ok: false, reason: "QUOTE_STORE_UNAVAILABLE" };
  const result = data as { success?: boolean; reason?: string; state?: X402QuoteState; quote?: Record<string, any> } | null;
  if (!result?.success || !result.quote) {
    return { ok: false, reason: result?.reason || "QUOTE_NOT_CLAIMED", state: result?.state };
  }
  const row = result.quote;
  return {
    ok: true,
    quote: {
      quoteId: row.quote_id,
      selectionId: row.selection_id,
      ownerWallet: row.owner_wallet,
      resource: row.resource,
      method: row.method,
      requestBodyHash: row.request_body_hash,
      amountAtomic: String(row.amount_atomic),
      payTo: row.pay_to,
      asset: row.asset,
      network: row.network,
      verifyingContract: row.verifying_contract,
      gatewayBatched: row.gateway_batched === true,
      paymentRequirementsHash: row.payment_requirements_hash,
      authorizationNonce: row.authorization_nonce,
      challenge: row.challenge as X402QuoteChallenge,
      state: "CLAIMED",
      executionId: row.execution_id,
      quotedAt: row.quoted_at,
      expiresAt: row.expires_at,
    },
  };
}

/**
 * Moves a claimed quote along. The only backwards step is CLAIMED to QUOTED,
 * and it is legal exactly once: when the relay is known never to have left --
 * `classifyRelayFailure` saying `not_dispatched`. Anything less certain stays
 * CLAIMED forever, which costs one unusable quote and is the only safe reading
 * after F3: a broken HTTP call is not evidence that no money moved.
 */
/**
 * Which moves exist, checked here as well as in Postgres.
 *
 * Mirrored rather than duplicated by accident: the SQL function is the
 * authority in production, and this is what makes the in-memory double refuse
 * the same things. A test store that accepts a move the real one rejects is
 * worse than no store, because every test passes while the failure waits in
 * production -- the execution ledger learned that with a usage map keyed by
 * mandate alone.
 */
const ALLOWED_QUOTE_MOVES: Record<string, readonly X402QuoteState[]> = {
  /* Back to QUOTED only from CLAIMED, and only for a relay that never left. */
  CLAIMED: ["DISPATCHED", "QUOTED"],
  DISPATCHED: ["SETTLED", "SETTLEMENT_UNVERIFIED", "SETTLEMENT_FAILED"],
};

export async function advanceX402Quote(input: {
  quoteId: string;
  expectedState: X402QuoteState;
  targetState: X402QuoteState;
  executionId?: string | null;
}): Promise<boolean> {
  if (!ALLOWED_QUOTE_MOVES[input.expectedState]?.includes(input.targetState)) return false;
  if (memoryAllowed()) {
    const quote = memoryQuotes.get(input.quoteId);
    if (!quote || quote.state !== input.expectedState) return false;
    memoryQuotes.set(input.quoteId, {
      ...quote,
      state: input.targetState,
      executionId: input.executionId ?? quote.executionId ?? null,
    });
    return true;
  }
  const { data, error } = await getByoaClient().rpc("advance_x402_quote", {
    p_quote_id: input.quoteId,
    p_expected_state: input.expectedState,
    p_target_state: input.targetState,
    p_execution_id: input.executionId ?? null,
  });
  if (error) return false;
  return (data as { success?: boolean } | null)?.success === true;
}

/** For tests and for anything that needs to read a quote back without claiming
 *  it. Never used to authorize: only {@link claimX402Quote} may do that. */
export async function fetchX402Quote(quoteId: string): Promise<X402QuoteRecord | null> {
  if (memoryAllowed() && memoryQuotes.has(quoteId)) {
    return memoryQuotes.get(quoteId) ?? null;
  }
  const { data, error } = await getByoaClient()
    .from("x402_quotes").select("*").eq("quote_id", quoteId).maybeSingle();
  if (error || !data) return null;
  return {
    quoteId: data.quote_id,
    selectionId: data.selection_id,
    ownerWallet: data.owner_wallet,
    resource: data.resource,
    method: data.method,
    requestBodyHash: data.request_body_hash,
    amountAtomic: String(data.amount_atomic),
    payTo: data.pay_to,
    asset: data.asset,
    network: data.network,
    verifyingContract: data.verifying_contract,
    gatewayBatched: data.gateway_batched === true,
    paymentRequirementsHash: data.payment_requirements_hash,
    authorizationNonce: data.authorization_nonce,
    challenge: data.challenge as X402QuoteChallenge,
    state: data.state,
    executionId: data.execution_id,
    quotedAt: data.quoted_at,
    expiresAt: data.expires_at,
  };
}
