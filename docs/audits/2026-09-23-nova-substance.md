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
| Say when evidence is incomplete | Every reading says how much of the article it stood on, for example "Read the first 24 of 32 sentences Nova kept from a longer article. The rest was not read." or "Read the whole article." It is shown in the warning colour when the reading was partial. |
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
a length of exactly 6,000 means it was cut. The model still gets the first 24
sentences; see below.

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

## Not shipped: giving the model the whole article

The obvious remedy for "24 of 32 sentences" is to give the model the whole
article. That was built as reading-rules edition 7 and then withdrawn before
shipping, for this reason.

A dry run on the owner's four Today cards produced alarming results. Under
edition 7 every plan disappeared, including the three that connected the event
to "Operational wallet не выбран"; the owner had rated two of those readings
useful. The prose became vaguer, and Arc Portal was now summarised through
cirBTC, which the owner had dismissed. An A/B run under identical conditions,
first 24 sentences against the whole article, two runs each, lost the plans
**in both arms**. The dry run had been run with the local environment, whose
reading model is `ministral-8b-latest` on Mistral, not production's
`deepseek-v4.1-flash` on OpenRouter. Missing exactly this connection is the
Ministral weakness edition 6 recorded. The run measured the model, not the
input.

So nothing has been measured about edition 7 on the model that would run it,
and it is not shipped. `EXCERPT_SENTENCES` stays at 24 and `READING_RULES`
stays at 6. Measuring edition 7 requires the production reading settings
(`LLM_READING_*`) in the local environment. What did ship is the card
stating how much was read, which item 2 asks for whatever the answer turns out
to be.

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
- Migration `20260923090000_nova_seen_through` applied to production
  (applied=1). The owner's `seen_through` is null and `last_opened_at` is
  22 September 19:09 UTC, so their next visit marks as new everything found
  since then.
- The moved reference was confirmed from here (307 to
  `/gateway-nanopayments/supported-networks.md`, which returns 200).
- A new release-gate step, `nova-substance:test`, covers coverage, cut
  detection, the redirect rules, the visit boundary, dates, one listing per
  endpoint and the text-free page view. The product-value bucket invariant
  now states that a duplicate is held and not listed. The full gate passes,
  including the production build.

## Not verified

- The deployed page has not been looked at by the owner. The new and re-read
  marks appear from their next visit onward.
- Whether the refresh stops writing Parallel cards will be seen on the next
  scheduled tick. The rule is tested only through `endpointOf`, since the
  refresh loop needs a database.
