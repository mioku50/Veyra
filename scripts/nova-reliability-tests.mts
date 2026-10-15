/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assessPublicMaterial, parseValueAssessment, parseValueAssessmentResult } from "../lib/nova/free-research.ts";
import { READING_PARSER_VERSION, type ReadingAttempt, type GithubRequest } from "../lib/nova/reliability.ts";
import { noWorkEstablished } from "../lib/nova/presentation.ts";
import { observeRepositories, observeRepositoryPulse, type GithubReadFailure } from "../lib/nova/sources.ts";
import { generateOpenAiCompatibleText } from "../lib/llm/openai-compatible.ts";
import { READING_RULES } from "../lib/nova/value.ts";

const now = new Date("2026-10-15T06:16:59Z");
const source = { id: "event", url: "https://www.langchain.com/blog/example", title: "Memory middleware",
  text: "The integration adds middleware to summarize history and compress tool results.", publishedAt: null, fetchedAt: now.toISOString() };
const input = { goal: "Research Nova improvements.", sources: [source], now, writtenBy: "fixture",
  projectContext: ["Research usefulness is the priority."] };
const raw = { significant: true, whatChanged: "The integration adds memory middleware.", whyItMatters: "It may help assess research context costs.",
  citationIds: ["s1.e1"], plan: null, gap: null };
const parse = (value: unknown) => parseValueAssessmentResult(JSON.stringify(value), input);
const rejection = (value: unknown, code: string, reason = "ungrounded") => {
  assert.deepEqual(parse(value), { ok: false, reason, code });
};

// Valid answers are still accepted, including the legacy exact-quote format.
for (const text of [JSON.stringify(raw), ` \n\uFEFF\x60\x60\x60json\n${JSON.stringify(raw)}\n\x60\x60\x60 \n`,
  JSON.stringify({ ...raw, citationIds: undefined, citations: [{ sourceId: "event", quote: `“${source.text}”` }] })]) {
  assert.ok(parseValueAssessment(text, input));
}
assert.deepEqual(parseValueAssessmentResult("{bad", input), { ok: false, reason: "invalid_response", code: "invalid_json" });
for (const bad of [null, [], true, { significant: "true" }, { ...raw, citations: [null], citationIds: undefined }]) rejection(bad, "invalid_shape", "invalid_response");
rejection({ ...raw, citationIds: ["s1.e999"] }, "unknown_citation");
rejection({ ...raw, citationIds: undefined, citations: [{ sourceId: "invented", quote: source.text }] }, "unknown_citation");
rejection({ ...raw, citationIds: undefined, citations: [{ sourceId: "event", quote: "Mainnet is live and every contract was audited." }] }, "invalid_quote");
rejection({ ...raw, citationIds: [] }, "missing_event_citation");
// Do not silently ignore a forged citation past the display cap.
rejection({ ...raw, citationIds: undefined, citations: [...Array(4).fill({ sourceId: "event", quote: source.text }), { sourceId: "fake", quote: source.text }] }, "unknown_citation");
const reference = { ...source, id: "reference" };
assert.deepEqual(parseValueAssessmentResult(JSON.stringify({ ...raw, citationIds: ["s2.e1"] }), { ...input, sources: [source, reference] }),
  { ok: false, reason: "ungrounded", code: "missing_event_citation" });
rejection({ ...raw, plan: { relation: "requires", establishedFrom: [99], unverified: "Which version?", action: "Upgrade." } }, "invalid_project_basis");

// Provenance is not entailment. Keep this limitation visible in acceptance
// tests: passing citation validation must never be described as a fact check.
const unsupported = parse({ ...raw, whatChanged: "Arc Mainnet is live and audited; Nova must migrate today." });
assert.equal(unsupported.ok, true, "Known semantic limitation; not evidence the claim is true");
const ui = readFileSync(new URL("../app/nova/nova-client.tsx", import.meta.url), "utf8");
assert.match(ui, /that does not verify every conclusion/);
assert.match(ui, /noWorkEstablished\(analysis.significant\)/);
assert.doesNotMatch(noWorkEstablished(true), /Nothing here for you to do|does not bear on/);
assert.match(noWorkEstablished(true), /does not rule out useful work/);
assert.match(noWorkEstablished(false), /Held back/);

