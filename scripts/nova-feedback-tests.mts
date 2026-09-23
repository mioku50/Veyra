/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import assert from "node:assert/strict";
import { NOTE_MAX, NOVA_REASONS, REASON_LABEL, learnedSentence, noteFrom, reasonFor } from "../lib/nova/verdict.ts";
import { coverageOf, missUrl, publicationVariants } from "../lib/nova/misses.ts";
import { PUBLIC_FEEDS } from "../lib/nova/public-sources.ts";
import { isReadingCategory, rankedByReading, scoreRelevance } from "../lib/nova/relevance.ts";
import { ignoreWeight } from "../lib/nova/service.ts";

/* ---- a reason belongs to its verdict ---- */

assert.equal(reasonFor("useful", "acted"), "acted");
assert.equal(reasonFor("not_interesting", "unneeded_work"), "unneeded_work");
assert.equal(reasonFor("useful", "off_goal"), null, "Not about my goal is not why something was useful");
assert.equal(reasonFor("not_interesting", "informed"), null, "Good to know is not why something was useless");
assert.equal(reasonFor("seen", "acted"), null, "A card merely seen has no reason to give");
assert.equal(reasonFor("not_interesting", 5), null);
assert.equal(reasonFor("__proto__", "acted"), null, "A key every object has is not a verdict");
for (const reason of [...NOVA_REASONS.useful, ...NOVA_REASONS.not_interesting]) {
  assert.ok(REASON_LABEL[reason], `${reason} has a label the owner can read`);
}

/* The owner's words: bounded, and nothing where nothing was said. */
assert.equal(noteFrom("  already  in\n our\tdocs "), "already in our docs");
assert.equal(noteFrom("   "), null);
assert.equal(noteFrom(""), null);
assert.equal(noteFrom(42), null);
assert.equal(noteFrom("x".repeat(NOTE_MAX + 100))?.length, NOTE_MAX);

/* ---- a press says what it taught, including that it taught nothing ---- */

assert.equal(learnedSentence({ facet: "cares_about", summary: "price changes" }, "useful"),
  "Nova will rank price changes higher.", "Category-wide, and said so -- the known limit is not hidden");
assert.equal(learnedSentence({ facet: "usually_ignores", summary: "cirbtc" }, "not_interesting"),
  "Hidden. Nova will rank cards about cirbtc lower.");
assert.equal(learnedSentence({ facet: "usually_ignores", summary: "announcements" }, "ignore_kind"),
  "Hidden. Nova will rank cards about announcements lower.");
assert.equal(learnedSentence({ facet: "follows", summary: "Circle announcements" }, "follow"), "Following Circle announcements.");
assert.match(learnedSentence(null, "not_interesting"), /^Hidden\. Nothing to learn .* still appear\.$/,
  "A dismissal that learned nothing says so, or the owner keeps dismissing and expecting fewer");
assert.equal(learnedSentence(null, "useful"), "Nothing to learn from this kind of card.");
/* A rating of a reading raises nothing, and the press says so. It used to
   answer "Nova will rank announcements higher", and nothing else on the page
   would tell the owner that this stopped. */
assert.equal(learnedSentence(null, "useful", { rankedByReading: true, rated: true, category: "announcements" }),
  "Kept as your rating of this reading. It does not rank all announcements higher; each one is placed by its own reading against your goal.");
assert.equal(learnedSentence(null, "useful", { rankedByReading: true, rated: false, category: "announcements" }),
  "Nothing kept: there is no reading of this for your current goal to rate yet.");
assert.equal(learnedSentence({ facet: "follows", summary: "Arc announcements" }, "follow", { rankedByReading: true }), "Following Arc announcements.");

/* ---- what the owner's feedback did, and what it does now ---- */

/* Their agent on 2026-09-23. Four ratings of Arc and Circle readings had
   taught "announcements"; one dismissal had taught "cirbtc". */
