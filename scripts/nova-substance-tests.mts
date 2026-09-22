/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import assert from "node:assert/strict";
import { LEGACY_TEXT_CAP, coverageSentence, wasCut, type PublicMaterial } from "../lib/nova/value.ts";
import { EXCERPT_SENTENCES, readingCoverage, sourceExcerpts } from "../lib/nova/free-research.ts";
import { ARTICLE_TEXT_CAP, parsePublication, readPublicPage } from "../lib/nova/public-sources.ts";
import { VISIT_GAP_MS, assembleBrief, endpointOf, visitBoundary } from "../lib/nova/brief.ts";
import { publishedAtOf, sinceLastVisit } from "../lib/nova/presentation.ts";
import { forThePage } from "../lib/nova/service.ts";
import { NOVA_WITHHOLD_REASONS, type NovaSignal } from "../lib/nova/types.ts";

const now = new Date("2026-09-23T09:00:00Z");
const sentences = (n: number) => Array.from({ length: n }, (_, i) => `Sentence number ${i + 1} says something about Arc.`).join(" ");
const material = (text: string, extra: Partial<PublicMaterial> = {}): PublicMaterial =>
  ({ id: "https://www.arc.io/blog/x", url: "https://www.arc.io/blog/x", title: "X", text, publishedAt: "2026-09-14T00:00:00Z", fetchedAt: "2026-09-21T00:00:00Z", ...extra });

/* ---- a reading says how much of the article it stands on ---- */

assert.equal(EXCERPT_SENTENCES, 24, "What the model is given is unchanged until a new edition is measured");
assert.equal(sourceExcerpts([material(sentences(40))]).length, 24);
assert.deepEqual(readingCoverage(material(sentences(32))), { sentencesRead: 24, sentencesKept: 32, cut: false });
assert.deepEqual(readingCoverage(material(sentences(7))), { sentencesRead: 7, sentencesKept: 7, cut: false });

/* Stored before the flag existed: cut exactly at the old cap, and only then. */
assert.equal(wasCut({ text: "x".repeat(LEGACY_TEXT_CAP) }), true);
assert.equal(wasCut({ text: "x".repeat(LEGACY_TEXT_CAP - 1) }), false);
assert.equal(wasCut({ text: "x".repeat(LEGACY_TEXT_CAP), truncated: false }), false, "The flag, where present, is the answer");
assert.equal(wasCut({ text: "short", truncated: true }), true);

assert.equal(coverageSentence(null), null);
assert.equal(coverageSentence({ sentencesRead: 7, sentencesKept: 7, cut: false }), "Read the whole article.");
assert.equal(coverageSentence({ sentencesRead: 24, sentencesKept: 32, cut: true }),
  "Read the first 24 of 32 sentences Nova kept from a longer article. The rest was not read.",
  "StableFX, as the owner's Today had it");
assert.equal(coverageSentence({ sentencesRead: 24, sentencesKept: 40, cut: false }), "Read the first 24 of 40 sentences. The rest was not read.");
assert.match(coverageSentence({ sentencesRead: 7, sentencesKept: 7, cut: true })!, /^Read everything Nova kept, which is the start of a longer article\./);

/* An article longer than what is kept says so; one that fits does not. */
const page = (body: string) => `<html><head><meta property="article:published_time" content="2026-09-20T00:00:00Z"></head><body><h1>Arc ships</h1><article>${body}</article></body></html>`;
const long = parsePublication(page("Arc documents the change in detail. ".repeat(600)), "https://www.arc.io/blog/long", now)!;
assert.equal(long.text.length, ARTICLE_TEXT_CAP);
assert.equal(long.truncated, true);
const short = parsePublication(page("Arc documents the change in detail. ".repeat(20)), "https://www.arc.io/blog/short", now)!;
assert.equal(short.truncated, false);

/* ---- one redirect, on the same approved site, and no further ---- */

