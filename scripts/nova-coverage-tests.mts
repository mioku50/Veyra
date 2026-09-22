/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import assert from "node:assert/strict";
import { coverageReport } from "../lib/nova/coverage-report.ts";
import { observePublications } from "../lib/nova/public-sources.ts";
import { READING_RULES } from "../lib/nova/value.ts";

const now = new Date("2026-09-22T12:00:00Z");

/* ---- a host that did not answer is not an article that did not parse ---- */

const article = (date: string) => `<html><head><meta property="article:published_time" content="${date}"></head>
  <body><h1>Arc ships a thing</h1><article>${"Arc documents the change in detail. ".repeat(12)}</article></body></html>`;
const index = `<html><body>
  <a href="https://www.langchain.com/blog/one">one</a>
  <a href="https://www.langchain.com/blog/two">two</a>
  <a href="https://www.langchain.com/blog/three">three</a>
</body></html>`;

function reader(pages: Record<string, { status: number; body: string }>): typeof fetch {
  return (async (url: string | URL) => {
    const page = pages[String(url)];
    if (!page) return new Response("missing", { status: 404 });
    return new Response(page.body, { status: page.status, headers: { "content-type": "text/html" } });
  }) as unknown as typeof fetch;
}

/* One article with no date at all. The page was fetched; the parser did not
   understand it. Reported for twelve passes of the D0 epoch as "could not
   reach LangChain announcements", which was false every time. */
const undated = await observePublications({
  interests: ["ai"], now,
  fetchImpl: reader({
    "https://www.langchain.com/blog": { status: 200, body: index },
    "https://www.langchain.com/blog/one": { status: 200, body: article("2026-09-21T00:00:00Z") },
    "https://www.langchain.com/blog/two": { status: 200, body: "<html><body><h1>No date here</h1><article>x</article></body></html>" },
    "https://www.langchain.com/blog/three": { status: 200, body: article("2026-09-20T00:00:00Z") },
  }),
});
assert.deepEqual(undated.unavailable, [], "A page that was read is not a source that could not be reached");
assert.deepEqual(undated.unreadable, { "LangChain announcements": 1 }, "It is counted, under its own name");
assert.equal(undated.observations.length, 2, "and the articles that did parse still arrive");

/* A host that genuinely did not answer still says so. */
const unreachable = await observePublications({
  interests: ["ai"], now,
  fetchImpl: reader({
    "https://www.langchain.com/blog": { status: 200, body: index },
    "https://www.langchain.com/blog/one": { status: 200, body: article("2026-09-21T00:00:00Z") },
    "https://www.langchain.com/blog/three": { status: 200, body: article("2026-09-20T00:00:00Z") },
  }),
});
assert.deepEqual(unreachable.unavailable, ["LangChain announcements (some articles unavailable)"]);
assert.deepEqual(unreachable.unreadable, {}, "and that is not also counted as a parse failure");

/* An old post the index still lists is neither. It is the ordinary case. */
const old = await observePublications({
  interests: ["ai"], now,
  fetchImpl: reader({
    "https://www.langchain.com/blog": { status: 200, body: index },
    "https://www.langchain.com/blog/one": { status: 200, body: article("2026-09-21T00:00:00Z") },
    "https://www.langchain.com/blog/two": { status: 200, body: article("2025-01-01T00:00:00Z") },
    "https://www.langchain.com/blog/three": { status: 200, body: article("2026-09-20T00:00:00Z") },
  }),
});
assert.deepEqual(old.unavailable, []);
assert.deepEqual(old.unreadable, {}, "An article older than the window is not a failure of any kind");
assert.equal(old.observations.length, 2);

/* ---- the report, over rows the scheduler wrote ---- */

