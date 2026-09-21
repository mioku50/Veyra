# Nova: project context, and an honest account of what was held back

Date: 2026-09-21. Status: **implemented; owner-value acceptance still open.**
Builds on [Nova Product Value V1](2026-09-21-nova-product-value-v1.md).

## Why

Three things were wrong with the first goal-driven briefs, all of them visible
in one real run: 24 subjects checked, 3 cards, and a panel reporting **"held
back as noise: 0"**.

1. The number was true about relevance and false about the brief. Most of a
   goal-driven brief is decided at the significance gate, and nothing counted
   what that gate did. The owner could see a filter that had done no work and
   not the one that had done all of it.
2. The reading budget — three public readings per pass — was spent in the order
   the source list happened to return. A publication Nova has not read cannot
   clear the significance gate, so with thirteen publications and three
   readings, ten were not judged unimportant; they were never judged at all,
   and traversal order silently chose the brief.
3. A goal says where the owner is going. Nothing said where they are. So a
   release note about sponsored transactions on Arc arrives as news to somebody
   who shipped against Arc in July, and "here is a new technology" never
   becomes "here is what changed for what you already built".

## What shipped

### Held back, by reason

`assembleBrief` now returns every withheld signal grouped by why it was
withheld: `noise`, `background`, `not_analyzed`, `not_significant`,
`duplicate`, `over_cap`. Every bucket but `noise` is exactly the existing
watchlist, so nothing is counted twice and nothing is invented; the Today panel
shows the total and opens into the groups.

`not_analyzed` is deliberately its own reason. "Nova has not read this for your
goal" is a gap in coverage — the budget ran out, the model was unavailable, the
goal changed after the reading — and "the reading found nothing significant" is
a verdict. Collapsing them would hide which of the two the owner is looking at,
and they have opposite remedies.

### A reading budget spent by relevance

`PUBLIC_READING_BUDGET` is unchanged at three. What changed is that the pass
now scores every observed change first, then spends the budget on the
highest-scoring candidates, skipping material relevance already rejected — the
brief would drop it whatever the reading said. What the budget does not reach
stays unread, is visible as unread, and is reconsidered by the next pass, which
drains the backlog in the same order. The backfill pass is ranked the same way
instead of by recency alone.

This does not increase coverage per pass. It decides which three of thirteen
get read, and reports the other ten instead of dropping them silently.

Observed on the first real run and then fixed: ranking the new events and the
unread backlog as two separate passes repeated the same bug one level up. A
refresh with three new publications spent the whole budget on them, and two
higher-relevance Arc events the owner cared about kept a reading made before
the project context existed. Both populations are now ranked together. A
stored signal keeps its band and not the number behind it, so it is ranked
from that band's floor.

That floor was still not enough: on the next pass two fresh `medium`
publications outscored the two stored `medium` Arc cards and the same cards
starved again, still showing a judgement made before their owner had said
where the work was. Inside a band, a **correction** now goes first — a reading
made against a project state that no longer exists is wrong on the screen now,
while an unread event is only missing, and missing is the better of the two to
still be true at the end of a pass. Across bands the band still wins: a stale
low does not outrank the most important thing that happened today. An event
with no reading at all is not a correction and waits its turn with the new
ones.

And the ranking still changed nothing, because the set being ranked was the
wrong set. The backlog read took twelve rows ordered by observation time, and
an agent's first look records every publication it finds in the same second:
forty rows tied on that column hand back an arbitrary twelve. The two events
the owner cared about were never in the set, so no amount of ranking could
reach them. The pool is now the backlog itself (60 rows, ordered
deterministically by time and then id) and is read through a projection —
headline, band, and the goal and project state of any stored reading — so
choosing three readings does not load forty articles. Material is fetched only
for the candidates the budget actually reaches, and a row whose material never
reached storage costs a lookup rather than a reading.

This one is not unit-testable: it is the shape of a database query, and it
failed in exactly the way that looks identical to working. It was found by
comparing the app's behaviour with the stored rows, and the fix was verified
by a read-only dry run of the same selection against live data, which put both
stale Arc cards at the top of the next three readings.

### Project context

A per-agent list of short statements about the state of the work
(`nova_project_context`, service-role RLS). Confirmed statements are supplied
to each reading as `projectState`; the assessment gains `relativeToWork` (what
this changes for work already done), `projectContext` (the statements it was
judged against, copied in), and `contextProposal`.