const pages = (routes: Record<string, () => Response>): { fetchImpl: typeof fetch; asked: string[] } => {
  const asked: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    asked.push(String(url));
    return (routes[String(url)] ?? (() => new Response("missing", { status: 404 })))();
  }) as unknown as typeof fetch;
  return { fetchImpl, asked };
};
const moved = pages({
  "https://developers.circle.com/gateway/nanopayments/supported-networks.md": () => new Response(null, { status: 307, headers: { location: "/gateway-nanopayments/supported-networks.md" } }),
  "https://developers.circle.com/gateway-nanopayments/supported-networks.md": () => new Response("# Supported networks"),
});
assert.equal(await readPublicPage("https://developers.circle.com/gateway/nanopayments/supported-networks.md", moved.fetchImpl), "# Supported networks",
  "Circle moved the page within its own docs; the reading follows it once");
assert.equal(moved.asked.length, 2);

const offsite = pages({ "https://docs.arc.io/a.md": () => new Response(null, { status: 302, headers: { location: "https://evil.example/a.md" } }) });
await assert.rejects(readPublicPage("https://docs.arc.io/a.md", offsite.fetchImpl), /moved off its approved site/);
assert.equal(offsite.asked.length, 1, "A redirect off the site is never requested");

const crossApproved = pages({ "https://docs.arc.io/a.md": () => new Response(null, { status: 302, headers: { location: "https://www.arc.io/blog/a" } }) });
await assert.rejects(readPublicPage("https://docs.arc.io/a.md", crossApproved.fetchImpl), /moved off its approved site/,
  "Another approved origin is still another origin");

const twice = pages({
  "https://docs.arc.io/a.md": () => new Response(null, { status: 301, headers: { location: "/b.md" } }),
  "https://docs.arc.io/b.md": () => new Response(null, { status: 301, headers: { location: "/c.md" } }),
});
await assert.rejects(readPublicPage("https://docs.arc.io/a.md", twice.fetchImpl), /more than once/);

/* ---- where "new since your last visit" starts ---- */

const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
assert.deepEqual(visitBoundary({ lastOpenedAt: ago(5 * 60_000), seenThrough: null, now }), { seenThrough: null, newVisit: false },
  "A first visit marks nothing: everything is new, which is the same as nothing");
assert.deepEqual(visitBoundary({ lastOpenedAt: ago(2 * 3_600_000), seenThrough: ago(26 * 3_600_000), now }), { seenThrough: ago(2 * 3_600_000), newVisit: true },
  "A new visit starts where the last one ended");
assert.deepEqual(visitBoundary({ lastOpenedAt: ago(10 * 60_000), seenThrough: ago(26 * 3_600_000), now }), { seenThrough: ago(26 * 3_600_000), newVisit: false },
  "A reload inside a visit, after a button, does not move the boundary");
assert.equal(visitBoundary({ lastOpenedAt: ago(VISIT_GAP_MS + 1000), seenThrough: null, now }).newVisit, true);
assert.deepEqual(visitBoundary({ lastOpenedAt: null, seenThrough: null, now }), { seenThrough: null, newVisit: true });

const seenThrough = "2026-09-22T19:09:06Z";
const reading = (generatedAt: string) => ({ valueAssessment: { version: 1, goal: "g", significant: true, whatChanged: "", whyItMatters: "", citations: [], gap: null, sources: [], generatedAt, writtenBy: "m" } });
assert.equal(sinceLastVisit({ observedAt: "2026-09-23T00:10:00Z", evidence: {} }, seenThrough), "new");
assert.equal(sinceLastVisit({ observedAt: "2026-09-21T16:45:00Z", evidence: reading("2026-09-23T06:00:00Z") }, seenThrough), "re-read");
assert.equal(sinceLastVisit({ observedAt: "2026-09-21T16:45:00Z", evidence: reading("2026-09-22T18:58:00Z") }, seenThrough), null);
assert.equal(sinceLastVisit({ observedAt: "2026-09-23T00:10:00Z", evidence: {} }, null), null);

/* When it happened, not only when Nova found it. */
assert.equal(publishedAtOf({ evidence: { subject: { publicMaterial: { publishedAt: "2026-09-14T00:00:00Z" } } } }), "2026-09-14T00:00:00Z");
assert.equal(publishedAtOf({ evidence: { publicMaterial: { publishedAt: "not a date" } } }), null);
assert.equal(publishedAtOf({ evidence: {} }), null);

/* ---- one listing per endpoint ---- */

