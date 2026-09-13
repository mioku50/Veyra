/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Which rail a counterparty is paid on, and whether this buyer can use it.
 *
 * x402 has two settlement rails and they are not interchangeable for the person
 * holding the wallet:
 *
 *   wallet           a vanilla EIP-3009 authorization, domain-separated by the
 *                    USDC contract itself. It spends the balance the wallet
 *                    already shows, and wallets simulate it without complaint.
 *
 *   gateway_deposit  Circle's batched scheme, domain-separated by the Gateway
 *                    contract rather than the token. It spends a deposit held
 *                    in Circle's GatewayWallet — a wallet full of USDC is still
 *                    refused — and because the authorization is bound to a
 *                    contract that is not the token, wallet simulators cannot
 *                    evaluate it and warn on it.
 *
 * Measured against Circle's live catalog: 289 of 389 resources publish the
 * vanilla rail, 74 the batched one, and none publish both. The rail is a
 * property of the endpoint, not a setting a buyer can change.
 *
 * This is deliberately kept out of the trust score. Whether an endpoint is
 * trustworthy and whether this wallet can pay it are different questions, and
 * folding the second into the first would make a well-evidenced seller look
 * untrustworthy because the buyer had not made a deposit. Ranking stays on
 * evidence; the router below chooses among ranked candidates and says out loud
 * when it passed over a higher-ranked one.
 */

export type PaymentFunding = "wallet" | "gateway_deposit";

export function fundingForAccept(accept: { gatewayBatched?: boolean } | null | undefined): PaymentFunding {
  return accept?.gatewayBatched ? "gateway_deposit" : "wallet";
}

export type RailReadiness = {
  /** True when the buyer can pay this rail right now, false when they cannot,
   *  null when it could not be established — which is never treated as "no". */
  payableNow: boolean | null;
  reason: string;
};

/**
 * Whether this buyer can settle on a candidate's rail without setting something
 * up first.
 *
 * `gatewayFundedAtomic` is null when the deposit could not be read. An unknown
 * deposit must not demote a candidate: telling someone their Gateway balance is
 * empty because Circle timed out would route them away from the endpoint they
 * were already able to pay.
 */
export function railReadiness(input: {
  funding: PaymentFunding;
  priceAtomic: bigint;
  gatewayFundedAtomic: bigint | null;
}): RailReadiness {
  if (input.funding === "wallet") {
    return {
      payableNow: true,
      reason: "Paid straight from the wallet balance.",
    };
  }
  if (input.gatewayFundedAtomic === null) {
    return {
      payableNow: null,
      reason: "Settles through a Circle Gateway deposit; that balance could not be read.",
    };
  }
  const covered = input.gatewayFundedAtomic >= input.priceAtomic;
  return {
    payableNow: covered,
    reason: covered
      ? "Settles through a Circle Gateway deposit, which covers this call."
      : "Settles through a Circle Gateway deposit, which this wallet has not funded.",
  };
}

export type RoutableCandidate = {
  candidateId: string;
  rank: number;
  funding: PaymentFunding;
  priceAtomic: bigint;
  eligible: boolean;
};

export type RouteDecision<T extends RoutableCandidate> = {
  winner: T | null;
  /** The candidate evidence alone would have chosen, when it differs. */
  passedOver: T | null;
  note: string | null;
};

/**
 * Picks the best candidate the buyer can actually pay.
 *
 * The ranking is not re-ordered and not re-weighted. This walks it in order and
 * takes the first candidate whose rail is usable, so a rail the buyer cannot
 * settle on loses only to a candidate that was already eligible on evidence.
 *
 * When nothing is payable the top-ranked candidate is still returned: the
 * honest outcome is "this is the best counterparty and here is what it needs",
 * not a refusal that hides the answer. The Gateway preflight on the purchase
 * screen is what turns that into a deposit the buyer can make.
 */
export function routeToPayableRail<T extends RoutableCandidate>(
  ranked: T[],
  gatewayFundedAtomic: bigint | null,
): RouteDecision<T> {
  const eligible = ranked.filter((candidate) => candidate.eligible);
  const top = eligible[0] ?? ranked[0] ?? null;
  if (!top) return { winner: null, passedOver: null, note: null };

  const readinessOf = (candidate: T) => railReadiness({
    funding: candidate.funding,
    priceAtomic: candidate.priceAtomic,
    gatewayFundedAtomic,
  }).payableNow;

  // Already payable: nothing to route around.
  if (readinessOf(top) !== false) return { winner: top, passedOver: null, note: null };

  const alternative = eligible.find((candidate) =>
    candidate.candidateId !== top.candidateId && readinessOf(candidate) !== false);

  if (!alternative) {
    return {
      winner: top,
      passedOver: null,
      note: "Every candidate here settles through a Circle Gateway deposit, so this one needs funding before it can be paid.",
    };
  }

  return {
    winner: alternative,
    passedOver: top,
    note: `Ranked #${top.rank} settles through a Circle Gateway deposit this wallet has not funded, so the best counterparty payable from the wallet balance was chosen instead.`,
  };
}

/**
 * Stops one seller's endpoint sprawl from filling the whole shortlist.
 *
 * A live "web search" discovery returned nine Orthogonal endpoints priced
 * identically, pushing out a vanilla resource that cost half as much. They tie
 * on capability and price, so the existing sort keeps catalog order and one
 * provider takes every slot — the buyer sees a market of one, on one rail.
 *
 * Order is otherwise preserved exactly: this only defers a provider's later
 * entries, it never promotes anything above a better match.
 */
export function diversifyByProvider<T>(
  candidates: T[],
  keyOf: (candidate: T) => string,
  perProvider: number,
): T[] {
  const kept: T[] = [];
  const deferred: T[] = [];
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    const key = keyOf(candidate);
    const seen = counts.get(key) ?? 0;
    counts.set(key, seen + 1);
    (seen < perProvider ? kept : deferred).push(candidate);
  }
  return [...kept, ...deferred];
}
