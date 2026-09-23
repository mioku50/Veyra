/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import assert from "node:assert/strict";
import { checkedFirst, describeReturns, isSearchField, toolLimitations, unpricedNote } from "../lib/nova/tool-card.ts";
import { reasonsFor } from "../lib/nova/research.ts";

/* ---- what comes back, in the tool's own published terms ---- */

/* As the live catalogue published them on 2026-09-23. */
const exaSearch = { type: "object", properties: {
  output: { type: "object" }, context: { type: "string" }, results: { type: "array", items: {} },
  requestId: { type: "string" }, searchType: { type: "string" }, costDollars: { type: "object" },
} };
const parallelSearch = { type: "object", properties: {
  results: { type: "array", items: { type: "object", properties: { url: {}, title: {}, excerpts: {}, publish_date: {} } } },
  warnings: { type: "array" }, search_id: { type: "string" },
} };
assert.equal(describeReturns(exaSearch), "A list of results, alongside output, context, requestId, searchType and more.");
assert.equal(describeReturns(parallelSearch), "A list of results, each with url, title, excerpts and publish_date.");
assert.equal(describeReturns({ type: "object", properties: { price: {}, currency: {} } }), "An object with price and currency.");
assert.equal(describeReturns(null), null, "Tavily and Serper through Orthogonal publish no output shape at all");
assert.equal(describeReturns({ type: "object" }), null);
assert.equal(describeReturns({ properties: [] } as unknown as Record<string, unknown>), null);

/* ---- where the question goes ---- */

for (const field of ["q", "query", "Query", "searchQuery", "keywords"]) assert.ok(isSearchField(field), field);
for (const field of ["question", "prompt", "input", "text", null, undefined]) assert.equal(isSearchField(field), false, String(field));

/* ---- what the tool will not do, kept apart from why it was chosen ---- */

const exa = toolLimitations({ sentAs: "query", outputSchema: exaSearch, catalogDrift: [], respondedWith402: true });
assert.match(exa[0], /^It takes your question as search text, in its "query" field\. What comes back is what it finds for those words, not an answer/,
  "Every tool Nova could ask on the live market was a search: the owner pays for pages, not an answer");
assert.equal(exa.length, 2, "and the score's meaning, and nothing that is not true of it");
assert.match(exa[1], /trust score is a live check of its payment terms, not a record of how good its answers are/);

const orthogonal = toolLimitations({ sentAs: "q", outputSchema: null });
assert.ok(orthogonal.some((l) => /publishes no shape for its answer/.test(l)), "No shape published: the check after paying is delivery, not content");

const asking = toolLimitations({ sentAs: "question", outputSchema: parallelSearch });
assert.ok(!asking.some((l) => /search text/.test(l)), "A field for a question is not a search");
assert.ok(toolLimitations({ sentAs: "query", outputSchema: exaSearch, catalogDrift: ["price_changed"] }).some((l) => /differ from its catalogue listing: price_changed/.test(l)));
assert.ok(toolLimitations({ sentAs: "query", outputSchema: exaSearch, respondedWith402: false }).some((l) => /without a payment challenge/.test(l)));
assert.ok(!toolLimitations({ sentAs: "query", outputSchema: exaSearch, respondedWith402: null }).some((l) => /without a payment challenge/.test(l)),
  "Not probed is not the same as answered without a challenge");

/* Only what speaks for a tool gets a tick. "Differs from its listing" was
   printed with one, beside the price. */
const drifted = reasonsFor({
  probe: { respondedWith402: false, reachable: true, catalogDrift: ["price_changed"], latencyMs: 740 },
  marketplace: { funding: "wallet" },
} as never);
assert.deepEqual(drifted, ["Answered in 0.74s", "Payable from your wallet balance, with no deposit first"]);
const clean = reasonsFor({
  probe: { respondedWith402: true, reachable: true, catalogDrift: [], latencyMs: 740 },
  marketplace: { funding: "gateway_deposit" },
} as never);
assert.deepEqual(clean, ["Answered a valid payment challenge just now", "Live price and payee match the listing", "Answered in 0.74s"]);

/* ---- free first, shown ---- */

assert.deepEqual(checkedFirst([
  { title: "Sponsored Transactions on Arc with USDC as Gas", url: "https://www.arc.io/blog/sponsored" },
  { title: "Arc network connection reference", url: "https://docs.arc.io/arc/references/connect-to-arc.md" },
  { title: "again", url: "https://www.arc.io/blog/sponsored" },
  { title: "", url: "https://developers.circle.com/gateway-nanopayments/supported-networks.md" },
  { title: "not a link", url: "javascript:alert(1)" },
]), [
  { title: "Sponsored Transactions on Arc with USDC as Gas", url: "https://www.arc.io/blog/sponsored" },
  { title: "Arc network connection reference", url: "https://docs.arc.io/arc/references/connect-to-arc.md" },
  { title: "https://developers.circle.com/gateway-nanopayments/supported-networks.md", url: "https://developers.circle.com/gateway-nanopayments/supported-networks.md" },
]);

/* An error is not a free answer, and a free answer thrown away says so. */
assert.match(unpricedNote(404), /^it answered HTTP 404 instead of a price/);
assert.match(unpricedNote(500), /HTTP 500 instead of a price/);
assert.match(unpricedNote(200), /^it answered without asking for payment \(HTTP 200\), and Nova does not yet use unpaid answers/);

console.log("PASS: tools — what a tool returns in its own published terms and a missing shape called missing, a search field named as one so a card cannot promise an answer and sell pages, limits kept off the ticked list and the trust score said to measure payment terms, the public sources read first shown as links, and an error never called a free answer.");
