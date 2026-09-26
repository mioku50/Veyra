# Arc discovery through the ERC-8004 registry, read every day

On 26 September the owner asked for full Arc discovery. They dropped the
Coinbase Bazaar from it, because it lists almost nothing on Arc: 12 of 16,604
listings on 23 September.

Until now, two things read Circle's catalogue only:
- Nova's brief;
- Veyra's selection of whom to pay.

So a seller that registered on Arc and sold there reached nobody's card.

This note covers:
- what the registry holds;
- how Veyra now reads it;
- where its offers go;
- two faults in how the brief chose listings, found on the way.

## What the registry holds

Read live on 26 September, without paying:

| | |
| --- | --- |
| Identities | 292: there were 192 on 23 September and 232 that morning |
| Registration files read | 218. The 74 unreadable ones are mostly on IPFS gateways, which answered 429 |
| Identities that declare x402 support | 15 |
| Offers on Arc, checked against each endpoint's own 402 | 68, from three sellers |
| Left out | 7 more, whose paths hold a template such as `{mint}` |

| Seller | Identity | Offers | Paid on Arc | Binding |
| --- | --- | --- | --- | --- |
| APEX Faucet | #1 | 40, all GET | From a wallet or a Gateway deposit, $0.003–$0.99 | Registry only |
| CRA AGENT data | #186 | 23, all GET | Gateway deposit, $0.0005–$0.005. Also from a wallet on Base | Both ways |
| Fuci | #193, and 8 more identities that declare the same manifest | 5: four GET, one POST | Gateway deposit, $0.0005–$0.04 | Registry only |

**Only one offer takes a question.** Fuci's `POST /api/agent/run` says "a Fuci
agent answers your question by buying the tools above and writing a brief".
- It costs $0.04, paid from a Gateway deposit on Arc.
- Its prompt field reads "Your question about Argus launches / Arc markets".
- The other 67 offers are GETs.

## How it is read

- **Batched chain reads.** The registry is read through Multicall3, which is
  deployed on Arc mainnet at its usual address. A full read took 22 seconds.
  One call per identity, as before, took 4 minutes 41 seconds. A rate limit can
  no longer pass for "no such identity" and cut the count short: a revert comes
  back as a failed call, and anything else stops the read.
- **Each file and endpoint read once.** Nine of Fuci's identities point at one
  manifest.
- **Every x402 shape sellers publish:**
  - a catalogue with `items` (APEX);
  - a manifest with `routes` (CRA);
  - a manifest with `resources` that carry their own accepts (Fuci);
  - or a declared endpoint that is itself paid and answers 402 (APEX's
    watchtower).
- **Binding by host.** An offer is bound both ways only when the manifest on
  its own host names the identity back. A catalogue can list anyone's URLs, and
  a manifest speaks for its own host only.
- **Each offer checked against its own unpaid 402.** The endpoint's answer
  decides:

  | The endpoint answers | What happens to the offer |
  | --- | --- |
  | A 402 with x402 accepts | Its accepts replace the listed ones, and it adds its description, tags and request schema |
  | A 402 that is not x402, or a 404 or 410 | Dropped |
  | Anything else (a 400 for missing parameters, a timeout) | The listing stands |

  67 were confirmed and one could not be.
- **Only what the owner's wallet can sign.** That means an EIP-712 name and
  version, and for a Gateway accept, Circle's GatewayWallet as the verifying
  contract. Fuci's manifest names no verifying contract; its live challenge
  does, so the offer carries the challenge's terms.

Nothing is paid or signed. The unpaid request is the same one Veyra's probe
makes before any purchase.

## Where the offers go

- **A daily job.** `/api/internal/discovery/arc-registry` runs at 02:43 UTC
  and writes one row to `arc_registry_snapshots`. It needs about 22 seconds of
  its 300. `npm run --silent arc:registry` runs the same read by hand, and
  `-- --save` keeps it.
- **Discovery.** Discovery reads the latest complete snapshot from the last 72
  hours. Each server instance keeps it for ten minutes. An older snapshot is
  not used, and the brief then lists the registry among the sources it could
  not read.
- **Selection, for a decision on Arc.** Registry offers join Circle's
  candidates for Nova's proposals, `/run` and the selection APIs:
  - They are matched on the same words Circle is asked, because nobody searches
    them on Veyra's behalf.
  - They then pass the same normalisation, probe, ranking, policy, quote and
    owner approval as a catalogue listing.
  - A card is found by its id whatever the search term.
  - An endpoint that Circle also lists stays one candidate, carrying the
    identity that declares it.
  - When Circle's catalogue does not answer, registry offers still do.
