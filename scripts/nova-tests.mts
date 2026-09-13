/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import {
  INTEREST_CATALOG,
  capabilityQueriesForInterests,
  keywordsForInterests,
  normalizeInterests,
  planRepositorySubjects,
} from "../lib/nova/interests.ts";
import {
  changesForSubject,
  repositoryDigest,
  x402Digest,
} from "../lib/nova/observation.ts";
import { orderByRelevance, scoreRelevance } from "../lib/nova/relevance.ts";
import { assembleBrief, greeting, quietSummary } from "../lib/nova/brief.ts";
import { observeRepositories } from "../lib/nova/sources.ts";
import { EXPLICIT_IGNORE_SUPPORT, ignoreWeight, summariseAway } from "../lib/nova/service.ts";
import {
  DORMANT_AFTER_DAYS,
  DUE_TOLERANCE_MINUTES,
  REFRESH_INTERVAL_HOURS,
  tickReader,
} from "../lib/nova/schedule.ts";

const NOW = new Date("2026-09-13T18:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

/* ---- interests: what a person says vs what can be observed ---- */

assert.deepEqual(normalizeInterests(["Arc", "arc", " AI "]), ["Arc", "AI"], "duplicates collapse, case-insensitively");
assert.deepEqual(normalizeInterests(["ai"]), ["AI"], "a known interest is stored under its catalog label");

/* An interest Veyra has no entry for is kept, not dropped. Dropping it would
   leave a person staring at a brief that ignores what they asked for, with
   nothing on screen explaining why. */
const unknown = normalizeInterests(["Ambient"]);
assert.deepEqual(unknown, ["Ambient"]);
assert(keywordsForInterests(unknown).includes("ambient"), "an unknown interest still matches on its own name");

assert.equal(normalizeInterests(["a", "b", "c", "d", "e", "f", "g"]).length, 6, "capped");
assert.deepEqual(normalizeInterests(["", "   ", null, 7]), [], "junk in, nothing out");

// Every catalog entry must resolve to something observable, or it is decoration.
for (const entry of INTEREST_CATALOG) {
  assert(entry.capabilityTerms.length > 0, `${entry.id} must query the catalog for something`);
  for (const repo of entry.repositories) {
    assert.match(repo.ref, /^[\w.-]+\/[\w.-]+$/, `${entry.id} repository ref must be owner/name`);
  }
}

const planned = planRepositorySubjects(["Arc", "Agent payments"]);
assert(planned.length > 0);
assert.equal(new Set(planned.map((s) => s.ref)).size, planned.length, "a repository is watched once, not once per interest");
assert(planned.every((s) => s.kind === "github_repository"));

const queries = capabilityQueriesForInterests(["Research & search", "Research & search"]);
assert.equal(new Set(queries.map((q) => q.term)).size, queries.length, "no duplicate catalog queries");

/* ---- the first brief must not be false news ---- */

/* A first sighting is a finding, and must be worded as one. Calling it "new"
   is the tempting version and it does not survive the data: of 1139 live
   catalog resources none was fresher than 11.9 days, so lastUpdated cannot
   carry the claim, and stretching the window until it fires would just mean
   calling month-old listings new. */
const firstLook = changesForSubject({
  label: "Orthogonal search",
  previous: null,
  next: x402Digest({ priceAtomic: "2000", payTo: "0xaaa", reachable: true, provider: "Orthogonal", network: "base", funding: "gateway_deposit" }),
  now: NOW,
  catalogUpdatedAt: hoursAgo(24 * 40),
});
assert.equal(firstLook.length, 1);
assert.equal(firstLook[0].kind, "capability_available");
assert.match(firstLook[0].headline, /\$0\.0020/);
assert.doesNotMatch(firstLook[0].headline + firstLook[0].detail, /\bnew\b/i, "a 40-day-old listing must never be called new");

const quietRepo = changesForSubject({
  label: "Foundry",
  previous: null,
  next: repositoryDigest({ lastCommitAt: hoursAgo(24 * 30), commitsInWindow: 40, contributorCount: 9, latestRelease: "v1.0", stars: 10 }),
  now: NOW,
});
assert.deepEqual(quietRepo, [], "a repository last touched a month ago is not this week's news");

const busyRepo = changesForSubject({
  label: "Foundry",
  previous: null,
  next: repositoryDigest({ lastCommitAt: hoursAgo(3), commitsInWindow: 17, contributorCount: 4, latestRelease: "v1.0", stars: 10 }),
  now: NOW,
});
assert.equal(busyRepo.length, 1);
assert.equal(busyRepo[0].kind, "repository_activity");
assert.match(busyRepo[0].headline, /17 new commits/);
assert.doesNotMatch(busyRepo[0].headline, /at least/, "a count below the page size is exact");
assert.match(busyRepo[0].detail, /4 contributors/);

/* One page of the commits API holds 100, so a count at the cap is a floor.
   Observed live: Foundry returned exactly 100 over a week and the brief printed
   "100 new commits" as though it were the total -- understating the busiest
   repository, which is the one place a reader would notice being wrong. */
const capped = changesForSubject({
  label: "Foundry",
  previous: null,
  next: repositoryDigest({ lastCommitAt: hoursAgo(3), commitsInWindow: 100, contributorCount: 17, latestRelease: null, stars: 1 }),
  now: NOW,
  commitsAreLowerBound: true,
});
assert.match(capped[0].headline, /at least 100 new commits/);
assert.equal(capped[0].evidence.commitsAreLowerBound, true);

// And on a later refresh, where the change is a delta rather than a first look.
const cappedAgain = changesForSubject({
  label: "Foundry",
  previous: repositoryDigest({ lastCommitAt: hoursAgo(40), commitsInWindow: 90, contributorCount: 15, latestRelease: null, stars: 1 }),
  next: repositoryDigest({ lastCommitAt: hoursAgo(2), commitsInWindow: 100, contributorCount: 17, latestRelease: null, stars: 1 }),
  now: NOW,
  commitsAreLowerBound: true,
});
assert.match(cappedAgain[0].headline, /at least 100 new commits/);

/* ---- real deltas ---- */

const before = x402Digest({ priceAtomic: "1000", payTo: "0xAAA", reachable: true, provider: "Exa", network: "base", funding: "wallet" });

// The payee changing is the signal nobody else would tell you about.
const payee = changesForSubject({
  label: "Exa search",
  previous: before,
  next: x402Digest({ priceAtomic: "1000", payTo: "0xBBB", reachable: true, provider: "Exa", network: "base", funding: "wallet" }),
  now: NOW,
});
assert.equal(payee.length, 1);
assert.equal(payee[0].kind, "payee_changed");
assert.match(payee[0].detail, /0xaaa/);
assert.match(payee[0].detail, /0xbbb/);

const priced = changesForSubject({
  label: "Exa search",
  previous: before,
  next: x402Digest({ priceAtomic: "3000", payTo: "0xAAA", reachable: true, provider: "Exa", network: "base", funding: "wallet" }),
  now: NOW,
});
assert.equal(priced[0].kind, "price_changed");
assert.match(priced[0].headline, /rose/);

const down = changesForSubject({
  label: "Exa search",
  previous: before,
  next: x402Digest({ priceAtomic: "1000", payTo: "0xAAA", reachable: false, provider: "Exa", network: "base", funding: "wallet" }),
  now: NOW,
});
assert.equal(down[0].kind, "endpoint_unreachable");

// Nothing changed means nothing is said. A daily product that manufactures a
// line every day teaches people that its lines mean nothing.
assert.deepEqual(changesForSubject({ label: "Exa search", previous: before, next: before, now: NOW }), []);

/* The same commits must not be re-reported every refresh. A rolling window
   keeps counting work already shown, so the newest commit -- not the count --
   is what decides whether there is anything new to say. */
const repoBefore = repositoryDigest({ lastCommitAt: hoursAgo(5), commitsInWindow: 12, contributorCount: 3, latestRelease: "v2.0", stars: 100 });
assert.deepEqual(
  changesForSubject({ label: "LangChain", previous: repoBefore, next: { ...repoBefore, commitsInWindow: 11 }, now: NOW }),
  [],
  "a shifting window count alone is not a change",
);
const repoMoved = changesForSubject({
  label: "LangChain",
  previous: repoBefore,
  next: repositoryDigest({ lastCommitAt: hoursAgo(1), commitsInWindow: 14, contributorCount: 3, latestRelease: "v2.0", stars: 100 }),
  now: NOW,
});
assert.equal(repoMoved.length, 1);
assert.equal(repoMoved[0].kind, "repository_activity");

/* The rail moving is invisible, free, and decides whether this person can pay
   at all. Learning it a day early is the whole point of the router having been
   built first. */
const railed = changesForSubject({
  label: "Exa search",
  previous: before,
  next: x402Digest({ priceAtomic: "1000", payTo: "0xAAA", reachable: true, provider: "Exa", network: "base", funding: "gateway_deposit" }),
  now: NOW,
});
assert.equal(railed.length, 1);
assert.equal(railed[0].kind, "rail_changed");
assert.match(railed[0].headline, /Gateway deposit/);
assert.equal(scoreRelevance({ change: railed[0], keywords: [], subjectText: "Exa search" }).relevance, "medium");

/* ---- relevance is arithmetic, not taste ---- */

const keywords = keywordsForInterests(["Agent payments", "Arc"]);

const payeeVerdict = scoreRelevance({ change: payee[0], keywords, subjectText: "Exa search web research" });
assert.equal(payeeVerdict.relevance, "high", "a changed payee is always worth telling someone");

/* Interest keywords are matched against the subject and never against the
   sentence Nova generated. The first version scored "Circle" as an interest
   match because Nova had itself written "Circle's catalog" into the detail
   line, and every catalog entry came back equally relevant. */
const selfMatch = scoreRelevance({
  change: { kind: "capability_available", headline: "Something is available for $0.01", detail: "Listed in Circle's catalog, matching usdc and payment.", evidence: {}, observedAt: NOW.toISOString() },
  keywords: ["circle", "usdc", "payment"],
  subjectText: "unrelated weather feed",
});
assert.doesNotMatch(selfMatch.reason, /matches/, "Nova must not score its own prose as evidence of your interests");

/* Whole words only. Run against the live catalog, substring matching claimed
   Exa's search endpoint matched "arc" and "ai" -- "search" contains a-r-c and
   "exa.ai" ends in a-i -- and printed both to the reader as the reason. A false
   reason is worse than a missing one. */
const substringTrap = scoreRelevance({
  change: firstLook[0],
  keywords: ["arc"],
  subjectText: "Exa search neural retrieval",
});
assert.doesNotMatch(substringTrap.reason, /matches/, '"search" is not a match for "arc"');

// A real word still matches, and so does a multi-word phrase.
assert.match(
  scoreRelevance({ change: firstLook[0], keywords: ["retrieval", "neural retrieval"], subjectText: "Exa search neural retrieval" }).reason,
  /matches retrieval/,
);

// A 3% price move is a fact, not news.
const tinyMove = changesForSubject({
  label: "Exa search",
  previous: before,
  next: x402Digest({ priceAtomic: "1030", payTo: "0xAAA", reachable: true, provider: "Exa", network: "base", funding: "wallet" }),
  now: NOW,
});
const tinyVerdict = scoreRelevance({ change: tinyMove[0], keywords: [], subjectText: "Exa search" });
assert(["low", "noise"].includes(tinyVerdict.relevance), `a 3% move should not lead the brief, got ${tinyVerdict.relevance}`);
assert.match(tinyVerdict.reason, /slightly/);

const doubled = scoreRelevance({ change: priced[0], keywords, subjectText: "Exa search" });
assert.equal(doubled.relevance, "high");
assert.match(doubled.reason, /doubled/);

/* Something payable now outranks something that needs a deposit first. Ranking
   them equally is how a brief sends a person to the dead end the router exists
   to route around. */
const payable = scoreRelevance({
  change: changesForSubject({ label: "Exa search", previous: null, now: NOW, catalogUpdatedAt: hoursAgo(48), next: x402Digest({ priceAtomic: "1000", payTo: "0xA", reachable: true, provider: "Exa", network: "base", funding: "wallet" }) })[0],
  keywords,
  subjectText: "Exa contents usdc payment",
});
const needsDeposit = scoreRelevance({ change: firstLook[0], keywords, subjectText: "Orthogonal search usdc payment" });
assert(payable.score > needsDeposit.score, "a capability payable from the wallet must outrank one needing a deposit");
assert.match(payable.reason, /payable from your wallet/);
assert.match(needsDeposit.reason, /Gateway deposit first/);

// Every verdict carries a reason a person could argue with.
for (const verdict of [payeeVerdict, tinyVerdict, doubled]) {
  assert(verdict.reason.length > 0, "a relevance decision with no stated reason is not auditable");
}

/* ---- what a person says, and what it changes ---- */

const NOTHING_SAID = { ignored: [], favoured: [], followed: [] };

/* One shrug is not a decision. A single "not interesting" on a crowded morning
   must not cost someone a whole topic -- it demotes, and that is all. */
const shrugged = scoreRelevance({
  change: busyRepo[0],
  keywords,
  subjectText: "Foundry ethereum toolkit",
  preferences: { ...NOTHING_SAID, ignored: [{ phrase: "commit", weight: ignoreWeight(1) }] },
});
assert.match(shrugged.reason, /usually dismiss/);
assert.notEqual(shrugged.relevance, "noise", "one dismissal must not bury a topic");

/* Repetition is what turns a shrug into a preference, and an explicit "never
   show me this" enters at the same weight repetition would take days to earn --
   because it is not an inference at all, the person said it. */
assert(ignoreWeight(3) > ignoreWeight(1), "saying it again has to count for more");
assert.equal(ignoreWeight(9), ignoreWeight(3), "past a point more of the same evidence adds nothing");
assert.equal(ignoreWeight(EXPLICIT_IGNORE_SUPPORT), ignoreWeight(99), "an explicit ban enters at the ceiling");

const banned = scoreRelevance({
  change: busyRepo[0],
  keywords,
  subjectText: "Foundry ethereum toolkit",
  preferences: {
    ...NOTHING_SAID,
    ignored: [{ phrase: "commit", weight: ignoreWeight(EXPLICIT_IGNORE_SUPPORT) }],
  },
});
assert.equal(banned.relevance, "noise", "an explicit ban has to actually silence the category");

/* When several learned preferences match, the strongest one decides. Stacking
   them would let three mild shrugs outweigh a deliberate decision. */
const several = scoreRelevance({
  change: busyRepo[0],
  keywords,
  subjectText: "Foundry ethereum toolkit",
  preferences: {
    ...NOTHING_SAID,
    ignored: [
      { phrase: "commit", weight: ignoreWeight(1) },
      { phrase: "foundry", weight: ignoreWeight(1) },
    ],
  },
});
assert.equal(several.score, shrugged.score, "matching twice is not a stronger statement than matching once");

/* Taste is evidence about what someone likes to read, not permission to hide
   where their money goes. Nothing a person can say switches this off. */
for (const weight of [ignoreWeight(1), ignoreWeight(EXPLICIT_IGNORE_SUPPORT)]) {
  const dismissedPayee = scoreRelevance({
    change: payee[0],
    keywords,
    subjectText: "Exa search usdc payment",
    preferences: { ...NOTHING_SAID, ignored: [{ phrase: "address", weight }, { phrase: "paying", weight }] },
  });
  assert.equal(dismissedPayee.relevance, "high", "a learned preference must not hide a payee change");
  assert.doesNotMatch(dismissedPayee.reason, /usually dismiss/, "and must not claim it tried");
}

/* Approval is the half that was missing. Without it the only thing either agent
   could learn was what to remove, so two Novas started from the same interests
   would converge on the same floor instead of diverging. */
const quiet = scoreRelevance({ change: busyRepo[0], keywords: [], subjectText: "Foundry ethereum toolkit" });
const approved = scoreRelevance({
  change: busyRepo[0],
  keywords: [],
  subjectText: "Foundry ethereum toolkit",
  preferences: { ...NOTHING_SAID, favoured: ["commits"] },
});
assert(approved.score > quiet.score, "marking a category useful has to raise it");
assert.match(approved.reason, /you find commits useful/);

/* Following is about one thing, not a category: the answer to "I do not care
   about commits in general, I care about this repository". */
const followed = scoreRelevance({
  change: busyRepo[0],
  keywords: [],
  subjectText: "Foundry ethereum toolkit",
  subjectLabel: "Foundry",
  preferences: { ...NOTHING_SAID, followed: ["Foundry"] },
});
assert(followed.score > quiet.score, "following has to raise the thing followed");
assert.match(followed.reason, /you follow Foundry/);

/* And only that thing. Matching a followed name as a substring of prose is how
   "Arc" would start following every mention of architecture. */
const notFollowed = scoreRelevance({
  change: busyRepo[0],
  keywords: [],
  subjectText: "Foundry ethereum toolkit",
  subjectLabel: "ethereum/ERCs",
  preferences: { ...NOTHING_SAID, followed: ["Foundry"] },
});
assert.equal(notFollowed.score, quiet.score, "a follow must match the subject's name, not a word inside it");

/* The plan's acceptance test, at the level it can actually be checked: two
   agents that started identically, shown the same week, must not produce the
   same brief. Before feedback could raise anything, the only thing either could
   learn was what to remove, so they converged on the same floor -- the more
   either used the product, the more alike they got. */
{
  const week = [busyRepo[0], priced[0], railed[0]].filter(Boolean);

  // One reads commits and ignores price moves.
  const engineer = week.map((change) => scoreRelevance({
    change,
    keywords,
    subjectText: "Foundry ethereum toolkit",
    subjectLabel: "Foundry",
    preferences: {
      ignored: [{ phrase: "price changes", weight: ignoreWeight(EXPLICIT_IGNORE_SUPPORT) }],
      favoured: ["commits"],
      followed: ["Foundry"],
    },
  }));

  // The other watches cost and does not want the commit firehose.
  const operator = week.map((change) => scoreRelevance({
    change,
    keywords,
    subjectText: "Foundry ethereum toolkit",
    subjectLabel: "Foundry",
    preferences: {
      ignored: [{ phrase: "commits", weight: ignoreWeight(EXPLICIT_IGNORE_SUPPORT) }],
      favoured: ["price changes"],
      followed: [],
    },
  }));

  assert.notDeepEqual(
    engineer.map((v) => v.relevance),
    operator.map((v) => v.relevance),
    "two agents shown the same week must be able to disagree about it",
  );
  assert(
    engineer[0].score > operator[0].score,
    "the one who said commits are useful has to see commits above the one who banned them",
  );
}

/* ---- ordering ---- */

const ordered = orderByRelevance([
  { relevance: "low" as const, observedAt: hoursAgo(1) },
  { relevance: "high" as const, observedAt: hoursAgo(10) },
  { relevance: "medium" as const, observedAt: hoursAgo(2) },
  { relevance: "high" as const, observedAt: hoursAgo(1) },
]);
assert.deepEqual(ordered.map((s) => s.relevance), ["high", "high", "medium", "low"]);
assert.equal(ordered[0].observedAt, hoursAgo(1), "within a rank, newest first");

/* ---- a blind source must say so ---- */

/* Observed live: GitHub allows sixty requests an hour per IP without a token,
   that budget ran out mid-run, the best item in the brief disappeared, and the
   run still reported every source as available. Losing your strongest source
   silently is worse than admitting you could not look. */
const rateLimited = (async () => new Response("{}", {
  status: 403,
  headers: { "x-ratelimit-remaining": "0" },
})) as unknown as typeof fetch;

const blindRun = await observeRepositories({ interests: ["Arc"], now: NOW, fetchImpl: rateLimited });
assert.deepEqual(blindRun.observations, []);
assert.equal(blindRun.unavailable.length, 1);
assert.match(blindRun.unavailable[0], /GitHub \(hourly request limit reached\)/);

/* Even a partial read is named when it was rate limiting that cut it short:
   repositories drop out one at a time as the budget runs down, and a shorter
   list looks exactly like a quieter week. */
let call = 0;
const partial = (async (url: string) => {
  call += 1;
  if (call <= 3) {
    return new Response(JSON.stringify({ pushed_at: NOW.toISOString(), stargazers_count: 5, description: "d" }), { status: 200 });
  }
  return new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } });
}) as unknown as typeof fetch;
const partialRun = await observeRepositories({ interests: ["Arc"], now: NOW, fetchImpl: partial });
assert(partialRun.observations.length >= 1, "what was read is kept");
assert.equal(partialRun.unavailable.length, 1, "and what could not be read is still named");

