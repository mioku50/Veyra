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
  readingStands,
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
  relativeToWork: "You have identity on Arc Testnet but no operational wallet, so this decides the next step rather than repeating one.",
  citations: [{ sourceId: source.id, quote: "Arc supports sponsored transactions with USDC as the gas token." }],
  gap: null,
  plan: {
    relation: "decides",
    establishedFrom: [2],
    unverified: "Which of the three models Veyra will use is not settled by the material or by your confirmed state.",
    action: "Compare the relayer and the paymaster against the wallet you have not chosen yet, and write down which one the choice depends on.",
  },
  contextProposal: { statement: "Gas sponsorship model is still undecided.", why: "The material names three models and your context does not name a choice." },
};
const withContext = parseValueAssessment(JSON.stringify(reply), { goal, sources: [source], now, writtenBy: "fixture", projectContext: contextForPrompt(mixed) });
assert(withContext);
assert.equal(withContext.relativeToWork, reply.relativeToWork);
assert.deepEqual(withContext.projectContext, contextForPrompt(mixed));
assert.deepEqual(withContext.contextProposal, reply.contextProposal);

/* The work Nova proposes, with the owner's own words where the owner's words
   belong. The model chose an index; the server copied the statement. */
assert.deepEqual(withContext.plan, {
  relation: "decides",
  established: ["Operational wallet is not chosen yet."],
  unverified: reply.plan.unverified,
  action: reply.plan.action,
});

/* And the failure this guards against: a sentence about somebody's project
   that nobody in this conversation ever said. An index nobody supplied fails
   the whole reading, exactly as an invented citation does. */
assert.equal(parseValueAssessment(JSON.stringify({ ...reply, plan: { ...reply.plan, establishedFrom: [7] } }), { goal, sources: [source], now, writtenBy: "fixture", projectContext: contextForPrompt(mixed) }), null,
  "A project statement the owner never confirmed cannot be cited as one");
assert.equal(parseValueAssessment(JSON.stringify({ ...reply, plan: { ...reply.plan, establishedFrom: ["Operational wallet is not chosen yet."] } }), { goal, sources: [source], now, writtenBy: "fixture", projectContext: contextForPrompt(mixed) }), null,
  "The statement is resolved from the index, never taken as written prose");

/* The rule this edition exists for: work standing on nothing the owner said
   is work invented out of what they did not say. An event whose subject they
   never mentioned is still reported -- it just arrives without a plan, which
   is the card saying there is nothing here to do. */
const fromSourceAlone = parseValueAssessment(JSON.stringify({ ...reply, plan: { ...reply.plan, establishedFrom: [] } }), { goal, sources: [source], now, writtenBy: "fixture", projectContext: contextForPrompt(mixed) });
assert(fromSourceAlone, "The reading still stands; only its proposed work does not");
assert.equal(fromSourceAlone.significant, true);
assert.equal(fromSourceAlone.plan, null);

/* And a basis is not a connection. The relation is picked from three words,
   so "I was not told about this" -- true of everything -- cannot be written
   as one. */
for (const relation of ["investigates", "relates", "", undefined]) {
  const stretched = parseValueAssessment(JSON.stringify({ ...reply, plan: { ...reply.plan, relation } }), { goal, sources: [source], now, writtenBy: "fixture", projectContext: contextForPrompt(mixed) });
  assert.equal(stretched?.plan, null, `A plan may not claim the relation ${JSON.stringify(relation)}`);
}
for (const relation of ["decides", "requires", "supersedes"]) {
  assert.equal(parseValueAssessment(JSON.stringify({ ...reply, plan: { ...reply.plan, relation } }), { goal, sources: [source], now, writtenBy: "fixture", projectContext: contextForPrompt(mixed) })?.plan?.relation, relation);
}

/* Half a plan is not work anybody can start. */
const halfPlan = parseValueAssessment(JSON.stringify({ ...reply, plan: { relation: "decides", establishedFrom: [1], action: "Do the thing." } }), { goal, sources: [source], now, writtenBy: "fixture", projectContext: contextForPrompt(mixed) });
assert.equal(halfPlan?.plan, null);

/* A gap is a question whose answer changes a decision. With no proposed work
   there is no decision of theirs to change, so the one reading that can end
   in spending cannot be produced by an event that asks for nothing. */
