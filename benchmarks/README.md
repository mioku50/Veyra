# Veyra benchmark

Measures whether Veyra classifies unsafe counterparties correctly, and how long
its decision takes, against outcomes fixed in
[`ground-truth.json`](ground-truth.json) **before** the run.

```bash
npm run benchmark
```

Results land in `benchmarks/results/<timestamp>/` as `raw.jsonl` (one line per
case, with everything observed) and `summary.json`. Raw output is committed: a
benchmark whose inputs cannot be re-examined is a claim, not a measurement.

---

## What is actually under test

The harness does not reimplement any of Veyra's logic. It imports and runs the
same modules the API serves from:

| Part | Module exercised | What it decides |
| :--- | :--- | :--- |
| Probe | `lib/providers/x402-probe.ts` → `probeX402Resource` | Is the endpoint alive, does it speak x402, does its live challenge still match the catalog |
| Policy | `lib/trust-gate/policy.ts` → `resolvePolicy` | Which trust tier the evidence supports |
| Budget | `lib/counterparty-selection/engine.ts` → `rankCounterpartyCandidate` | Eligibility and the exposure ceiling |

What the harness controls is the **input**. `probeX402Resource` accepts an
injected `fetchImpl`, so each ground-truth case supplies a scripted seller — one
that refuses connections, one that quietly charges five times its listed price,
one that redirects payment to an address the catalog never advertised. The
condition is known exactly, which is the only way an expectation can be fixed in
advance.

---

## Results — 2026-09-12

24 of 24 cases pass. Full output in
[`results/2026-09-12T21-03-41-757Z/`](results/2026-09-12T21-03-41-757Z/).

### Unsafe conditions correctly flagged

| Condition | Cases | Caught |
| :--- | ---: | ---: |
| Dead endpoint (refused, timed out) | 2 | 2 |
| Protocol violation (200 instead of 402, 503, unparseable challenge) | 3 | 3 |
| Price drift — live challenge charges more than the catalog says | 1 | 1 |
| Payee drift — payment redirected to an unadvertised address | 1 | 1 |
| Asset drift — a different token demanded | 1 | 1 |
| Network drift — the listed chain is not offered | 1 | 1 |
| Conformant seller, correctly cleared (body and header transport) | 2 | 2 |

Both transports matter: an x402 v2 server puts its challenge in the
`payment-required` header with an empty body, and a probe that only reads the
body would score a conformant seller as broken.

### Policy tiers

Eight cases, all passing. The load-bearing ones:

- **A first-contact marketplace endpoint cannot reach `ALLOW`.** With a perfect probe score of 92 and 0.95 confidence it still resolves to `REQUIRE_EVALUATOR`, because only two of six evidence dimensions are observable without settlement history. Coverage binds, not score.
- **A critical risk flag closes the gate rather than lowering the score.** `SYBIL_RISK` on a 95-score, 0.9-coverage counterparty resolves to `DENY`.
- **Unverifiable history is treated as absent history.** `ARC_PROOF_UNVERIFIED` → `DENY`.
- **Freshness gates independently of score.** Evidence four hours old drops a 90-score counterparty out of `ALLOW`.

### Budget and exposure

Five cases, all passing. `maxExposureUsdc` is `min(budget, tier ceiling)` — a
ceiling on what Veyra authorises, deliberately not the seller's quoted price. A
price above the returned exposure must not be paid; the engine never raises the
ceiling to accommodate one. A denied tier yields zero exposure regardless of
budget.

### Decision latency

Ranking every probed candidate and resolving the policy tier, 2,000 iterations
after warm-up:

| Candidates | p50 | p95 | p99 |
| ---: | ---: | ---: | ---: |
| 2 | 0.009 ms | 0.021 ms | 0.054 ms |
| 6 | 0.017 ms | 0.048 ms | 0.093 ms |
| 25 | 0.023 ms | 0.087 ms | 0.172 ms |

Sub-millisecond at every size, and near-flat from 6 to 25 candidates. This is
the part Veyra is responsible for, and it is not where the time goes: probing a
real endpoint takes **257 ms at p50**, roughly fifteen thousand times longer than
deciding what to do with the result.

