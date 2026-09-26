/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import assert from "node:assert/strict";
import {
  DATA_TOOL_LIMIT,
  fitToQuestion,
  lookUpDocs,
  namedIn,
  needsParameters,
  orderSearchTerms,
  orderByFit,
  ownerAsk,
  parseDocsAnswer,
  parseQuestionPlan,
  proposeForQuestion,
  questionFromRow,
  searchWords,
  type NovaQuestion,
} from "../lib/nova/ask.ts";
import {
  clearDocsIndexCache,
  docsPassages,
  markdownPassages,
  parseDocsIndex,
  rankDocsPages,
  readDocsIndex,
  type DocsPage,
} from "../lib/nova/docs-lookup.ts";
import type { MarketplaceCandidate } from "../lib/counterparty-selection/marketplace-source.ts";

/* ---- the documentation indexes ---- */

/* Lines as the live indexes published them on 2026-09-26. */
const ARC_INDEX = [
  "# Arc",
  "> Arc is an open Layer-1 blockchain purpose-built for programmable money.",
  "## Getting Started — Use the Skill First",
  "- [use-arc](https://github.com/circlefin/skills/blob/master/plugins/circle/skills/use-arc/SKILL.md): not on this site",
  "## Arc Network",
  "- [Stable Fee Design](https://docs.arc.io/arc/concepts/stable-fee-design.md): USDC as gas, predictable fees",
  "- [Connect to Arc](https://docs.arc.io/arc/references/connect-to-arc.md): RPC endpoints and wallet setup",
  "- [Contract Addresses](https://docs.arc.io/arc/references/contract-addresses.md): USDC, EURC, CCTP, Gateway addresses",
  "- [Connect to Arc](https://docs.arc.io/arc/references/connect-to-arc.md#again): the same page twice",
  "### Bridge",
  "- [Overview](https://docs.arc.io/app-kit/bridge.md)",
].join("\n");
const CIRCLE_INDEX = [
  "# Circle Developer Platform",
  "## Paymaster",
  "- [Overview](https://developers.circle.com/paymaster.md): Users pay gas in USDC instead of native tokens",
  "- [Addresses and Events](https://developers.circle.com/paymaster/addresses-and-events.md): Contract addresses and events",
  "- [Arc on another host](https://docs.arc.io/arc-chain.md): an Arc page listed by Circle is not Circle's to list",
  "## Stablecoins",
  "- [USDC Contract Addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses.md): All chains",
].join("\n");

const arcPages = parseDocsIndex(ARC_INDEX, "Arc documentation", "https://docs.arc.io/llms.txt");
assert.deepEqual(arcPages.map((page) => page.url), [
  "https://docs.arc.io/arc/concepts/stable-fee-design.md",
  "https://docs.arc.io/arc/references/connect-to-arc.md",
  "https://docs.arc.io/arc/references/contract-addresses.md",
  "https://docs.arc.io/app-kit/bridge.md",
], "Off the site's own host (GitHub) is dropped, and a page listed twice is one page");
assert.equal(arcPages[0].section, "Arc Network");
assert.equal(arcPages[3].section, "Bridge", "an 'Overview' means nothing without the heading it sits under");
assert.equal(arcPages[3].description, null);
const circlePages = parseDocsIndex(CIRCLE_INDEX, "Circle documentation", "https://developers.circle.com/llms.txt");
assert.equal(circlePages.length, 3, "Circle's index cannot vouch for a page on Arc's host");

/* ---- a page, in passages ---- */

/* Shaped like the live page: one table per product, inside a Mainnet tab and
   a Testnet tab. */
const CONTRACTS_PAGE = [
  "# Contract Addresses",
  "",
  "Arc mainnet contract addresses for USDC, EURC, CCTP and Gateway. Use these, never an address from an unofficial source.",
  "",
  "### Gateway",
  "",
  "<Tabs>",
  "  <Tab title=\"Mainnet\">",
  "    | Contract | Domain | Address |",
  "    | --- | --- | --- |",
  "    | **GatewayWallet** | 26 | [`0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE`](https://explorer.arc.io/address/0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE) |",
  "  </Tab>",
  "  <Tab title=\"Testnet\">",
  "    | **GatewayWallet** | 26 | [`0x0077777d7EBA4688BDeF3E311b846F25870A19B9`](https://explorer.testnet.arc.io/address/0x0077777d7EBA4688BDeF3E311b846F25870A19B9) |",
  "  </Tab>",
  "</Tabs>",
  "",
  "<Note>Testnet addresses differ from mainnet.</Note> Check the [network](https://docs.arc.io/x) first.",
].join("\n");
const passages = markdownPassages(CONTRACTS_PAGE);
assert.ok(passages.includes("Gateway, Mainnet: GatewayWallet | 26 | 0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE"),
  "A table is kept by row, and a row says where it sits: the same name has another address on testnet");