// The ScaleDown path reports no supported plan, not a negative finding about
// Nova's implementation. A priority is not an inventory of memory/research.
let prompt: Record<string, unknown> | undefined;
const attempts: ReadingAttempt[] = [];
const failures: string[] = [];
const generate = (text: string) => (async (request: Parameters<typeof generateOpenAiCompatibleText>[0]) => {
  prompt = JSON.parse(request.userPrompt);
  return { ok: true as const, provider: "Fixture", protocol: "openai-compatible" as const, model: "fixture-v1", text, attempts: 1 };
});
for (const text of [JSON.stringify(raw), "{bad", JSON.stringify({ ...raw, citationIds: ["s1.e999"] })]) {
  await assessPublicMaterial({ ...input, headline: "Memory middleware", generate: generate(text),
    onAttempt: attempt => attempts.push(attempt), onFailure: reason => failures.push(reason) });
}
assert.deepEqual(attempts.map(a => a.outcome), ["accepted", "invalid_response", "ungrounded"]);
assert.deepEqual(attempts.map(a => a.code), [null, "invalid_json", "unknown_citation"]);
assert.ok(attempts.every(a => a.rules === READING_RULES && a.parser === READING_PARSER_VERSION && a.model === "fixture-v1" && a.attempts === 1));
assert.deepEqual(failures, ["invalid_response", "ungrounded"]);
assert.deepEqual(prompt?.projectState, [{ index: 1, statement: input.projectContext[0] }]);
assert.equal(JSON.stringify(attempts).includes(raw.whatChanged), false, "Diagnostics never store model prose");
await assessPublicMaterial({ ...input, headline: "x", generate: async () => ({ ok: false, provider: "Fixture", protocol: "openai-compatible", model: "unavailable", reason: "not_configured", attempted: false, attempts: 0 }),
  onAttempt: attempt => { assert.equal(attempt.attempted, false); assert.equal(attempt.attempts, 0); } });

const github = (opts: { status?: number; badCommits?: boolean; badRelease?: boolean; brokenRepo?: string } = {}) => (async (url: string | URL) => {
  const path = String(url);
  if (opts.status && (!opts.brokenRepo || path.includes(opts.brokenRepo))) return new Response(null, { status: opts.status });
  if (path.includes("/commits?")) return Response.json(opts.badCommits ? {} : []);
  if (path.endsWith("/releases/latest")) return opts.badRelease ? Response.json({}) : new Response(null, { status: 404 });
  return Response.json({ pushed_at: now.toISOString(), stargazers_count: 1 });
}) as typeof fetch;
const pulse = (fetchImpl: typeof fetch, requests: GithubRequest[] = []) => observeRepositoryPulse({
  ref: "circlefin/stablecoin-evm", label: "USDC", interest: "Arc", now, fetchImpl, outcome: { failure: null as GithubReadFailure, requests },
});
const requests: GithubRequest[] = [];
assert.ok(await pulse(github(), requests), "Release 404 is normal, with valid commits and repository metadata");
assert.equal(requests.length, 3);
assert.equal(requests.filter(r => r.outcome === "no_release").length, 1);
for (const status of [401, 403, 404, 429, 503]) {
  const run = await observeRepositories({ interests: ["Arc"], now, fetchImpl: github({ status, brokenRepo: "stablecoin-evm" }) });
  assert.ok(run.observations.length > 0, "Healthy repositories remain available");
  assert.ok(run.unavailable.length, `Partial HTTP ${status} must be visible`);
  assert.ok(run.githubRequests?.some(r => r.status === status && r.outcome === (status === 429 ? "rate_limited" : "http_error")));
}
assert.equal(await pulse(github({ badCommits: true })), null, "A malformed commits response is not zero commits");
assert.equal(await pulse(github({ badRelease: true })), null, "A malformed release response is not a removed release");
const network = await observeRepositories({ interests: ["Arc"], now, fetchImpl: async () => { throw new Error("secret transport details"); } });
assert.ok(network.githubRequests?.every(r => r.outcome === "transport_error" && r.status === null));
assert.equal(JSON.stringify(network).includes("secret transport"), false);

// Never persist or expose provider error bodies, even when HTTP says 200.
const envelopes: Array<[string, string]> = [
  ["private request data", "body_not_json"],
  [JSON.stringify({ error: { message: "secret-token" } }), "provider_error_envelope"],
  [JSON.stringify({ choices: [] }), "missing_choices"],
  [JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "length" }] }), "completion_limit"],
  [JSON.stringify({ choices: [{ message: { refusal: "secret input" } }] }), "provider_refusal"],
];
for (const [body, code] of envelopes) {
  const result = await generateOpenAiCompatibleText({ config: { provider: "Fixture", protocol: "openai-compatible", baseUrl: "https://example.invalid/v1", model: "fixture", apiKey: "private-key", userAgent: null },
    systemPrompt: "x", userPrompt: "y", maxAttempts: 1, fetchImpl: async () => new Response(body) });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.detail, code);
}

console.log("PASS: Nova reliability — valid/invalid parser outputs, strict citations and owner facts, semantic limitation, honest no-plan UI, model/rules diagnostics, GitHub partial/HTTP/shape failures, expected release 404, secret-safe provider diagnostics.");