- **Cards.** A listing card's header says where the listing came from, next to
  "pays on Arc":
  - "ERC-8004 #186 · confirmed both ways";
  - "ERC-8004 #193 · not confirmed by the endpoint";
  - or "Circle catalogue". Older cards all came from Circle's catalogue, and
    say so.

  The first card for a new listing says it too. For example: "Not in Circle's
  catalog: declared by agent #193 in the ERC-8004 registry on Arc; the endpoint
  does not name that agent back."

## Two faults in how the brief chose listings

Both belong to the owner's item b, better selection of services. Both kept the
registry's one askable seller off the owner's brief.

1. **Circle's search matches inside words.**
   - Asked for "arc" on Arc, it returned 206 listings. None of them had "arc"
     as a word: they were search engines, matched on "se-arc-h".
   - So the owner's Arc interest showed Exa search and Parallel search.
   - They also took the shortlist on price before a real Arc seller was
     considered.

   The brief now keeps only listings whose name, description, tags, path or
   request fields contain one of the term's words as a whole word. The check
   runs in discovery, before the shortlist. Purchases are unchanged: there,
   the caller has already said what it wants done.
2. **A GET cannot be asked anything.**
   - Veyra sends a GET with no body.
   - The quote refuses a GET that would need one, rather than drop the question
     without saying so.
   - So Nova's purchase path skips every GET.

   GETs made up 30 of the 82 listing cards on the owner's agent in the last 30
   days, and 67 of the registry's 68 offers. A GET is no longer a card. GETs
   can come back once their parameters can be bound into the URL the owner
   approves.

**A dry run with live data.** The run used all six interests, Circle's live
catalogue and the registry snapshot, and wrote to no database.

| Interest | Before | After |
| --- | --- | --- |
| Arc | Exa contents, Exa search and Parallel search | Fuci's agent (ERC-8004 #193, $0.04 on Arc) |
| Research & search | — | The search engines |

## The Fuci card, card to quote, without paying

The dry run used memory stores, the live snapshot, Circle's live catalogue and
Fuci's live endpoint. Steps:

1. Selection found the card's endpoint by its id, from the registry snapshot.
2. It probed the endpoint and ranked it. Veyra allowed it.
3. The exact question was priced with an unpaid request: $0.04, from a Gateway
   deposit on Arc.
4. It stopped at payability: "This one settles through Circle Gateway deposit
   on Arc, which this wallet cannot pay from right now."

The owner's wallet holds no Gateway deposit on Arc, and Fuci takes nothing
else. Nothing was signed or paid.

## Not done

- **Nothing has been bought from a registry seller.**
- **No GET purchases.** They need query parameters bound into the approved URL.
- **Two registries are not read.** The ERC-8004 reputation and validation
  registries on Arc.
- **74 registration files are unreadable**, mostly behind rate-limited IPFS
  gateways.

## Verified

- **Tests.** `arc-registry:test` is new and in the release gate. It covers:
  - the batched read and one read per endpoint;
  - binding by host;
  - the challenge rules;
  - the snapshot, and when it counts as stale;
  - registry offers in discovery and in the brief, the word rule and the GET
    rule;
  - the card's words.

  `market-discovery`, `nova-discovery`, `marketplace` and the rest of the
  release gate pass.
- **Live reads, each without paying:**
  - the snapshot;
  - the brief's catalogue read;
  - Nova's proposal for the Fuci card.

## Production

Done in this order on 26 September:

1. **The migration.** The owner applied
   `20260926100000_arc_registry_snapshots` with `npm run db:migrate`: one
   applied, 73 already recorded. It went first because code deployed without
   the table would list the ERC-8004 registry on Arc, in every brief, as a
   source it could not read.
2. **The deploy**, commit `dc2a77f`. The release gate passed on GitHub, and
   production answered as expected:
   - the home page, 200;
   - the job's route, 404 without the cron secret, answered by the route
     itself;
   - Vercel lists the job at 02:43 UTC, with the three it already ran.
3. **The first snapshot: not taken yet.** Until it is, the brief lists the
   registry among the sources it could not read. It comes from one of:
   - the daily job;
   - `vercel crons run /api/internal/discovery/arc-registry`, which runs the
     deployed job now;
   - `npm run --silent arc:registry -- --save`, the same read from a local
     checkout.
