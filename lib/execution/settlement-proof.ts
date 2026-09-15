/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Where the claim that money moved actually comes from.
 *
 * Veyra recorded settled purchases on the strength of a header the seller
 * wrote. The browser path read `settlement.success` out of the response; the
 * server adapter declared economicSettled the moment that response contained
 * something shaped like a transaction hash. Both went on to COMPLETED, to a
 * spend figure, and to reputation evidence about the seller -- computed from
 * the seller's own account of itself.
 *
 * For most sellers that account is true. The problem is that a product whose
 * entire subject is counterparty risk cannot have its strongest economic claim
 * rest on the counterparty, and cannot tell a reader which of the two it has.
 *
 * So the claim is graded and the grade is kept. Nothing here refuses a
 * purchase: a seller-reported settlement is still a settlement, still spends
 * budget, and still closes the attempt. What it no longer does is silently
 * become evidence of the same weight as a fact read off the chain.
 */
export type SettlementProof =
  /** Nobody said anything. The response that would have carried a receipt never
   *  arrived, and the rail this purchase used cannot be asked after the fact --
   *  Circle's batched settlement nets many purchases into one transaction and
   *  publishes no per-authorization status. The spend is booked because a
   *  budget that under-counts what may have left is a broken promise, and the
   *  grade says plainly that nothing corroborates it. */
  | "presumed_spent"
  /** The endpoint said so. Nothing else was checked. */
  | "seller_reported"
  /** Acknowledged with no onchain reference yet, which is what a batched
   *  Gateway settlement looks like until the batch lands. Stronger than a bare
   *  claim -- the facilitator accepted the authorization -- and weaker than a
   *  spent nonce. */
  | "facilitator_accepted"
  /** The chain agrees: the authorization nonce is spent, or a receipt binds a
   *  transfer to it. This is the only level that is evidence about a seller
   *  rather than evidence from one. */
  | "onchain_final";

/** Ranked, so a later check can only ever raise the grade. */
const RANK: Record<SettlementProof, number> = {
  presumed_spent: -1,
  seller_reported: 0,
  facilitator_accepted: 1,
  onchain_final: 2,
};

export function strongerProof(a: SettlementProof, b: SettlementProof): SettlementProof {
  return RANK[a] >= RANK[b] ? a : b;
}

/**
 * Whether a settlement at this level may become reputation evidence.
 *
 * Reputation is the output of this whole system and the thing other people's
 * money will be routed by. Feeding it a seller's own word makes the score a
 * measure of what sellers say -- and the sellers with the most to gain from
 * saying it are exactly the ones the score exists to catch.
 */
export function provesEconomicEvidence(proof: SettlementProof | null | undefined): boolean {
  return proof === "onchain_final";
}

/**
 * The grade for an x402 response, before anything is asked of the chain.
 *
 * A transaction reference in the receipt is still the seller's claim -- it is a
 * string in a header it wrote -- so it does not reach onchain_final here. It is
 * raised to that only by {@link strongerProof} once something has actually been
 * read from the chain.
 */
export function proofFromReceipt(input: {
  settlementSuccess: boolean | null | undefined;
  transaction: string | null | undefined;
  batched?: boolean;
}): SettlementProof {
  if (input.transaction) return "seller_reported";
  /* No reference and an acknowledgement is the batched shape: Gateway settles
     on a schedule, so the absence of a hash is expected rather than evasive. */
  if (input.batched && input.settlementSuccess === true) return "facilitator_accepted";
  return "seller_reported";
}
