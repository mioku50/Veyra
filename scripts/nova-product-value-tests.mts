/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import assert from "node:assert/strict";
import { assembleBrief } from "../lib/nova/brief.ts";
import { ATTENDED_READING_BUDGET, PUBLIC_READING_BUDGET, readingOrder } from "../lib/nova/service.ts";
import { scoreFloorFor } from "../lib/nova/relevance.ts";
import { NOVA_WITHHOLD_REASONS } from "../lib/nova/types.ts";
import { changesForSubject, repositoryDigest } from "../lib/nova/observation.ts";
import { normalizeGoal, paidResearchReadiness, type PublicMaterial } from "../lib/nova/value.ts";
import { READING_FAILURE_DETAIL, assessPublicMaterial, parseValueAssessment } from "../lib/nova/free-research.ts";
import { parseFeed, parsePublication, publicationUrl, readPublicPage, observePublications } from "../lib/nova/public-sources.ts";
import { proposeResearch } from "../lib/nova/research.ts";
import type { NovaSignal } from "../lib/nova/types.ts";
const now = new Date("2026-09-20T12:00:00Z");
const goal = "Track Arc changes that matter to building Veyra.";
const source: PublicMaterial = { id: "source-a", url: "https://www.arc.io/blog/example", title: "Network release", text: "The network release adds a new public endpoint for developers. Compatibility must be checked separately.", publishedAt: "2026-09-19T12:00:00Z", fetchedAt: now.toISOString() };
const second: PublicMaterial = { ...source, id: "source-b", url: "https://docs.arc.io/reference" };
const raw = { significant: true, whatChanged: "The source announces a public endpoint.", whyItMatters: "Your integration needs a compatibility check.", nextStep: "Compare the documented interfaces to your app.", citations: [{ sourceId: source.id, quote: "The network release adds a new public endpoint for developers." }], gap: { question: "Does the Arc endpoint support the response shape required by this integration?", missing: "The supplied material does not describe the response shape.", expectedResult: "A documented response schema to compare with the integration." } };
const input = { goal, sources: [source, second], now, writtenBy: "fixture" };
const value = parseValueAssessment(JSON.stringify(raw), input)!;
assert(value);
assert(parseValueAssessment(JSON.stringify({ ...raw, citations: undefined, citationIds: ["s1.e1"] }), input));
assert.equal(parseValueAssessment(JSON.stringify({ ...raw, citations: undefined, citationIds: ["s1.fake"] }), input), null);
assert(parseValueAssessment(JSON.stringify({ ...raw, citations: [{ sourceId: source.id, quote: `"${source.text}"` }] }), input), "Allow formatting quotes only when the inner text still exactly matches the source");
assert.equal(parseValueAssessment(JSON.stringify({ ...raw, citations: [{ sourceId: second.id, quote: source.text }] }), input), null, "The event itself must support the finding, not just a context document");
assert.equal(parseValueAssessment(JSON.stringify({ ...raw, citations: [{ sourceId: "invented", quote: source.text }] }), input), null);
assert.equal(parseValueAssessment(JSON.stringify({ ...raw, citations: [{ sourceId: source.id, quote: "The application is definitely ready to spend on mainnet." }] }), input), null);
assert.equal(parseValueAssessment('{"significant":true}', input), null);

/* Six causes used to arrive as one sentence. A provider that is not
   configured, a clock that ran out and an answer that did not match its
   sources ask three different things of whoever reads the card. */
const failures: string[] = [];
assert.equal(await assessPublicMaterial({ goal, headline: "x", sources: [source], now,
  generate: async () => ({ ok: false, provider: "p", protocol: "openai-compatible", model: "m", reason: "timeout", attempted: true, attempts: 1 }),
  onFailure: (reason) => failures.push(reason) }), null);
assert.equal(await assessPublicMaterial({ goal, headline: "x", sources: [source], now,
  generate: async () => ({ ok: true, provider: "p", protocol: "openai-compatible", model: "m", text: '{"significant":true}', attempts: 1 }),
  onFailure: (reason) => failures.push(reason) }), null);
