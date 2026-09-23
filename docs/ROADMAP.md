# Veyra product roadmap

**Updated:** 2026-09-23  
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
| D0 — Shadow Autonomy | Running; calibration not accepted | PREVIEW v2 evaluates live proposals and signed limits without creating payment authorizations. No automatic mandate renewal or promotion to AUTOPILOT. |
| **V — Nova Product Value V1** | **Technical first slice implemented; owner-value acceptance open (CURRENT PRIORITY)** | Goal-driven public-source research has shipped. Whether it produces useful work consistently remains to be shown with real owner feedback. |
| D1 — Operational wallet | Research/test design only | No production wallet signer, funded Nova wallet, or wallet-enforced autonomy has passed acceptance. |
| D2 — Bounded live autonomy | Not enabled | Requires fresh AUTOPILOT consent and all D1 gates; PREVIEW cannot be upgraded by an environment flag. |
| D3 — Nova hires agents | Infrastructure proof only | An ERC-8183 escrow job was demonstrated on Arc Testnet; the owner-facing Nova → agent-hiring workflow is not complete. |
| Mainnet / broader launch | Preparation only | Existing Nova identity, proofs and contracts are on Arc Testnet; do not describe them as Arc mainnet identity or mainnet revenue. |

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

## D0 — Close shadow calibration honestly

**Closed as insufficient for funding. The mandate expired 2026-09-22 12:49:49 UTC and the capture required at expiry is complete: [D0 PREVIEW closure](audits/2026-09-21-d0-preview-closure.md).** Final figures are unchanged from the pre-expiry snapshot — 13 decisions, 4 WOULD_ALLOW, 0.030000 USDC hypothetical, **0 of 13 carrying owner feedback**, no duplicates, no integrity violations, `liveAutonomyApproval: NOT_GRANTED`. No budget recommendation is supported, and none is made. One required item could not be answered: the per-tick `unpriced` reasons are emitted to the scheduler log and never persisted, so an epoch-wide figure is unavailable after the fact. Persisting the tick outcome is the fix and belongs to item 3 below.

The active PREVIEW epoch predates this product-value change. Its original snapshot contained 11 priced decisions (2 WOULD_ALLOW, 9 WOULD_DENY); the 2026-09-20 postrelease record contained 13 (4 WOULD_ALLOW, 9 WOULD_DENY), **$0.030000 hypothetical allowed spend**, and no recorded owner feedback. These are observations from the configured database, correlated with scheduled-run evidence; they do not prove delivery, usefulness, settlement or wallet enforcement. See [D0/D1 readiness](audits/2026-09-20-nova-d0-d1-readiness.md).

- The current PREVIEW mandate expires **2026-09-22 12:49:49 UTC**. It is not a live payment authorization. Do not renew it silently, alter its allowed capabilities, increase its limits or count a fresh mandate as the same calibration epoch.
- The 2026-09-21 goal/source selection release changes the proposal population. Record the code boundary and assess the old and new pipelines separately, even under the same mandate hash. Do not present their conversion rates as a controlled comparison.
- At expiry, capture the final report, ask for actual owner usefulness feedback, document `unpriced`/missed-coverage reasons and decide explicitly whether the evidence is sufficient. An insufficient result is a valid D0 outcome and does not justify a wallet by itself.
- A second PREVIEW epoch, if requested, must have a new signed mandate and explicit calibration purpose. Do not mix its decisions with the earlier epoch.

## D1 — Wallet boundary, **only after V's exit gate**

Before writing a production signer adapter, compare Circle Agent Wallet, Developer-Controlled Wallets and enforceable smart-account/session permissions for a **single isolated test wallet**. Circle's documented controls do not prove that every arbitrary typed-data/contract-call path Veyra needs is actually constrained. A Veyra server-side policy alone limits Veyra's code, not a raw wallet key.

**Acceptance:** pin the exact approved endpoint/method/body hash/payee/asset/network/amount/expiry across wallet integration; prove per-action and concurrent budget ceilings, Gateway deposit-vs-per-purchase accounting, cross-chain scope, owner-calendar-day vs rolling-window differences, signer/process isolation, recovery from lost responses, and independent owner revocation of **new** authorizations. Test direct EIP-3009, approvals, permit and arbitrary contract calls as potential bypasses. Preserve already-issued authorizations until settled/expired/provably cancelled. Record actual observed outcomes, not just wallet error messages.

If permissions cannot be enforced at wallet level, state the narrower guarantee explicitly: **risk is bounded by funded balance; Veyra policy is not a cryptographic spending cap.** The wallet must not have access to the human's main-wallet key or to its own policy-administration credentials.

## D2 — One real bounded-autonomy pilot

Only after V and D1 pass: owner explicitly funds a small isolated operational wallet and signs a **new AUTOPILOT mandate** naming that wallet. Reuse the hardened Veyra execution boundary and its atomic budget/reconciliation machinery; do not create a second executor for Nova. Run one narrow research/data purchase; observe actual balance change, payment evidence, delivery result, receipt, budget accounting, revocation and crash recovery. `PREVIEW` signatures must always fail at the live executor. No unlimited approvals, no automatic permission expansion, no DeFi/swaps/arbitrary transfers in this pilot.

## D3 — Nova in the agent economy

Expose an owner-understandable proposal to hire a specific ERC-8004 agent for a specific result and price. Revalidate counterparty evidence, have the owner approve funding, execute an ERC-8183 job through its existing escrow/evaluator lifecycle, report a truthful outcome and build standing from verified history. The current testnet escrow proof is infrastructure evidence, **not** proof that this end-to-end Nova UX exists. Agent earnings, job acceptance and independent service provision come only after genuine counterparties and settled work exist.

## Parallel work, not blockers for V

- **Portable receipt / independent verifier:** export authorized terms, policy version, payment and delivery evidence, hashes and optional Arc attestation without exposing raw private requests, responses or reusable authorizations. A verified hash is not a claim of factual truth.
- **External SDK pilot:** try one actual outside research/data-agent client against the same execution boundary. Business pricing and paid-team demand remain hypotheses; Nova is not demoted to a mere demo by default.
- **Arc mainnet foundation:** obtain and verify official network/contract manifests, deploy and verify separate mainnet contracts/signers/roles, and distinguish testnet identity/history from mainnet. No automatic migration assumption or renaming of old proof URLs.
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

**Next decision:** review the first real, goal-driven briefs and record owner feedback. Do not start funded autonomy just because the new feature is deployed or the old PREVIEW mandate reaches its expiry date.