assert.equal(fromSourceAlone.gap, null, "No work, no research need, and no path to a purchase");

/* Nothing worth doing about material that changes nothing. A plan under an
   insignificant reading is a suggestion the card has already withheld. */
const insignificant = parseValueAssessment(JSON.stringify({ ...reply, significant: false }), { goal, sources: [source], now, writtenBy: "fixture", projectContext: contextForPrompt(mixed) });
assert.equal(insignificant?.plan, null);
assert.equal(insignificant?.gap, null);

/* An owner who has confirmed nothing has confirmed nothing, and an index into
   an empty list is the same invention as an index past the end of a full one. */
assert.equal(parseValueAssessment(JSON.stringify(reply), { goal, sources: [source], now, writtenBy: "fixture" }), null,
  "With no project state supplied there is nothing for proposed work to build on");

/* Said against nothing, "this is new to you" is not checkable. */
const without = parseValueAssessment(JSON.stringify({ ...reply, plan: { ...reply.plan, establishedFrom: [] } }), { goal, sources: [source], now, writtenBy: "fixture" });
assert(without);
assert.equal(without.relativeToWork, null);
assert.deepEqual(without.projectContext, []);

/* A half-written proposal is not a question anybody can answer. */
const partial = parseValueAssessment(JSON.stringify({ ...reply, contextProposal: { statement: "Something changed." } }), { goal, sources: [source], now, writtenBy: "fixture", projectContext: ["A fact.", "A second fact."] });
assert(partial);
assert.equal(partial.contextProposal, null);

/* End to end: the confirmed state reaches the model, the unconfirmed does not. */
let sent: { projectState?: Array<{ index: number; statement: string }> } = {};
const assessed = await assessPublicMaterial({
  goal, projectContext: contextForPrompt(mixed), headline: "Sponsored transactions on Arc", sources: [source], now,
  generate: async (request) => {
    sent = JSON.parse(request.userPrompt as string);
    return { ok: true, provider: "fixture", protocol: "openai-compatible", model: "test", text: JSON.stringify(reply), attempts: 1 };
  },
});
assert(assessed);
assert.deepEqual(sent.projectState, [
  { index: 1, statement: "ERC-8004 identity is live on Arc Testnet." },
  { index: 2, statement: "Operational wallet is not chosen yet." },
], "Numbered, because the proposed work points back into this list by index");
assert.equal(sent.projectState?.some(entry => entry.statement === "Veyra migrated to Arc mainnet."), false, "A proposal Nova wrote must never be read back to it as fact");
assert.equal(assessed.projectContext?.length, 2);

/* A reading carries the state it was judged against, so a pass can tell which
   readings are answering a question about a project that no longer exists. */
assert.equal(readAgainst(["a", "b"], ["a", "b"]), true);
assert.equal(readAgainst(["a", "b"], ["b", "a"]), false);
assert.equal(readAgainst(["a"], ["a", "b"]), false);
assert.equal(readAgainst(undefined, []), true, "An assessment written before context existed matches an empty context and nothing else");
assert.equal(readAgainst(undefined, ["a"]), false);

/* Three things retire a stored reading, and the edition of the rules is the
   one that is easy to forget: changing the instructions rewrites what every
   later reading would say and nothing about the stored ones. */
const current = { goal, context: ["a", "b"], rules: 2 };
assert.equal(readingStands({ goal, context: ["a", "b"], rules: 2 }, current), true);
assert.equal(readingStands({ goal: "another goal", context: ["a", "b"], rules: 2 }, current), false);
assert.equal(readingStands({ goal, context: ["a"], rules: 2 }, current), false);
assert.equal(readingStands({ goal, context: ["a", "b"], rules: 1 }, current), false);
assert.equal(readingStands({ goal, context: ["a", "b"], rules: null }, current), false, "A reading from before editions were recorded is reconsidered");
assert.equal(readingStands({ goal: null, context: null, rules: null }, { ...current, context: [] }), false);

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

console.log("PASS: project context — work proposed with the owner's own words and never a verdict on their code, no work proposed out of what the owner never mentioned, one fact per line, owner-confirmed statements only in the prompt, a reading that says what changed against work already done, an inference Nova cannot confirm for itself, a reading reconsidered when the state it was judged against changes, a pasted blob offered back as the facts it is, and a reading retired when the rules that produced it change.");