const refreshes = [
  { trigger: "scheduled", subjects_checked: 20, signals_found: 5, signals_kept: 4, signals_as_noise: 1, duration_ms: 1000,
    sources_unavailable: ["LangChain announcements", "Nova public-source analysis (timeout)"],
    articles_unreadable: { "Arc announcements": 2 }, readings_attempted: 3, reading_failures: { timeout: 1 } },
  { trigger: "scheduled", subjects_checked: 20, signals_found: 3, signals_kept: 3, signals_as_noise: 0, duration_ms: 9000,
    sources_unavailable: ["LangChain announcements"],
    articles_unreadable: { "Arc announcements": 1 }, readings_attempted: 2, reading_failures: { ungrounded: 1, timeout: 1 } },
  { trigger: "manual", subjects_checked: 20, signals_found: 0, signals_kept: 0, signals_as_noise: 0, duration_ms: 3000,
    sources_unavailable: [], articles_unreadable: {}, readings_attempted: 1, reading_failures: {} },
];
const ticks = [
  { stopped_early: false, shadow_decided: 2, shadow_would_allow: 1, shadow_blocked: { no_mandate: 1 }, shadow_unpriced: { no_quote: 3 } },
  { stopped_early: true, shadow_decided: 1, shadow_would_allow: 0, shadow_blocked: {}, shadow_unpriced: { no_quote: 1, no_service: 2 } },
];
const signals = [{ rules: String(READING_RULES) }, { rules: String(READING_RULES) }, { rules: "5" }, { rules: null }, { rules: null }];

/* A thenable that is also its own query builder: every chained call returns
   the same object, and awaiting it anywhere in the chain yields the rows. */
const table = (rows: unknown[]) => {
  const result = Promise.resolve({ data: rows, error: null }) as Promise<{ data: unknown[]; error: null }> & Record<string, unknown>;
  for (const method of ["select", "gte", "lte", "order", "limit", "eq"]) result[method] = () => result;
  return result;
};
const db = { from: (name: string) => table(name === "nova_refreshes" ? refreshes : name === "nova_ticks" ? ticks : signals) };

const report = await coverageReport(db as never, { from: "2026-09-15T00:00:00Z", to: "2026-09-22T00:00:00Z" });

assert.equal(report.passes.total, 3);
assert.deepEqual(report.passes.byTrigger, { scheduled: 2, manual: 1 });
assert.equal(report.coverage.signalsFound, 8);
assert.equal(report.coverage.notKept, 1, "Found and not kept is a number of its own, not the noise count");

/* A reading failure is recorded twice on purpose -- once for the owner in
   sources_unavailable, once as a count -- and must be reported once. */
assert.deepEqual(report.unavailable, { "LangChain announcements": 2 }, "The reading note is not a source that failed");
assert.deepEqual(report.unreadable, { "Arc announcements": 3 });

/* The model invalid-output rate, by cause. */
assert.equal(report.reading.attempted, 6);
assert.equal(report.reading.failed, 3);
assert.deepEqual(report.reading.byCause, { timeout: 2, ungrounded: 1 });
assert.equal(report.reading.failureRate, "50.0%");

assert.equal(report.durationMs.max, 9000);
assert.equal(report.ticks.recorded, 2);
assert.equal(report.ticks.stoppedEarly, 1);
assert.deepEqual(report.ticks.shadowUnpriced, { no_quote: 4, no_service: 2 }, "The figure the D0 capture could not answer");
assert.deepEqual(report.ticks.shadowBlocked, { no_mandate: 1 });

assert.deepEqual(report.cards, { stored: 5, underCurrentRules: 2, stale: 1, neverRead: 2 });

/* Nothing measurable is claimed for what is not measured. */
assert(report.limitations.some(l => l.includes("Missed important events")));
assert(report.limitations.some(l => l.includes("costs")));

/* An empty window is an empty report, not a crash or a divide by zero. */
const empty = await coverageReport({ from: () => table([]) } as never, { from: "2026-09-01T00:00:00Z", to: "2026-09-02T00:00:00Z" });
assert.equal(empty.passes.total, 0);
assert.equal(empty.reading.failureRate, "n/a");
assert.deepEqual(empty.durationMs, { median: 0, p90: 0, max: 0 });

console.log("PASS: coverage — a host that did not answer told apart from an article that did not parse and from an old post that is neither, a reading failure counted once rather than twice, the model invalid-output rate by named cause, the unpriced reasons the D0 capture could not answer, and the two measurements nobody can take named instead of approximated.");