assert.deepEqual(failures, ["timeout", "ungrounded"], "No answer and a rejected answer are not the same event");
assert(READING_FAILURE_DETAIL.not_configured.includes("not configured"));
assert.equal(Object.values(READING_FAILURE_DETAIL).some(text => !text.trim()), false, "Every cause has words of its own");
assert.equal(normalizeGoal("  Build   Veyra  "), "Build Veyra");
assert.throws(() => normalizeGoal("x".repeat(601)));
assert.equal(normalizeGoal(null), null);
const signal: NovaSignal = { signalId: "sig", subjectId: "subject", subjectLabel: "Arc", subjectKind: "official_publication", subjectRef: source.url, interest: "Arc", kind: "official_publication", headline: source.title, detail: source.text, evidence: { valueAssessment: value }, observedAt: now.toISOString(), relevance: "high", relevanceReason: "goal", status: "new", executionPublicId: null };
assert(paidResearchReadiness(signal, goal, now).ready);
for (const candidate of [
  { ...signal, kind: "repository_activity" as const },
  { ...signal, kind: "capability_available" as const },
  { ...signal, evidence: {} },
  { ...signal, evidence: { valueAssessment: { ...value, gap: null } } },
  { ...signal, evidence: { valueAssessment: { ...value, significant: false } } },
  { ...signal, evidence: { valueAssessment: { ...value, sources: [source] } } },
  { ...signal, evidence: { valueAssessment: { ...value, sourcesUnavailable: ["reference"] } } },
]) assert.equal(paidResearchReadiness(candidate, goal, now).ready, false);
assert.equal(paidResearchReadiness(signal, "a different goal", now).ready, false);
assert.equal(paidResearchReadiness(signal, null, now).ready, false);
assert.equal(paidResearchReadiness(signal, goal, new Date("2026-09-22")).ready, false);
let requests = 0;
const refused = await proposeResearch({ signal: { ...signal, kind: "repository_activity" }, goal, now,
  fetchImpl: async () => { requests++; throw new Error("No marketplace call is justified"); } });
assert(!refused.ok); assert.equal(requests, 0);
const old = { ...signal, signalId: "old", observedAt: "2026-09-19T12:00:00Z" };
const commits = { ...signal, signalId: "commits", kind: "repository_activity" as const };
const listing = { ...signal, signalId: "listing", kind: "capability_available" as const };
const security = { ...signal, signalId: "warning", kind: "payee_changed" as const, evidence: {} };
const brief = assembleBrief([old, signal, commits, listing, security], { goal });
assert.deepEqual(new Set(brief.worthAttention.map(s => s.signalId)), new Set(["sig", "warning"]));
assert.equal(assembleBrief([signal], { goal: "different" }).worthAttention.length, 0);
assert.equal(assembleBrief([{ ...signal, evidence: { valueAssessment: { ...value, significant: false } } }], { goal }).worthAttention.length, 0);

/* Held back, by the reason it was held. A brief driven by a goal rejects most
   of its material at the significance gate, so counting only relevance told
   somebody "held back as noise: 0" on a pass that filtered everything. */
assert.deepEqual(brief.withheld.duplicate.map(s => s.signalId), ["old"]);
assert.deepEqual(new Set(brief.withheld.background.map(s => s.signalId)), new Set(["commits", "listing"]));
assert.deepEqual(brief.withheld.noise, []);
const unread = { ...signal, signalId: "unread", subjectRef: "https://www.arc.io/blog/unread", evidence: {} };
const insignificant = { ...signal, signalId: "dull", subjectRef: "https://www.arc.io/blog/dull", evidence: { valueAssessment: { ...value, significant: false } } };
const staleGoal = { ...signal, signalId: "stale", subjectRef: "https://www.arc.io/blog/stale", evidence: { valueAssessment: { ...value, goal: "an older goal" } } };
const held = assembleBrief([signal, unread, insignificant, staleGoal], { goal });
assert.deepEqual(held.worthAttention.map(s => s.signalId), ["sig"]);
assert.deepEqual(new Set(held.withheld.not_analyzed.map(s => s.signalId)), new Set(["unread", "stale"]),
  "No reading for the goal in force is a gap in coverage, not a verdict on the material");