assert.ok(passages.includes("Gateway, Testnet: GatewayWallet | 26 | 0x0077777d7EBA4688BDeF3E311b846F25870A19B9"));
assert.ok(!passages.some((p) => /---/.test(p)), "and its separator row is not a passage");
assert.ok(passages.some((p) => p.startsWith("Testnet addresses differ from mainnet. Check the network first.")), "markup and link targets are taken out, the words kept");
assert.ok(!passages.some((p) => p.length < 20), "a fragment too short to stand on is not a passage");
const long = markdownPassages(`${"The fee is paid in USDC and it is predictable. ".repeat(20)}`);
assert.ok(long.length > 1 && long.every((p) => p.length <= 360), "A long paragraph is split at sentences, within the passage limit");

/* A long page gives the model the passages that say the searched words. */
const filler = Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1} explains something else about the network in general terms.`).join("\n\n");
const longPage = { id: "l", title: "Contract Addresses (Arc documentation)", url: "https://docs.arc.io/arc/references/contract-addresses.md", text: `${filler}\n\n${CONTRACTS_PAGE}`, publishedAt: null, fetchedAt: "2026-09-26T00:00:00Z" };
const chosenPassages = docsPassages([longPage], ["gateway", "wallet", "address"]);
assert.equal(chosenPassages.length, 40);
assert.ok(chosenPassages.some((p) => p.quote.startsWith("Gateway, Mainnet: GatewayWallet")), "The row that answers is given, from past the first forty passages");
assert.deepEqual(chosenPassages.map((p) => Number(p.id.split(".")[1])), [...chosenPassages.map((p) => Number(p.id.split(".")[1]))].sort((a, b) => a - b),
  "in the page's own order, under the page's own numbers");
assert.equal(docsPassages([longPage]).length, 40, "Without words to go on, the first forty");

/* ---- choosing pages without the model ---- */

const numbered: DocsPage[] = [...arcPages, ...circlePages].map((page, index) => ({ ...page, id: index + 1 }));
const ranked = rankDocsPages(numbered, ["paymaster", "usdc"]);
assert.equal(ranked[0].url, "https://developers.circle.com/paymaster.md", "The rare word decides; 'usdc' is on half the pages");
assert.deepEqual(rankDocsPages(numbered, ["kubernetes"]), [], "A word no page says chooses nothing");

/* ---- the owner's question ---- */

assert.deepEqual(ownerAsk("  How much does a   transaction cost on Arc?  "), { ok: true, question: "How much does a transaction cost on Arc?" });
assert.equal(ownerAsk("why?").ok, false);
assert.equal(ownerAsk("x".repeat(401)).ok, false);
assert.equal(ownerAsk(42).ok, false);
const secret = ownerAsk(`Is this key safe sk-proj-${"a".repeat(24)} to use?`);
assert.equal(secret.ok === false && secret.reason, "sensitive_input_rejected", "A secret is sent to nobody: not the docs, not a seller");

assert.deepEqual(searchWords(["How much does the gas cost", "Gas fees"]), ["gas", "cost", "fees"], "Question words out, repeats out, most specific kept first");
assert.deepEqual(searchWords(["Сколько стоит газ на Arc?"]), ["arc"], "A question in Russian leaves only its Latin words without the model");
assert.equal(searchWords(["alpha beta gamma delta epsilon"]).length, 4);

/* The owner's own names come first; a small reading model dropped "Argus" for "arc". */
assert.deepEqual(namedIn("Which new tokens launched on Argus in the last day?"), ["argus"]);
assert.deepEqual(namedIn("What is the GatewayWallet contract address on Arc mainnet?"), ["gatewaywallet", "arc"], "camelCase and a capital mid-sentence; not the opening 'What'");
assert.deepEqual(namedIn("Сколько стоит мост USDC через CCTP?"), ["usdc", "cctp"], "Acronyms in a question written in another script");
assert.deepEqual(orderSearchTerms([...namedIn("Which new tokens launched on Argus in the last day?"), "arc", "token", "launchpad", "risk"]),
  ["argus", "token", "launchpad", "risk"], "What every Arc seller says goes last, and here off the end");
assert.deepEqual(orderSearchTerms(["usdc", "cctp", "cctp", "bridge", "cost"]), ["cctp", "bridge", "cost", "usdc"]);

/* ---- what the model may say ---- */

assert.deepEqual(parseQuestionPlan(JSON.stringify({ pages: [2, 99, 2, 0, 1.5, 3, 4, 5], terms: ["Gas", "fee estimate", "the", "Arc"] }), 7), {
  pageIds: [2, 3, 4],
  terms: ["gas", "fee", "estimate", "arc"],
}, "Only pages that exist, once each, three at most; words split, lowercased, question words out");
assert.equal(parseQuestionPlan("not json", 7), null);
assert.deepEqual(parseQuestionPlan(JSON.stringify({ pages: "all" }), 7), { pageIds: [], terms: [] });

const given = docsPassages([{ id: "u", title: "Contract Addresses (Arc documentation)", url: "https://docs.arc.io/arc/references/contract-addresses.md", text: CONTRACTS_PAGE, publishedAt: null, fetchedAt: "2026-09-26T00:00:00Z" }]);
const gatewayRow = given.find((p) => p.quote.startsWith("Gateway, Mainnet: GatewayWallet"))!;
const grounded = parseDocsAnswer(JSON.stringify({ answered: true, answer: "Circle's GatewayWallet on Arc is at 0x7777…eE.", passageIds: [gatewayRow.id, gatewayRow.id], missing: "" }), given);
assert.equal(grounded.answered, true);
assert.deepEqual(grounded.citations.map((c) => c.id), [gatewayRow.id], "Cited once however often it is named");
const invented = parseDocsAnswer(JSON.stringify({ answered: true, answer: "It is at 0xdead.", passageIds: [gatewayRow.id, "d9.9"] }), given);
assert.deepEqual([invented.answered, invented.failure, invented.answer], [false, "ungrounded", null],
  "One passage nobody supplied throws the whole answer out");
assert.equal(parseDocsAnswer(JSON.stringify({ answered: true, answer: "Yes.", passageIds: [] }), given).failure, "ungrounded", "An answer standing on nothing is not shown");
const partial = parseDocsAnswer(JSON.stringify({ answered: false, answer: "", passageIds: [], missing: "The page lists addresses, not what a transfer costs." }), given);
assert.deepEqual([partial.answered, partial.failure, partial.missing], [false, null, "The page lists addresses, not what a transfer costs."]);
assert.equal(parseDocsAnswer("{", given).failure, "ungrounded");

/* ---- step 1 end to end: the documentation, with a fake web and a fake model ---- */

const PAGES: Record<string, string> = {
  "https://docs.arc.io/llms.txt": ARC_INDEX,
  "https://developers.circle.com/llms.txt": CIRCLE_INDEX,
  "https://docs.arc.io/arc/references/contract-addresses.md": CONTRACTS_PAGE,
  "https://developers.circle.com/paymaster.md": "# Paymaster\n\nCircle Paymaster lets users pay gas fees in USDC instead of the native token, through a smart account.",
  "https://docs.arc.io/arc/concepts/stable-fee-design.md": "<!doctype html><html>a web page, not markdown</html>",
};
let fetched: string[] = [];
const web = (overrides: Record<string, string | null> = {}) => (async (url: string) => {
  fetched.push(url);
  const body = url in overrides ? overrides[url] : PAGES[url];
  return body === null || body === undefined ? new Response("missing", { status: 404 }) : new Response(body, { status: 200 });
}) as unknown as typeof fetch;
const says = (plan: unknown, answer: unknown) => (async (input: { systemPrompt: string }) => ({
  ok: true as const, provider: "Fake", protocol: "openai-compatible" as const, model: "reader-1", attempts: 1,
  text: JSON.stringify(input.systemPrompt.startsWith("You route") ? plan : answer),
})) as never;
const mute = (async () => ({ ok: false as const, provider: "Fake", protocol: "openai-compatible" as const, model: null, reason: "upstream_error", attempted: true, attempts: 1 })) as never;
const NOW = new Date("2026-09-26T12:00:00Z");
/* Ids in the combined list: Arc's four pages, then Circle's three. */
const CONTRACTS_ID = 3;
const PAYMASTER_ID = 5;

clearDocsIndexCache();
fetched = [];
const answered = await lookUpDocs({
  question: "Where is Circle's GatewayWallet on Arc?",
  fetchImpl: web(),
  now: NOW,
  generate: says({ pages: [CONTRACTS_ID], terms: ["gateway", "wallet", "address"] },
    { answered: true, answer: "At 0x7777…eE, per Arc's contract addresses page.", passageIds: [gatewayRow.id.replace(/^d\d+/, "d1")], missing: "" }),
});
assert.deepEqual(answered.searchTerms, ["gatewaywallet", "gateway", "wallet", "address"], "The name the owner wrote, then the model's words; 'circle' and 'arc' say nothing here");
assert.equal(answered.docs.answered, true);
assert.equal(answered.docs.citations[0].url, "https://docs.arc.io/arc/references/contract-addresses.md");
assert.deepEqual(answered.docs.checked, [{ title: "Arc Network: Contract Addresses (Arc documentation)", url: "https://docs.arc.io/arc/references/contract-addresses.md" }]);
assert.equal(answered.docs.writtenBy, "Fake · reader-1");
assert.deepEqual(fetched, ["https://docs.arc.io/llms.txt", "https://developers.circle.com/llms.txt", "https://docs.arc.io/arc/references/contract-addresses.md"],
  "Both indexes, then only the page chosen");

fetched = [];
const html = await lookUpDocs({
  question: "What is Arc's stable fee design?",
  fetchImpl: web(),
  now: NOW,
  generate: says({ pages: [1], terms: ["fee"] }, { answered: false }),
});
assert.deepEqual(fetched, ["https://docs.arc.io/arc/concepts/stable-fee-design.md"], "The indexes are kept for an hour; only the page is read again");
assert.deepEqual([html.docs.failure, html.docs.checked, html.docs.unavailable], ["docs_unavailable", [], ["Stable Fee Design"]],
  "A web page where markdown was expected is unread, and named; it is never read as an answer");

const nothing = await lookUpDocs({ question: "Who won the football match yesterday?", fetchImpl: web(), now: NOW, generate: says({ pages: [], terms: ["football"] }, {}) });
assert.equal(nothing.docs.failure, "nothing_relevant", "The model chose no page: nothing is read and nothing is claimed");

const unread = await lookUpDocs({ question: "How do I pay gas in USDC with a paymaster?", fetchImpl: web(), now: NOW, generate: mute });
assert.deepEqual(unread.searchTerms, ["pay", "gas", "paymaster", "usdc"], "Without the model, the question's own English words, 'usdc' last");
assert.equal(unread.docs.checked[0]?.url, "https://developers.circle.com/paymaster.md", "and the pages whose titles say the rarest of them");
assert.equal(unread.docs.failure, "model_unavailable", "Read, but nobody could answer from it: said as that, not as 'the docs do not say'");

clearDocsIndexCache();
const down = await lookUpDocs({
  question: "Where is the GatewayWallet?",
  fetchImpl: web({ "https://docs.arc.io/llms.txt": null, "https://developers.circle.com/llms.txt": null }),
  now: NOW,
  generate: says({ pages: [], terms: ["gateway"] }, {}),
});
assert.equal(down.docs.failure, "docs_unavailable");
assert.deepEqual(down.docs.unavailable, ["Arc documentation", "Circle documentation"]);
assert.deepEqual(down.searchTerms, ["gatewaywallet", "gateway"], "The market can still be searched when the documentation cannot be read");

clearDocsIndexCache();
fetched = [];
const halfIndex = await readDocsIndex({ fetchImpl: web({ "https://developers.circle.com/llms.txt": null }), now: NOW });
assert.deepEqual(halfIndex.unavailable, ["Circle documentation"]);
await readDocsIndex({ fetchImpl: web(), now: NOW });
assert.equal(fetched.filter((url) => url.endsWith("llms.txt")).length, 4, "An index with a site missing is not kept for the next question");
clearDocsIndexCache();

/* ---- step 2: which listing fits the question ---- */

function listing(id: string, over: Partial<MarketplaceCandidate> & { tags?: string[] }): MarketplaceCandidate {
  return {
    candidateId: id,
    resource: `https://seller.example/${id}`,
    method: "GET",
    description: null,
    inputSchema: null,
    capabilities: [],
    priceUsdc: 0.005,
    provider: { name: id, description: null, category: null, tags: over.tags ?? [] },
    ...over,
  } as unknown as MarketplaceCandidate;
}

