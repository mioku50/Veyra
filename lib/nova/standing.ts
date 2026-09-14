/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import type { NovaInvestigation } from "./types.ts";

/**
 * What Nova has actually been through, counted from its own money.
 *
 * Standing used to be three numbers read off proxies -- learning rows, signals
 * carrying an execution id, signals marked investigated -- and a single
 * verified purchase moved all three to 1. Three counters that rise together are
 * not three facts; they are one fact printed three times, and a page that shows
 * them side by side is padding a history rather than reporting one.
 *
 * So it is derived from the settled purchases themselves, which is where the
 * evidence was the whole time: what was spent, what passed the delivery check,
 * what took money and failed anyway, what asked for a signature and moved
 * nothing, and which of it is attested on Arc.
 *
 * The per-counterparty record is the part that earns its place. It is the only
 * thing here that can change a decision: before signing again, the person sees
 * what happened the last time this agent paid this seller -- bought with their
 * own money, not inferred from a catalogue.
 *
 * One rule runs through all of it. A record is not a rate. With one attempt
 * behind it there is nothing to average, and rendering "0% success" over a
 * single bad morning would be the screen inventing a confidence nobody has.
 * Counts are reported as counts until there are enough of them to mean
 * anything, and the language says which.
 */

export type NovaProviderRecord = {
  provider: string;
  /** Settled attempts: everything that reached a payment decision. */
  attempts: number;
  /** Attempts where money actually moved. */
  paid: number;
  spentUsdc: number;
  /** Paid, delivered, and through the delivery check. */
  passed: number;
  /** Paid, and the answer did not hold up. */
  failedAfterPaying: number;
  /** Signed for, and nothing moved -- a refused or rejected payment. */
  nothingMoved: number;
  lastAt: string | null;
};

export type NovaDerivedStanding = {
  /** Purchases that passed their delivery check. */
  verifiedResearch: number;
  /** Every settled attempt Veyra decided on, paid or not. */
  veyraDecisions: number;
  /** Attempts where money actually moved. The middle of the funnel: an
   *  attempt is a decision, a payment is an exposure, and a pass is a result --
   *  three different things, and the old standing collapsed them into one. */
  observedOutcomes: number;
  readyForArcIdentity: boolean;
  spentUsdc: number;
  /** Purchases with an attestation recorded on Arc. */
  attestedOnArc: number;
  /** Newest first, and only counterparties this agent has actually paid. */
  providers: NovaProviderRecord[];
};

const SETTLED = new Set(["verified", "paid_unverified", "unpaid"]);

/**
 * Enough attempts for a share to mean something.
 *
 * Below this the record is reported as "once" or "twice" and what happened,
 * never as a proportion. Three is not a statistical claim; it is the point
 * where "every time so far" stops describing a coincidence.
 */
export const RATE_NEEDS_ATTEMPTS = 3;

export function standingFrom(investigations: NovaInvestigation[]): NovaDerivedStanding {
  const settled = investigations.filter((entry) => SETTLED.has(entry.status));

  const verifiedResearch = settled.filter((entry) => entry.status === "verified").length;
  const spentUsdc = settled.reduce((total, entry) => total + (entry.paidUsdc ?? 0), 0);
  const attestedOnArc = settled.filter((entry) => entry.arcProof).length;

  const byProvider = new Map<string, NovaProviderRecord>();
  for (const entry of settled) {
    const provider = entry.provider?.trim() || "an unnamed endpoint";
    const record = byProvider.get(provider) ?? {
      provider,
      attempts: 0,
      paid: 0,
      spentUsdc: 0,
      passed: 0,
      failedAfterPaying: 0,
      nothingMoved: 0,
      lastAt: null,
    };
    record.attempts += 1;
    const paid = entry.paidUsdc ?? 0;
    if (paid > 0) {
      record.paid += 1;
      record.spentUsdc += paid;
      if (entry.status === "verified") record.passed += 1;
      else record.failedAfterPaying += 1;
    } else {
      record.nothingMoved += 1;
    }
    if (entry.settledAt && (!record.lastAt || entry.settledAt > record.lastAt)) {
      record.lastAt = entry.settledAt;
    }
    byProvider.set(provider, record);
  }

  const providers = [...byProvider.values()]
    .sort((left, right) => (right.lastAt ?? "").localeCompare(left.lastAt ?? ""));

  return {
    verifiedResearch,
    veyraDecisions: settled.length,
    /* Not "has a verdict": a refused payment has one too, and counting those
       would make this the same number as veyraDecisions. What is distinct and
       worth a row is how often money actually left the wallet. */
    observedOutcomes: settled.filter((entry) => (entry.paidUsdc ?? 0) > 0).length,
    /* "Becomes one by doing things that can be checked" has to mean evidence
       that survives outside Veyra, or it is a badge Veyra grants itself off its
       own bookkeeping. Arc is not a second opinion: it does not re-run the
       delivery check and it does not second the verdict, which stays Veyra's.
       What it adds is that the claim becomes public, tamper-evident and
       readable by a stranger without asking us -- and it carries the request
       and response hashes, so anyone holding the artifact can test it against
       what was recorded. A verified purchase is the work; the attestation is
       the part somebody else can read; only both together are a history an
       identity can point at.

       The first Nova was minted under the weaker rule, one purchase with a
       delivery PASS, and its attestation landed a minute later -- so the end
       state is right and nothing is being taken back. The rule is tightened
       for everyone after it. */
    readyForArcIdentity: verifiedResearch >= 1 && attestedOnArc >= 1,
    spentUsdc,
    attestedOnArc,
    providers,
  };
}

/**
 * What happened last time this agent paid this counterparty, in one sentence.
 *
 * Shown before a signature, which is the only moment it can change anything.
 * Null when there is no history, because "no history" is already what a card
 * with no such line says, and writing it out would make every first encounter
 * look like a warning.
 */
export function priorWith(
  standing: NovaDerivedStanding,
  provider: string | null,
): { tone: "good" | "warn" | "idle"; sentence: string } | null {
  const record = standing.providers.find(
    (entry) => entry.provider.toLowerCase() === (provider ?? "").trim().toLowerCase(),
  );
  if (!record || record.attempts === 0) return null;

  const times = record.attempts === 1 ? "once" : record.attempts === 2 ? "twice" : `${record.attempts} times`;

  if (record.paid === 0) {
    return {
      tone: "idle",
      sentence: `You signed for ${record.provider} ${times} before and nothing moved either way.`,
    };
  }
  if (record.passed === record.paid) {
    return {
      tone: "good",
      sentence: record.attempts < RATE_NEEDS_ATTEMPTS
        ? `You paid ${record.provider} ${times} before, and the answer passed its check.`
        : `You have paid ${record.provider} ${times}, and every answer passed its check.`,
    };
  }
  if (record.passed === 0) {
    return {
      tone: "warn",
      sentence: `You paid ${record.provider} ${times} before and the answer did not pass its check.`,
    };
  }
  return {
    tone: "warn",
    sentence: `You have paid ${record.provider} ${times}: ${record.passed} passed the check, ${record.failedAfterPaying} did not.`,
  };
}
