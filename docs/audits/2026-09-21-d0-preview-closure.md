# D0: closing the PREVIEW calibration epoch

Date: 2026-09-21. Mandate: PREVIEW v2, canonical hash
`0x32c4b9a9e1421b8a97afbe57704e27a250b6ff146569ea9179eecc0cacf87db1`.
Expiry: **2026-09-22 12:49:49 UTC** (14:49:49 Europe/Berlin).
Status: **closing as insufficient for funding. D1 remains deferred behind gate V.**

## Decision

The epoch ends on its own terms. It is not renewed, not extended, and its
limits are not raised. No AUTOPILOT mandate is requested by this note, and no
wallet is funded on the strength of the record below.

The reason is not that the record is bad. It is that the record answers a
question nobody is blocked on — whether signed limits refuse what they should —
and does not answer the question that decides funding: whether the work Nova
proposed was worth buying. Zero of thirteen decisions carry owner feedback, so
the usefulness column of this calibration is empty by measurement, not by
judgement.

## Observed record

Read-only report against the database configured by the local environment, at
`asOf` 2026-09-21 16:59:15 UTC, seven hours before the mandate expires. Its
identity has not been independently compared with the deployed production
environment. Reproduce with `npm run --silent nova:calibration:report`.

| Observation | Result |
| --- | --- |
| Window | `in_progress` at extraction; not revoked |
| Recorded decisions under this hash | 13 |
| WOULD_ALLOW | 4; hypothetical total 0.030000 USDC |
| WOULD_DENY | 9 |
| Decisions under other mandates, excluded | 8 |
| Owner feedback | 0 useful, 0 not worth it, **13 unanswered** |
| Refusal reasons (overlapping) | `within_per_action_limit` 5, `within_daily_budget` 5, `capability_allowed` 4 |
| Quote histogram | 0.006 × 1, 0.007 × 2, 0.010 × 5, 0.040 × 5 USDC |
| First / last decision | 2026-09-15 20:17:42 UTC / 2026-09-20 16:14:08 UTC |
| Last scheduled refresh | 2026-09-21 10:48:43 UTC |
| Duplicate signal/mandate/budget-day rows | 0 |
| Recorded budget-integrity violations | 0 |
| `liveAutonomyApproval` | `NOT_GRANTED` |

Per budget day, on the owner's Europe/Berlin clock: 1 allowed / 1 denied
(0.010000), 1 / 3 (0.006000), 0 / 4, 0 / 1, then 2 / 0 (0.014000). Five of the
nine refusals fail both the per-action and the daily check; they are five
refused decisions, not ten. Denied quotes are not counted as hypothetical
spend.

### What this establishes, and what it does not

- It establishes that the signed limits bind in both directions under live
  proposals, that the budget-day arithmetic held across the epoch, and that no
  duplicate or integrity-violating row was written.
- It does not establish delivery, answer quality, settlement, wallet
  enforcement, or that any of the four allowed proposals was worth 0.007 USDC
  to the owner. A `WOULD_ALLOW` is a statement about a policy, not about value.
- Five quotes at 0.040 USDC sat above a 0.010 USDC per-action ceiling. That is
  not evidence the ceiling is wrong. Whether the work behind those quotes was
  worth buying was never answered, and raising a limit to increase the allowed
  count would answer it in the wrong direction.

## Code boundaries inside this epoch

The epoch spans three releases of the pipeline that produces its proposals, so
its decisions are not one controlled population:

1. `202f3cf` (2026-09-20 14:30 UTC) — discovery and proposal-preparation fixes.
2. `6ccaf72` (2026-09-21) — goal-driven public-source research; the population
   of events that can become a proposal changed.
3. This change — the public-reading budget is spent by relevance rather than by
   traversal order, and the brief reports why each held-back item was held.

Compare before and after each boundary separately. An unchanged mandate hash
does not make the pipeline underneath it the same pipeline.

## Capture required at expiry

After 2026-09-22 12:49:49 UTC, and before any new mandate is signed:

1. Re-run `npm run --silent nova:calibration:report` and record the final
   figures with `window` no longer `in_progress`.
2. Record the owner's actual usefulness verdict on the allowed decisions, or
   record explicitly that none was given. Test-agent ratings do not count.
3. Document the unpriced and missed-coverage reasons from the scheduler
   metrics for the epoch, not only for one tick.
4. State an explicit budget recommendation derived from the above, or state
   that the evidence does not support one.

A second PREVIEW epoch, if the owner wants one, needs a new signature, a stated
calibration purpose, and its own record. Do not merge its decisions into this
hash.

## What unblocks D1

Gate V in [the roadmap](../ROADMAP.md): recurring, source-backed, goal-relevant
findings the owner marks useful, including runs with zero paid calls. Until
then the operational-wallet acceptance matrix in
[D0/D1 readiness](2026-09-20-nova-d0-d1-readiness.md) stays a test design, not
a work item.
