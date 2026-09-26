# Veyra product roadmap

**Updated:** 2026-09-26  
**Product:** Nova, a personal agent that works toward an owner's goals; Veyra, its deterministic trust and economic governor.  
**North star:** The owner regularly receives useful, source-grounded work. Payments and onchain history support that work; neither is the product's purpose.

> **Your agent works. Veyra keeps it safe.**
>
> A Veyra `WOULD_ALLOW` means a proposed expense fits a policy. It does **not** mean the work is useful, that the answer is true, or that payment has occurred.

This roadmap supersedes the original sequencing of Daily Product → Paid Investigation → Arc Identity → Agent Economy → Controlled Autonomy. We brought the shadow-autonomy rehearsal forward, hardened the existing execution boundary, and have now placed **Nova Product Value** before any operational wallet. The initial plan remains useful as historical product intent, not as a claim that every phase is completed.

## Status at this revision

| Track | Status | What this status does and does not establish |
| --- | --- | --- |
| A — Daily Nova | Implemented | Owner-created agents, scheduled refresh, a short brief, observations and preference feedback exist. Technical refresh does not by itself establish a valuable brief. |
| B — Owner-approved research | Implemented | Nova can propose an x402 purchase; Veyra checks terms and the owner signs. Recorded payment/delivery evidence must not be confused with answer quality. |
| C — Arc Testnet identity and history | Implemented on testnet | Earned ERC-8004 identity, Veyra attestations and outcome-derived standing exist. An Arc record is a public, tamper-evident **Veyra claim**, not an independent truth oracle. Product ownership still follows the recovery credential, not an ERC-8004 token transfer alone. |
| Execution security convergence | Internally hardened | Audit findings F1–F9 were addressed in the application; this is not an independent third-party audit or proof of every production configuration. |
| D0 — Shadow Autonomy | Closed 2026-09-22; frozen with autonomy 2026-09-26 | The calibration was closed as insufficient for funding. Since the freeze, no shadow-autonomy limits can be signed and the scheduled rehearsal does not run. |
| **V — Nova Product Value V1** | **Technical first slice implemented; owner-value acceptance open (CURRENT PRIORITY)** | Goal-driven public-source research has shipped. Whether it produces useful work consistently remains to be shown with real owner feedback. |
| Arc first | Direction set 2026-09-23; Arc mainnet in the payment tables 2026-09-24; the ERC-8004 registry read daily 2026-09-26 | Arc mainnet has a live x402 market: 482 offers in Circle's own catalogue, and 68 more declared through the ERC-8004 registry on Arc. Those now reach Veyra's selection and Nova's cards from a daily snapshot. The owner dropped the Bazaar. The owner's own signed purchases work on Arc, and Nova's brief reads Arc first. The first one settled on 2026-09-24: Exa search, $0.007, from the owner's browser wallet. Nova's mandate still names Base. Base stays as an additional network. |
| D1 — Operational wallet | **Frozen 2026-09-26** | The signer's place, the check matrix and option C (MetaMask delegation, tested on a fork of Arc) are written down. MetaMask refused to grant the permission on Arc mainnet, and the owner froze autonomous spending. |
| D2 — Bounded live autonomy | **Frozen 2026-09-26** | The autopilot endpoint and new AUTOPILOT mandates are refused in code, whatever the environment says. |
| D3 — Nova hires agents | Infrastructure proof only | An ERC-8183 escrow job was demonstrated on Arc Testnet; the owner-facing Nova → agent-hiring workflow is not complete. |
| Mainnet / broader launch | Preparation only | Existing Nova identity, proofs and contracts are on Arc Testnet; do not describe them as Arc mainnet identity or mainnet revenue. Veyra has no mainnet identity, contracts or paid API: its Trust API sells only on testnets. |

## Autonomy frozen (2026-09-26)

**Decided by the owner.** Nothing spends on its own, for any user. Nova
proposes, Veyra checks, and the owner approves every payment.

- **What prompted it.** The first stage of option C's real test: MetaMask
  showed the permission on Arc mainnet and then refused to sign it. Its
  delegation-contract table has no Arc mainnet.
- **What is closed.** In code, by `AUTONOMY_FROZEN` rather than a setting:
  - the autopilot endpoint;
  - new AUTOPILOT mandates;
  - new shadow-autonomy limits;
  - the scheduled shadow pass.

  Nothing was running when it was frozen.
