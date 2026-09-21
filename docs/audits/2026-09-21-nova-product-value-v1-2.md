# Nova Product Value V1.2 — a reading somebody asked for, and work instead of a topic

## What this changes

Two things, and they answer the same complaint from two directions.

1. **Reassess for my project.** A card with public sources can be re-read on
   its own, on request, against the project state as it stands. It spends none
   of the background budget and it never returns the stored paragraph.
2. **Proposed work instead of a subject.** A significant reading now carries a
   plan: what the owner already confirmed, what the event changes, what is
   still not established, and one concrete action. Nothing in it is a finding
   about their code.

## Why the button had to be new

The per-card reading endpoint already existed, and it reused a stored
assessment whenever the goal, the project state and the rules behind it still
matched and it was under a day old. That is the right behaviour for a pass
nobody asked for and the wrong one for a button: a person pressing it is asking
what this event means for the project **now**, and handing back yesterday's
paragraph answers a question they are no longer asking — indistinguishably, in
the same typeface.

`researchPublicSources` takes `reassess`, the route reads it from the body, and
the page always sends it. Absent or malformed, the body means the older
reuse behaviour, so nothing else that calls the endpoint changes.

This is separate from the refresh budget on purpose. A backlog two dozen deep
drained three to five at a time cannot answer "what does *this* card mean for
me", which is the question somebody with a card open is actually asking.

## What a failed reassessment shows

A reassessment can fail two ways: no readable public material is stored
(`source_unavailable`), or the model did not return a usable, source-supported
answer (`analysis_unavailable`). Neither overwrites what is stored.

The page then says so twice, because the error alone is not enough — the
paragraph underneath it still looks current:

- the failure message, as before; and
- above the reading: *Not re-read just now. What follows is the earlier
  reading, written <time>.*

Independently of any button press, a stored reading is marked when it was
written against a project state the owner has since changed, or under an
earlier edition of the reading rules. The page computes this the same way the
refresh pass does — `contextForPrompt` and `readAgainst` over the confirmed
statements, and `READING_RULES` — so the marker and the re-reading queue cannot
disagree about which readings are current.

`READING_RULES` moved from `lib/nova/free-research.ts` to `lib/nova/value.ts`
for that reason: the page needs the edition number, and the rules module pulls
in the model client.

## The plan, and the one sentence it is not allowed to write

The example this was built against:

> **What you already have** — your confirmed context says the native/ERC-20
> USDC difference is handled.
> **What changed** — Arc published compatibility requirements for existing EVM
> apps.
> **What is not established** — whether every Veyra execution path uses the
> right USDC units. Answering that needs the implementation.
> **Do this** — check the payment and balance adapters against the guide; with
> no access to the source, produce the exact list of files and checks instead.

The dangerous line is the first. A model given four facts about a project will
generalise them into a verdict about all of it — "your paths are Arc-compatible"
from "native USDC differences are handled" — and a verdict nobody can check is
worse than no verdict.

So `plan.established` is not prose the model wrote. The model chooses which of
the owner's confirmed statements it is standing on, **by 1-based index**, and
the server copies in the owner's own words. An index nobody supplied fails the
whole assessment, exactly as an invented citation does. This is the same
provenance mechanism as `citationIds`, applied to the other half of the input:
the sources establish what a release says, the project context establishes what
the owner has built, and neither the model's memory nor its inference may
substitute for either.

The status line — *Proposed work, not a completed check. Nova reads public
sources; it has not seen your code.* — is fixed in the page. It is not a field
the model can fill in, so there is no output that makes it say anything else.

Rules added to the prompt: never report a defect, a passing check, a
compatibility result or an audit outcome; never turn a few confirmed facts into
a verdict about the whole project; where an answer needs the implementation, say
so instead of guessing it; and where the action needs access the model does not
have, the action is to produce the exact list of files and checks to run.

`plan` is null when the reading is insignificant or the event asks for no work,
and a half-written plan is dropped in favour of the one-line next step. The
plan replaces that line on the card rather than joining it.

## The reading rules are now edition 3

Changing the instructions rewrites what every later reading would say and
nothing about the stored ones, so the edition is recorded on each assessment and
`readingStands` retires the ones that predate it. All 27 stored publication
readings go back into the queue.

That made a flaw in the ranking visible. Inside a relevance band the pass read
corrections first — a reading judged against a project that no longer exists is
wrong on the screen, while an unread event is merely missing. When a rules bump
retires everything at once, every candidate is a correction and the flag sorts
nothing.

What still separates them is whether the stale paragraph is one the owner is
looking at. A reading found significant is what puts a card on Today; one held
back as insignificant will most likely be held back again, and re-reading it
changes nothing anybody sees. The order inside a band is now: a stale reading
on the screen, then one nobody has made yet, then one nobody sees.

Measured against the live database before deploying, read-only: pool 27, all 27
needing a reading under edition 3, and the first three candidates are the three
cards actually on the owner's Today — Arc Compatibility Guide, Arc Portal,
Sponsored Transactions on Arc. Under the previous order those sat at positions
5, 8 and lower, behind material the owner had already been shown as
insignificant.

`onScreen` is a projection of `evidence->valueAssessment->>significant`, and the
comment says what it is worth: the brief's five-card cap and its deduplication
can still keep a significant card off the screen, so it means "could be on the
screen", not a promise.

## What this does not establish

- No claim is made that Veyra is Arc-compatible, or that any adapter was
  checked. Nova has not read the repository. Every plan is proposed work.
- Excerpt matching establishes provenance, not that the interpretation is
  right. Index resolution establishes that a statement is the owner's, not that
  the owner is still correct about it.
- A reassessment costs an application-side model call per press. It charges no
  wallet and calls no paid tool, and the button is owner-authenticated, but it
  is not free to the operator.
- Gate V is unchanged. Whether these findings are worth reading is still the
  owner's judgement, and no amount of formatting settles it.

## Verification

`npm run nova-project-context:test` now pins the provenance of the plan: an
index resolves to the owner's exact statement, an index past the end of the list
fails the assessment, a statement passed as prose instead of an index fails it,
an empty index list is allowed and yields work built on nothing confirmed, a
half-written plan is dropped, and an insignificant reading carries no plan. The
end-to-end case asserts the prompt now numbers the statements, because an index
into an unnumbered list is a guess.

`npm run nova-product-value:test` pins the new order for the case that exposed
it: four candidates, all corrections, ranked as on-screen, then never read, then
held back.

Full `npm run release:gate`, plus a read-only dry run of the backlog query and
the ranking against the live database.

Not verified here: the quality of any real plan, whether a reassessment
produces a better reading than the one it replaces, and the behaviour of the
failure paths against the deployed database. Those are observations to collect
after the deploy, not claims to make now.
