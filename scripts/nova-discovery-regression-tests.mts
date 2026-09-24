/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import assert from "node:assert/strict";
import { discoverMarketplaceCandidates, normalizeMarketplaceItem } from "../lib/counterparty-selection/marketplace-source.ts";
import { actionFor } from "../lib/nova/action.ts";
import type { NovaSignal } from "../lib/nova/types.ts";
import { buildRequestBody } from "../lib/x402/request-body.ts";
import { priceX402Call } from "../lib/x402/execution.ts";

const repo = actionFor({ subjectKind: "github_repository", subjectLabel: "LangChain", subjectRef: "langchain-ai/langchain" } as NovaSignal);
assert.equal(repo.query, "web search", "discover the service capability, not endpoints containing 'project update'");
assert.match(repo.intent, /LangChain/, "keep the project in the question sent to the provider");
assert.equal(repo.requiredCapability, "research");

const network = "eip155:8453";
const accept = { scheme: "exact", network, amount: "1000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x0000000000000000000000000000000000000001" };
const item = (id: string, amount = "1000") => ({
  resource: `https://example.com/${id}`, accepts: [{ ...accept, amount }],
  metadata: { method: "POST", path: "/search", provider: { name: id, tags: ["research"] } },
});
const target = item("target", "9000");
for (const method of ["PATCH", "PUT", "DELETE"]) {
  assert.equal(normalizeMarketplaceItem({ ...target, metadata: { ...target.metadata, method } },
    { capability: "research", network }), null, "unsupported methods must not be rewritten to GET");
}
const wanted = normalizeMarketplaceItem(target, { capability: "research", network })!.candidateId;
const calls: string[] = [];
const fallback = [...Array.from({ length: 15 }, (_, i) => item(`cheap-${i}`)), target];
const mock = (items: unknown[]) => (async (url: string | URL | Request) => {
  const query = new URL(String(url)).searchParams.get("query")!;
  calls.push(query);
  return Response.json({ items: query === "research" ? items : [], pagination: { total: items.length } });
}) as typeof fetch;
const found = await discoverMarketplaceCandidates({ capability: "research", query: "NamedSeller", mustInclude: wanted, limit: 2, maxPriceUsdc: 0.01, fetchImpl: mock(fallback) });
assert.equal(found.candidates[0]?.candidateId, wanted, "the named candidate survives fallback shortlist truncation");
assert(found.candidates.length <= 2);
assert.equal(calls.length, 2, "one bounded fallback, no recursive lookup");
const expensive = item("target", "20000");
const refused = await discoverMarketplaceCandidates({ capability: "research", query: "NamedSeller", mustInclude: wanted, limit: 2, maxPriceUsdc: 0.01, fetchImpl: mock([expensive]) });
assert(!refused.candidates.some(c => c.candidateId === wanted), "mustInclude cannot bypass price limits");
const changedPayee = { ...target, accepts: [{ ...accept, amount: "9000", payTo: "0x0000000000000000000000000000000000000002" }] };
const replaced = await discoverMarketplaceCandidates({ capability: "research", query: "NamedSeller", mustInclude: wanted, limit: 2, fetchImpl: mock([changedPayee]) });
assert(!replaced.candidates.some(c => c.candidateId === wanted), "a changed payee is not the pinned counterparty");

for (const properties of [
  { url: { type: "string", format: "uri" } },
  { query: { type: "array", items: { type: "string" } } },
  { query: { type: "string", format: "uri" } },
  { messageId: { type: "string" } },
]) {
  const plan = buildRequestBody({ intent: "What changed in LangChain?", capability: "research", inputSchema: { type: "object", properties } });
  assert.equal(plan.intentField, null, "questions must not be put into URLs, IDs or structured inputs");
}
const getBody = await priceX402Call({
  resource: "https://example.invalid/search", method: "GET", requestBody: { q: "LangChain" }, maxAmountUsdc: 0.01,
});
assert.equal(getBody.kind, "refused");
assert.equal(getBody.kind === "refused" && getBody.code, "get_request_body_unsupported",
  "refuse before any network call rather than price a discarded GET body");
/* Arc first, Base additional: the brief reads Arc before Base, and one
   endpoint sold on both networks is one card, on Arc. */
{
  const { observeX402Catalog } = await import("../lib/nova/sources.ts");
  const ARC_USDC = "0x3600000000000000000000000000000000000000";
  const listed = (id: string, net: string, asset: string) => ({
    resource: `https://${id}.example.com/search`,
    accepts: [{ scheme: "exact", network: net, amount: "1000", asset, payTo: "0x0000000000000000000000000000000000000001", extra: { name: "USDC", version: "2" } }],
    metadata: { method: "POST", provider: { name: id, tags: ["research", "search"] } },
  });
  const asked: string[] = [];
  const byNetwork = (async (url: string | URL | Request) => {
    const net = new URL(String(url)).searchParams.get("network")!;
    asked.push(net);
    const items = net === "eip155:5042"
      ? [listed("both", net, ARC_USDC), listed("arconly", net, ARC_USDC)]
      : [listed("both", net, accept.asset), listed("baseonly", net, accept.asset)];
    return Response.json({ items, pagination: { total: items.length } });
  }) as typeof fetch;
  const result = await observeX402Catalog({ interests: ["Research & search"], fetchImpl: byNetwork });
  assert.equal(asked[0], "eip155:5042", "Arc is asked first");
  assert(asked.includes("eip155:8453"), "Base is still asked");
  const cards = result.observations.map((o) => `${o.context?.provider} ${o.context?.network}`);
  assert.equal(cards.filter((c) => c.startsWith("both ")).length, 1, "one endpoint on two networks is one card");
  assert(cards.includes("both eip155:5042"), "and that card is the Arc one");
  assert(cards.includes("arconly eip155:5042"), `Arc-only sellers reach the brief: ${cards.join(", ")}`);
}

console.log("PASS: research service discovery, pinned subject beyond shortlist, price/payee guards, text input semantics and discarded GET-body prevention");