// A source that answers everything is not flagged.
const healthy = (async () => new Response(JSON.stringify({ pushed_at: NOW.toISOString(), stargazers_count: 1 }), { status: 200 })) as unknown as typeof fetch;
assert.deepEqual((await observeRepositories({ interests: ["Arc"], now: NOW, fetchImpl: healthy })).unavailable, []);

/* ---- a brief is a few lines, not a list ---- */

/* The first live run produced thirteen items. Thirteen items every morning is
   how a person learns to stop opening them, and then the changed payee is the
   one they miss. */
const flood = [
  ...Array.from({ length: 12 }, (_, i) => ({
    kind: "capability_available" as const, relevance: "medium" as const, observedAt: hoursAgo(i + 2), id: `finding-${i}`,
  })),
  { kind: "payee_changed" as const, relevance: "high" as const, observedAt: hoursAgo(1), id: "payee" },
  { kind: "repository_activity" as const, relevance: "low" as const, observedAt: hoursAgo(3), id: "repo" },
  { kind: "price_changed" as const, relevance: "noise" as const, observedAt: hoursAgo(4), id: "tiny" },
];
const brief = assembleBrief(flood);
assert(brief.worthAttention.length <= 5, "a brief is a few lines");
assert.equal(brief.worthAttention[0].id, "payee", "the change leads");