const owner = {
  favoured: ["price changes", "announcements"],
  ignored: [{ phrase: "cirbtc", weight: ignoreWeight(1) }],
  followed: [] as string[],
};
const nothing = { favoured: [], ignored: [], followed: [] };
const watched = ["payment", "settle", "model", "usdc", "gateway", "agent", "prompt", "ai", "arc", "circle"];
const publication = (headline: string, body: string, feed: string) => ({
  change: { kind: "official_publication" as const, headline, detail: headline, evidence: {}, observedAt: "2026-09-22T13:28:17Z" },
  keywords: watched,
  subjectText: `${headline} ${body}`,
  subjectLabel: feed,
});

/* The two the category boost pushed over the "high relevance" line. Both
   went first in the owner's own refresh; one of them was StableFX, which the
   owner had objected to. */
const stableFx = publication("StableFX Is Live on Arc: Always-On FX Is Here",
  "Onchain FX for payment flows that settle in seconds, priced by a quoting model.", "Arc announcements");
const healthcare = publication("The Reliability Layer for Healthcare AI: Common LangSmith Use Cases",
  "Teams ship an agent, tune each prompt, and trace AI calls in production.", "LangChain announcements");
for (const card of [stableFx, healthcare]) {
  const now = scoreRelevance({ ...card, preferences: owner });
  const untaught = scoreRelevance({ ...card, preferences: nothing });
  assert.equal(now.relevance, "medium", `${card.change.headline}: a rating of a reading does not push another article over the line`);
  assert.equal(now.score, untaught.score);
  assert.doesNotMatch(now.reason, /you find announcements useful/, "and the card does not claim it did");
}

/* "Less cirBTC" demoted an Arc Interop announcement that mentions cirBTC
   once in its text. What a publication is about is its feed and headline. */
const interop = publication("Introducing Interop on Arc: Crosschain Liquidity Without the Complexity",
  "Move USDC through Gateway across chains; assets such as cirBTC arrive the same way.", "Arc announcements");
assert.equal(scoreRelevance({ ...interop, preferences: owner }).score, scoreRelevance({ ...interop, preferences: nothing }).score,
  "a dismissed product mentioned in an article's text does not demote the article");
assert.doesNotMatch(scoreRelevance({ ...interop, preferences: owner }).reason, /usually dismiss/);
const cirBtcAgain = publication("cirBTC lending opens on Arc", "Borrow against cirBTC.", "Arc announcements");
assert.match(scoreRelevance({ ...cirBtcAgain, preferences: owner }).reason, /you usually dismiss cirbtc/,
  "the product itself, named in the headline, still is");

/* The lever that remains for a publisher is the explicit one. */
const followed = scoreRelevance({ ...interop, preferences: { ...owner, followed: ["Arc announcements"] } });
assert.equal(followed.relevance, "high");
assert.match(followed.reason, /you follow Arc announcements/);
assert.equal(scoreRelevance({ ...healthcare, preferences: { ...owner, followed: ["Arc announcements"] } }).relevance, "medium",
  "following Arc does not lift LangChain");

/* A category is matched as a category. "Price changes" in a listing's text
   is not a price change, and "commits" in a description is not a commit. */
const listing = (description: string) => ({
  change: { kind: "capability_available" as const, headline: "Available: Commit search", detail: "", evidence: {}, observedAt: "2026-09-22T00:00:00Z" },
  keywords: [], subjectText: `Commit search ${description}`, subjectLabel: "Commit search",
});
const plain = scoreRelevance({ ...listing("tracks price changes and commits across repositories"), preferences: nothing });
assert.equal(scoreRelevance({ ...listing("tracks price changes and commits across repositories"), preferences: { ...nothing, favoured: ["price changes"] } }).score, plain.score);
assert.equal(scoreRelevance({ ...listing("tracks price changes and commits across repositories"), preferences: { ...nothing, ignored: [{ phrase: "commits", weight: ignoreWeight(3) }] } }).score, plain.score);
assert.ok(scoreRelevance({ ...listing("x"), preferences: { ...nothing, favoured: ["new capabilities"] } }).score > scoreRelevance({ ...listing("x"), preferences: nothing }).score,
  "a background category marked useful still rises");