/* Descriptions as the ERC-8004 registry on Arc published them on 2026-09-26. */
const arcGas = listing("arc-gas", { resource: "https://apexfaucet.xyz/api/x402/arc-gas", description: "What a transaction on Arc ACTUALLY costs, measured from real receipts", priceUsdc: 0.003 });
const arcPayment = listing("arc-payment", { resource: "https://apexfaucet.xyz/api/x402/arc-payment", description: "Did that Arc payment actually land? Pass ?tx=0x… and optionally ?to=0x" });
const forecast = listing("fees-forecast", { resource: "https://api.cra-agent.tech/v1/paid/fees/forecast", description: "Base fee now and next block, 24h band, utilisation trend, cost per operation" });
const deploys = listing("deploys", { resource: "https://api.cra-agent.tech/v1/paid/deploys/history", description: "Recent contract deploys with labels and per-hour history (?limit=200)" });
const bulk = listing("exit-bulk", { resource: "https://apexfaucet.xyz/api/x402/arc-exit-check-bulk", description: "Arc exit check, bulk: up to 25 tokens or v4 pool ids on Arc (ids=a,b,c" });
const bonding = listing("bonding", { resource: "https://www.fuci.family/api/x402/argus/bonding", description: "Price, progress toward bonding", inputSchema: { type: "object", properties: { token: { type: "string" } }, required: ["token"] } });
const run = listing("fuci-run", { method: "POST", resource: "https://www.fuci.family/api/agent/run", description: "A Fuci agent answers your question about Argus launches and Arc markets", inputSchema: { type: "object", properties: { prompt: { type: "string", description: "Your question about Argus launches / Arc markets" } }, required: ["prompt"] }, priceUsdc: 0.04 });
const templated = listing("mint", { resource: "https://seller.example/token/{mint}" });

