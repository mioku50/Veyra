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

## Edition 4, written against the first real reassessment

The owner pressed the new button on *Arc Portal: The Easiest Place To Get
Started on Arc*. The chain worked end to end and the verdict was wrong, in a
way the stored reading states plainly:

- `significant: true`
- `plan.established: []`
- `relativeToWork`: "Нет прямой связи с проектным состоянием, но расширяет
  функционал…"
- `plan.action`: "Обратиться к документации Arc Portal и Circle для получения
  списка доступных API"

The model said there is no direct connection to the project state, stood on
none of the owner's confirmed statements, and proposed going to read the source
it had just been handed. That last part is the abstraction this release was
built to remove, one level down: "study the three sponsorship models" became
"go and find out which APIs exist".

Edition 3 already forbade this — an ecosystem addition naming no concrete
decision is not significant — so the gap was not a missing rule. Two rules were
added anyway, because both are inferences from what the model itself wrote
rather than new opinions about the subject:

- `plan.action` is work on the owner's side: a check, a comparison, a decision
  or a change. Reading the handed-over material, visiting a site to see what it
  offers, or finding out which APIs exist is not an action; naming a document
  belongs inside a larger action. **If nothing beyond that is supported, the
  event is not significant** — an event nobody can act on is news about the
  ecosystem, not work for this owner.
- If `relativeToWork` would say the event has no direct connection to
  `projectState`, `significant` is false. "May be useful", "could help" and
  "expands possibilities" are not significance.

### Measured, on the stored material, three runs per subject

| Subject | significant | action |
| --- | --- | --- |
| Arc Compatibility Guide | true, *unusable*, true | analyse Veyra contracts for balance operations; build a compatibility test case |
| Sponsored Transactions on Arc | true, true, true | compare Veyra's gas handling against the documented models |
| cirBTC Is Now Live on Arc | false, false, false | — |
| Circle discontinuing Noble | false, false, false | — |
| Arc Portal | *unusable*, true, false | — |

The actions are now work rather than reading. Four of the five subjects are
stable across runs. **Arc Portal remains a coin flip**, and that is not fixed.

### An experiment that was reverted

`plan.established` came back empty on every run, so the "what you already have"
part of the format is almost always the empty branch. For the Compatibility
Guide that is honest: the owner's four confirmed facts say nothing about USDC
units — that came from the illustration in the request, not from their context.
For Sponsored Transactions it is a miss: "operational wallet не выбран" is
exactly what the work turns on.

Rewording `establishedFrom` to include "the reason the work is needed" made it
worse, and the trial is why we know: cirBTC flipped to significant, and Arc
Portal justified itself with "«Приоритет — полезность исследований Nova". A
model told to find an anchor finds one, and having found one, judges the event
relevant. Reverted to the narrower wording. Empty stays the common case.

### What this says about the model

The deployed reading model is `ministral-8b-latest`. It is applying twenty
judgement rules to Russian-language material and returning a different verdict
on repeat runs of identical input, and roughly one run in seven is rejected
outright as unusable — correctly, and visibly, but rejected. Every prompt fix
in this release had to be trialled against that variance, and one of the three
attempts swung the wrong way.

Prompt wording is close to exhausted as a lever here. The remaining variable is
the model, which is configuration (`LLM_*`), a cost decision, and the owner's to
make. Nothing in this note recommends spending it.

## Choosing a model for the judgement call, 2026-09-21

Prompt wording had stopped paying. The owner asked for a comparison before
changing anything, so this is the measurement it rests on: same prompt, the
owner's real goal, their four confirmed facts, the stored material of five
events, 25 runs per model.

| | ministral-8b-latest (was) | deepseek-v4-flash (now) |
| --- | --- | --- |
| Verdict matches the reference | 5 of 5 subjects | 4 of 5 |
| Same verdict across runs | 4 of 5 | 5 of 5 |
| Usable answers | 24/25 | 24/25 |
| Latency median / p90 / max | 5.1s / 6.6s / 7.8s | 16.4s / 33.4s / 36.6s |
| Over the 25s reading timeout | 0 of 24 | 6 of 24 |
| Answered in the goal's language | 24/24 | 13/24, then 9/9 |
| Cited a confirmed project fact | **0 of 24** | **15 of 24** |

The last row decided it. Nothing was wrong with the mechanism that resolves a
project statement from an index; the model simply never used it, so the "what
you already have" half of every finding was empty by construction. The
difference shows in the actions too — "создать список файлов, ответственных за
обработку балансов, и проверить их на совместимость" against "составить перечень
файлов и путей, где читаются `address.balance`/`balanceOf`, переводят native
USDC или ERC-20 и индексируют Transfer, затем проверить каждый на 18↔6".

### What the reference got wrong

Arc Portal is the one subject the two models disagree on, and this note called
deepseek's *significant* the error. Re-read afterwards with the project context
actually in use, it proposed: build a checklist for choosing the operational
wallet — networks, agent delegation, limits, permissions — and settle it
against what Arc Portal offers. Against a confirmed "operational wallet не
выбран" that is not ecosystem news; it is material for a decision the owner has
said is open. The 4-of-5 above should be read as 5 of 5, and the reference
judgement as the thing that was wrong.

### Two models, because the workloads are not the same

`.env.example` already recorded deepseek-v4-flash failing two calls in five on
Nova's one-sentence rewrite — a reasoning model spending its whole budget
reaching a single sentence. Pointing `LLM_MODEL` at it would have traded one
regression for another.

So `LLM_READING_*` overlays the judgement call alone, each setting falling back
to its plain counterpart. An environment that sets none of them resolves
exactly as before, and that fallback is pinned by a test in
`scripts/llm-provider-tests.mts`.

