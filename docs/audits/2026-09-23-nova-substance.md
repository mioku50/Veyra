# Nova — the substance of a card: when, what is new, how much was read

Roadmap item 2 asks for "evidence links, observation/publication dates, what's
new relative to the previous brief, relevance to the goal and a concrete next
step. If evidence is incomplete, say so." Relevance to the goal and the next
step already existed (the reading's "why it matters" and, since edition 6, the
plan or an explicit "nothing here for you to do"). This change covers the rest.
It started from the owner's brief as it stood, rebuilt read-only from
production, not from a list of features.

## What the owner's brief showed

- **One time per card, and the wrong one.** The Today card showed when Nova
  found the event. The Arc compatibility guide was published 14 September and
  found on the 21st. The Arc Portal launch was published on the 18th, also
  found on the 21st. In the watchlist, three Circle posts from 8–10 September
  were found on the 21st. Each was presented as if it had just happened.
- **Nothing marked as new.** "While you were away" gave a count of passes. No
  card said it had arrived since the owner last looked.
- **A reading of the opening, presented as a reading of the article.** The
  model is given the first 24 sentences of a source. For StableFX that was 24
  of 32 kept sentences, for the compatibility guide 24 of 34, for sponsored
  transactions 24 of 31. Each of those texts was itself the first 6,000
  characters of a longer article. The card did not say so.
- **The same paid endpoint, 24 times.** "Parallel search is available for
  $0.01" appeared four times in the watchlist. Every copy had the same
  resource, method, network (Base) and rail. The difference was the payee:
  Parallel returns a new payment address on every catalogue read. A Nova
  subject is keyed by resource, network and payee, so each scheduled pass
  created a new subject and a new "available" card. There were 24 in eight
  days on the owner's agent, and they took slots in the brief's 60-signal
  window from real events.
- **A 770 KiB brief**, 310 KiB of it article text the page never displays:
  up to three copies of each article that was read.

## What changed

| Item 2 asks for | Now |
| --- | --- |
| Publication dates | Publications and releases show "published 14 Sep · found 2d ago", or "publication date unknown". Everything else shows "found …". |
| What is new relative to the previous brief | A card found since the owner's previous visit is marked **new**. A card whose reading was rewritten since then is marked **re-read**. |
| Evidence links | A read card links to the original next to the reading's own date, not only inside the collapsed sources. |
| Say when evidence is incomplete | Every reading says how much of the article it stood on, for example "Read the first 24 of 32 sentences Nova kept from a longer article. The rest was not read." or "Read the whole article." It is shown in the warning colour when the reading was partial. Since edition 7 (below) a reading is given the whole article, so the first of those is what older readings say. |
| Duplicates | One listing per endpoint (resource, method, network, rail), whatever payee it names. The brief keeps the newest, and the refresh no longer writes a second "available" card for an endpoint already listed this month. |

**The previous visit.** `last_opened_at` could not define "new": the brief
reloads after every refresh, reading and goal change, so "since the last load"
means "since a minute ago", and every mark would disappear on the first press.
`nova_agents.seen_through` moves only when a new visit begins, meaning more
than 30 minutes have passed since the last open, and it moves to the end of
the previous visit. Nothing is marked during an agent's first visit.
"While you were away" now uses the same boundary, so it no longer disappears
when the owner presses a button.

**The page receives no article text.** The brief builder works out an older
reading's coverage from its stored text and then sends the page empty
`text` fields. The stored rows are unchanged.

**Kept text.** An article is now kept to 12,000 characters instead of 6,000,
and the parser records whether it was cut. For material stored before that,
a length of exactly 6,000 means it was cut.

## Found along the way: a reference page had moved

Circle moved its Nanopayments reference from `/gateway/nanopayments/` to
`/gateway-nanopayments/` and answers the old address with a 307. Nova's reader
refused all redirects, so from that point every reading would have lost the
page, and the card would have said "Could not read: Circle Nanopayments
supported networks. Coverage is incomplete." The move happened after the most
recent stored reading (22 September, 18:58 UTC), which still has the page.
None of the 16 stored readings is affected.

The address is corrected. The reader now follows **one** redirect, and only
to the same approved origin. A redirect to another origin, even another
approved one, is still a failure, as is a second redirect. The seven-second
limit covers both requests together.

## The whole article: withdrawn once, then measured and shipped as edition 7

The obvious remedy for "24 of 32 sentences" is to give the model the whole
article. The first attempt was withdrawn before shipping. Its dry run on the
owner's four Today cards lost every plan, including the three that connected
the event to "Operational wallet не выбран", two of which the owner had rated
useful. An A/B under identical conditions lost the plans **in both arms**,
and the run had used the local environment, whose reading model is
`ministral-8b-latest` on Mistral, not production's `deepseek-v4.1-flash` on
OpenRouter. Missing exactly this connection is the Ministral weakness edition 6
recorded. That run measured the model, not the input.