assert.equal(needsParameters(arcGas), false, "Called as listed, it answers");
assert.equal(needsParameters(arcPayment), true, "'Pass ?tx=0x…' in words is a parameter");
assert.equal(needsParameters(bulk), true);
assert.equal(needsParameters(deploys), true, "Read conservatively: an optional parameter reads the same");
assert.equal(needsParameters(bonding), true, "A required field in its schema");
assert.equal(needsParameters(templated), true);
assert.equal(needsParameters(run), false, "A POST carries its question in its body");

const pool = [forecast, arcPayment, arcGas, run, deploys];
const fits = fitToQuestion(pool, ["gas", "cost", "transaction"]);
assert.deepEqual(fits.get("arc-gas")!.matched, ["gas", "cost", "transaction"], "Path words count: /arc-gas says gas; 'costs' says cost");
assert.deepEqual(fits.get("fees-forecast")!.matched, ["cost"]);
assert.deepEqual(fits.get("arc-payment")!.matched, []);
assert.equal(fits.get("arc-gas")!.listing, "What a transaction on Arc ACTUALLY costs, measured from real receipts");
assert.deepEqual(orderByFit(pool, fits).map((c) => c.candidateId).slice(0, 2), ["arc-gas", "fees-forecast"]);
const rarity = fitToQuestion([arcGas, forecast, run], ["arc", "argus"]);
assert.ok(rarity.get("fuci-run")!.fit > rarity.get("arc-gas")!.fit, "A word every Arc seller says weighs less than the one only this one says");
assert.equal(rarity.get("arc-gas")!.specific, false, "Saying only 'arc' is not a fit for anything");