assert.deepEqual(held.withheld.not_significant.map(s => s.signalId), ["dull"]);
const crowd = Array.from({ length: 6 }, (_, index) => ({ ...security, signalId: `alert-${index}`, subjectRef: `subject-${index}` }));
const capped = assembleBrief(crowd, { goal });
assert.equal(capped.worthAttention.length, 5);
assert.equal(capped.withheld.over_cap.length, 1);
/* Every bucket but noise is the watchlist, and nothing is counted twice: the
   panel adds these up in front of a person. */
for (const sample of [brief, held, capped]) {
  const grouped = NOVA_WITHHOLD_REASONS.flatMap((reason) => sample.withheld[reason]);
  assert.equal(grouped.length, new Set(grouped).size);
  assert.deepEqual(new Set(grouped), new Set([...sample.noise, ...sample.overflow]));
  assert.equal(grouped.length + sample.worthAttention.length, new Set([...grouped, ...sample.worthAttention]).size);
}

/* The reading budget is spent by relevance, not by whatever the source list
   returned first and not on the new events merely for being new: an unread
   publication cannot clear the significance gate, so this order decides the
   brief. Inside a band a correction goes first -- a card whose reading was
   made against a project state the owner has since changed is wrong on the
   screen now, while an unread event is only missing. */
const candidate = (headline: string, over: Partial<{ relevance: "high" | "medium" | "low"; correction: boolean; onScreen: boolean; score: number; observedAt: string }> = {}) => ({
  headline, relevance: "medium" as const, correction: false, onScreen: false, score: 50, observedAt: "2026-09-20T10:00:00Z", ...over,
});
const candidates = [
  candidate("fresh medium, newer", { observedAt: "2026-09-20T12:00:00Z" }),
  candidate("fresh medium, older"),
  candidate("stale medium", { correction: true, onScreen: true, score: scoreFloorFor("medium") }),
  candidate("unread medium", { score: scoreFloorFor("medium"), observedAt: "2026-09-18T10:00:00Z" }),
  candidate("fresh high", { relevance: "high", score: 80 }),
  candidate("stale low", { relevance: "low", correction: true, onScreen: true, score: scoreFloorFor("low") }),
];
assert.deepEqual(readingOrder(candidates).map(entry => entry.headline), [
  "fresh high",
  "stale medium",
  "fresh medium, newer",
  "fresh medium, older",
  "unread medium",
  "stale low",
], "Band first, then the correction, then score and recency");

/* Bumping the reading rules retires every stored reading at once, and a flag
   every candidate carries sorts nothing. What separates them then is whether
   the stale paragraph is one the owner is looking at: a card held back as
   insignificant is very likely to be held back again, and re-reading it
   changes nothing on the screen. */
const allStale = [
  candidate("held back, newest", { correction: true, observedAt: "2026-09-20T18:00:00Z" }),
  candidate("held back, newer", { correction: true, observedAt: "2026-09-20T17:00:00Z" }),
  candidate("on Today", { correction: true, onScreen: true, observedAt: "2026-09-20T09:00:00Z" }),
  candidate("never read", { observedAt: "2026-09-20T08:00:00Z" }),
];
assert.deepEqual(readingOrder(allStale).map(entry => entry.headline), [
  "on Today", "never read", "held back, newest", "held back, newer",
], "A stale reading the owner can see, then one nobody has made, then one nobody sees");
assert.equal(scoreFloorFor("noise"), 0);
assert(scoreFloorFor("high") > scoreFloorFor("medium") && scoreFloorFor("medium") > scoreFloorFor("low"));
assert.equal(readingOrder(candidates).length, candidates.length, "Ranking selects an order, the budget selects how many");
assert.deepEqual(readingOrder([candidate("no flag", { relevance: "low" }), candidate("high band")]).map(e => e.headline), ["high band", "no flag"], "onScreen is optional and absent means not on the screen");
assert.deepEqual(readingOrder(candidates).slice(0, PUBLIC_READING_BUDGET).map(entry => entry.headline),
  ["fresh high", "stale medium"],
  "What a scheduled tick's readings are actually spent on: today's most important event, then the card that is currently wrong");