Production's reading settings are Vercel secrets and do not come back out:
`vercel env pull` and `vercel env run` both return them empty. The second
measurement gave them to the measuring process directly. Nothing was written
to the local environment file.

Five cards: the owner's four on Today, and every card they rated useful. Three
runs per arm. Arm A gave the event as edition 6 saw it, the first 24 sentences
of what was stored. Arm B gave edition 7's input, the whole article, fetched
again up to 12,000 characters. The goal, the confirmed project facts, the
reference pages, the model and the code path were the same in both.

| | A, input changes (3 cards) | B, input changes | A, control (2 cards) | B, control |
| --- | --- | --- | --- | --- |
| Answered | 8/9 | 8/9 | 5/6 | 6/6 |
| Plan proposed | 4 | 5 | 3 | 3 |
| Plan built on "Operational wallet не выбран" | 2 | 5 | 3 | 3 |
| Answer not in the goal's language | 4 | 1 | 0 | 1 |
| Median / slowest | 19s / 43s | 26s / 43s | 19s / 24s | 21s / 29s |

- **Sponsored transactions** (rated useful): the wallet plan in 3 of 3 against
  1 of 2 answers, and all three in Russian against neither.
- **StableFX**: no plan in either arm, as stored. Two of three edition-6
  answers came back in English.
- **The compatibility guide** (rated useful) is where edition 7 was not
  better. One run failed with `invalid_response` at 42 seconds. Edition 6's
  plans split between the wallet and a check of the escrow contract.

The readings use what the opening never had. "arc-anvil" is sentence 31 of the
compatibility guide. The `maxFee` threshold is sentence 26 of sponsored
transactions. That StableFX participation is permissioned is its sentence 48.

Arc Portal and the Noble notice were not cut, so both arms gave the model the
same text, and they are the control. There, cirBTC, which the owner had
dismissed, was mentioned in 1 of 3 answers in one arm and 3 of 3 in the other.
That is how much two runs of an identical input vary on this measure. It is
not an effect of edition 7, though the first dry run had counted it as one.

**Cost and time.** Thirty readings cost $0.09 on the key's usage counter,
under a cent each. On the cards whose input grows, the median reading took 26
seconds against 19. The slowest is bounded by the same 45-second limit. The
article is fetched again only where the stored copy stopped at the old
6,000-character cap, and alongside the reference pages rather than before
them. So the per-card button's worst case is unchanged: it has 60 seconds,
and the model alone may take 45.

**What shipping it does.** `READING_RULES` becomes 7. Every stored reading is
then marked as written under an earlier edition and is read again, Today's
cards first, two per scheduled pass, or at once from the card's own button.
The owner's ratings stay recorded against the readings they rated.

## Open, for item 4

A seller with a rotating payee cannot have its payee watched for changes. Each
observation is a new subject, so there is never a previous payee to compare
against. The brief and the refresh now show and write one card per endpoint,
but the subject table still gains a row per pass for such a seller. Pricing a
card finds its endpoint again by the subject's reference, and that reference
includes the payee, so whether an endpoint like this can be priced through
Veyra at all should be checked under item 4 (free-first tool selection). It is
not claimed either way here.

## Verified

- The owner's brief was rebuilt read-only from production before and during
  this work. All of the figures above come from it.
- The first scheduled pass after the deploy, at 06:04 UTC on 23 September,
  wrote one "available" card, for a new endpoint (AIsa), and none for
  Parallel. Its two readings came from OpenRouter's `deepseek-v4.1-flash` and
  recorded their own coverage: 24 of 31 sentences from a cut article, and
  1 of 1.
- The owner's visit at 15:06 UTC began a new visit. `seen_through` moved to
  19:09 UTC on 22 September, the end of the previous one.
- Migration `20260923090000_nova_seen_through` applied to production
  (applied=1). The owner's `seen_through` is null and `last_opened_at` is
  22 September 19:09 UTC, so their next visit marks as new everything found
  since then.
- The moved reference was confirmed from here (307 to
  `/gateway-nanopayments/supported-networks.md`, which returns 200).
- A new release-gate step, `nova-substance:test`, covers coverage, cut
  detection, the redirect rules, the visit boundary, dates, one listing per
  endpoint and the text-free page view. For edition 7 it covers the event
  given whole, a reading citing past the old twenty-fourth sentence, and the
  refetch: done only for the old cap, alongside the references, and falling
  back to the stored copy. The product-value bucket invariant
  now states that a duplicate is held and not listed. The full gate passes,
  including the production build.

## Not verified

- What the owner saw of the new and re-read marks. The boundary moved as
  designed, and nobody here has looked at their screen.
- Edition 7 in production until a reading is written there under it. Five
  cards and three runs per arm are a small sample. The compatibility guide
  shows that a longer input can still lose a run.