/* As the live registry answered "Which new tokens launched on Argus in the last day, and which look risky?". */
const launches = listing("argus-launches", { resource: "https://www.fuci.family/api/x402/argus/launches", description: "Latest token launches on Argus, the launchpad on Arc: who launched them and when" });
const deployers = listing("arc-deployers", { resource: "https://apexfaucet.xyz/api/x402/arc-deployers", description: "Who launched what on Arc. Every creator with more than one launchpad token, with the risk flags its pools carry" });
const riskReport = listing("fuci-risk", { resource: "https://www.fuci.family/api/x402/risk", description: "A graded risk report for a token on Arc" });
const argusFits = fitToQuestion([deployers, launches, riskReport, arcGas], ["argus", "token", "launchpad", "risk"]);
assert.deepEqual(orderByFit([deployers, launches, riskReport, arcGas], argusFits).map((c) => c.candidateId).slice(0, 2), ["argus-launches", "arc-deployers"],
  "The name the owner wrote, searched first, outweighs three general words");

/* ---- steps 2 and 3: the walk, with a fake engine and a fake price ---- */

type Fake = { listing: MarketplaceCandidate; decision?: string; funding?: "wallet" | "gateway_deposit"; payableNow?: boolean | null; outputSchema?: Record<string, unknown> | null };
const exa = listing("exa-search", {
  method: "POST",
  resource: "https://api.exa.ai/search",
  description: "Search the web",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  priceUsdc: 0.007,
});
const alchemy = listing("token-prices", {
  method: "POST",
  resource: "https://x402.alchemy.com/prices",
  description: "Token prices by address: gas token and fee token prices",
  inputSchema: { type: "object", properties: { addresses: { type: "array" } } },
});