/* A change must never be crowded out by findings, however many there are and
   whatever they score: findings describe the world, changes are the reason to
   come back. */
assert(brief.worthAttention.some((s) => s.id === "repo"), "a low-relevance change still outranks a medium finding");
assert.equal(brief.worthAttention.filter((s) => s.kind === "capability_available").length, 3, "findings are capped");

// Noise is kept, not discarded: "1 ignored as noise" has to be openable.
assert.deepEqual(brief.noise.map((s) => s.id), ["tiny"]);

// Nothing in, nothing out, no crash.
assert.deepEqual(assembleBrief([]), { worthAttention: [], noise: [] });

/* "Nothing changed" and "I could not look" produce the same empty screen and
   mean opposite things. */
assert.match(quietSummary({ subjectsChecked: 16, sourcesUnavailable: [] }), /Nothing moved across the 16/);
const blind = quietSummary({ subjectsChecked: 16, sourcesUnavailable: ["GitHub"] });
assert.match(blind, /could not reach GitHub/);
assert.doesNotMatch(blind, /Nothing moved/, "a blind day must not be dressed as a quiet one");

assert.equal(greeting(9), "Good morning");
assert.equal(greeting(15), "Good afternoon");
assert.equal(greeting(22), "Good evening");
assert.equal(greeting(2), "Good evening", "2am is not morning");

