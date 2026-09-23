# Nova — free-first tool selection: what a paid tool is, said before paying

Roadmap item 4: "The task must come before discovery. Use available public
sources before offering a paid API. Show the unresolved question, expected
incremental result, reason public information is insufficient, exact quoted
price and provider limitations. If no suitable askable service exists, stop
honestly." It carried one lead from item 2, a seller whose payee address
changes on every catalogue read, to be checked first.

## Where item 4 stood

| Item 4 asks for | Before this change |
| --- | --- |
| The task before discovery | Already structural. `paidResearchReadiness` refuses API listings and activity counts as background, and requires a fresh reading, made against the current goal, that is significant and has an open question with a plan. The D0 shadow pass goes through the same gate. |
| Public sources before a paid API | The same gate, which also requires two or more public sources with none unavailable. The card did not say what those sources were. |
| The unresolved question, the expected result, why public information is not enough | On the card: the question, "Requested result" and "What the public material does not answer". |
| The exact quoted price | From the live 402 challenge raised by the exact request body, not from the listing. |
| Provider limitations | **Missing.** The only list on the card was the reasons, each printed with a tick, and it could include "Differs from its listing". |
| Stop honestly | Refusals already said which case applied: nothing askable, nothing allowed, the subject gone, refused or unaskable, not payable from this wallet. One label was wrong: any answer other than a 402, a 404 or a 500 included, read "it answers without charging". |

## The market Nova actually chooses from

Measured on 2026-09-23, read-only. The run did discovery, the free 402
probes, and pricing with the question in the body. It paid nothing, issued no
clearance and stored nothing.

- Three discovery queries returned 22 candidate rows. One of them is the query
  Nova's research uses, "web search".
- **Every tool that could be asked took the question in a search field**
  (`query` or `q`). They were Exa search ($0.007, wallet), Tavily search and
  extract and Serper through Orthogonal ($0.01 and $0.002, needing a Circle
  Gateway deposit), and Parallel search ($0.01, refused, see below).
- None answered without a payment challenge.
- The catalogue gave none of them a description. Exa and Parallel publish an
  output shape. Orthogonal's endpoints do not.
- A dry run of a proposal on a realistic open question chose Exa search at
  $0.007 and would send `{"query": "<the question>"}`. The card above that
  price would have read "Requested result: a list of wallets with Arc Testnet
  paymaster support". What $0.007 buys is the pages that match those words.

## What changed on the card

- **Read first, at no charge.** The sources the reading used, as links, with
  when it read them. The free-first gate existed; now the card shows what it
  consisted of.
- **Question sent as.** The tool's own input field.
- **Returns.** What comes back, from the tool's published output shape, for
  example "A list of results, each with url, title, excerpts and
  publish_date". Where no shape is published, the row says "No published
  shape".
- **Limits**, a separate list with no ticks:
  - The question goes in as search text, so what comes back is what the tool
    finds for those words, not an answer.
  - No published shape, so after paying Veyra can check only that an answer
    arrived and is not an error.
  - Live terms that differ from the listing.
  - The tool answered a probe without a payment challenge.
  - The trust score is a live check of payment terms, not a record of answer
    quality.
- **The reasons list** keeps only what speaks for the tool.
- **The promise about the check after paying** now matches what the check
  does. Without a published shape the card no longer says the answer will be
  checked "against what this endpoint says it returns".
- **A candidate that did not ask to be paid.** An error is now called an
  error. A 2xx says that Nova does not yet use unpaid answers from the market,
  instead of passing over a free answer without comment.

## The rotating payee

Three consecutive unpaid requests to Parallel search returned three different
`payTo` addresses. Price ($0.01) and network (Base) were the same each time,
and each response also carried a Tempo MPP challenge. The address is issued
per request.

Veyra's probe compares the challenge's payee with the listing's and treats
any difference as critical drift. The integrity score becomes 0 and the
decision DENY, recorded as `catalog_drift:payto_changed`. That is the verdict
a seller whose payee had been swapped would get. **So a seller like this
cannot be priced or paid through Veyra at all.**

In practice Nova is not affected: it routes to the next allowed tool, and Exa
won every run. Two things are wrong, though:

- The recorded reason is a payee change, when the seller actually issues a
  new address per request.
- The watchlist lists "Parallel search is available for $0.0100", an endpoint
  Veyra would refuse to pay.

**Not changed, deliberately.** Supporting per-request payees would mean
pinning the endpoint, price and network instead of the payee, and binding the
clearance to the address in the quote being paid. The card would say that
the payee cannot be checked against a known one. That relaxes a payment check
this product exists to make, so it is the owner's decision, not a side effect
of this item.

## Not done

- **Discovery by what the question needs.** Nova always asks the market for
  a web search, so the task decides whether discovery happens, not what is
  looked for.
- **Using an unpaid answer.** None occurred on the measured market, so
  nothing was built to show one.
- **A free lookup of the open question in official documentation** before
  pricing a search.
- **Open questions are rare, so this card is rarely reached.** In the
  edition-7 measurement 1 of 29 readings carried one. The owner has had no
  paid proposal since V1: their six, all from 13–14 September, were the
  "What is X for" kind that V1 retired.

## Verified

- `nova-tools:test` is new and in the release gate. It covers:
  - the returns sentence, including a missing shape;
  - search fields;
  - limitations, and keeping them off the ticked list;
  - the sources read first;
  - an error never being called a free answer.
- A read-only dry run of `proposeResearch` against the live market produced
  the new fields for Exa search as described above.

## Not verified

- The card on screen with a real open question. No reading on the owner's
  agent currently has one.