function rankedFrom(fake: Fake) {
  const c = fake.listing;
  return {
    agentId: c.candidateId,
    trustDecision: fake.decision ?? "ALLOW_WITH_LIMITS",
    trustScore: 71.6,
    recommendedMaxExposureUsdc: 0.05,
    marketplace: {
      candidateId: c.candidateId,
      resource: c.resource,
      provider: c.provider,
      method: c.method,
      priceUsdc: c.priceUsdc,
      payTo: "0x1111111111111111111111111111111111111111",
      network: "eip155:5042",
      asset: "0x3600000000000000000000000000000000000000",
      funding: fake.funding ?? "wallet",
      payableNow: fake.payableNow ?? null,
      inputSchema: c.inputSchema,
      outputSchema: fake.outputSchema ?? null,
    },
    probe: { respondedWith402: true, reachable: true, catalogDrift: [], latencyMs: 420 },
  };
}

const calls: Array<{ query: string; tenantKey: string; requireWordMatch?: boolean; network?: string }> = [];
const engine = (byQuery: Record<string, Fake[] | "down">) => (async (input: {
  request: { query: string; network?: string };
  tenant: { tenantKey: string };
  requireWordMatch?: boolean;
  order?: (candidates: MarketplaceCandidate[]) => MarketplaceCandidate[];
}) => {
  calls.push({ query: input.request.query, tenantKey: input.tenant.tenantKey, requireWordMatch: input.requireWordMatch, network: input.request.network });
  const fakes = byQuery[input.request.query];
  if (fakes === "down" || fakes === undefined) throw new Error("marketplace_discovery_unavailable");
  const order = input.order ? input.order(fakes.map((f) => f.listing)) : fakes.map((f) => f.listing);
  const byId = new Map(fakes.map((f) => [f.listing.candidateId, f]));
  return { selectionId: "sel_1", probed: fakes.length, expiresAt: "2026-09-26T12:10:00Z", candidates: order.map((c) => rankedFrom(byId.get(c.candidateId)!)) };
}) as never;

const sent: Array<{ resource: string; method: string; body: unknown }> = [];
const market = (answers: Record<string, "free" | "refused" | "gateway" | number>) => (async (input: { resource: string; method: "GET" | "POST"; requestBody: unknown }) => {
  sent.push({ resource: input.resource, method: input.method, body: input.requestBody });
  const answer = answers[input.resource] ?? 0.005;
  if (answer === "free") return { kind: "free", status: 200, body: "{}" };
  if (answer === "refused") return { kind: "refused", status: 422, code: "request_body_invalid", message: "no" };
  const usdc = answer === "gateway" ? 0.005 : answer;
  return {
    kind: "priced",
    quote: {
      resource: input.resource, method: input.method, quotedUsdc: usdc, maxAmountUsdc: 0.05, resourceDescriptor: null,
      inputSchema: null, outputSchema: null, quotedAt: NOW.toISOString(),
      accept: {
        amountAtomic: String(Math.round(usdc * 1e6)), network: "eip155:5042", payTo: "0x1111111111111111111111111111111111111111",
        asset: "0x3600000000000000000000000000000000000000", gatewayBatched: answer === "gateway",
      },
    },
  };
}) as never;