- **Lifting it.** A reviewed change to the constant and to its test, and the
  owner's decision.

See [autonomy frozen](audits/2026-09-26-autonomy-frozen.md).

## V — Nova Product Value (the next product gate)

### Why this phase comes first

Owner feedback on 2026-09-20: ordinary commit-count cards (e.g. Foundry/Ethereum/LangChain) and speculative paid endpoint investigations were not compelling. The former D0 funnel could authorize a $0.007 research request without establishing why the owner needed its answer. An allowed purchase is not customer value. **Do not give Nova money merely to improve its WOULD_ALLOW count.**

### Already implemented in the 2026-09-21 release

The [Product Value V1 implementation and audit note](audits/2026-09-21-nova-product-value-v1.md) and commit [`6ccaf722`](https://github.com/mioku50/Veyra/commit/6ccaf722dceb28747a933b67655d449f6249a2ca) include:

- Optional, owner-authenticated **goal** (alongside interests). Existing owners must set their own goal; do not invent one from a profile or change their signed mandate.
- Bounded reading of curated official publications, release notes and public references (Arc, Circle, Ethereum and selected developer sources). This is **not** unrestricted web browsing or complete news coverage.
- Significance screening against the current goal. Routine commit counts and available-API listings stay in background history; important payment-destination/availability alerts retain deterministic handling.
- A short, deduplicated brief; explanation of what changed, why it matters, a suggested next step and explicit uncertainties.
- Source references resolved by the server against the supplied excerpts. An exact excerpt match supports provenance, **not** the truth of the model's entire interpretation.
- Owner-requested public reading using the app's model without charging the owner's wallet (app-side inference still has a cost).
- A paid proposal only after a current, goal-matched significant assessment identifies a concrete remaining question and expected result, with source-read and freshness gates. A gap is a hypothesis, not proof that free research is exhausted or permission to pay.
- Assessment- and goal-scoped usefulness feedback. A failed read/analysis cannot become a paid fallback, and old receipts and D0 decisions remain historical evidence.

Migrations, focused checks and a temporary-agent browser smoke were recorded in the [implementation note](audits/2026-09-21-nova-product-value-v1.md). The smoke demonstrated the workflow, **not** owner-value acceptance. Confirm actual release/runtime status separately when reviewing later changes.

### Also implemented on 2026-09-21, after the first real briefs

See [project context and held-back reporting](audits/2026-09-21-nova-project-context.md).

- **Project context.** Owner-confirmed short statements of what is already true about the work, supplied to every reading alongside the goal. An assessment now says what an event changes relative to work already done, and carries the statements it was judged against. Nova may **propose** a statement and may never confirm one; a proposal never reaches a prompt, and a dismissed one is not raised again.
- **A reading budget spent by relevance.** The three public readings per pass go to the highest-scoring candidates instead of whatever the source list returned first. An unread publication cannot clear the significance gate, so traversal order was deciding the brief. Coverage per pass is unchanged; what the budget does not reach is now reported as unread and reconsidered next pass.
- **Held back, by reason.** The brief reports noise, background, not-read-yet, not-significant, duplicate and over-cap separately. "Held back as noise: 0" on a day that filtered twenty-one things was a true number in front of a false impression.

### Product Value V1.2, same day

See [a reading somebody asked for, and work instead of a topic](audits/2026-09-21-nova-product-value-v1-2.md).

- **Reassess for my project.** A card with public sources can be re-read on its own, against the project state as it stands. It spends none of the background reading budget, and it never hands back the stored paragraph — a button that sometimes answers yesterday's question is one nobody can trust. A failed reassessment overwrites nothing and says on the card that what follows is the earlier reading.
- **A stored reading says how far it can be trusted.** The page marks a reading written before the owner's project facts last changed, or under an earlier edition of the reading rules, using the same functions the refresh pass uses to decide what to re-read.
- **Proposed work instead of a subject to study.** A significant reading now carries what the owner already confirmed, what is still not established and what would establish it, and one concrete action. The confirmed part is resolved from indices the model chooses into the owner's own words, so "your context says X" cannot be a sentence the model wrote; the status line saying this is proposed work and not a completed check is fixed in the page, not a field the model fills in. Nova has not read the repository and states no compatibility result.
- **Reading rules edition 3, and an order that survives it.** A rules bump retires every stored reading at once, which makes "is this a correction" stop sorting anything. Inside a band the pass now reads a stale card the owner can see, then one nobody has read, then one nobody sees.

None of this is evidence of product value. It changes what Nova is told, what it proposes and what the owner can audit; gate V is unchanged.

### Reading rules edition 6 and the reading model, 2026-09-22

See [the V1.2 audit](audits/2026-09-21-nova-product-value-v1-2.md), sections
"absence is not a finding" and "OpenRouter".

- **Absence of confirmation is not a need for work.** The owner read four cards
  and found the same defect in all of them: a subject their project context did
  not mention came back as an unestablished part of their implementation, and
  the proposed work was to go and establish it. Nova had two outcomes, work or
  held back, so a real event had no way to surface except by finding itself
  something to do. A third outcome now exists, and the other two are gated
  structurally: `plan.relation` is one of `decides`/`requires`/`supersedes`
  checked against a closed set, `plan.establishedFrom` may not be empty, and a
  `gap` requires a plan — so an event that asks for nothing cannot reach a
  purchase. `nextStep` is gone; it was the fallback where every "look into the
  new technology" landed.
- **The reading model is a deepseek on OpenRouter.** Edition 6 shipped with a
  measured cost: ministral-14b would not connect sponsored gas on Arc to the
  owner's own "operational wallet не выбран", six times out of six. Seven
  candidates were measured on the six hardest stored cards;
  `deepseek-v4.1-flash` makes that connection, invents no work, and writes the
  best proposed work of any of them. Verified from the deployment, not only
  from a laptop: three production readings under edition 6.
- Two client defects surfaced doing it. The completion-token budget was one
  constant for two workloads, so a reasoning model ran out mid-trace and
  returned an empty message reported as `invalid_response`; it is now per call.
  And OpenRouter serves one model id from a dozen upstreams, several of which
  ignore `response_format`, which threw out about a third of readings at
  random — `LLM_EXTRA_BODY` now carries `require_parameters`.

None of this is evidence of product value either. Gate V is unchanged, and
item 1 below is still the only thing that can move it.

### Remaining work, in order

1. **Owner goal and real-use review.** Have the owner set a concrete goal in My Agent, use Nova for several days and assess findings in Today, including `useful` / `not interesting` and the reason. Do not substitute test-agent ratings or historical D0 approvals for user feedback. *(Started. By 2026-09-22 the owner had rated five readings, four useful and one not, and none carried a reason, because the page had nowhere to put one. It does now: a rating of a reading takes an optional reason from the review's own categories and a note, and "Did Nova miss something?" takes a link. See [why, with the rating; and what Nova missed](audits/2026-09-22-nova-reasons-and-misses.md). Reasons are recorded for this review and change no ranking.)*
2. **Improve the substance of findings.** *(largely addressed 2026-09-23; see [the substance of a card](audits/2026-09-23-nova-substance.md). A finding is stated against work already done, and a significant one carries proposed work rather than a topic. Whether that work is worth doing is unmeasured — that is item 1.)* Explain changes to a release, policy, integration, product or API rather than presenting a raw commit count as a headline. Show evidence links, observation/publication dates, what's new relative to the previous brief, relevance to the goal and a concrete next step. If evidence is incomplete, say so.

   Cards now carry both the publication date and the date Nova found them. They mark what is **new** or **re-read** since the owner's previous visit and link to the original. Every reading says how much of the article it stood on. A paid endpoint whose seller rotates its payee address had produced a new card on every pass, 24 of Parallel search in eight days; it is now listed once, and the first scheduled pass after the change wrote none. The page no longer receives article text, which was 310 KiB of a 770 KiB brief.

   Since reading-rules edition 7 the model reads the whole article, up to 12,000 kept characters. It used to get the first 24 sentences of a text already cut to 6,000 — 24 of 32 for StableFX. The first attempt was withdrawn: its dry run had used the local environment's `ministral-8b`, not production's reading model. Measured again on production's model before shipping, on the three cards whose input changes: a plan built on the owner's open wallet decision in 5 answers against 2, and 1 answer outside the goal's language against 4. Found and fixed on the way: Circle moved its Nanopayments reference page, and the reader, which refused all redirects, would have dropped it from every reading. It was caught before any stored reading lost it, and the reader now follows one redirect within the same approved site.
3. **Source coverage and reliability.** *(measurement in place 2026-09-22; the extending is not done.)* Measure inaccessible publications, missed important events, duplicates, stale cards, content-read failures, model invalid-output rates, processing time and app-side model/RPC costs. Extend source coverage based on missed owner-relevant events, not raw item volume. Preserve bounded SSRF-safe reads and untrusted-source isolation.

   Six of the eight are now written down as they happen and read back by `npm run --silent nova:coverage:report [from] [to]`. `nova_ticks` keeps one row per scheduled tick, because the shadow and unpriced counts were aggregated per tick and thrown away — the D0 capture needed them for an epoch and had to record the item as unanswerable. On `nova_refreshes`, `articles_unreadable`, `readings_attempted` and `reading_failures` split three failures that used to be one prose column: a host that did not answer, an article fetched whose date the parser could not find, and a reading model that returned nothing. The middle one is not an availability failure, and reporting it as one told the owner their LangChain source was unreachable on all twelve passes of the epoch, from a single undated article out of ten — nine of the ten read fine.

   The other two are named rather than approximated, in the report itself. **Missed important events** cannot be measured from this side: nothing records an event that was never observed, so only the owner naming one establishes it — which makes this part of item 1, not of item 3. **App-side model and RPC costs** live in provider billing, which the report does not read.

   The owner can now name a miss. A reported link is never fetched. It is sorted into `observed` (Nova had the article: a ranking miss), `covered` (Nova reads that publisher or repository but has no card for it: a reading miss) or `not_covered` (a coverage gap), and the report counts them under `misses`, listing hosts only for the coverage gaps, since only those are fixed by adding a source. A miss nobody reports is still unmeasured, and the report says so.

   Not done: extending coverage. That needs missed owner-relevant events, and none has been reported yet.
4. **Free-first tool selection.** *(largely addressed 2026-09-23; see [free-first tool selection](audits/2026-09-23-nova-free-first-tools.md).)* The task must come before discovery. Use available public sources before offering a paid API. Show the unresolved question, expected incremental result, reason public information is insufficient, exact quoted price and provider limitations. If no suitable askable service exists, stop honestly.

   Most of this was already structural: a paid proposal needs a fresh reading against the current goal with an open question, and listings never reach one. The card now shows the provider's limitations. It lists the sources read first at no charge, the field the question is sent in, what comes back and what the tool will not do. On the live market every askable tool was a search, so the owner would have paid for pages that match the question while the card promised a result. An error from a tool is no longer called a free answer.

   The lead from item 2 is answered. A seller that issues a new payee per request (Parallel) is refused by Veyra's probe as a changed payee, so it cannot be priced or paid at all. That is safe, but the label is wrong. Supporting such sellers would relax payee pinning and is left to the owner. Not done: discovery by what the question needs (Nova always looks for a web search), and a free documentation lookup for the question itself.
5. **Feedback-to-brief loop.** *(verified and partly fixed 2026-09-22; its effect on the owner's brief measured and fixed 2026-09-23, see [what the owner's feedback did](audits/2026-09-23-nova-feedback-effect.md).)* Verify that explicit owner feedback changes future prioritization without silently suppressing safety alerts or whole publishers. Keep feedback failures visible and avoid claiming personalization without demonstrated effect.

   Verified against the owner's own record. There are three real ratings, all "useful", all on announcements: Sponsored Transactions on Arc, and the Arc Compatibility Guide twice. They taught `cares_about: announcements`, which adds 10 to every announcement — cirBTC and StableFX included, the two the owner had objected to. Feedback does change prioritization; publishers are not silenced (a dismissed announcement never teaches its feed), and payee changes cannot be learned away in either direction.

   Found and fixed: the loop had one direction. "Not interesting" on an announcement taught nothing, so an owner whose every card is an announcement could say "more" and never "less". It now teaches a product name from the publisher's headline — a word with a capital inside it, never a watched word, never the publisher's name, and nothing when none survives. The first heuristic (longest word) was right once in thirteen real headlines and would have learned "discontinuing" from a deprecation notice; the shipped one learns 5 of 26, every one a product. Every learned preference can now be forgotten from "what Nova knows about you".

   Measured on 2026-09-23 on the owner's own agent, which answers what the 22 September pass could not show. Feedback did move their ranking, and every move went against what they had said. Ratings of readings had taught "announcements", which added 10 to every announcement. That pushed two articles into "high relevance": StableFX, which the owner had objected to, and a LangChain post about healthcare AI. Both were read first in the owner's own refresh. "Less cirBTC" demoted an Arc Interop announcement because its text mentions cirBTC. Today showed the same cards in the same order with or without any of it.

   Fixed:
   - On an announcement or a release, "useful" is kept as a rating of the reading and raises nothing.
   - A preference is matched against a publication's feed and headline, not against its article.
   - A category preference matches its category and nothing else.

   Following a feed is now the lever for a publisher. Not done: stored bands are not rewritten, and interest words still match whole articles, so LangChain's posts about agents score like Arc's. **Personalization is still not claimed.** What is left of it for this owner is "less of this product" and "follow this feed", and neither has yet been seen to change a brief.

**Exit gate V:** Over several real scheduled cycles, the owner can point to recurring, source-backed, goal-relevant findings or completed work they actually found useful, including runs with **zero paid calls**. Review accepted and rejected findings, important misses, noise/duplicates, evidence gaps and per-agent operating cost. Do not use an arbitrary count of positive cards as a substitute for the owner's assessment. If this gate fails, iterate on goals/sources/analysis before D1.

## Arc first — Arc primary, Base additional

**Decided by the owner on 2026-09-23.** Arc becomes Veyra's primary ecosystem.
Base stays as an additional network for buying services. D1 is prepared
without creating any new way to spend.

See [Arc first: the market, discovery and Arc Portal](audits/2026-09-23-arc-first-market-and-discovery.md)
and [D1: where an operational signer plugs in](audits/2026-09-23-d1-operational-signer.md).

### What was found

- **Arc mainnet has an x402 market.** Measured read-only on 2026-09-23:
  - Circle's own catalogue lists 482 offers on Arc, from 5 providers. All are
    payable through a Circle Gateway deposit. Exa's 2, search among them,
    also take a payment straight from a wallet, at the same $0.007 as on Base.
  - The Coinbase Bazaar adds 12 listings, from 8 hosts.
  - The ERC-8004 registries on Arc mainnet hold 192 identities. Two of them
    sell standard x402 on Arc, and neither is in any catalogue.
  - 56 of 62 unpaid probes asked to be paid on Arc.
- **The D1 comparison's "no endpoints on Arc" described Veyra, not the
  market.** Veyra's discovery never asked for Arc. The comparison is corrected
  in place.
- **Veyra can pay nothing on Arc today.** Arc mainnet is missing from:
  - discovery's networks;
  - the USDC and Gateway-domain tables;
  - reconciliation;
  - the installed viem;
  - the only mandate.

  Each gap is small, and each is in payment code.
- **Arc Portal.** No self-serve way to get listed is documented. Circle
  curates what Portal shows, and says a listing is not an endorsement. ERC-8004
  registration is not a listing. The route in is the Arc team. The Circle Agent
  Marketplace has a documented intake: a payable endpoint, an OpenAPI spec, a
  payout wallet and a review.

### Rules

- A decision is bound to one network. If Veyra refuses an offer on Arc, Nova
  does not retry the same seller on Base. Buying there is a new decision,
  under a mandate that allows Base.
- Base support is kept.
- Discovery listings are never terms. Every payment needs a fresh quote of the
  exact request under a decision ceiling. One Arc listing asked $50 live
  against $0.05 listed.
- SSRF-safe reads and counterparty checks apply to every new source. That
  covers registration files, manifests, catalogues and probes. A 402 that is
  not `exact` x402 is not an offer.

### Order of work

Steps marked *owner* need the owner's action. *Money* means real USDC.

1. **Done:** Arc market measured, discovery designed, the D1 signer's
   connection point and check matrix written.
2. **Read-only Arc discovery.** Circle's catalogue per network (Arc first), a
   bounded daily Bazaar snapshot and an ERC-8004 Arc reader with two-way
   binding checks. The network shown on every card. No payment change.
   *(Started 2026-09-24: the three readers and the one-record-per-offer merge
   are in `lib/discovery/`, tested by `market-discovery:test` in the release
   gate, and readable with `npm run --silent arc:market`. First live read: 519
   offers on Arc, 50 of them listed with a wallet payment, none quotable by Veyra;
   22 offers bound to their ERC-8004 identity both ways. Later the same day
   Nova's brief began reading Circle's catalogue for Arc first and Base second,
   with one card per endpoint naming the network it pays on. Not yet done: the
   daily Bazaar snapshot, and ERC-8004 offers on cards.)* *(2026-09-26: the
   owner dropped the Bazaar, which lists almost nothing on Arc. The ERC-8004
   registry on Arc is read once a day into `arc_registry_snapshots`, and its
   offers join Circle's in selection and on cards, which say where each listing
   came from. See [Arc discovery through the ERC-8004
   registry](audits/2026-09-26-arc-registry-discovery.md).)*
3. **Arc mainnet in the payment tables:** USDC on chain 5042, Gateway domain
   26, the chain definition and reconciliation, each with tests. The owner's
   own signed purchases then work on Arc through the existing flow. *Owner
   approves, since it touches payment code.* *(Done 2026-09-24 with the
   owner's approval. It covers the asset, the Gateway domain, the
   reconciliation chain, the marketplace network, Veyra's own chain
   definition and the wallet's add-chain step, each tested. The EIP-712 domain
   was read from the chain. No real payment on Arc mainnet has been made; the
   first one is the owner's to make.)* *(Later the same day three more blockers
   were fixed. The owner can ask a listed tool their own question from My
   Agent. The quote takes the decision's network, payee and asset rather than
   the seller's first offer. Nova's approval stores its decision, so the quote
   can read it: that had been broken since 2026-09-16. Exa search on Arc
   priced and quoted live without paying; see the Arc-first note. The owner
   then bought it: the first payment through Veyra on Arc mainnet, $0.007 in
   block 22517476, answer checked PASS.)*
4. **D1 set-up and free checks** (matrix groups A–F). The owner creates the
   agent wallet, deploys it on Arc, sets limits before funding, and confirms
   Arc Portal shows it. Circle's limits act when it is asked to sign, so the
   limit, bypass, revocation and repeat checks run while the wallet is still
   empty. Group D decides whether Circle's cap binds a compromised runtime.
   *Owner, with the owner's email code; no money.*
5. **D1 seller checks** (group G): Exa and CRA on Arc, then Exa on Base, for
   one or two dollars funded only after every test signature has expired.
   *Owner, money.*
6. **Signer host, and the six Veyra changes** the signer note lists: the
   payer bound from the mandate, smart-account signatures, the mandate budget
   reserved at the claim, the mandate on the attempt, the Arc tables and a
   signature queue. Behind flags, tested without funds.
7. **Veyra on Arc mainnet.** A paid Trust API on Arc through mainnet Gateway,
   and an ERC-8004 identity for Veyra from its own registrant wallet. Then the
   Circle Marketplace intake and the Arc team for Portal. Contracts only after
   an external audit. *Owner, small gas.*
8. **Gate V**, unchanged and still the product priority.
9. **D2 on Arc.** A new AUTOPILOT mandate naming the agent wallet and
   `eip155:5042`. Base only under a mandate that names it. Wallet payments
   only (Exa, CRA) until the Gateway checks D6 and D7 pass.

*(2026-09-26: steps 4, 5, 6 and 9 are frozen with autonomy. The owner's order
from here:*

*a. **Full Arc discovery.** Step 2's remainder: the daily Bazaar snapshot and
   ERC-8004 offers on cards, then whatever else keeps Arc's market from
   reaching the owner.* *(2026-09-26: built, without the Bazaar, which the owner
   dropped. The registry is read every day through Multicall3. Each offer is
   checked against its own unpaid 402, and its binding is judged by host.
   Registry offers enter selection on Arc and reach cards. On the first read, 68
   offers came from three sellers, and only one takes a question: Fuci's agent,
   $0.04 from a Gateway deposit on Arc. Its card was priced without paying,
   and stops at payability, because the owner's wallet holds no Gateway deposit
   on Arc.)*

*b. **Better selection of services.** Gate V item 4's remainder: discovery by
   what the question needs rather than always a web search, and a free
   documentation lookup before any paid tool.* *(2026-09-26, two faults fixed
   first, found while doing a:*
   - *Circle's search matches inside words, so "arc" found search engines
     ("se-arc-h"). A card now needs the term as a whole word in the listing's
     own words.*
   - *A GET is no longer a card: Nova can never ask one a question. GETs made
     up 30 of the owner's 82 listing cards in thirty days. They come back when
     a GET's parameters can be bound into the URL the owner approves.)*

*c. **Veyra's identity and attestations on Arc mainnet.** An ERC-8004 identity
   from Veyra's own registrant wallet. Contracts only after an external audit.*

*d. **Veyra's own paid service on Arc.** Then the Circle Agent Marketplace
   intake, and the Arc team for Portal (step 7).*

*e. **Then D3,** with the owner confirming every hire.)*

## D0 — Close shadow calibration honestly

**Closed as insufficient for funding. The mandate expired 2026-09-22 12:49:49 UTC and the capture required at expiry is complete: [D0 PREVIEW closure](audits/2026-09-21-d0-preview-closure.md).** Final figures are unchanged from the pre-expiry snapshot — 13 decisions, 4 WOULD_ALLOW, 0.030000 USDC hypothetical, **0 of 13 carrying owner feedback**, no duplicates, no integrity violations, `liveAutonomyApproval: NOT_GRANTED`. No budget recommendation is supported, and none is made. One required item could not be answered: the per-tick `unpriced` reasons are emitted to the scheduler log and never persisted, so an epoch-wide figure is unavailable after the fact. Persisting the tick outcome is the fix and belongs to item 3 below.

The active PREVIEW epoch predates this product-value change. Its original snapshot contained 11 priced decisions (2 WOULD_ALLOW, 9 WOULD_DENY); the 2026-09-20 postrelease record contained 13 (4 WOULD_ALLOW, 9 WOULD_DENY), **$0.030000 hypothetical allowed spend**, and no recorded owner feedback. These are observations from the configured database, correlated with scheduled-run evidence; they do not prove delivery, usefulness, settlement or wallet enforcement. See [D0/D1 readiness](audits/2026-09-20-nova-d0-d1-readiness.md).

- The current PREVIEW mandate expires **2026-09-22 12:49:49 UTC**. It is not a live payment authorization. Do not renew it silently, alter its allowed capabilities, increase its limits or count a fresh mandate as the same calibration epoch.
- The 2026-09-21 goal/source selection release changes the proposal population. Record the code boundary and assess the old and new pipelines separately, even under the same mandate hash. Do not present their conversion rates as a controlled comparison.
- At expiry, capture the final report, ask for actual owner usefulness feedback, document `unpriced`/missed-coverage reasons and decide explicitly whether the evidence is sufficient. An insufficient result is a valid D0 outcome and does not justify a wallet by itself.
- A second PREVIEW epoch, if requested, must have a new signed mandate and explicit calibration purpose. Do not mix its decisions with the earlier epoch.

## D1 — Wallet boundary, **only after V's exit gate**

*(Frozen on 2026-09-26 with all autonomous spending. See
[autonomy frozen](audits/2026-09-26-autonomy-frozen.md). What follows is the
record.)*

Before writing a production signer adapter, compare Circle Agent Wallet, Developer-Controlled Wallets and enforceable smart-account/session permissions for a **single isolated test wallet**. *(Compared on 2026-09-23 without money, from Circle's documentation and the Circle CLI's own source: see [which wallet Nova would pay from](audits/2026-09-23-d1-wallet-comparison.md). Recommendation: a Circle Agent Wallet on mainnet, used only to sign the exact authorization Veyra approved, from a small host the owner controls. It is accepted only after three small mainnet tests, of which the decisive one is whether a permit or an approve can get round the cap.)* *(2026-09-23, later:* [where the signer plugs in](audits/2026-09-23-d1-operational-signer.md)*. The signer takes the owner's browser wallet's place between `quoteX402Call` and `settleX402Call`. It does not go through the legacy Arc Testnet executor or `circle services pay`. Six Veyra changes are listed, starting with the payer bound from the mandate. The full check matrix is written: set-up, signature compatibility, limits, bypasses, revocation, repeated execution, real sellers and separation. None of it has run. The chain is Arc first, and the seller test is Exa search on Arc, which takes a wallet payment there.)* Circle's documented controls do not prove that every arbitrary typed-data/contract-call path Veyra needs is actually constrained. A Veyra server-side policy alone limits Veyra's code, not a raw wallet key.

**Acceptance:** pin the exact approved endpoint/method/body hash/payee/asset/network/amount/expiry across wallet integration; prove per-action and concurrent budget ceilings, Gateway deposit-vs-per-purchase accounting, cross-chain scope, owner-calendar-day vs rolling-window differences, signer/process isolation, recovery from lost responses, and independent owner revocation of **new** authorizations. Test direct EIP-3009, approvals, permit and arbitrary contract calls as potential bypasses. Preserve already-issued authorizations until settled/expired/provably cancelled. Record actual observed outcomes, not just wallet error messages.

If permissions cannot be enforced at wallet level, state the narrower guarantee explicitly: **risk is bounded by funded balance; Veyra policy is not a cryptographic spending cap.** The wallet must not have access to the human's main-wallet key or to its own policy-administration credentials.

## D2 — One real bounded-autonomy pilot

*(Frozen on 2026-09-26.)*

Only after V and D1 pass: owner explicitly funds a small isolated operational wallet and signs a **new AUTOPILOT mandate** naming that wallet. Reuse the hardened Veyra execution boundary and its atomic budget/reconciliation machinery; do not create a second executor for Nova. Run one narrow research/data purchase; observe actual balance change, payment evidence, delivery result, receipt, budget accounting, revocation and crash recovery. `PREVIEW` signatures must always fail at the live executor. No unlimited approvals, no automatic permission expansion, no DeFi/swaps/arbitrary transfers in this pilot.

## D3 — Nova in the agent economy

*(2026-09-26: next after Arc first. Nova proposes one ERC-8004 agent for one
task at one price, and the owner confirms every hire. This needs no
autonomy.)*

Expose an owner-understandable proposal to hire a specific ERC-8004 agent for a specific result and price. Revalidate counterparty evidence, have the owner approve funding, execute an ERC-8183 job through its existing escrow/evaluator lifecycle, report a truthful outcome and build standing from verified history. The current testnet escrow proof is infrastructure evidence, **not** proof that this end-to-end Nova UX exists. Agent earnings, job acceptance and independent service provision come only after genuine counterparties and settled work exist.

## Parallel work, not blockers for V

- **Portable receipt / independent verifier:** export authorized terms, policy version, payment and delivery evidence, hashes and optional Arc attestation without exposing raw private requests, responses or reusable authorizations. A verified hash is not a claim of factual truth.
- **External SDK pilot:** try one actual outside research/data-agent client against the same execution boundary. Business pricing and paid-team demand remain hypotheses; Nova is not demoted to a mere demo by default.
- **Arc mainnet foundation:** obtain and verify official network/contract manifests, deploy and verify separate mainnet contracts/signers/roles, and distinguish testnet identity/history from mainnet. No automatic migration assumption or renaming of old proof URLs. *(2026-09-23: the network facts are now read from Arc's documentation and the chain itself. That covers chain 5042, USDC, the Gateway, and the ERC-8004 v2.0.0 registries at their canonical mainnet addresses. What Veyra still lacks for mainnet and for Arc Portal is listed in [Arc first](audits/2026-09-23-arc-first-market-and-discovery.md), in order, under step 7 of "Arc first" above.)*
- **Operational readiness:** review recovery-key rotation for any exposed owner credential, public security warnings, observability and externally reviewed contracts before inviting users to move meaningful funds. Internal F1–F9 closure does not replace an independent audit.

## Permanent product and safety invariants

1. Nova starts from an **owner goal** and produces useful, evidence-grounded work before proposing a payment.
2. LLMs reason and write; Veyra alone evaluates deterministic financial conditions. Provider documents and purchased results are untrusted data, never instructions or authority.
3. Every real spend must pass a durable, owner-bound decision, an exact single-use quote/authorization, reserve-before-dispatch and rail-appropriate reconciliation. Unknown settlement is not zero spend.
4. Price, payee, method, request body, asset, network and policy must not drift between approval and dispatch. A paid response passing a delivery check does not establish semantic usefulness or factual truth.
5. An onchain Veyra attestation remains **Veyra's** assertion. ERC-8004 identity, token owner, product recovery access, and operational agent wallet are distinct.
6. PREVIEW never signs or sends funds; no wallet is granted live permission by the existence of a shadow decision or by a deployment setting.
7. The owner chooses if/when to fund autonomy. Pausing and revocation must have truthful, tested semantics independent of the Nova app where possible.
8. Do not fake activity, reputation, earned income, freshness, payment confirmation, or a claim that a model has proven a result useful.

**Next decision:** review the first real, goal-driven briefs and record owner feedback. Do not start funded autonomy just because the new feature is deployed or the old PREVIEW mandate reaches its expiry date. *(2026-09-26: autonomy is frozen. The work goes to Arc first, items a–d above, then to D3. The owner's review of briefs continues alongside.)*
