/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import type { PublicMaterial } from "./value.ts";

/**
 * What a paid tool is, said before anybody pays for it.
 *
 * Roadmap item 4 asks a proposal to show the unresolved question, the expected
 * incremental result, why public information is not enough, the exact quoted
 * price and the provider's limitations. The first four were on the card. The
 * last was not, and on the live market it decides whether the purchase makes
 * sense at all. On 2026-09-23 every tool Nova could ask, across three
 * discovery queries, took the question in a search field: Exa search, Tavily
 * and Serper through Orthogonal, Parallel search. So the owner would pay for
 * the pages that match their words, while the card above the price read
 * "Requested result: a list of wallets with Arc Testnet paymaster support".
 */

/** Input fields that take search text rather than a question to be answered. */
const SEARCH_FIELDS = new Set(["q", "query", "search", "searchquery", "term", "terms", "keywords"]);

export function isSearchField(field: string | null | undefined): boolean {
  return typeof field === "string" && SEARCH_FIELDS.has(field.toLowerCase());
}

/** "a, b and c", or "a, b, c, d and more" past `most`. */
const listed = (names: string[], most = 4) =>
  names.length > most
    ? `${names.slice(0, most).join(", ")} and more`
    : names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/**
 * What comes back, from the tool's own published output shape, in a sentence.
 * Null when it publishes none, which is itself something the card says.
 */
export function describeReturns(outputSchema: Record<string, unknown> | null | undefined): string | null {
  const properties = outputSchema && typeof outputSchema === "object"
    ? (outputSchema as { properties?: unknown }).properties
    : null;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return null;
  const fields = properties as Record<string, { type?: unknown; items?: { properties?: unknown } } | undefined>;
  const names = Object.keys(fields);
  if (!names.length) return null;
  const list = names.find((name) => fields[name]?.type === "array");
  if (!list) return `An object with ${listed(names, 5)}.`;
  const itemProperties = fields[list]?.items?.properties;
  const itemFields = itemProperties && typeof itemProperties === "object" ? Object.keys(itemProperties) : [];
  if (itemFields.length) {
    return `A list of ${list}, each with ${listed(itemFields)}.`;
  }
  const others = names.filter((name) => name !== list);
  return `A list of ${list}${others.length ? `, alongside ${listed(others)}` : ""}.`;
}

/**
 * The public sources a reading stood on: what Nova checked, for nothing,
 * before it looked for anything to pay. The gate that requires a fresh,
 * significant reading with an open question existed; the card never said what
 * that reading had read.
 */
export function checkedFirst(sources: Array<Pick<PublicMaterial, "title" | "url">>): Array<{ title: string; url: string }> {
  const seen = new Set<string>();
  const checked: Array<{ title: string; url: string }> = [];
  for (const source of sources) {
    if (!source.url || seen.has(source.url) || !/^https:\/\//i.test(source.url)) continue;
    seen.add(source.url);
    checked.push({ title: source.title || source.url, url: source.url });
  }
  return checked.slice(0, 6);
}

/**
 * What this tool cannot do, or cannot be checked for, each in a sentence.
 * Kept apart from the reasons it was chosen: a list printed with a tick beside
 * every line had "Differs from its listing" ticked like a virtue.
 */
export function toolLimitations(input: {
  sentAs: string | null;
  outputSchema: Record<string, unknown> | null | undefined;
  catalogDrift?: string[];
  respondedWith402?: boolean | null;
}): string[] {
  const limitations: string[] = [];
  if (isSearchField(input.sentAs)) {
    limitations.push(`It takes your question as search text, in its "${input.sentAs}" field. What comes back is what it finds for those words, not an answer written to your question.`);
  }
  if (!describeReturns(input.outputSchema)) {
    limitations.push("It publishes no shape for its answer, so after paying Veyra can check that an answer arrived and is not an error, and nothing about what is in it.");
  }
  if (input.catalogDrift?.length) {
    limitations.push(`Its live terms differ from its catalogue listing: ${input.catalogDrift.join(", ")}.`);
  }
  if (input.respondedWith402 === false) {
    limitations.push("When Veyra probed it, it answered without a payment challenge.");
  }
  limitations.push("Its trust score is a live check of its payment terms, not a record of how good its answers are.");
  return limitations;
}

/**
 * Why a tool that did not ask to be paid was passed over.
 *
 * Anything but a 402 used to read "it answers without charging", and that
 * included a 404 and a 500. An error is not a free answer, and a free answer
 * that Nova throws away should say that it is throwing it away.
 */
export function unpricedNote(status: number): string {
  return status >= 200 && status < 300
    ? `it answered without asking for payment (HTTP ${status}), and Nova does not yet use unpaid answers from the market, so there is nothing here to authorise.`
    : `it answered HTTP ${status} instead of a price, so there is nothing here to authorise.`;
}
