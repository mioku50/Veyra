# Nova: D0 evidence and D1 wallet decision

Date: 2026-09-20. Updated 2026-09-21. Status: **D1 deferred: establish Nova product value before operational-wallet work.**

## Decision

The owner found the proposed commit-count investigations insufficiently useful. The next stage is [Nova Product Value V1](2026-09-21-nova-product-value-v1.md): explicit goals, substantive events, public-source analysis and usefulness feedback. Operational-wallet acceptance and a funded autonomy pilot remain deferred. The technical D0 evidence and D1 test matrix below remain reference material, not authorization to proceed to funding.

This work neither enables AUTOPILOT nor migrates Veyra to Arc mainnet. The current signed PREVIEW mandate remains unchanged.

## D0: observed data

Evidence: `2026-09-20-nova-d0-snapshot.json`, collected using SELECT-only requests to the database configured by the local environment. Its identity has not been independently compared with the deployed production environment in this investigation. No private queries, response bodies, credentials, owner addresses or signatures are included.

| Observation | Result |
| --- | --- |
| Calibration epoch | 1; canonical hash registered in `lib/nova/calibration.ts` |
| Mandate | PREVIEW v2; Base settlement; Europe/Berlin budget day |
| Expiry | 2026-09-22 12:49:49 UTC (14:49:49 Berlin) |
| Recorded decisions | 11 |
| WOULD_ALLOW | 2; hypothetical total 0.016000 USDC |
| WOULD_DENY | 9 |
| Old development decisions excluded | 8 |
| Owner feedback | 0 useful, 0 not worth it, 11 unanswered |
| Price distribution, all decisions | 0.006 × 1; 0.010 × 5; 0.040 × 5 USDC |
| Refusal reasons | 5 over both per-action/daily limits; 4 capability refusals |
| Duplicate signal/mandate/budget-day records | 0 |
| Recorded allowance budget violations | 0 |
| Last decision | 2026-09-18 16:32:53 UTC |
| Agent's last scheduled refresh | 2026-09-20 06:23:11 UTC |

Reason counts overlap: the same five decisions fail two budget checks. They are five refused decisions, not ten. Denied prices are not included in hypothetical spending. No conclusion about actual delivery can be derived from these shadow records.

### What this means

