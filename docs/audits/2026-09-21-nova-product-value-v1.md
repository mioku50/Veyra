# Nova Product Value V1

## Product decision

The owner's September 20 feedback rejects ordinary commit counts and speculative API purchases as useful work. Policy allowances establish permission, not customer value. D1 operational-wallet work is deferred. Keep existing PREVIEW terms and expiry unchanged; do not automatically renew or raise limits.

Nova should start with an owner-stated goal, examine substantive events, explain their relevance from public sources, then identify any remaining question. Veyra retains the separate deterministic financial boundary.

## Implemented behavior

- Optional owner-authenticated research goal (600 characters), alongside interests. No goal is silently inferred or assigned to existing agents. Set it in **My Agent → Change goal and sources**.
- Curated Arc, Circle and LangChain publication indexes and Ethereum RSS, plus GitHub release notes. Official hosts, HTTPS, no redirects/auth/payment retry, seven-second reads, 1.5 MB per response, bounded discovery. Unknown publication dates and unreadable articles are reported as incomplete coverage. Publications older than 21 days are excluded from the initial look.
- Commit-count changes and available-API listings remain background observations, including historical cards. Important payment destination/availability alerts retain deterministic handling.
- Releases/publications require a significant assessment for the current goal before entering Today. The brief deduplicates same-subject events and stays capped at five cards. An empty brief says nothing was selected, rather than claiming nothing happened.
- At most three model analyses per refresh. Backfill reconsiders recent events when a goal is set/changed. A failed analysis is visible and cannot become a paid fallback. Owner-requested public reading is also available in the background list.
- Stored summaries explain what changed, relevance, a next step and remaining uncertainty. The model selects supplied excerpt IDs; the server resolves them to exact source text. Unknown references and unmatched quotes are rejected. Links, publication/read times and model provenance are preserved. Quote matching establishes provenance, not the truth of every interpretation.
- Arc/Circle analyses also consult fixed Arc network and Circle Nanopayments reference pages. Other sources currently have narrower coverage. These are bounded excerpts, not exhaustive web research.
- A paid proposal requires a current goal-matched significant assessment, a specific open question and expected result, at least two public sources, complete reference reads and an assessment younger than 24 hours. These are minimum eligibility conditions, not proof that a purchase will be useful. A human can review the gap; policy checks still apply independently.
- Paid research uses the remaining question unchanged. An endpoint must declare a usable question field; an unknown schema is not guessed. Goal/question eligibility is rechecked before approving an existing proposal.
- Useful/not-interesting feedback is saved per assessment and goal in a service-only RLS table. Dismissing one article does not suppress its entire publisher. Historical policy decisions and paid receipts remain intact. We did not fabricate feedback records from the owner's message.
- Source digests advance only after successful event writes; failed history/refresh writes fail visibly.

## Deliberate limits

This is a first bounded research workflow, not unrestricted browsing or proof of product value. The source list is curated, initial discovery reads at most ten article links per HTML index, model analysis is capped, and excerpts can miss details. There is no automatic implementation of suggested work. Model operation uses the app's existing provider and can incur app-side cost; public research does not charge the owner's wallet.

A gap is a hypothesis. Two source reads do not prove free information is exhausted. Do not graduate Nova to a funded autonomous wallet based on this implementation or on an increased WOULD_ALLOW count.

## Rollout and acceptance

Apply `20260920220000_nova_product_value.sql` and `20260921093000_nova_value_feedback.sql` before publishing the app. The focused migration runner verifies the configured database target, applies the migration and ledger entry transactionally, verifies nullable goal and publication kinds, and reloads the REST schema. It does not modify user goals, histories or signed mandates.

Technical checks: Product Value regressions cover goals, significance selection, old activity filtering, deduplication, invalid citations, unavailable models/sources, paid eligibility, bounded readers and first-seen releases. Existing Nova, presentation, autonomy, discovery and release suites must continue passing. Verify goal persistence, public-source analysis, feedback and mobile rendering in the browser.

Product acceptance remains open: for several days Nova must deliver concrete findings or work the owner marks useful, even if there are no paid calls. Review usefulness, duplicates/noise, source support, missed important events and app-side model cost. A successful release is not evidence that this criterion has passed.

## Verification recorded on September 21

- Both focused database migrations applied and verified; feedback table RLS enabled. No existing user goal or mandate was edited.
- Live browser smoke created a dedicated test agent, saved a goal, collected 13 publication events, obtained three source-supported assessments, and displayed one selected finding in that run. Model outputs are nondeterministic; these counts are observations, not quotas or quality scores.
- The same smoke verified unauthorized read rejection, source-analysis retrieval, result feedback persisted against the assessment/goal, goal editing, no browser exceptions, and no horizontal overflow at 390 and 1366 pixels. The temporary agent and cascading records were deleted afterward. No paid tool or wallet was called.
- The first live attempts correctly refused malformed model output. JSON mode, bounded prose and excerpt-ID selection repaired the observed failures without relaxing source matching. The pure regression suite also covers forged citations and unavailable models.
- Product acceptance still requires the owner's real feedback. Test-agent ratings do not count toward it.