const listing = (id: string, observedAt: string, subject: Record<string, unknown>) => ({
  signalId: id, kind: "capability_available" as const, relevance: "low" as const, observedAt,
  subjectRef: `x402:${id}`, evidence: { subject },
});
const parallel = { resource: "https://parallelmpp.dev/api/search", method: "POST", network: "eip155:8453", funding: "wallet" };
const listings = [
  listing("p1", "2026-09-22T00:10:00Z", { ...parallel, payTo: "0x3b22" }),
  listing("p2", "2026-09-22T10:04:00Z", { ...parallel, payTo: "0x99c5" }),
  listing("p3", "2026-09-22T18:58:00Z", { ...parallel, payTo: "0xcce9" }),
  listing("p4", "2026-09-22T13:28:00Z", { ...parallel, payTo: "0x8e5d" }),
  listing("arc", "2026-09-22T12:00:00Z", { ...parallel, network: "eip155:5042" }),
  listing("other", "2026-09-22T11:00:00Z", { resource: "https://example.com/api", method: "GET", network: "eip155:8453", funding: "wallet" }),
];
assert.equal(endpointOf(listings[0]), endpointOf(listings[1]), "A new payee is not a new endpoint");
assert.notEqual(endpointOf(listings[0]), endpointOf(listings[4]), "Another chain is");
assert.equal(endpointOf({ evidence: {} }), null);
const market = assembleBrief(listings);
assert.deepEqual(market.overflow.map(s => s.signalId).sort(), ["arc", "other", "p3"],
  "Parallel search once, and the newest of it");
assert.deepEqual(market.withheld.duplicate.map(s => s.signalId).sort(), ["p1", "p2", "p4"]);
const grouped = NOVA_WITHHOLD_REASONS.flatMap((reason) => market.withheld[reason]);
assert.equal(grouped.length, new Set(grouped).size, "Nothing counted twice");
assert.ok(market.withheld.duplicate.every(s => !market.overflow.includes(s)), "A duplicate is held, and not listed a second time");

/* ---- the page gets no article text ---- */

const read = {
  signalId: "s", kind: "official_publication", headline: "H", detail: "d", relevance: "high", relevanceReason: "", status: "seen",
  observedAt: "2026-09-21T00:00:00Z", subjectId: null, subjectLabel: null, subjectRef: null, subjectKind: null, interest: null, settlesOn: null,
  executionPublicId: null, refusal: null,
  evidence: {
    label: "Arc announcements",
    publicMaterial: material("x".repeat(LEGACY_TEXT_CAP)),
    subject: { url: "https://www.arc.io/blog/x", publicMaterial: material(sentences(32).padEnd(LEGACY_TEXT_CAP, " ").slice(0, LEGACY_TEXT_CAP)) },
    valueAssessment: { ...reading("2026-09-22T18:58:00Z").valueAssessment, sources: [material(sentences(32).padEnd(LEGACY_TEXT_CAP, " ").slice(0, LEGACY_TEXT_CAP)), material(sentences(5), { id: "ref", url: "https://docs.arc.io/r.md" })] },
  },
} as unknown as NovaSignal;
const sent = forThePage(read);
const texts = JSON.stringify(sent.evidence).match(/"text":"[^"]+"/g) ?? [];
assert.deepEqual(texts, [], "No copy of the article reaches the page");
assert.deepEqual((sent.evidence.valueAssessment as { coverage: unknown }).coverage, { sentencesRead: 24, sentencesKept: 32, cut: true },
  "An older reading's coverage is worked out before its text is dropped");
assert.equal((sent.evidence.subject as { url: string }).url, "https://www.arc.io/blog/x", "Everything else on the card survives");
assert.equal((sent.evidence.valueAssessment as { sources: Array<{ url: string }> }).sources[1].url, "https://docs.arc.io/r.md");
assert.ok(JSON.stringify(sent).length < JSON.stringify(read).length / 3);

console.log("PASS: substance — a reading that says how much of the article it read and whether the article was longer, the model's input unchanged until a new edition is measured, one redirect followed only within the same approved site, a visit boundary that a reload inside the visit does not move, the date a thing happened alongside the date Nova found it, one listing per endpoint whatever payee it names, and a brief that carries no article text to the page.");