const docsChecked = [{ title: "Arc Network: Stable Fee Design (Arc documentation)", url: "https://docs.arc.io/arc/concepts/stable-fee-design.md" }];
const asked: Pick<NovaQuestion, "questionId" | "question" | "searchTerms" | "docs"> = {
  questionId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  question: "Сколько сейчас стоит транзакция на Arc?",
  searchTerms: ["fee", "cost", "operation"],
  docs: { checked: docsChecked, unavailable: [], answered: false, answer: null, citations: [], missing: "The page explains the design, not today's cost.", failure: null, writtenBy: "Fake · reader-1", checkedAt: NOW.toISOString() },
};

/* The best fit (it says fee, cost and operation) cannot be paid from this
   wallet; the next one is a data tool that needs nothing from the owner, and
   is priced as listed. */
calls.length = 0;
sent.length = 0;
const dataTool = await proposeForQuestion({
  question: asked,
  selectImpl: engine({
    "fee cost operation": [
      { listing: arcPayment },
      { listing: forecast, funding: "gateway_deposit", payableNow: false },
      { listing: arcGas, outputSchema: { type: "object", properties: { costUsdc: {}, measuredAt: {} } } },
    ],
  }),
  priceImpl: market({ [forecast.resource]: "gateway" }),
});
assert.equal(dataTool.ok, true);
assert.deepEqual(calls[0], { query: "fee cost operation", tenantKey: `nova:q:${asked.questionId}`, requireWordMatch: true, network: "eip155:5042" },
  "Searched on Arc with the question's words, and only listings that say one of them");
if (dataTool.ok) {
  const { proposal, plan } = dataTool;
  assert.equal(proposal.resource, arcGas.resource);
  assert.equal(proposal.askedBy, "owner");
  assert.equal(proposal.questionId, asked.questionId);
  assert.equal(proposal.signalId, undefined);
  assert.deepEqual(proposal.chosenFor, { matched: ["cost"], listing: arcGas.description, general: false });
  assert.equal(proposal.sentAs, null, "A data tool is sent no question");
  assert.equal(proposal.limitations?.[0], DATA_TOOL_LIMIT, "and the card says so first");
  assert.deepEqual(proposal.checkedFirst, docsChecked, "The documentation it read first, for nothing, is on the card");
  assert.equal(proposal.searchedFor, "fee cost operation");
  assert.match(proposal.routingNote ?? "", /fees\/forecast\): it settles only through Circle Gateway deposit on Arc, and there is no deposit to pay from\./);
  assert.ok(!/arc-payment/.test(proposal.routingNote ?? ""), "Ordered last by fit, it was never reached, so it was not passed over");
  assert.deepEqual([plan.method, plan.requestBody, plan.candidateId], ["GET", {}, "arc-gas"], "Called exactly as listed");
  assert.equal(proposal.funding, "wallet");
  assert.equal(proposal.costUsdc, 0.005);
}
assert.deepEqual(sent.map((s) => s.resource), [forecast.resource, arcGas.resource], "Priced in fit order; the one needing a parameter is never priced");

/* Nothing that says the question's words can take it, so a web search: the
   general option, labelled as one, with the owner's own words sent to it. */
calls.length = 0;
sent.length = 0;
const general = await proposeForQuestion({
  question: { ...asked, question: "Which agents on Arc answer questions about Argus launches?", searchTerms: ["argus", "launches"] },
  selectImpl: engine({
    "argus launches": [{ listing: run, funding: "gateway_deposit", payableNow: false }, { listing: alchemy }],
    search: [{ listing: exa }],
  }),
  priceImpl: market({ [run.resource]: "gateway", [exa.resource]: 0.007 }),
});
assert.equal(general.ok, true);
assert.deepEqual(calls.map((c) => c.query), ["argus launches", "search"]);
if (general.ok) {
  assert.deepEqual(general.proposal.chosenFor, { matched: [], listing: "Search the web", general: true });
  assert.equal(general.proposal.sentAs, "query");
  assert.match(general.proposal.routingNote ?? "", /fuci-run \(\/api\/agent\/run\): it settles only through Circle Gateway deposit on Arc/);
  assert.equal(general.proposal.costUsdc, 0.007);
}
assert.deepEqual(sent.find((s) => s.resource === exa.resource)?.body, { query: "Which agents on Arc answer questions about Argus launches?" },
  "What a seller is sent is the owner's question, never a rewrite of it");