/* ---- the scheduler: working while nobody is looking ---- */

/* A tick refreshes many agents that watch the same seven repositories. Without
   a shared reader that is the same commit list fetched once per agent: the same
   answer, N times the rate-limit budget, inside the same second. */
{
  let calls = 0;
  const underlying = (async (input: RequestInfo | URL) => {
    calls += 1;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return new Response(JSON.stringify({ url, call: calls }), {
      status: 200,
      headers: { "content-type": "application/json", "x-ratelimit-remaining": "4999" },
    });
  }) as typeof fetch;

  const reader = tickReader(underlying);
  const first = await reader("https://api.github.com/repos/coinbase/x402");
  const second = await reader("https://api.github.com/repos/coinbase/x402");
  assert.equal(calls, 1, "the same URL is read once per tick");

  // Both callers get a usable body: a shared Response whose stream was already
  // drained by the first reader would hand the second an empty one.
  assert.deepEqual(await first.json(), { url: "https://api.github.com/repos/coinbase/x402", call: 1 });
  assert.deepEqual(await second.json(), { url: "https://api.github.com/repos/coinbase/x402", call: 1 });
  assert.equal(second.status, 200);
  assert.equal(second.headers.get("x-ratelimit-remaining"), "4999", "headers survive the copy");

  await reader("https://api.github.com/repos/ethereum/ERCs");
  assert.equal(calls, 2, "a different URL is a different read");

  // Nothing in Nova's observation path writes, and a POST collapsed into one
  // shared answer would be a silent correctness bug rather than a saving.
  await reader("https://api.github.com/repos/coinbase/x402", { method: "POST" });
  assert.equal(calls, 3, "a non-GET is never shared");
}