### What the slower model cost, paid before deploying

- Reading timeout 25s → 45s. At 25s roughly a quarter of readings were killed
  mid-answer and shown as the model declining rather than the clock expiring.
- Reading budgets 3 → 2 scheduled and 5 → 3 attended, so a refresh finishes
  inside the route's 180 seconds. Three readings at the measured tail plus the
  source fetches and the observation pass already spend most of it. The
  per-card button means the backlog is no longer the only way through.
- Response cap 24 KB → 96 KB **for this call only**. This was not predicted: the
  first live call through the real path returned no answer after 34 seconds
  with everything configured correctly. The model returns its working inside
  the body — 6150 completion tokens for a 1.2 KB reply — and across eight
  readings the raw bodies ran 6.7 KB to 22.9 KB. The largest sat at 95% of the
  cap and one call crossed it. Nothing was failing consistently, which is why
  only a live run found it.
- Rules edition 5 states the language rule per field. It also retires every
  judgement the previous model made, as a side effect of the edition rather
  than through any rule that models which model wrote a reading.

### Verified

Six of six readings through the real path — `resolveReadingLlmConfig` →
`generateOpenAiCompatibleText` → AgentRouter, no test double — 12 to 24
seconds, every one in Russian, every one citing two or three confirmed facts.

Not verified: cost. AgentRouter publishes no pricing in its model catalogue and
this note does not estimate one. Nor is there evidence yet from a scheduled
tick in production, or from the owner's own judgement of whether the proposed
work is worth doing. That is still gate V.

## The model change was reverted on 2026-09-22: a firewall, not a model

Every reading from production failed for sixteen hours, across four passes and
one owner-triggered reassessment. Nothing was written by the new model, ever.

The cause, once the client stopped discarding the evidence:

```
Nova public-source analysis (invalid_response: body was not JSON (<!doctype html>
<meta charset="UTF-8">
<meta name="aliyun_wa…))
```

AgentRouter sits behind Alibaba Cloud's web application firewall, which answers
requests from Vercel's egress addresses with an HTML challenge page **and HTTP
200**. From a laptop the same call, the same key, the same headers and the same
prompt succeed; from a datacenter address they do not. The key was not
exhausted — a direct call during the outage returned a valid answer in 2.1s.

`LLM_READING_*` has been removed from production, so the reading call resolves
to the base configuration again, which is the fallback that exists for exactly
this and is pinned by a test in `scripts/llm-provider-tests.mts`. Nova reads
again on ministral-8b, with the empty "what you already have" section the
comparison documented.

### Three failures of diagnosis, each mine, each fixed after it cost something

1. **Six causes, one sentence.** The first failure said "could not produce a
   source-supported analysis", which reads as the model having looked and
   declined. It covered a provider not configured, a timeout, a rate limit, an
   upstream refusal, an oversized answer and an ungrounded one.
2. **The evidence was thrown away.** Having named `invalid_response`, the
   client still discarded the body that would have said what it was. A router
   refusing at 200 and a model with nothing to say are identical from the
   client's side; only the body tells them apart.
3. **The screen said nothing.** The unreachable-sources warning rendered only
   when Today had cards. A brief empty because every reading failed looked
   exactly like a brief empty because nothing happened — which is what the
   owner saw twice, reporting "I see no difference". It now renders either way,
   and says which of the two it is.

A local reproduction that passes 6 of 6 is not evidence that a deployment
works. Nothing here was caught by a test, a type or a gate; the only thing that
found it was a diagnostic written after the fact and a live press.

### What is still open

deepseek-v4-flash is unreachable from this deployment, not unsuitable — the
comparison stands. Getting it back needs one of: AgentRouter allowing Vercel's
addresses through its firewall, the same model behind a provider that is not
behind that firewall, or a request path that does not originate from a Vercel
function. None of these is a code change in this repository, and none is
attempted here.

## Settled on ministral-14b, 2026-09-22

With AgentRouter unreachable, the question became what is available on the key
that already works from this deployment. `mistral-small`, `mistral-medium` and
`magistral-small` all answer 429 `Rate limit exceeded` on it — the account does
not reach them. `ministral-14b-latest` answers.

Measured against the production source set — the event plus the Arc and Circle
reference pages, three sources rather than one. That matters: yesterday's
25-run comparison used a single source and flattered the smaller model.

| Subject, 4 runs each | ministral-14b |
| --- | --- |
| Arc Compatibility Guide | significant 4/4, cites 1–2 confirmed facts |
| Sponsored Transactions on Arc | significant 4/4, cites 1 |
| Arc Portal | significant 4/4, cites 1 |
| cirBTC Is Now Live | significant 4/4 — the bar is lower than either other model |
| Circle discontinuing Noble | ungrounded 4/4, rejected by the citation check |

Confirmed facts cited: **12 of 12 usable runs**, against **0 of 14** for
ministral-8b under the same conditions, where 8b also called the owner's main
card significant only once in three.

The trade was taken deliberately. 14b's defect is extra cards on Today —
visible, capped at five, and correctable by the owner's own "not interesting".
8b's defect is that it never uses what the owner said about their work, and
nothing corrects that.

Set as `LLM_READING_MODEL` alone; base URL, key and label fall back to the
Mistral configuration the rewrite path already uses. No rules bump: every
stored reading predates edition 5 and is queued for re-reading already.

Still unverified: whether 14b holds up beyond these five subjects, what the
extra cards do to the brief in practice, and whether the proposed work is worth
doing. The last one is gate V and no model choice settles it.
