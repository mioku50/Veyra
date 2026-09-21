/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import assert from "node:assert/strict";
import {
  PROJECT_CONTEXT_LIMITS,
  ProjectContextError,
  confirmedContext,
  contextForPrompt,
  normalizeStatement,
  normalizeStatements,
  proposedContext,
  readAgainst,
  splitStatements,
  type NovaProjectContext,
} from "../lib/nova/project-context.ts";
import { assessPublicMaterial, parseValueAssessment } from "../lib/nova/free-research.ts";
import type { PublicMaterial } from "../lib/nova/value.ts";

const now = new Date("2026-09-21T12:00:00Z");
const goal = "Track Arc and Circle changes that matter to building Veyra.";
const source: PublicMaterial = {
  id: "source-a",
  url: "https://www.arc.io/blog/sponsored-transactions",
  title: "Sponsored transactions on Arc",
  text: "Arc supports sponsored transactions with USDC as the gas token. An EIP-3009 relayer submits the transfer and pays gas from its own USDC balance.",
  publishedAt: "2026-09-20T12:00:00Z",
  fetchedAt: now.toISOString(),
};

const entry = (over: Partial<NovaProjectContext> & { statement: string }): NovaProjectContext => ({
  contextId: over.statement, status: "confirmed", origin: "owner", evidence: {},
  updatedAt: now.toISOString(), confirmedAt: now.toISOString(), ...over,
});

/* One statement at a time, and never two spellings of the same one. */
assert.equal(normalizeStatement("  ERC-8183   escrow is tested \n on Arc Testnet. "), "ERC-8183 escrow is tested on Arc Testnet.");
assert.throws(() => normalizeStatement("   "), ProjectContextError);
assert.throws(() => normalizeStatement(42), ProjectContextError);
assert.throws(() => normalizeStatement("x".repeat(PROJECT_CONTEXT_LIMITS.statement + 1)), ProjectContextError);
assert.deepEqual(normalizeStatements(["Wallet not chosen", "wallet  not chosen"]), ["Wallet not chosen"]);
assert.deepEqual(normalizeStatements(null), []);
assert.throws(() => normalizeStatements("not a list"), ProjectContextError);
assert.throws(() => normalizeStatements(Array.from({ length: PROJECT_CONTEXT_LIMITS.confirmed + 1 }, (_, i) => `Fact ${i}`)), ProjectContextError);

/* The invariant the whole feature rests on: what Nova inferred about the
   project cannot reach the prompt that judges the next event against the
   project. Otherwise the model confirms its own reading on the second pass. */
const mixed: NovaProjectContext[] = [
  entry({ statement: "ERC-8004 identity is live on Arc Testnet.", confirmedAt: "2026-09-01T00:00:00Z" }),
  entry({ statement: "Operational wallet is not chosen yet.", confirmedAt: "2026-09-10T00:00:00Z" }),
  entry({ statement: "Veyra migrated to Arc mainnet.", status: "proposed", origin: "nova_reading", confirmedAt: null }),
  entry({ statement: "Nova has a funded wallet.", status: "dismissed", origin: "nova_reading", confirmedAt: null }),
];
assert.deepEqual(contextForPrompt(mixed), [
  "ERC-8004 identity is live on Arc Testnet.",
  "Operational wallet is not chosen yet.",
], "Only owner-confirmed statements, oldest confirmation first");
assert.equal(confirmedContext(mixed).length, 2);
assert.deepEqual(proposedContext(mixed).map(e => e.statement), ["Veyra migrated to Arc mainnet."]);
const long = Array.from({ length: PROJECT_CONTEXT_LIMITS.confirmed }, (_, i) => entry({ statement: `${i} `.padEnd(PROJECT_CONTEXT_LIMITS.statement, "x") }));
assert(contextForPrompt(long).join(" ").length <= PROJECT_CONTEXT_LIMITS.promptCharacters, "A growing context cannot crowd the excerpts out of the prompt");
assert(contextForPrompt(long).length < PROJECT_CONTEXT_LIMITS.confirmed);

/* A reading judged against the project says what it changes for work already
   done, and carries the state it was judged against. */