**Nova proposes; only the owner confirms.** A proposal is stored with status
`proposed` and never reaches a prompt. This is the load-bearing rule: an
inference about the owner's project that could confirm itself would be
indistinguishable, a week later, from something the owner said, and every later
reading would be judged against it. A dismissed statement is not proposed
again — re-asking is how an agent argues with its owner until the owner stops
reading, and the dismissal is itself information.

Limits: 12 confirmed statements, 200 characters each, at most 6 unanswered
proposals, and 1,200 characters of context per prompt so a growing context
cannot crowd the source excerpts out of it.

### Changing the context reconsiders recent readings

Each stored assessment carries the statements it was judged against, so a pass
can tell which readings answer a question about a project that no longer
exists. A changed context now reopens them the same way a changed goal does,
within the same reading budget and in the same relevance order; saving the
context asks Nova to look again, so the effect is visible rather than deferred
to the next scheduled tick. Cards the budget does not reach keep the reading
they had, and every card names the state it was read against.

An assessment written before this existed stores no context, which matches an
empty context and nothing else — set one statement and the old readings are
reconsidered.

### One fact per row, offered rather than imposed

The first owner to use the panel typed four facts into one row. It reads the
same to the model, but it cannot be corrected a line at a time, and being
correctable is what keeps this list from going stale — "operational wallet is
not chosen" has to be removable on the day one is. The editor now detects a
row that is several sentences and offers to split it. It does not split
anything on its own: silently rewriting what somebody typed about their own
project is the same mistake as confirming an inference for them.

### What the context did to significance, and the edition that fixes it

The first eight readings made against a real project context all came back
`significant: false` — including an Arc compatibility guide that had been
significant before the context existed, and whose next step named a concrete
audit of this codebase. Four confirmed facts about ERC-8183, ERC-8004 and an
operational wallet had become a checklist: anything they did not name was
answered with "does not change ERC-8183 or ERC-8004". The context made the
agent narrower rather than sharper, which is the opposite of the point.

The rules now say that project state is a baseline and not the list of
everything that matters, that significance is still judged against the goal,
and that an unmentioned subject is usually work not yet done rather than proof
of irrelevance — followed immediately by a sentence refusing to lower the
significance bar, because the first correction sent every ecosystem
announcement back to significant. Trialled twice per case against the owner's
stored material: the compatibility guide and sponsored transactions came back
significant both times, a new-asset launch insignificant both times. Two
samples per case is evidence about a prompt, not a guarantee about a model.

Changing those rules retires the readings made under the old ones, which
nothing would otherwise notice: an instruction change rewrites what every
later reading would say and leaves the stored ones asserting a judgement the
current rules would not make. Each assessment now records the edition that
produced it, and a reading stands only while the goal, the project state and
the edition all still hold. The fourteen assessments written before this are
reconsidered a budget at a time.

## Deliberate limits

- A confirmed statement is the owner's claim, not a verified fact. Nothing
  checks it against the repository, the chain or the deployment, and a stale
  one will be used as true until the owner corrects it.
- `relativeToWork` is the model's comparison of an event against those claims.
  Excerpt matching establishes what a source says; it does not establish that
  the comparison is right.
- Saving context does not rewrite assessments already stored. Each one carries
  the context it was read against, which is what makes a later disagreement
  legible instead of invisible.
- None of this establishes product value. It changes what Nova is told and what
  the owner can see; whether the findings are worth reading remains gate V.

## Rollout

Apply `20260921180000_nova_project_context.sql` **before** deploying, with
`npm run nova-project-context:migrate`. The application reads
`nova_project_context` on every brief, so deploying first makes the brief fail
until the table exists. The runner verifies RLS and the confirmation-recording
constraint, and touches no existing goal, signal or mandate.

## Verification

`npm run nova-project-context:test` (new; in the release gate), plus
`nova:test`, `nova-product-value:test`, `nova-presentation:test`,
`nova-autonomy:test`, `nova-discovery:test`, `tsc --noEmit`, targeted ESLint and
the Next.js production build. The new suite pins the invariant directly: a
`proposed` statement never appears in the prompt sent to the model.

Not verified here: live behaviour against the deployed database, the quality of
any real `relativeToWork`, and whether owners actually keep their context
current. Those are observations to collect, not claims to make now.
