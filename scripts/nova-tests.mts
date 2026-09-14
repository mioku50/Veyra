/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import {
  INTEREST_CATALOG,
  SUBJECT_LIMITS,
  subjectBudgetFor,
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
import { BRIEF_LIMITS, assembleBrief, greeting, quietSummary } from "../lib/nova/brief.ts";
import { observeRepositories } from "../lib/nova/sources.ts";
import { EXPLICIT_IGNORE_SUPPORT, ignoreWeight, summariseAway } from "../lib/nova/service.ts";
import { networkName, settlementNetworkOf } from "../lib/nova/network.ts";
import { buildRequestBody } from "../lib/x402/request-body.ts";
import { actionFor } from "../lib/nova/action.ts";
import { readResult } from "../lib/nova/synthesis.ts";
import { sharpenIntent } from "../lib/nova/intent.ts";
import {
  compareTerms,
  hashTerms,
  normaliseTerms,
  type NovaResearchTerms,
} from "../lib/nova/research-terms.ts";
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

/* A category ban has to work on every category, not just the one whose name
   happens to appear in Nova's own sentence.

   The first version matched preferences through the prose, which worked for
   "commits" -- a repository headline says "22 new commits" -- and silently did
   nothing for the other four. Banning "new capabilities" wrote the preference,
   showed it in what Nova knows about you, and then went on showing every
   capability signal, because no capability signal contains that phrase. A ban
   that is visibly recorded and quietly ignored is worse than one never offered. */
{
  const capabilityText = "Orthogonal search web research api";
  assert.doesNotMatch(
    `${capabilityText} ${firstLook[0].headline}`,
    /new capabilities/i,
    "the fixture must not contain the phrase, or this test proves nothing",
  );

  const shown = scoreRelevance({ change: firstLook[0], keywords, subjectText: capabilityText });
  const banned = scoreRelevance({
    change: firstLook[0],
    keywords,
    subjectText: capabilityText,
    preferences: {
      ...NOTHING_SAID,
      ignored: [{ phrase: "new capabilities", weight: ignoreWeight(EXPLICIT_IGNORE_SUPPORT) }],
    },
  });
  assert(banned.score < shown.score, "banning a category has to reach the category");
  assert.match(banned.reason, /you usually dismiss new capabilities/);
}

/* And a followed subject survives a ban on its category: "I do not care about
   new capabilities, except this one" is a thing people mean. */
{
  const banned = {
    ...NOTHING_SAID,
    ignored: [{ phrase: "new capabilities", weight: ignoreWeight(EXPLICIT_IGNORE_SUPPORT) }],
  };
  const silenced = scoreRelevance({
    change: firstLook[0], keywords, subjectText: "Orthogonal search", subjectLabel: "Orthogonal search",
    preferences: banned,
  });
  const excepted = scoreRelevance({
    change: firstLook[0], keywords, subjectText: "Orthogonal search", subjectLabel: "Orthogonal search",
    preferences: { ...banned, followed: ["Orthogonal search"] },
  });
  assert(excepted.score > silenced.score, "following has to be able to carve an exception out of a ban");
}

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
assert.deepEqual(assembleBrief([]), { worthAttention: [], noise: [], overflow: [] });

/* A finding that lost only the cap has to be reachable. It used to be in
   neither list: "held back" means relevance rejected it, and an item the cap
   dropped was simply absent -- twenty-two paid endpoints watched, five that
   could be seen, and "Things watched: 34" a number nobody could open. */
const manyFindings = Array.from({ length: 9 }, (_, i) => ({
  kind: "capability_available" as const,
  relevance: "high" as const,
  observedAt: `2026-09-14T0${i}:00:00.000Z`,
}));
const cappedFindings = assembleBrief(manyFindings);
assert.equal(cappedFindings.worthAttention.length, BRIEF_LIMITS.findings, "the brief still caps hard");
assert.equal(cappedFindings.noise.length, 0, "nothing here was rejected for relevance");
assert.equal(
  cappedFindings.overflow.length,
  manyFindings.length - BRIEF_LIMITS.findings,
  "everything the cap dropped stays reachable",
);
assert.equal(
  new Set([...cappedFindings.worthAttention, ...cappedFindings.overflow]).size,
  manyFindings.length,
  "shown plus reachable accounts for every relevant signal, with no double count",
);

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

/* ---- paid research: what somebody agreed to, and what is true now ---- */

const SHOWN: NovaResearchTerms = {
  provider: "Exa",
  resource: "https://api.exa.ai/x402/contents",
  capability: "search",
  priceAtomic: "7000",
  payTo: "0x1111111111111111111111111111111111111111",
  network: "eip155:8453",
  funding: "wallet",
};

assert.deepEqual(compareTerms(SHOWN, SHOWN), [], "identical terms are not a change");

/* Checksum case is not a changed payee. This is the one signal Nova raises on
   its own and must never cry wolf about: an address that differs only in the
   case of its hex digits is the same address, and reporting it would teach
   people to click through the warning that matters most. */
assert.deepEqual(
  compareTerms(SHOWN, { ...SHOWN, payTo: SHOWN.payTo.toUpperCase().replace("0X", "0x") }),
  [],
  "the same address in a different case is the same address",
);

/* The negative acceptance, in the smallest form that can hold it. A price or a
   payee that moved between the card and the click has to come back as a change,
   with both numbers, or the revalidation is decoration. */
const priceMoved = compareTerms(SHOWN, { ...SHOWN, priceAtomic: "12000" });
assert.equal(priceMoved.length, 1);
assert.equal(priceMoved[0].field, "priceAtomic");
assert.equal(priceMoved[0].was, "$0.0070");
assert.equal(priceMoved[0].now, "$0.0120", "a person must be able to read the new price, not just be told it changed");

const payeeMoved = compareTerms(SHOWN, {
  ...SHOWN,
  payTo: "0x2222222222222222222222222222222222222222",
});
assert.equal(payeeMoved.length, 1);
assert.equal(payeeMoved[0].field, "payTo");

/* Money first. Somebody scanning a list of differences should meet the ones
   that decide whether to walk away before the ones that decide nothing. */
const manyMoved = compareTerms(SHOWN, {
  ...SHOWN,
  provider: "Exa Labs",
  priceAtomic: "9000",
  payTo: "0x3333333333333333333333333333333333333333",
});
assert.deepEqual(
  manyMoved.map((change) => change.field),
  ["priceAtomic", "payTo", "provider"],
  "price and payee are read before a renamed provider",
);

/* Every field is compared, or the ones left out are the ones that change. */
const FIELDS: (keyof NovaResearchTerms)[] = [
  "provider", "resource", "capability", "priceAtomic", "payTo", "network", "funding",
];
for (const field of FIELDS) {
  const altered: NovaResearchTerms = {
    ...SHOWN,
    [field]: field === "funding" ? "gateway_deposit" : `${SHOWN[field]}-changed`,
  };
  assert.equal(compareTerms(SHOWN, altered).length, 1, `a changed ${field} must be reported`);
}

/* The hash is what a re-confirmation is bound to. If a price that moved twice
   produced the same fingerprint as a price that moved once, a click that saw
   the first move would silently approve the second. */
assert.equal(hashTerms(SHOWN), hashTerms({ ...SHOWN }), "the same terms hash the same");
assert.notEqual(
  hashTerms({ ...SHOWN, priceAtomic: "12000" }),
  hashTerms({ ...SHOWN, priceAtomic: "13000" }),
  "two different prices must not share a confirmation",
);
assert.notEqual(
  hashTerms(SHOWN),
  hashTerms({ ...SHOWN, payTo: "0x2222222222222222222222222222222222222222" }),
  "a changed payee must invalidate a confirmation",
);
/* And it must not be sensitive to the things that are not differences, or
   every approval would come back as a change. */
assert.equal(
  hashTerms(SHOWN),
  hashTerms({ ...SHOWN, payTo: SHOWN.payTo.toUpperCase().replace("0X", "0x"), network: "EIP155:8453" }),
  "case is not a change, so it must not break a confirmation either",
);

/* Atomic units, compared as text. A float comparison of 0.007 against
   0.007000000000000001 is a bug waiting for a provider that prices in thirds. */
assert.equal(normaliseTerms({ ...SHOWN, priceAtomic: 7000 as unknown as string }).priceAtomic, "7000");

/* ---- an interest is not a network ---- */

/* The brief printed the interest that matched directly above the price, so
   choosing Arc put the word ARC over "$0.0100" on an endpoint that settles on
   Base. Circle's catalogue publishes nothing on Arc at all, so that reading was
   not merely unsupported -- it could never be true. */
assert.equal(networkName("eip155:8453"), "Base");
assert.equal(networkName("eip155:137"), "Polygon");
assert.equal(networkName(null), null);
/* Arc is deliberately absent from the marketplace network map, and an unknown
   chain id must come back as nothing rather than as its own raw identifier: a
   card reading "pays on eip155:5042002" is worse than a card that stays quiet. */
assert.equal(networkName("eip155:5042002"), null, "an unlisted chain id is not a name");

assert.equal(
  settlementNetworkOf({
    kind: "x402_resource",
    priceAtomic: "10000",
    payTo: "0x1111111111111111111111111111111111111111",
    reachable: true,
    provider: "StableEnrich",
    network: "eip155:8453",
    funding: "wallet",
  }),
  "Base",
);
/* A repository has no price and therefore no chain, and must not be given one. */
assert.equal(
  settlementNetworkOf({
    kind: "github_repository",
    lastCommitAt: null,
    commitsInWindow: 3,
    contributorCount: 2,
    latestRelease: null,
    stars: 10,
  }),
  null,
  "a repository does not settle anywhere",
);
assert.equal(settlementNetworkOf(null), null);

/* ---- a question has to land somewhere ---- */

/* Alchemy's token-price endpoint, exactly as Circle publishes it: properties,
   no required list, and no field a sentence fits in. `{}` satisfies this schema,
   so every downstream check passed and $0.0010 bought
   "Required argument [HttpRequest request] not specified". */
const alchemy = buildRequestBody({
  intent: "What changed in Ethereum EIPs, and does it matter?",
  capability: "research",
  inputSchema: {
    type: "object",
    properties: { addresses: { type: "array", items: { type: "object" } } },
  } as never,
});
assert.deepEqual(alchemy.body, {}, "nothing in the schema can carry the question");
assert.equal(alchemy.intentField, null);
assert.equal(alchemy.guessed, false, "the schema was published, so the shape is not a guess");
assert.ok(
  alchemy.note && /no field for a question/.test(alchemy.note),
  "an empty body that satisfies a weak schema must still say it asks nothing",
);

/* A schema that does have somewhere to put it still works, and in the
   provider's own spelling rather than ours. */
const askable = buildRequestBody({
  intent: "what is this for",
  capability: "research",
  inputSchema: { type: "object", properties: { searchQuery: { type: "string" } }, required: ["searchQuery"] } as never,
});
assert.equal(askable.intentField, "searchQuery");
assert.deepEqual(askable.body, { searchQuery: "what is this for" });
assert.equal(askable.note, null);

/* ---- every interest gets looked at ---- */

/* Asked interest by interest, the first interest's three capability terms could
   eat nine of the twelve observations an agent is allowed, and a fourth
   interest was never queried at all. Somebody added two and saw one new thing. */
const fairQueries = capabilityQueriesForInterests(["Arc", "AI", "Agent payments", "Agent standards"]);
const firstFour = fairQueries.slice(0, 4).map((q) => q.interest);
assert.deepEqual(
  firstFour,
  ["Arc", "AI", "Agent payments", "Agent standards"],
  "every interest is asked once before any interest is asked twice",
);
/* And nothing is lost -- the deeper terms still follow, just behind everyone
   else's first. */
const interestsSeen = new Set(fairQueries.map((q) => q.interest));
assert.equal(interestsSeen.size, 4, "no interest is dropped by the interleave");
assert.ok(fairQueries.length > 4, "second and third capability terms are still asked");

/* ---- what the card is asking to do ---- */

function signalFor(kind: "x402_resource" | "github_repository", label: string, capability?: string) {
  return {
    signalId: "s1", subjectId: "sub1", subjectLabel: label, subjectRef: "x402:aff46c21",
    subjectKind: kind, interest: "Arc", kind: "capability_available",
    headline: `${label} is available`, detail: "", relevance: "high", relevanceReason: "",
    status: "new", executionPublicId: null, observedAt: "2026-09-14T00:00:00.000Z",
    evidence: capability ? { subject: { capability } } : {},
  } as never;
}

/* A catalogue listing is a seller. The card is named after it, the price on the
   card is its price, and nobody else may be paid instead -- that substitution
   happened, at twenty times the price, silently. */
const exa = actionFor(signalFor("x402_resource", "Exa contents", "search"));
assert.equal(exa.actionType, "interact_with_subject");
assert.equal(exa.requiredCapability, "search", "an interaction needs the subject's own capability");
assert.equal(exa.subject?.ref, "x402:aff46c21", "routing is pinned to the subject");

/* A repository sells nothing, so the work has to be bought from somebody and
   which somebody is a real routing decision. */
const repo = actionFor(signalFor("github_repository", "Ethereum EIPs"));
assert.equal(repo.actionType, "research_subject");
assert.equal(repo.requiredCapability, "research");
assert.match(repo.intent, /What changed in Ethereum EIPs/);

/* An x402 listing with no capability recorded is still an interaction. The
   capability falls back; the action type does not, because what may be paid is
   not a function of how well the evidence was filled in. */
assert.equal(actionFor(signalFor("x402_resource", "Sponge fast sdxl")).actionType, "interact_with_subject");

/* ---- the brief has to be a market, not a catalogue page ---- */

/* Three per interest were requested and three were kept, so every filter --
   a templated path, a schema with nowhere to put a question, a seller already
   holding its share -- came out of the interest's own share. Measured: asking
   for exactly what is kept left Research & search with nothing, because its
   first three were all one provider that had already filled up. */
assert.ok(
  SUBJECT_LIMITS.candidatesPerQuery > SUBJECT_LIMITS.x402PerInterest,
  "the catalogue must be asked for more than will be kept, or filtering costs the share",
);
assert.ok(
  SUBJECT_LIMITS.perProvider < SUBJECT_LIMITS.x402PerInterest * 2,
  "one seller must not be able to fill two interests by itself",
);

/* The budget follows the interests. A flat ceiling meant choosing all six got
   each of them two, and an endpoint already watched produces no new card, so
   the brief for six looked like the brief for two. */
assert.equal(subjectBudgetFor(1), SUBJECT_LIMITS.perAgent, "a single interest still gets the floor");
assert.equal(subjectBudgetFor(5), 15, "five interests get three each");
assert.equal(
  subjectBudgetFor(50),
  SUBJECT_LIMITS.perAgentMax,
  "and it stops somewhere, because every subject is a live read on every refresh",
);

/* ---- reading back what was bought ---- */

const READING_INPUT = {
  agentName: "Nova",
  interests: ["Arc"],
  memory: ["cares about payee changes"],
  question: "What changed?",
  provider: "Exa",
  resource: "https://api.exa.ai/search",
  paidUsdc: 0.007,
  verdict: "PASS",
  verificationSummary: "Paid, delivered, and verified.",
  executionPublicId: "vexec_1",
  transaction: "0xabc",
  result: { results: [{ title: "a release" }] },
};

const stub = (text: string) => async () => ({
  ok: true as const, provider: "AgentRouter", protocol: "openai-compatible" as const,
  model: "deepseek-v4-flash", text, attempts: 1,
});

/* A label is only a label at the start of a line. Matching the bare word
   anywhere swallowed prose: a MATTERS paragraph containing "sits right next to
   agent payments" was read as the start of NEXT, so the card printed the tail
   of one answer as the whole of another. */
const bleed = await readResult({
  ...READING_INPUT,
  generate: stub([
    "CHANGED: two items, not twenty-two commits.",
    "MATTERS: a metering bug, which sits right next to agent payments and billing.",
    "NEXT: ask whether the deprecated path has a removal date.",
  ].join("\n")),
});
assert.ok(bleed);
assert.equal(bleed.whatChanged, "two items, not twenty-two commits.");
assert.equal(bleed.whyItMatters, "a metering bug, which sits right next to agent payments and billing.");
assert.equal(bleed.watchNext, "ask whether the deprecated path has a removal date.");

/* The verification line is Veyra's, composed from facts the caller already
   holds. A model asked to report on the trustworthiness of text it was handed
   is a model marking its own source's homework, so it is never asked. */
assert.match(bleed.provenance, /Veyra checked the answer/);
assert.match(bleed.provenance, /PASS/);
assert.match(bleed.provenance, /vexec_1/);
assert.match(bleed.provenance, /api\.exa\.ai/);
assert.equal(bleed.writtenBy, "AgentRouter · deepseek-v4-flash");

/* A reading is a convenience on top of a receipt. Every way the model can let
   us down leaves the purchase exactly as it was. */
for (const [why, generate] of [
  ["the model refused", async () => ({ ok: false as const, provider: "AgentRouter", protocol: "openai-compatible" as const, reason: "upstream_error", message: "no" })],
  ["it answered nothing", stub("")],
  ["it ignored the shape", stub("Here is a summary of the release notes in prose.")],
  ["it threw", async () => { throw new Error("socket hang up"); }],
] as const) {
  assert.equal(
    await readResult({ ...READING_INPUT, generate: generate as never }),
    null,
    `${why}: the receipt stands and the reading is simply absent`,
  );
}

/* Nothing to read is not something to read. */
assert.equal(await readResult({ ...READING_INPUT, result: "", generate: stub("CHANGED: x") as never }), null);

/* ---- asking something worth the money ---- */

const LISTING = actionFor(signalFor("x402_resource", "Exa search", "search"));
const INTENT_INPUT = {
  action: LISTING,
  headline: "Exa search is available for $0.0070",
  detail: "A paid capability matching your interests.",
  agentName: "Nova",
  interests: ["Arc", "Agent payments"],
  memory: ["cares about payee changes"],
};
const says = (text: string) => async () => ({
  ok: true as const, provider: "AgentRouter", protocol: "openai-compatible" as const,
  model: "deepseek-v4-flash", text, attempts: 1,
});

const better = await sharpenIntent({
  ...INTENT_INPUT,
  generate: says('  "Which Exa search endpoints expose agent-payment data, and at what price?"  '),
});
assert.equal(better.written, true);
assert.equal(better.intent, "Which Exa search endpoints expose agent-payment data, and at what price?",
  "quotes and stray whitespace are not part of the question");

/* The object of the action is never swapped, and that has to hold in language
   as well as in routing. A model that wandered off the subject is not a smaller
   problem than a router that wandered; it is the same problem one layer up. */
const drifted = await sharpenIntent({
  ...INTENT_INPUT,
  generate: says("What are the latest changes to the Tavily API pricing?"),
});
assert.equal(drifted.written, false, "a question about something else is discarded");
assert.equal(drifted.intent, LISTING.intent, "and the template stands");

/* Shape, because this goes on a card next to a price and into a paid request. */
for (const [why, text] of [
  ["not a question", "Exa search is a web search API for agents."],
  ["too long for a card", `Exa ${"very ".repeat(60)}long?`],
  ["nothing at all", "   "],
] as const) {
  const out = await sharpenIntent({ ...INTENT_INPUT, generate: says(text) });
  assert.equal(out.written, false, why);
  assert.equal(out.intent, LISTING.intent, `${why}: the template stands`);
}

/* And every way the model can fail leaves the card exactly as it was. */
for (const generate of [
  async () => ({ ok: false as const, provider: "AgentRouter", protocol: "openai-compatible" as const, reason: "upstream_error", message: "no" }),
  async () => { throw new Error("socket hang up"); },
] as const) {
  const out = await sharpenIntent({ ...INTENT_INPUT, generate: generate as never });
  assert.equal(out.intent, LISTING.intent);
  assert.equal(out.written, false);
}

/* A repository has no capability of its own, so the question is written for a
   stranger and has to carry the subject's name into it. */
const repoAction = actionFor(signalFor("github_repository", "Ethereum ERCs"));
const forStranger = await sharpenIntent({
  action: repoAction,
  headline: "Ethereum ERCs: 2 new commits",
  detail: "",
  agentName: "Nova",
  interests: ["Agent standards"],
  generate: says("Which two Ethereum ERCs drafts changed, and do either touch agent payments?"),
});
assert.equal(forStranger.written, true);
assert.match(forStranger.intent, /Ethereum/);

console.log("[nova-test] passed: interests kept even when unknown, a first sighting reported as a finding rather than as news, the same commits not re-reported across refreshes, a payee change outranking everything and un-learnable away, a rail change surfaced a day before it could refuse a payment, a 3% price move kept out of the headline, a brief that caps findings so a change can never be crowded out, a tick that reads each URL once and shares its failures, and an absence measured by adding up every unattended pass rather than reporting the last one, and feedback that can raise as well as bury without ever silencing a payee change, and terms that stop a payment when the price or the payee moved between reading the card and pressing the button, and a card that names the chain its money moves on rather than letting the interest stand in for one, and a body that says it asks nothing rather than satisfying a schema with silence, and a budget every interest gets a share of before any interest gets seconds, and an action type that decides whether routing may substitute at all, and a watchlist that grows with the interests and cannot be filled by one seller, and a reading of what was bought that never speaks for the verification and never costs the receipt, and a question written for the event that is thrown away the moment it drifts off the subject");