assert.deepEqual(readingOrder([candidate("a", { observedAt: "not a date" }), candidate("b")]).map(e => e.headline), ["b", "a"]);
/* A pass somebody is waiting on reads further into the backlog than an
   unattended one, and neither is unbounded. */
assert(ATTENDED_READING_BUDGET > PUBLIC_READING_BUDGET && ATTENDED_READING_BUDGET <= 8);
const xml = `<rss><channel><item><title>Release</title><link>https://blog.ethereum.org/release</link><pubDate>2026-09-19T12:00:00Z</pubDate><description>${source.text}</description></item><item><title>Future</title><link>https://blog.ethereum.org/future</link><pubDate>2027-01-01</pubDate><description>${source.text}</description></item><item><title>Bad link</title><link>http://127.0.0.1/private</link><pubDate>2026-09-19</pubDate><description>${source.text}</description></item></channel></rss>`;
assert.equal(parseFeed(xml, "https://blog.ethereum.org/feed.xml", now).length, 1);
assert.throws(() => parseFeed("<html>not RSS</html>", source.url, now));
assert.equal(publicationUrl("https://www.arc.io.evil.example/blog/a", source.url), null);
assert.equal(publicationUrl("https://user:pass@www.arc.io/blog/a", source.url), null);
assert.equal(publicationUrl("http://127.0.0.1", source.url), null);
let fetched = 0;
await assert.rejects(readPublicPage("http://127.0.0.1", async () => { fetched++; return new Response(""); }));
assert.equal(fetched, 0);
await assert.rejects(readPublicPage(source.url, async () => new Response("Payment required", { status: 402 })));
await assert.rejects(readPublicPage(source.url, async () => new Response("x".repeat(1_500_001))));
const html = `<html><script type="application/ld+json">{"datePublished":"2026-09-19"}</script><h1>Release</h1><div class="w-richtext">short</div><article>${source.text}</article></html>`;
assert.equal(parsePublication(html, source.url, now)?.title, "Release");
assert.equal(parsePublication(html.replace('"2026-09-19"','"2027-01-01"'), source.url, now), null);
assert.throws(() => parsePublication("<h1>Missing metadata</h1><article>" + source.text + "</article>", source.url, now));
const discovery = await observePublications({ interests: ["Arc"], now, fetchImpl: async url => {
  const u = String(url);
  if (u === "https://www.arc.io/blog") return new Response([1,2,3,4].map(i => `<a href="/blog/post-${i}">Post</a>`).join(""));
  if (u.startsWith("https://www.arc.io/blog/post-")) return new Response(u.endsWith("4") ? html : html.replace('"2026-09-19"', '"2025-01-01"'));
  return new Response("Unavailable", { status: 503 });
} });
assert.equal(discovery.observations.length, 1, "Pinned old posts must not hide the fourth fresh article");
assert(discovery.unavailable.includes("Circle announcements"));
const publication = { kind: "official_publication" as const, material: source };
assert.equal(changesForSubject({ label: "Arc", previous: null, next: publication, now }).length, 1);
assert.equal(changesForSubject({ label: "Arc", previous: publication, next: publication, now }).length, 0);
const release = repositoryDigest({ lastCommitAt: null, commitsInWindow: 0, contributorCount: 0, latestRelease: "v2", stars: 1, releaseMaterial: source });
assert.equal(changesForSubject({ label: "Repo", previous: null, next: release, now })[0].kind, "repository_release");
assert.equal(await assessPublicMaterial({ goal, headline: "Release", sources: [source], generate: async () => { throw new Error("offline"); } }), null);
console.log("PASS: goals, significant-event selection, historical noise, deduplication, why each held-back item was held, a reading budget spent by relevance, grounded citations, unavailable-source handling, paid-need gates, bounded official readers, a failed reading that says which of six things failed, and release first-look.");