/* An empty success must not become a crash: `new Response(body, {status: 204})`
   throws, so a 304 from a conditional GitHub read would take down the tick. */
{
  const underlying = (async () => new Response(null, { status: 304 })) as typeof fetch;
  const reader = tickReader(underlying);
  const response = await reader("https://api.github.com/repos/coinbase/x402");
  assert.equal(response.status, 304);
}

/* If a host is down it is down for the whole tick. Retrying it once per agent
   would neither discover otherwise nor be a kindness to a struggling host. */
{
  let attempts = 0;
  const underlying = (async () => {
    attempts += 1;
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const reader = tickReader(underlying);
  await assert.rejects(() => reader("https://api.github.com/x"));
  await assert.rejects(() => reader("https://api.github.com/x"));
  assert.equal(attempts, 1, "a failure is shared across the tick, not repeated per agent");
}

/* ---- "while you were away" is an addition, not the last row ---- */

const awayRows = [
  { subjects_checked: 16, signals_found: 3, signals_kept: 2, signals_as_noise: 1, sources_unavailable: [], started_at: hoursAgo(20), finished_at: hoursAgo(20) },
  { subjects_checked: 16, signals_found: 5, signals_kept: 1, signals_as_noise: 4, sources_unavailable: ["GitHub (hourly request limit reached)"], started_at: hoursAgo(14), finished_at: hoursAgo(14) },
  { subjects_checked: 16, signals_found: 2, signals_kept: 0, signals_as_noise: 2, sources_unavailable: [], started_at: hoursAgo(8), finished_at: hoursAgo(8) },
];

const away = summariseAway(awayRows, hoursAgo(24));
assert(away, "three passes in the window is an absence");
assert.equal(away.refreshes, 3);
assert.equal(away.subjectsChecked, 48, "the passes add up; reporting the last one would undercount by 3x");
assert.equal(away.signalsKept, 3);
assert.equal(away.signalsAsNoise, 7);
assert.equal(away.until, hoursAgo(8), "the window ends at the last pass, not at now");

/* A source that failed on one pass out of three is still named. Two good reads
   do not retire the blind spot the third had -- and the last pass succeeding is
   exactly the case where reading only `lastRefresh` would hide it. */
assert.deepEqual(away.sourcesUnavailable, ["GitHub (hourly request limit reached)"]);

// Nothing ran unattended: a first visit after creation, or a quick return.
assert.equal(summariseAway([], hoursAgo(24)), null, "no scheduled pass is not an absence");

/* The scheduler's two clocks have to stay on opposite sides of each other: if
   an agent could be retired faster than it is visited, every agent would go
   dormant before its second pass. */
assert(
  DORMANT_AFTER_DAYS * 24 > REFRESH_INTERVAL_HOURS * 4,
  "an agent must get many passes before it can be considered abandoned",
);

/* The scheduler fires on the same period an agent is due on, so the cutoff has
   to forgive a late run. Without this a tick twenty minutes later than the last
   one finds nothing due and skips a whole cycle, silently -- nothing errors,
   the queue is simply empty. */
assert(DUE_TOLERANCE_MINUTES > 0, "an exact cutoff loses a cycle to scheduler jitter");

/* And it must stay well inside the period, or a tick would pick up agents that
   were refreshed by the tick before it. */
assert(
  DUE_TOLERANCE_MINUTES < REFRESH_INTERVAL_HOURS * 60 / 2,
  "tolerance this large would let consecutive ticks refresh the same agent",
);

console.log("[nova-test] passed: interests kept even when unknown, a first sighting reported as a finding rather than as news, the same commits not re-reported across refreshes, a payee change outranking everything and un-learnable away, a rail change surfaced a day before it could refuse a payment, a 3% price move kept out of the headline, a brief that caps findings so a change can never be crowded out, a tick that reads each URL once and shares its failures, and an absence measured by adding up every unattended pass rather than reporting the last one, and feedback that can raise as well as bury without ever silencing a payee change");
