/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from "node:crypto";

/**
 * The seven facts a person is actually agreeing to.
 *
 * A brief is read at breakfast and acted on at lunch. In between, a catalogue
 * entry can be re-listed, a price can move, and a payee address can change --
 * that last one is a signal Nova already raises on its own, which is precisely
 * why it must never be something a stale card can walk somebody past.
 *
 * So the card's numbers are recorded, and the moment before a wallet opens they
 * are measured again and compared. Anything different stops the payment. Not
 * "re-routes to the new best option": stops, says what changed, and waits. A
 * product that silently substitutes what you are buying after you have decided
 * to buy it has not saved you a click, it has spent your money on something you
 * did not choose.
 */
export type NovaResearchTerms = {
  provider: string;
  resource: string;
  capability: string;
  /** Atomic USDC, as a decimal string. Compared as text on purpose: a float
   *  comparison of 0.0070 against 0.007000000000000001 is a bug waiting for a
   *  provider that prices in thirds. */
  priceAtomic: string;
  /** Lowercased. An address that differs only in checksum case is the same
   *  address, and reporting it as a changed payee would cry wolf about the one
   *  signal that must never be ignored. */
  payTo: string;
  network: string;
  funding: "wallet" | "gateway_deposit";
};

export type TermsChange = {
  field: keyof NovaResearchTerms;
  label: string;
  was: string;
  now: string;
};

const FIELD_LABEL: Record<keyof NovaResearchTerms, string> = {
  provider: "Provider",
  resource: "Endpoint",
  capability: "Capability",
  priceAtomic: "Price",
  payTo: "Payee",
  network: "Network",
  funding: "Payment rail",
};

const FIELD_ORDER: (keyof NovaResearchTerms)[] = [
  // Money first. Somebody scanning a list of changes should meet the ones that
  // decide whether to walk away before the ones that decide nothing.
  "priceAtomic",
  "payTo",
  "provider",
  "resource",
  "network",
  "funding",
  "capability",
];

export function usdcFromAtomic(atomic: string): number {
  const parsed = Number(atomic);
  return Number.isFinite(parsed) ? parsed / 1e6 : 0;
}

function displayValue(field: keyof NovaResearchTerms, value: string): string {
  if (field === "priceAtomic") return `$${usdcFromAtomic(value).toFixed(4)}`;
  if (field === "funding") return value === "wallet" ? "Direct USDC" : "Circle Gateway deposit";
  return value;
}

export function normaliseTerms(terms: NovaResearchTerms): NovaResearchTerms {
  return {
    provider: terms.provider.trim(),
    resource: terms.resource.trim(),
    capability: terms.capability.trim().toLowerCase(),
    priceAtomic: String(terms.priceAtomic),
    payTo: terms.payTo.trim().toLowerCase(),
    network: terms.network.trim().toLowerCase(),
    funding: terms.funding,
  };
}

/**
 * A fingerprint of exactly what was on screen.
 *
 * The re-confirmation carries this back. Without it, "the user confirmed the
 * new price" means "the user pressed a button at some point", and a price that
 * moved twice would be approved by a click that only ever saw the first move.
 */
export function hashTerms(terms: NovaResearchTerms): string {
  const canonical = normaliseTerms(terms);
  const ordered = FIELD_ORDER.map((field) => `${field}=${canonical[field]}`).join("\n");
  return `0x${createHash("sha256").update(ordered).digest("hex")}`;
}

export function compareTerms(shown: NovaResearchTerms, live: NovaResearchTerms): TermsChange[] {
  const before = normaliseTerms(shown);
  const after = normaliseTerms(live);
  const changes: TermsChange[] = [];
  for (const field of FIELD_ORDER) {
    if (before[field] === after[field]) continue;
    changes.push({
      field,
      label: FIELD_LABEL[field],
      was: displayValue(field, before[field]),
      now: displayValue(field, after[field]),
    });
  }
  return changes;
}

/** What the card shows for a set of terms, so the changed ones can be rendered
 *  in the same words as the originals. */
export function describeTerms(terms: NovaResearchTerms): Record<keyof NovaResearchTerms, string> {
  const canonical = normaliseTerms(terms);
  return Object.fromEntries(
    FIELD_ORDER.map((field) => [field, displayValue(field, canonical[field])]),
  ) as Record<keyof NovaResearchTerms, string>;
}