- The recorded sample demonstrates both allowances and refusals under the selected terms. It does not yet establish usefulness, a viable budget or safe live autonomy.
- Do not raise the 0.01 USDC action cap merely because five quotes cost 0.04. Review whether the underlying proposed work was useful first.
- There are no recorded decisions after September 18 despite later refreshes. A refresh is not proof that a shadow pass completed. The [September 20 cron run](https://github.com/mioku50/Veyra/actions/runs/35494082209) refreshed two agents with zero refresh failures and zero shadow decisions. It reported 40 unpriced candidates: `nothing_askable: 24`, `subject_missing: 11`, `subject_unaskable: 2`, `not_payable: 2`, `subject_policy_refused: 1`. This explains that aggregate run, not every missing decision or the per-agent breakdown.
- Thus the next product investigation is whether Nova can turn relevant signals into useful, priceable requests. Raising spending limits does not repair missing request parameters or unavailable subject terms. Inspect provider-specific proposal preparation before changing trust thresholds.
- The deployed scheduler can hide a shadow exception in an otherwise successful refresh. This change adds count-only metrics in `lib/nova/shadow-observability.ts`: attempted passes, failures, time skips, readiness blocks, considered/skipped candidates and deadline hits. Existing decision/unpriced metrics remain. No error text or agent identifiers are added to the public cron response. These metrics take effect after deployment; they cannot reconstruct past errors.
- Calendar completion is insufficient: conclude D0 only with reviewed allowances/refusals, owner feedback, explained coverage gaps and an explicit budget recommendation. If observations remain insufficient at expiry, record that outcome and request a new PREVIEW mandate; never silently extend it or merge changed terms into this epoch.

### Reproduce

```bash
npm run nova-calibration:test
npm run nova-autonomy:test
npm run nova-shadow-observability:test
npm run --silent nova:calibration:report
# Optional: append a canonical mandate hash to select another epoch.
```

The report reads one agent's decisions, paginates in stable order with a decision-time cutoff, and selects the requested mandate hash. It sums amounts in integer micro-USDC and reports other mandates separately. This is not a transactional historical database snapshot: owner feedback is read at extraction time. It does not verify the mandate signature. `liveAutonomyApproval` is always `NOT_GRANTED`, including after expiry or with an empty dataset.

## D1: candidate and unresolved guarantees

**Candidate for a single-user pilot: Circle Agent Wallet with independently controlled policy administration. Not yet selected for production.**

The current x402 server adapter uses a private-key signer and Arc Testnet configuration (`lib/execution/adapters/x402.ts`). It is not already a Circle Agent Wallet adapter. A Circle CLI local-wallet import is also not equivalent to an Agent Wallet with enforced policies.

Official documentation reviewed on September 20:

- [Agent Wallets](https://developers.circle.com/agent-stack/agent-wallets): user-controlled MPC wallet and spending controls.
- [Custom policies](https://developers.circle.com/agent-stack/agent-wallets/wallet-operations/custom-policies): mainnet-only policies, rolling limits, address rules, and OTP-confirmed changes.
- [Authentication](https://developers.circle.com/agent-stack/agent-wallets/wallet-operations/authenticate): 28-day sessions, local credential storage, and separate testnet/mainnet sessions.
- [CLI reference](https://developers.circle.com/agent-stack/circle-cli/command-reference): typed-data signing, contract execution, EVM-wide remaining budgets, local credential clearing on logout, and a five-agent-wallet-per-user limit.
- [Gateway network scope](https://developers.circle.com/gateway/nanopayments/supported-networks): SDK deposits/payments are scoped to the configured chain.

These describe capabilities, not proof of enforcement for Veyra's exact paths. The `circle` executable was not found on this shell's PATH. No CLI session, wallet policy, signature, funding or payment operation was performed.

### Required acceptance matrix

All live tests below remain **NOT RUN**. Use isolated funds and record exact CLI/SDK versions, chain, wallet, configured rules, expected result and observed settlement evidence. A rejection message alone does not prove zero economic effect.

| Test | Required result |
| --- | --- |
| Exact-quote integration | Existing boundary controls method, URL, body hash, recipient, amount, chain, expiry and dispatch. CLI must not silently substitute a fresh quote after Veyra approval. |
| Transfer and direct x402 limits | Below-cap request succeeds; above-cap request is rejected without a usable authorization or settlement. |
| Arbitrary typed-data / contract calls | Attempts to bypass limits using EIP-3009, approvals, permit, native USDC value or contract execution are rejected or explicitly excluded by enforceable permissions. |
| Concurrent requests | Two individually valid requests whose sum exceeds the remaining budget cannot both create spendable authorizations. |
| Gateway | Verify accounting across deposit, delegated signing, individual nanopayments and withdrawals. A deposit cap alone is not a per-purchase cap. |
| Cross-chain budget | Verify Base + Arc share the intended wallet cap; retain Veyra's separate mandate accounting. |
| Budget clock | Enforce Veyra's owner-calendar-day limit and Circle's rolling limit independently; do not translate them as equivalent. |
| Revocation | From an independent owner-controlled channel, invalidate the runtime's ability to create new spend authorizations; verify with a second session/process. Local logout is insufficient evidence. |
| Outstanding authorizations | After stopping new issuance, retain reservations until existing signatures settle, expire or have provable cancellation. |
| Runtime lifecycle | Securely survive process restart; expired or unavailable sessions deny spending; re-authentication cannot silently elevate permissions. |
| Isolation | One agent cannot use another agent's wallet or policy-admin credentials. Check whether session permissions can actually be narrowed per wallet. |
| Crash recovery | Reserve-before-dispatch, lost response after dispatch and overdue uncertain settlement all converge without duplicate payment. |

Keep policy-administration email/OTP access outside Nova's runtime. Otherwise an agent capable of changing its own policy defeats the intended independent control.

### Architecture recommendation

Nova / Manual Purchase / External Agent → existing decision and policy checks → atomic reservation → wallet-specific signer → rail-specific dispatch → reconciliation → receipt.

Define the signer integration around a durable execution ID and exact approved terms. Preserve x402 and ERC-8183's separate economic lifecycles. Prefer a narrow signer adapter if the supported Circle interface exposes the necessary semantics; a CLI that owns discovery, signing and dispatch requires explicit review of its handoff before integration. Do not simply replace the adapter with `circle services pay` and assume all current guarantees survive.

If Agent Wallet session isolation, hosting or signing cannot meet acceptance, compare Developer-Controlled Wallets and restricted smart-account permissions. Document the change in custody/control; do not promise equivalent independent enforcement from server-held credentials.

## Original ordered actions — deferred by the September 21 product decision

Complete Product Value V1 and owner usefulness review first. The sequence below documents the former technical plan; it is not the active next-stage instruction.

1. Deploy the count-only shadow diagnostics, investigate `nothing_askable` / `subject_missing`, and review both allowances plus representative refusals in Nova. Record actual owner feedback. One aggregate cron run has been explained; historical coverage remains incomplete.
2. At expiry, regenerate the report and conclude D0 as sufficient or insufficient; propose any new limits from evidence.
3. Validate the D1 matrix against one isolated Agent Wallet. Determine server-runtime suitability before writing the production signer adapter.
4. Add a portable receipt plus one external client using the existing boundary; no separate platform.
5. Only after acceptance, use a newly signed AUTOPILOT mandate, bounded funding and an independently tested stop procedure for a small pilot.
6. Prepare Arc mainnet network/contract configuration in parallel. An Arc seller's HTTP 402 proves an offered route, not a successfully settled purchase. Keep the Base calibration terms unchanged; mainnet history has its own chain and contract identities.

Product direction remains Nova. Subscription and separate purchase-budget economics remain hypotheses to validate with usefulness, retention and actual operating costs.

## Local verification

Passed: `nova-calibration:test`, `nova-shadow-observability:test`, `nova-autonomy:test`, `nova:test`, `tsc --noEmit`, targeted ESLint and `git diff --check`. The read-only report command also completed against the configured database. At preparation time, the new scheduler diagnostics had not been deployed or observed in a live tick; no wallet-enforcement or crash-recovery acceptance test is claimed by these unit checks.

Pre-release verification: the full `npm run release:gate` passed, including secret scanning, ESLint, SDK build, deterministic application suites, 31 Foundry contract tests and the Next.js production build. Calibration, shadow diagnostics, discovery regressions and x402 request-body tests are now included in this gate. Deployment and post-release observations must be recorded separately from this preparation snapshot.

## Follow-up: proposal preparation fixes (September 20)

Read-only live discovery reproduced the research-routing problem. `LangChain project update` returned domain/webhook update APIs, trading-position updates and other generic matches. Querying for a web-search service returned search APIs. The research subject remains in the question sent to the selected provider, not the service catalog query.

Changes:

1. Repository research discovers `web search` services; the policy capability remains `research`.
2. Named-subject fallback checks the full bounded response before shortlist truncation. The old code could lose a returned seller behind cheaper endpoints. Capability/price checks still apply, and a changed payee does not satisfy the pinned candidate ID. This is not an exhaustive catalog scan: a subject outside the upstream response can still be unavailable.
3. Approval-time re-discovery also pins the shown candidate and settlement network. Existing trust and changed-terms checks remain mandatory.
4. Plain questions are no longer automatically placed into URL, array/object or formatted-string schema fields. Missing inputs remain unresolved instead of being invented.
5. GET calls with nonempty request bodies are rejected before price/quote network calls, because the current transport would discard that body. Supporting query parameters requires binding the prepared URL through selection and execution; this change does not silently append parameters to an approved resource.
6. Catalog HTTP methods unsupported by the GET/POST transport are excluded instead of being rewritten to GET.

Live price check (no payment): `https://parallelmpp.dev/api/search`, POST, schema-declared `query`, not guessed; `priceX402Call` returned `priced`, **0.01 USDC**, `eip155:8453`. This establishes discovery and price preparation only. It does not prove a trust clearance, funded Gateway balance, settlement, delivery quality or live wallet enforcement.

Regression fixtures reproduce the wrong discovery query and the named-subject truncation before the fix, then verify the corrections and price/payee guards. The original D0 snapshot remains unchanged. On deployment, record the release/time boundary and compare proposal preparation before/after separately: unchanged signed limits do not make the observed discovery pipeline identical.

Follow-up checks passed: `nova-discovery:test`, `marketplace:test`, `x402-request-body:test`, `x402-decision:test`, `x402-payment:test`, `nova:test`, `nova-autonomy:test`, TypeScript and targeted ESLint. Marketplace fixtures ran without a configured observation database and reported the expected unavailable-store warnings; this is not a live persistence test.

## Published release and observed PREVIEW results

Code release: `202f3cf02442c6d0a5aca8fac45e6e26e0dd3321`, Vercel deployment `dpl_69nAC26aGT6GGJWrwzBUxwTVaREV`, READY at **2026-09-20 14:30:25.412 UTC** and aliased to `agent-commerce-six.vercel.app`. The [GitHub release gate](https://github.com/mioku50/Veyra/actions/runs/35516649410) passed. The production home page returned HTTP 200. This timestamp is the code boundary for before/after analysis; the signed PREVIEW mandate and original D0 snapshot are unchanged.

The [16:13 UTC scheduled tick](https://github.com/mioku50/Veyra/actions/runs/35522042704) exercised the deployed code: two agents refreshed, four signals kept, two shadow passes attempted, no shadow failures, no time skips and no deadline hits. One pass was blocked by `no_mandate`. Across the tick, four candidates were considered: two decisions were recorded as WOULD_ALLOW for **0.014 USDC hypothetical spend**, and two were unpriced (`subject_unaskable: 1`, `subject_policy_refused: 1`).

The configured database report collected at 19:22 UTC now contains **13 decisions: 4 allowed and 9 denied**, with **0.030000 USDC total hypothetical allowed spend**, no duplicate signal/day records and no recorded budget-integrity violations. The two additional rows are Exa research on Base, 0.007 USDC each, with no failed policy checks. Their times and totals agree with the scheduled run; this correlation is not an independent attestation of database identity. Owner feedback is still missing on all 13 decisions.

The [19:21 UTC manual scheduler invocation](https://github.com/mioku50/Veyra/actions/runs/35532042401) returned success and the new metrics with `due: 0`. No extra pass was forced and scheduler timestamps were not reset. Vercel's grouped runtime-error query for `/api/nova/cron`, from release readiness through the inspection at approximately 19:22 UTC, returned no errors. This is a scoped observation, not proof that every application route is error-free.

Machine-readable evidence: `2026-09-20-nova-postrelease-evidence.json`. The earlier 40-unpriced-candidate tick and this four-candidate tick had different signals and stopping conditions; their totals are not a controlled success-rate comparison. The release has now produced priceable, policy-allowed proposals in production, but usefulness, delivery quality, paid settlement and D1 wallet enforcement remain unproven. D0 remains open until owner review and the expiry assessment; no AUTOPILOT permission or mainnet migration was enabled.