assert.ok(rankedByReading("official_publication") && rankedByReading("repository_release"));
assert.ok(!rankedByReading("capability_available") && !rankedByReading("price_changed"));
assert.ok(isReadingCategory("announcements") && isReadingCategory(" Releases "));
assert.ok(!isReadingCategory("price changes") && !isReadingCategory("new capabilities") && !isReadingCategory("cirbtc"));

/* ---- a reported link is parsed, never trusted, never fetched ---- */

assert.equal(missUrl("https://www.arc.io/blog/cirbtc?utm_source=x&utm_medium=y#top")?.toString(), "https://www.arc.io/blog/cirbtc",
  "Tracking parameters and fragments identify the sharer, not the article");
assert.equal(missUrl("https://x.com/a?id=5&utm_medium=y")?.toString(), "https://x.com/a?id=5", "A meaningful query survives");
assert.equal(missUrl("  http://blog.ethereum.org/en/2026/09/x  ")?.hostname, "blog.ethereum.org");
assert.equal(missUrl("javascript:alert(1)"), null);
assert.equal(missUrl("ftp://x.com/a"), null);
assert.equal(missUrl("https://user:secret@x.com/a"), null, "A link carrying credentials is refused, not stored");
assert.equal(missUrl("https://localhost/a"), null);
assert.equal(missUrl("arc.io/blog/cirbtc"), null, "Not a link without a scheme");
assert.equal(missUrl(`https://x.com/${"a".repeat(3000)}`), null);
assert.equal(missUrl(undefined), null);

/* Stored publication links are https, queryless, and spelled however the
   publisher's own index spelled them. A report must find the card under any
   of those spellings. */
const variants = publicationVariants(new URL("http://arc.io/blog/cirbtc-is-live/"));
for (const stored of ["https://www.arc.io/blog/cirbtc-is-live", "https://arc.io/blog/cirbtc-is-live/"]) {
  assert.ok(variants.includes(stored), `${stored} is found`);
}
assert.deepEqual(publicationVariants(new URL("https://www.arc.io/")), ["https://arc.io/", "https://www.arc.io/"]);

/* ---- which of three defects a miss is ---- */

const feeds = PUBLIC_FEEDS;
assert.deepEqual(coverageOf(new URL("https://www.arc.io/blog/cirbtc-is-live"), feeds, []), { feed: "Arc announcements" });
assert.deepEqual(coverageOf(new URL("https://arc.io/blog"), feeds, []), { feed: "Arc announcements" }, "The index itself, with or without www");
assert.equal(coverageOf(new URL("https://www.arc.io/blogroll"), feeds, []), null, "A path that merely begins with the same letters is not under the index");
assert.equal(coverageOf(new URL("https://www.circle.com/pressroom/anything"), feeds, []), null,
  "Nova reads Circle's blog, not all of circle.com -- a press release there is a coverage gap");
assert.deepEqual(coverageOf(new URL("https://blog.ethereum.org/en/2026/09/22/anything"), feeds, []), { feed: "Ethereum announcements" },
  "A feed on a host of its own covers the host");
assert.deepEqual(coverageOf(new URL("https://github.com/CircleFin/Arc-Node/releases/tag/v1.2.0"), feeds, ["circlefin/arc-node"]),
  { repository: "circlefin/arc-node" }, "A watched repository, whatever the case of the link");
assert.equal(coverageOf(new URL("https://github.com/someone/else"), feeds, ["circlefin/arc-node"]), null);
assert.equal(coverageOf(new URL("https://github.com/circlefin"), feeds, ["circlefin/arc-node"]), null, "An organisation page is not a repository");
assert.equal(coverageOf(new URL("https://x.com/arc/status/1"), feeds, []), null);

console.log("PASS: feedback — a reason only with its own verdict and never from a key every object has, the owner's note bounded, every press saying what it taught including nothing, a rating of a reading kept as a rating and never again a boost for every announcement, a dismissed product matched in the headline and not in an article's text, a category matched only as a category, following as the lever for a publisher, a reported link parsed and refused when it carries credentials, a stored article found under every spelling of its link, and a miss sorted into ranking, reading or coverage with a publisher's blog not standing in for its whole site.");
