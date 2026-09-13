/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import {
  diversifyByProvider,
  fundingForAccept,
  railReadiness,
  routeToPayableRail,
  type RoutableCandidate,
} from "../lib/counterparty-selection/payment-rail.ts";

/* ---- which rail an accept settles on ---- */

assert.equal(fundingForAccept({ gatewayBatched: true }), "gateway_deposit");
assert.equal(fundingForAccept({ gatewayBatched: false }), "wallet");
// An accept that says nothing is vanilla: the batched scheme announces itself.
assert.equal(fundingForAccept({}), "wallet");
assert.equal(fundingForAccept(null), "wallet");

/* ---- can this buyer pay it right now ---- */

const PRICE = BigInt(2_000);

// The wallet rail needs nothing set up, whatever the Gateway balance is.
for (const funded of [null, BigInt(0), BigInt(1_000_000)]) {
  assert.equal(
    railReadiness({ funding: "wallet", priceAtomic: PRICE, gatewayFundedAtomic: funded }).payableNow,
    true,
  );
}

assert.equal(
  railReadiness({ funding: "gateway_deposit", priceAtomic: PRICE, gatewayFundedAtomic: BigInt(0) }).payableNow,
  false,
);
assert.equal(
  railReadiness({ funding: "gateway_deposit", priceAtomic: PRICE, gatewayFundedAtomic: PRICE }).payableNow,
  true,
  "a deposit exactly covering the price is enough",
);
assert.equal(
  railReadiness({ funding: "gateway_deposit", priceAtomic: PRICE, gatewayFundedAtomic: BigInt(1_999) }).payableNow,
  false,
);

/* An unreadable deposit is unknown, never "no". Routing someone away from an
   endpoint they could already pay, because Circle timed out, would be a worse
   error than leaving them on it. */
const unknown = railReadiness({
  funding: "gateway_deposit",
  priceAtomic: PRICE,
  gatewayFundedAtomic: null,
});
assert.equal(unknown.payableNow, null);
assert.match(unknown.reason, /could not be read/);

/* ---- the router ---- */

function candidate(
  id: string,
  rank: number,
  funding: "wallet" | "gateway_deposit",
  priceUsdc: number,
  eligible = true,
): RoutableCandidate {
  return { candidateId: id, rank, funding, priceAtomic: BigInt(Math.round(priceUsdc * 1e6)), eligible };
}

/* The real shape of the failed purchase: Orthogonal ranked first on evidence,
   settles through a Gateway deposit the wallet had never funded, and Exa sat
   below it on the vanilla rail at half the price. */
const live = [
  candidate("orthogonal", 1, "gateway_deposit", 0.002),
  candidate("exa", 2, "wallet", 0.001),
];

const routed = routeToPayableRail(live, BigInt(0));
assert.equal(routed.winner?.candidateId, "exa");
assert.equal(routed.passedOver?.candidateId, "orthogonal");
assert.match(routed.note ?? "", /ranked #1/i);
assert.match(routed.note ?? "", /Gateway deposit/);

// With the deposit funded, the ranking stands and nothing is said about rails.
const funded = routeToPayableRail(live, BigInt(1_000_000));
assert.equal(funded.winner?.candidateId, "orthogonal");
assert.equal(funded.passedOver, null);
assert.equal(funded.note, null);

// An unknown deposit must not reroute either: unknown is not "no".
const unknownDeposit = routeToPayableRail(live, null);
assert.equal(unknownDeposit.winner?.candidateId, "orthogonal");
assert.equal(unknownDeposit.note, null);

/* A rail the buyer cannot settle on loses only to a candidate that was already
   eligible on evidence. An ineligible alternative is not an alternative. */
const onlyIneligibleAlternative = routeToPayableRail([
  candidate("batched", 1, "gateway_deposit", 0.002),
  candidate("refused", 2, "wallet", 0.001, false),
], BigInt(0));
assert.equal(onlyIneligibleAlternative.winner?.candidateId, "batched");
assert.equal(onlyIneligibleAlternative.passedOver, null);
assert.match(onlyIneligibleAlternative.note ?? "", /needs funding/);

/* When nothing is payable the best counterparty is still returned, with what it
   needs said plainly. Hiding the answer would be worse than naming the cost. */
const allBatched = routeToPayableRail([
  candidate("a", 1, "gateway_deposit", 0.002),
  candidate("b", 2, "gateway_deposit", 0.003),
], BigInt(0));
assert.equal(allBatched.winner?.candidateId, "a");
assert.equal(allBatched.passedOver, null);
assert.match(allBatched.note ?? "", /Every candidate/);

// Nothing in, nothing out — and no crash.
assert.deepEqual(routeToPayableRail([], BigInt(0)), { winner: null, passedOver: null, note: null });

/* ---- one seller must not be the whole market ---- */

/* Live "web search" discovery returned nine Orthogonal endpoints at an
   identical price, which filled the shortlist and pushed out a vanilla resource
   costing half as much. */
const sprawl = [
  { id: "exa-contents", provider: "Exa" },
  ...Array.from({ length: 9 }, (_, i) => ({ id: `orthogonal-${i}`, provider: "Orthogonal" })),
  { id: "exa-search", provider: "Exa" },
  { id: "parallel-extract", provider: "Parallel" },
];
const spread = diversifyByProvider(sprawl, (item) => item.provider, 3);

/* Every seller gets its first three before any seller gets its fourth. The tail
   still fills with the deferred entries — deferring is not dropping, and when
   there is nothing else to show, more of one seller beats an empty list. */
const firstFour = spread.findIndex((item, index) =>
  spread.slice(0, index).filter((earlier) => earlier.provider === item.provider).length >= 3);
const others = spread.map((item, index) => ({ ...item, index }))
  .filter((item) => item.provider !== "Orthogonal");
for (const other of others) {
  assert(
    other.index < firstFour,
    `${other.id} must be seen before Orthogonal's fourth endpoint`,
  );
}
assert.equal(
  new Set(spread.slice(0, firstFour).map((item) => item.provider)).size,
  3,
  "the shortlist ahead of the deferred tail is a market, not one seller",
);

// Order is preserved, never re-sorted: the best match still leads.
assert.equal(spread[0].id, "exa-contents");
assert.deepEqual(
  spread.map((item) => item.id).sort(),
  sprawl.map((item) => item.id).sort(),
  "deferring must not drop a candidate",
);

// A single-provider catalog is unchanged rather than truncated.
const solo = Array.from({ length: 5 }, (_, i) => ({ id: `x${i}`, provider: "Only" }));
assert.deepEqual(diversifyByProvider(solo, (item) => item.provider, 3).map((item) => item.id),
  solo.map((item) => item.id));

console.log("[payment-rail-test] passed: rail identified from the accept, an unreadable Gateway deposit treated as unknown rather than empty, the ranking routed but never re-weighted, a passed-over winner reported out loud, and one seller's endpoint sprawl kept from filling the shortlist");
