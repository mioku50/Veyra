# Veyra

[![Release](https://img.shields.io/badge/release-v0.2.0--beta.8-blue.svg)](https://github.com/mioku50/Veyra/releases/tag/v0.2.0-beta.8)
[![CI](https://github.com/mioku50/Veyra/actions/workflows/release-gate.yml/badge.svg)](https://github.com/mioku50/Veyra/actions/workflows/release-gate.yml)
[![Network](https://img.shields.io/badge/network-Arc%20Testnet%20(5042002)-emerald.svg)](https://testnet.arcscan.app)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Live](https://img.shields.io/badge/live-agent--commerce--six.vercel.app-7b6cff.svg)](https://agent-commerce-six.vercel.app)

> ## Veyra decides. Circle pays.
>
> **Before an agent spends USDC, Veyra decides whether it should pay, whom, and how much.**

Circle gives an agent a wallet, a marketplace, and a way to pay. Veyra is the
independent layer in front of that: it measures the evidence available about a
counterparty, ranks the alternatives, enforces budget and risk policy, and issues
a signed authorization bound to one endpoint and one amount. After execution, the
observed outcome becomes new reputation on Arc.

`ERC-8004` · `ERC-8183` · `x402` · `Gateway Nanopayments` · `USDC` · `Arc`

**Live on Arc Testnet — [agent-commerce-six.vercel.app](https://agent-commerce-six.vercel.app)**
· [Create an agent](https://agent-commerce-six.vercel.app), the front door — a
personal agent, its brief, and what it has earned on Arc
· [Choose and pay yourself](https://agent-commerce-six.vercel.app/run), the same
decision driven by hand
· [Decision log](https://agent-commerce-six.vercel.app/executions), every
trust-routed action, authorization and onchain settlement as it happened

## The agent in front of it

The front door creates **Nova**, a personal agent owned by the person who made it.
Nova starts from an owner-stated goal and interests. It reads official publications
and release notes, explains significant changes with source excerpts, and keeps
ordinary commit counts and API listings in background history. Public-source
analysis uses the app's model without charging the owner's wallet.

```text
GOAL       a concrete result the owner wants
  ↓
OBSERVE    official publications · release notes · payment changes
  ↓
EXPLAIN    what changed · why it matters · next step · source excerpts
  ↓
FEEDBACK   was this result useful?
  ↓ only for a specific unanswered question
PROPOSE    suitable tool · expected result · exact price · Veyra policy
  ↓ only after owner approval and existing execution checks
SIGN → EXECUTE → VERIFY → RECEIPT / ARC ATTESTATION
```

A missing answer is a research hypothesis, not permission to spend. Financial
permission remains Veyra's separate deterministic decision. The operational-wallet
phase is deferred until Nova demonstrates useful work; see
[Nova Product Value V1](docs/audits/2026-09-21-nova-product-value-v1.md).

Nova never holds money and there is no signing path in its code. It can want to
spend and it says so, with a price and a verdict on the item; the payment goes
through the same selection, clearance and wallet signature as any other Veyra
purchase.

An identity is earned, not granted. The rule is a verified purchase **and** an
attestation somebody else can read — not because Arc re-checks Veyra's verdict
(it does not; the verdict stays Veyra's) but because a claim that lives only in
Veyra's database is a claim whose only witness is the party making it.

## The decision underneath

```text
INTENT     "Research the latest developments in Ambient"
           budget 0.10 USDC · optimize for trust
              ↓
DISCOVER   ERC-8004 agents on Arc  ·  Circle x402 marketplace        4 candidates
              ↓
VERIFY     live endpoint probe · catalog drift · latency
           settlement history · onchain identity      evidence coverage caps the tier
              ↓
DECIDE     ALLOW · ALLOW_WITH_LIMITS · REQUIRE_EVALUATOR · REVIEW · DENY
                                                       fails closed, never silently
              ↓                EIP-712 clearance, bound to endpoint + amount
EXECUTE    x402 / Gateway Nanopayments  ·  ERC-8183 escrow on Arc
              ↓
LEARN      observed outcome → reputation on Arc
```

One decision core. Two ways to spend. Every score traceable to the evidence that
produced it.

## Shadow autonomy

Nova is currently rehearsing a kind of spending it cannot do.

The owner signs an `ExecutionMandate` — EIP-712, v2, `mode: PREVIEW` — naming the
capabilities, rails, per-action, per-day and total ceilings, attempts per day,
minimum trust score and budget timezone a rehearsal runs under. On every
scheduled pass the whole path then runs for real: a model notices something, a
question is written for it, discovery runs, an endpoint quotes a live price,
Veyra decides, and the signed mandate is evaluated against all of it. Then it
stops, one step before the only step that costs anything.

No payment authorization is built, no EIP-3009 signature is produced, and no
wallet is touched. The decision table has no column for a signature, a clearance,
a transaction or a settled amount, so a bug cannot write one into it.

All eleven checks run on every proposal, including the ones after the first
failure, so a refusal names everything that was wrong rather than the first thing
— which matters, because raising the limit would not have helped if the trust
score was also too low:

```text
capability_allowed · rail_allowed · network_matches_mandate · veyra_decision_allows
trust_at_least_minimum · within_per_action_limit · within_daily_budget
within_total_budget · attempts_remaining · payable_unattended · evaluator_where_required
```

> **A PREVIEW mandate can never authorize a live payment.** Execution refuses any
> mode but `AUTOPILOT`, and `subjectWallet` is the zero address, deliberately —
> Nova has no operational wallet, and inventing one would put an address naming
> nothing into a signed document. Enabling real autonomy later requires a fresh
> signature on a mandate that names a real wallet.

It exists because the honest way to decide whether an agent should be funded is
to watch what it would have done, for a week, with nothing at risk. The record
that produces — what it would have bought, what Veyra refused, what the market
would not price at all — is what the real limits get set from.

Deterministic evaluator: [`lib/nova/autonomy.ts`](lib/nova/autonomy.ts) · the one
mandate it issues: [`lib/nova/autonomy-mandate.ts`](lib/nova/autonomy-mandate.ts)

## Why this exists

An autonomous agent with a funded wallet pays whoever answers first. It cannot
tell a service that has settled 147 payments from one listed an hour ago, and it
does not notice when the catalog price is no longer what the endpoint charges.
Veyra answers the question that comes first: **should I pay this endpoint at all,
and for how much.**

A first-contact endpoint never reaches `ALLOW` — not because it is bad, but
because no settlement history exists for a counterparty nobody has paid yet. Veyra
reports the absence of evidence instead of scoring around it.

## Proof it works

A complete ERC-8183 job — creation, USDC escrow, deliverable, independent
evaluation, payout — executed on Arc Testnet, with every step backed by a
transaction hash:

| | |
| :--- | :--- |
| Job | [#186207](https://testnet.arcscan.app/tx/0x0f0c3e5ce89423bb43a5f206d8cf46269f70793cac4e7dd2730cc638757cf392) on Arc Testnet |
| Lifecycle cost | 560,260 gas — **0.0118 USDC**, about 1.2 cents |
| Time to payout | **19 seconds**, createJob → USDC in the provider's wallet |
| Policy checks | 11 of 11 passed, deliverable re-fetched and re-hashed by the evaluator |

## Two rails, one decision core

The same engine, policy tiers, and EIP-712 clearance serve both. What differs is
the candidate source and the shape of the evidence.

| | **API purchase** | **Agent job** |
| :--- | :--- | :--- |
| Discover | Circle x402 marketplace | ERC-8004 IdentityRegistry on Arc |
| Evidence | live 402 probe, catalog drift, latency | onchain settlement history, evaluator verdicts |
| Execute | x402 / Gateway Nanopayments | ERC-8183 job with USDC escrow |
| Verify | response validity, settlement | independent evaluator verdict, signed EIP-712 |

Circle's catalogue publishes zero resources on Arc — measured, not assumed — so an
x402 purchase settles wherever the endpoint lives, usually Base, while identity,
authorization, attestation and escrow stay on Arc. The product says which chain a
price is on rather than letting the Arc heading imply one. Settlement is a
property of the endpoint too: 74 of the 389 catalogue resources take a batched
Gateway accept, which spends a deposit already sitting in Circle's GatewayWallet
on that chain rather than the wallet's balance, 289 do not, and none offers both.

A trust score is worth nothing if you cannot see what produced it, so every
decision exposes its evidence: the live 402 challenge against the advertised one,
settled ERC-8183 jobs and evaluator verdicts on Arc, observed latency and uptime
over time, and project and treasury signals. These are inputs to a decision, not
separate products.

## Primitives

The standards Veyra is built on, in the role each one actually plays:

| Primitive | Role |
| :--- | :--- |
| **Nova** | The personal agent in front of all of it — watches, proposes, holds no key |
| **ERC-8004** | Agent identity and reputation registries on Arc |
| **ERC-8183** | Job lifecycle: escrow, deliverable, evaluation, settlement |
| **Veyra Trust Gate** | EIP-712 clearance, verified and consumed onchain |
| **Veyra Evaluator** | Independent, fail-closed verdicts that authorize ERC-8183 payout |
| **x402 / Nanopayments** | Gas-free USDC payment for an API call — a direct EIP-3009 authorization, or a batched Gateway accept where the endpoint takes one |
| **Mandates** | EIP-712 budget and capability limits an agent operates under — `PREVIEW` rehearses, `AUTOPILOT` pays |
| **Arc Proof Registry** | Verified purchases written onchain: parties, amount, request and response hashes |

### LLM forms the intent. Veyra makes the financial decision.

The language model turns a request into a structured intent — capability, budget,
priority — and decides what is worth asking. It does not choose who gets paid and
it cannot reach the evaluator's inputs except by producing a proposal the market
priced. Ranking, policy, exposure limits and the signed authorization are
deterministic and reproducible from the evidence, so the same inputs always
produce the same decision, and it can be audited later.

### Veyra is itself an x402 resource

Discoverable and payable by the machinery it verifies, at
[`/.well-known/x402`](https://agent-commerce-six.vercel.app/.well-known/x402). The
verdict is free, with its evidence; the signed clearance costs, because a contract
can consume an attestation and cannot consume an opinion. Reporting what happened
after a purchase earns a credit toward the next one.

## Arc integration

| | |
| :--- | :--- |
| Network | Arc Testnet |
| Chain ID | `5042002` (`0x4CEF52`) |
| RPC | `https://rpc.testnet.arc.network` |
| Explorer | [testnet.arcscan.app](https://testnet.arcscan.app) |
| Native gas | USDC — 18 decimals native, 6 decimals ERC-20 (`0x3600…0000`) |
| ERC-8183 | [`0x0747EEf0706327138c69792bF28Cd525089e4583`](https://testnet.arcscan.app/address/0x0747EEf0706327138c69792bF28Cd525089e4583) |
| ERC-8004 Identity | [`0x8004A818BFB912233c491871b3d84c89A494BD9e`](https://testnet.arcscan.app/address/0x8004A818BFB912233c491871b3d84c89A494BD9e) |
| Veyra Evaluator | [`0x0d2C04580E081e222BBE5BF9818af337E2633eb7`](https://testnet.arcscan.app/address/0x0d2C04580E081e222BBE5BF9818af337E2633eb7) |

Authorization, escrow, evaluation and reputation all live on Arc, and Gateway is
where the agent's USDC comes from. Sub-second finality and USDC-denominated gas
are what make a per-job escrow sensible at cent scale.

> Contracts are deployed on Arc Testnet for evaluation and have **not** had an
> independent third-party security audit.

## Quickstart

```bash
git clone https://github.com/mioku50/Veyra.git && cd Veyra
npm install
cp .env.example .env.local
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Ask Veyra before paying an endpoint — no account, no key

```bash
curl -s -X POST "$VEYRA_BASE_URL/api/x402/v1/verdict" \
  -H "content-type: application/json" \
  -d '{"resource":"https://api.example.com/search","budgetUsdc":0.01}'
```

`granted: false` means do not pay. `maxExposureUsdc` is the ceiling for the call,
and a clearance is bound to one resource — it is not transferable to another.

### TypeScript SDK

```typescript
const veyra = new VeyraClient({ baseUrl, token });
const decision = await veyra.trustGate.evaluate({
  subject: agentWallet, counterparty: providerWallet,
  action: "erc8183_job", amountUsdc: 0.05,
});
if (!decision.granted) throw new Error(decision.reasons.join(", "));
```

Build it with `npm run machine:sdk-build`. Machine-readable API: [`/openapi/veyra-agent-api-v1.json`](public/openapi/veyra-agent-api-v1.json) ·
SDK source: [`sdk/typescript`](sdk/typescript)

## Verification

The deterministic suite runs locally with no secrets — every `*:test` script in
`package.json`, the Foundry contract tests, and the build:

```bash
npm run lint && npm run build
npm run erc8004:test && npm run erc8183:test && npm run trust-gate:test
npm run x402-payment:test && npm run x402-trust-api:test
npm run nova:test && npm run nova-standing:test && npm run nova-identity:test
npm run nova-presentation:test && npm run nova-autonomy:test && npm run nova-arc-proof:test
(cd contracts && forge test)
```

`nova-autonomy:test` pins the v1 canonical mandate hash against a golden value
taken before v2 was written, so adding fields cannot silently change what an
already-signed mandate covers, and asserts that twelve tampered variants of the
preview mandate are rejected before a wallet is ever asked to sign one.

## Documentation

| | |
| :--- | :--- |
| [Proof of live ERC-8183](docs/PROOF_OF_LIVE_ERC8183.md) | Transaction-level record of a settled job on Arc |
| [Trust-routed execution](docs/trust-routed-execution.md) | Clearance, mandates, and the execution state machine |
| [Contracts](docs/contracts.md) | Deployed addresses, ABIs, and verification |
| [Agent API](docs/agent-api.md) · [Webhooks](docs/webhooks.md) | Machine surface for autonomous callers |
| [Operations](docs/operations.md) | Running and monitoring a deployment |
| [Benchmarks](benchmarks/README.md) | Decision accuracy against ground truth fixed before the run |

## Security

- **Testnet only.** Never use keys that control real assets.
- **Unaudited.** Contracts and protocol implementations are experimental.
- **No custody.** Nova holds no key and cannot sign a payment; an owner is proven
  by a secret whose SHA-256 is all the database stores.
- **Disclosure.** See [SECURITY.md](SECURITY.md) — no public issues for active vulnerabilities.
- **Scope.** External seller commerce remains an internal capability. It is not the
  primary catalog or product positioning.

## License

Licensed under the [Apache License 2.0](LICENSE). Portions derive from
open-source material by Circle Internet Group, Inc., also Apache-2.0 — see
[NOTICE](NOTICE). Veyra is independent and is not affiliated with or endorsed by
Circle Internet Group, Inc. or Arc.

Copyright © 2026 Veyra Contributors.