const reply = {
  significant: true,
  whatChanged: "Arc documents three ways to sponsor transaction fees in USDC.",
  whyItMatters: "It decides who pays gas once the agent has its own wallet.",
  nextStep: "Compare the relayer and paymaster models against the planned wallet.",
  relativeToWork: "You have identity on Arc Testnet but no operational wallet, so this decides the next step rather than repeating one.",
  citations: [{ sourceId: source.id, quote: "Arc supports sponsored transactions with USDC as the gas token." }],
  gap: null,
  contextProposal: { statement: "Gas sponsorship model is still undecided.", why: "The material names three models and your context does not name a choice." },
};
const withContext = parseValueAssessment(JSON.stringify(reply), { goal, sources: [source], now, writtenBy: "fixture", projectContext: contextForPrompt(mixed) });
assert(withContext);
assert.equal(withContext.relativeToWork, reply.relativeToWork);
assert.deepEqual(withContext.projectContext, contextForPrompt(mixed));
assert.deepEqual(withContext.contextProposal, reply.contextProposal);

/* Said against nothing, "this is new to you" is not checkable. */
const without = parseValueAssessment(JSON.stringify(reply), { goal, sources: [source], now, writtenBy: "fixture" });
assert(without);
assert.equal(without.relativeToWork, null);
assert.deepEqual(without.projectContext, []);

/* A half-written proposal is not a question anybody can answer. */
const partial = parseValueAssessment(JSON.stringify({ ...reply, contextProposal: { statement: "Something changed." } }), { goal, sources: [source], now, writtenBy: "fixture", projectContext: ["A fact."] });
assert(partial);
assert.equal(partial.contextProposal, null);

/* End to end: the confirmed state reaches the model, the unconfirmed does not. */
let sent: { projectState?: string[] } = {};
const assessed = await assessPublicMaterial({
  goal, projectContext: contextForPrompt(mixed), headline: "Sponsored transactions on Arc", sources: [source], now,
  generate: async (request) => {
    sent = JSON.parse(request.userPrompt as string);
    return { ok: true, provider: "fixture", protocol: "openai-compatible", model: "test", text: JSON.stringify(reply), attempts: 1 };
  },
});
assert(assessed);
assert.deepEqual(sent.projectState, [
  "ERC-8004 identity is live on Arc Testnet.",
  "Operational wallet is not chosen yet.",
]);
assert.equal(sent.projectState?.includes("Veyra migrated to Arc mainnet."), false, "A proposal Nova wrote must never be read back to it as fact");
assert.equal(assessed.projectContext?.length, 2);

/* A reading carries the state it was judged against, so a pass can tell which
   readings are answering a question about a project that no longer exists. */
assert.equal(readAgainst(["a", "b"], ["a", "b"]), true);
assert.equal(readAgainst(["a", "b"], ["b", "a"]), false);
assert.equal(readAgainst(["a"], ["a", "b"]), false);
assert.equal(readAgainst(undefined, []), true, "An assessment written before context existed matches an empty context and nothing else");
assert.equal(readAgainst(undefined, ["a"]), false);

/* Real input from the first owner to use the panel: four facts typed into one
   row. It reads the same to the model and cannot be corrected a line at a
   time, which is what keeps the list from going stale. */
const blob = "ERC-8183 escrow протестирован. ERC-8004 identity живёт на Arc Testnet . Operational wallet не выбран. «Приоритет — полезность исследований Nova";
assert.deepEqual(splitStatements(blob), [
  "ERC-8183 escrow протестирован.",
  "ERC-8004 identity живёт на Arc Testnet .",
  "Operational wallet не выбран.",
  "«Приоритет — полезность исследований Nova",
]);
assert.deepEqual(splitStatements("Line one\nLine two"), ["Line one", "Line two"]);
assert.deepEqual(splitStatements("One fact and nothing else."), [], "A single fact is not a suggestion to split");
assert.deepEqual(splitStatements("Version 1.2 shipped."), [], "A decimal point does not end a sentence");
assert(splitStatements(blob).every(part => part.length <= PROJECT_CONTEXT_LIMITS.statement));

console.log("PASS: project context — one fact per line, owner-confirmed statements only in the prompt, a reading that says what changed against work already done, an inference Nova cannot confirm for itself, a reading reconsidered when the state it was judged against changes, and a pasted blob offered back as the facts it is.");