assert.deepEqual(sent.find((s) => s.resource === run.resource)?.body, { prompt: "Which agents on Arc answer questions about Argus launches?" },
  "An agent's own field takes the question too");
assert.ok(!sent.some((s) => s.resource === alchemy.resource), "A schema with nowhere to put a question is never priced");

/* Refusals say which case applied. */
const deny = await proposeForQuestion({
  question: asked,
  selectImpl: engine({ "fee cost operation": [{ listing: arcGas, decision: "DENY" }], search: [{ listing: exa, decision: "REVIEW_REQUIRED" }] }),
  priceImpl: market({}),
});
assert.deepEqual(deny.ok === false && [deny.reason, /would not put any of them in front of you/.test(deny.detail)], ["nothing_allowed", true]);

const unpayable = await proposeForQuestion({
  question: asked,
  selectImpl: engine({ "fee cost operation": [{ listing: forecast, funding: "gateway_deposit", payableNow: false }], search: [] }),
  priceImpl: market({ [forecast.resource]: "gateway" }),
});
assert.equal(unpayable.ok === false && unpayable.reason, "not_payable");
assert.match(unpayable.ok === false ? unpayable.detail : "", /Nothing was signed\./);

/* Says the question's words, and wants a value in its address. */
const estimate = listing("fees-estimate", { resource: "https://api.cra-agent.tech/v1/paid/fees/estimate", description: "Cost in USDC of a transaction with the given gas at the current base fee. Pass ?gas=21000" });
const unaskable = await proposeForQuestion({
  question: asked,
  selectImpl: engine({ "fee cost operation": [{ listing: estimate }, { listing: arcPayment }], search: [{ listing: alchemy }] }),
  priceImpl: market({}),
});
assert.equal(unaskable.ok === false && unaskable.reason, "nothing_askable");
assert.match(unaskable.ok === false ? unaskable.detail : "", /needs a value from you in its address/);

const offline = await proposeForQuestion({ question: asked, selectImpl: engine({ "fee cost operation": "down", search: "down" }), priceImpl: market({}) });
assert.equal(offline.ok === false && offline.reason, "lookup_failed");

calls.length = 0;
await proposeForQuestion({ question: { ...asked, searchTerms: [] }, selectImpl: engine({ search: [{ listing: exa }] }), priceImpl: market({}) });
assert.deepEqual(calls.map((c) => c.query), ["search"], "With no words to search by, only the general option is looked for");

/* A listing that says only what every Arc seller says is not considered. */
sent.length = 0;
const onlyArc = listing("arc-only", { method: "GET", resource: "https://seller.example/arc-only", description: "Everything about Arc" });
const vague = await proposeForQuestion({
  question: { ...asked, searchTerms: ["paymaster", "arc"] },
  selectImpl: engine({ "paymaster arc": [{ listing: onlyArc }], search: [{ listing: exa }] }),
  priceImpl: market({}),
});
assert.equal(vague.ok && vague.proposal.chosenFor?.general, true, "It falls through to the general option");
assert.ok(!sent.some((s) => s.resource === onlyArc.resource), "and it is never priced");

const free = await proposeForQuestion({ question: asked, selectImpl: engine({ "fee cost operation": [{ listing: arcGas }], search: [] }), priceImpl: market({ [arcGas.resource]: "free" }) });
assert.equal(free.ok, false, "An endpoint that answers without a price is not something to authorise");

/* ---- storage ---- */

const restored = questionFromRow({
  question_id: asked.questionId,
  question: asked.question,
  search_terms: ["gas", 7, "cost"],
  docs: { answered: true, answer: "Yes.", citations: [], checked: [], unavailable: [], failure: null, checkedAt: "2026-09-26T12:00:00Z" },
  refusal: null,
  created_at: "2026-09-26T12:00:01Z",
});
assert.deepEqual(restored.searchTerms, ["gas", "cost"]);
assert.equal(restored.docs.answered, true);
assert.equal(questionFromRow({ question_id: "x", docs: null, created_at: "t" }).docs.checkedAt, "t", "A row without its lookup still reads");

console.log("nova ask: all assertions passed");