---

## Live observation — the real Circle catalog

```bash
npm run benchmark -- --live --capability=web_search --limit=12
```

Nothing is asserted here. Nobody controls these sellers, so no expectation could
be fixed in advance; what the live pass produces is the one number the fixture
harness cannot — how long a real x402 challenge takes — and a look at how often
a live endpoint disagrees with the catalog advertising it.

Run of 2026-09-12, capability `web_search`:

| | |
| :--- | ---: |
| In Circle's catalog for this capability | 132 |
| Discovered and probed | 12 |
| Reachable | 12 |
| Answered a valid 402 challenge | 12 |
| **Disagreed with the catalog** | **1** |
| Probe latency p50 / p95 | 257 ms / 1431 ms |

The one that disagreed: **`https://api.exa.ai/contents`**. Circle's catalog
advertises 0.001 USDC; the matching accept in its live challenge did not carry
that amount — it parsed as 0 — so the entry is flagged `price_changed`, fails the
`accepts_matches_catalog` check, and scores 0 on probe integrity. Whether the
seller changed its price or publishes a dynamic one, the catalog no longer
describes what the endpoint actually demands, and an agent paying on the strength
of the listing would be paying against terms it never saw. This is the condition
the product exists to catch, found on the first live pass.

One in twelve is a single observation, not a rate. It is reported because it
happened, not as a measurement of how common drift is.

### A note on capabilities that return nothing

`--capability=market_research` returns zero candidates. That is not a defect:
Circle's discovery search is conjunctive, and the query built from the capability
(`market research`) has to match both terms. `market` alone returns 50, `research`
alone returns 50, `web search` returns 50, `crypto market data` returns 9 — but
nothing in the catalog matches `market` *and* `research`. Pick a capability the
catalog actually carries.

---

## The three latencies, and why they are reported separately

They are paid by different parties and differ by five orders of magnitude.
Collapsing them into one "decision time" would hide which part is slow and would
let a network-bound number be presented as an engine-bound one.

| | Bound by | Measured where |
| :--- | :--- | :--- |
| **Probe latency** | The seller's network and server | Measured by the live pass: **p50 257 ms, p95 1431 ms**. The fixture harness cannot produce this - it drives scripted sellers, so any timing there would describe the harness. |
| **Decision latency** | Veyra's own computation | Measured above: **p50 0.017 ms** over six candidates. |
| **Execution latency** | Arc block times and settlement | Measured onchain, not simulated. Job #186207 settled in **19 seconds** across five transactions for **0.0118 USDC**. See [docs/PROOF_OF_LIVE_ERC8183.md](../docs/PROOF_OF_LIVE_ERC8183.md). |

---

## What this benchmark does not claim

Worth stating plainly, because these numbers are easy to over-read:

- **The unsafe-condition counts are from controlled fixtures, not from the live Circle marketplace.** They demonstrate that Veyra classifies each condition correctly when it occurs. They are not a measurement of how often those conditions occur in the wild, and must not be quoted as "Veyra found 4 drifting endpoints in the catalog".
- **The live pass is an observation, not a rate.** Twelve endpoints on one day is not a survey of the catalog, and the one drifting endpoint it found is not a measurement of how often drift occurs.
- **Decision latency excludes discovery and probing**, which dominate wall-clock time in a real request. It is the cost of deciding once the evidence is in hand.
- **The policy and budget cases drive the engine with fixture evidence**, not with evidence produced by a full discovery run.

---

## Changing an expectation

`ground-truth.json` is the contract. Editing it to match observed behaviour
defeats the purpose, so any change there is a deliberate commit of its own with a
reason.

One expectation has been corrected since the file was written: the
`dead_endpoint_refused` case originally expected `errorCategory: "connection"`, a
value that does not exist in the `ErrorCategory` union
(`lib/providers/api-quality-types.ts` defines `none | timeout | network |
invalid_response | payment_failed | settlement_failed | execution_failed |
verification_failed`). The expectation named a nonexistent enum member; it was
corrected to `"network"`. No assertion about behaviour was relaxed.
