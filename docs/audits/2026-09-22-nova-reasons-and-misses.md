# Nova — why, with the rating; and what Nova missed

## What this changes

Gate V asks the owner to rate findings "and the reason" and to review
"important misses". Neither could be done in the product. By 2026-09-22 the
owner had rated five readings (four useful, one not), and none of them had a
reason, because the page had nowhere to put one. A missed event could only be
told to whoever was reading the chat. The coverage report said as much: "only
the owner naming one establishes it."

1. **A reason with a rating of a reading.** After "Useful" or "Not useful" on a
   card whose reading was made against the current goal, the card offers
   optional reasons and a note in the owner's own words.
2. **"Did Nova miss something?"** The owner pastes a link. Nova says what it
   had, and the miss is recorded for the coverage report.
3. **Every press says what it taught**, including that it taught nothing.

## The reasons are the review's categories

| Verdict | Reason | What the review reads it as |
| --- | --- | --- |
| Useful | Changes what I'll do | work, not only news |
| Useful | Good to know | news |
| Not useful | Not about my goal | noise |
| Not useful | Already knew it | late, or not new to this owner |
| Not useful | Proposes work I don't need | the edition-6 failure mode, measured |
| Not useful | Wrong or unsupported | an evidence gap in the reading |
| Not useful | Duplicate | a duplicate |

A review counts these rather than interpreting prose. A reason is accepted only
with its own verdict: the database has a CHECK for it, and `reasonFor` refuses
a cross-verdict pair (and `__proto__`, which is a key of every object). Every
send states the whole rating, so a verdict changed from useful to not useful
cannot keep "Changes what I'll do".

**Nothing is learned from a reason.** The page says so next to the chips. A
reason that quietly retrained the scorer would be personalization claimed
without a demonstrated effect, which item 5 already rules out. The note is
stored for the review and is never sent to a model, so it is not a way to put
instructions into a reading.

Reasons are offered only where the server kept the rating: a reading judged
against the goal as it stands. On a card with no reading there is nothing for a
reason to be about, and chips there would record nothing. A reason sent without
its verdict is refused by the route. The old fallback would have turned it into
"seen" and brought a dismissed card back.

## A rejected card folds instead of vanishing

"Not useful" used to remove the card, and a card that has gone can neither say
what the press taught nor ask why. It now folds to its headline in whichever
list it is in, says what was learned — "Hidden. Nova will rank cards about
cirbtc lower." or "Hidden. Nothing to learn from this one, so similar cards will
still appear." — and is gone on the next load. The second sentence matters. A
dismissed announcement whose headline names no product teaches nothing, and an
owner who is not told that will go on dismissing them and expecting fewer.

"Useful" now says "Nova will rank announcements higher." That is category-wide,
and saying so keeps the known limit from item 5 in view: it is not hidden
behind a checkmark.

## A missed link is parsed and never fetched

Fetching it would turn an owner form into a way to make the server read any
address on the internet. The answer the owner needs does not require a fetch.
Nova reports one of three findings, and each is a different defect:

| Finding | Meaning | Fixed by |
| --- | --- | --- |
| `observed` | Nova has a card for this exact article | ranking or significance, not sources |
| `covered` | Nova reads this publisher's index, or watches this repository, but has no card for it | the reader: window, index links, parsing |
| `not_covered` | Nova reads nothing there | adding a source |

Only the third is fixed by adding a source, and only its hosts are listed in the
report under `misses.notCoveredHosts`. That makes the list the input item 3
asked for: extend coverage from missed owner-relevant events, not from raw
item volume.

For `observed`, the answer comes from the goal as it stands now. A reading made
under an earlier goal is not a judgement about this one, and "judged not
significant" on the strength of it would blame the wrong step.

Coverage follows the index, not the domain. `www.circle.com/blog` does not
cover a Circle press release, so a press release is correctly a coverage gap.
A feed on a host of its own (`blog.ethereum.org`) covers the whole host.

Stored article links are https, with no query and no fragment, and keep
whatever `www.` and trailing slash the publisher's index used. A report is
matched under every one of those spellings, with tracking parameters stripped
first.

## Verified

- Migration `20260922200000_nova_reasons_and_misses` applied to production
  with `npm run db:migrate` (applied=1). A read-only check confirmed the
  `reason`/`note` columns on the five existing rows (all null) and an empty
  `nova_misses`.
- The lookup `reportMiss` makes was run read-only against the owner's
  production agent.
  `http://arc.io/blog/cirbtc-is-now-live-on-arc/?utm_source=x#top` found the
  stored card "cirBTC Is Now Live on Arc", which is stored as
  `https://www.arc.io/blog/cirbtc-is-now-live-on-arc` and marked dismissed. A
  made-up link on the same blog found nothing.
- `nova-feedback:test` (new, in the release gate) and the extended
  `nova-coverage:test` pass, as does the full gate including the production
  build.

## Not verified

- No reason and no miss has been recorded by the owner yet. The chips, the
  note and the miss form have not been exercised in the deployed page by
  anyone, and no production agent was created to exercise them. An agent made
  for a test is somebody's agent in the tables that count owners.
- Whether the reasons change anything is not a question this change can
  answer. They exist so that the gate V review has something to count.
