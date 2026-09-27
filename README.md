# Veyra

[![Release](https://img.shields.io/badge/release-v0.3.0--beta.1-blue.svg)](https://github.com/mioku50/Veyra/releases/tag/v0.3.0-beta.1)
[![CI](https://github.com/mioku50/Veyra/actions/workflows/release-gate.yml/badge.svg)](https://github.com/mioku50/Veyra/actions/workflows/release-gate.yml)
[![Arc mainnet](https://img.shields.io/badge/Arc%20mainnet-agent%20%23298-emerald.svg)](https://agent-commerce-six.vercel.app/.well-known/agent-registration.json)
[![Arc Testnet](https://img.shields.io/badge/Arc%20Testnet-5042002-emerald.svg)](https://testnet.arcscan.app)
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

**Live — [agent-commerce-six.vercel.app](https://agent-commerce-six.vercel.app)**
· [Create an agent](https://agent-commerce-six.vercel.app), the front door — a
personal agent, its brief, and what it has earned on Arc
· [Choose and pay yourself](https://agent-commerce-six.vercel.app/run), the same
decision driven by hand
· [Decision log](https://agent-commerce-six.vercel.app/executions), every
trust-routed action, authorization and onchain settlement as it happened

On **Arc mainnet** Veyra is ERC-8004 agent
[#298](https://agent-commerce-six.vercel.app/.well-known/agent-registration.json).
It sells its Trust API there, paid through Circle Gateway. Its own contracts
(the Trust Gate, the evaluator and the proof registry) stay on **Arc Testnet**
until they are audited.

## The agent in front of it

The front door creates **Nova**, a personal agent owned by the person who made it.
Nova starts from an owner-stated goal, interests, and a short owner-confirmed
account of where the work already is. It reads official publications and release
notes, explains significant changes against what has already been built, with
source excerpts, and keeps ordinary commit counts and API listings in background
history. Nova may propose a change to that project context and can never confirm
one itself. Public-source analysis uses the app's model without charging the
owner's wallet.

```text
GOAL       a concrete result the owner wants
  ↓
STATE      what is already true about the work, confirmed by the owner
  ↓
OBSERVE    official publications · release notes · payment changes
  ↓
EXPLAIN    what changed · why it matters against work already done ·
           next step · source excerpts
  ↓
FEEDBACK   was this result useful?
  ↓ only for a specific unanswered question
PROPOSE    suitable tool · expected result · exact price · Veyra policy
  ↓ only after owner approval and existing execution checks
SIGN → EXECUTE → VERIFY → RECEIPT / ARC ATTESTATION
```

**Ask Nova.** The owner can put a question to Nova directly.
- Nova answers from Arc's and Circle's documentation first, at no charge.
- Only when that does not answer does it choose a tool on Arc for the
  question, and price it for the owner to approve.

The brief reads Arc first and Base after, with one card per endpoint. The cards
come from Circle's catalogue and from the ERC-8004 registry on Arc.

A missing answer is a research hypothesis, not permission to spend. Financial
permission remains Veyra's separate deterministic decision. The owner signs
every payment, because autonomous spending is [frozen](#autonomy-is-frozen).

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

## Autonomy is frozen

Nova proposes, and the owner signs every payment. On 26 September autonomous
spending was frozen for every user:
- `AUTONOMY_FROZEN` is a constant in
  [`lib/execution/autonomy-freeze.ts`](lib/execution/autonomy-freeze.ts), not a
  setting, so no environment variable can undo it.
- The autopilot route answers 503, and new `AUTOPILOT` mandates are refused.
- The scheduled shadow pass stops before it reads a mandate.

Before the freeze, Nova rehearsed spending it could not do:
- The owner signed an `ExecutionMandate` (EIP-712, v2, `mode: PREVIEW`). It named
  the capabilities, rails, spending ceilings and minimum trust score.
- Every scheduled pass then ran the whole path for real: a question,
  discovery, a live price, Veyra's decision and all eleven mandate checks.
- Each pass stopped one step before the only step that costs anything.

That epoch ended on 22 September, when its mandate expired. It was not
renewed.

> **A PREVIEW mandate can never authorize a live payment.** Execution refuses any
> mode but `AUTOPILOT`. The decision table has no column for a signature, a
> clearance, a transaction or a settled amount.

The next step keeps the owner in control. Nova will propose hiring a specific
ERC-8004 agent for a task at a price, and the owner will confirm every hire.

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
| Discover | Circle x402 marketplace · offers declared in the ERC-8004 registry on Arc | ERC-8004 IdentityRegistry on Arc |
| Evidence | live 402 probe, catalog drift, latency | onchain settlement history, evaluator verdicts |
| Execute | x402 / Gateway Nanopayments | ERC-8183 job with USDC escrow |
| Verify | response validity, settlement | independent evaluator verdict, signed EIP-712 |

An x402 purchase settles wherever the endpoint sells, and Nova reads Arc first.
On 23 September Circle's catalogue listed 482 offers on Arc mainnet and 1,009 on
Base. Identity, authorization, attestation and escrow stay on Arc. The product
says which chain a price is on, rather than letting the Arc heading imply one.

Settlement is a property of the endpoint too:
- All 482 Arc offers take a batched Gateway accept. It spends a deposit already
  held in Circle's GatewayWallet, not the wallet's balance.
- Only two of them also take a plain wallet payment.

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

On Arc mainnet Veyra sells two answers of its own:
- `history`, what it has observed of an endpoint, at 0.005 USDC;
- `select`, a ranked choice of sellers for a task, at 0.02 USDC.

Both are paid only on Arc, through Circle Gateway, to Veyra's own Circle wallet.
Credits do not pay there, and no clearance is signed there, because the Trust
Gate is on Arc Testnet. See the
[OpenAPI document](https://agent-commerce-six.vercel.app/openapi/veyra-arc-trust-api.json)
and the [ERC-8004 registration](https://agent-commerce-six.vercel.app/.well-known/agent-registration.json).

## Arc integration

| | Arc mainnet | Arc Testnet |
| :--- | :--- | :--- |
| Chain ID | `5042` | `5042002` (`0x4CEF52`) |
| RPC | `https://rpc.mainnet.arc.io` | `https://rpc.testnet.arc.network` |
| Explorer | [explorer.arc.io](https://explorer.arc.io) | [testnet.arcscan.app](https://testnet.arcscan.app) |
| Native gas | USDC — 18 decimals native, 6 decimals ERC-20 (`0x3600…0000`) | the same |
| ERC-8004 Identity | [`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`](https://explorer.arc.io/address/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432) | [`0x8004A818BFB912233c491871b3d84c89A494BD9e`](https://testnet.arcscan.app/address/0x8004A818BFB912233c491871b3d84c89A494BD9e) |
| Veyra's identity | agent #298, [registered](https://explorer.arc.io/tx/0xd770ed6af88eb3adc8756365b2e9a6a50377e13bdd3ee408f45b7102770b05b4) by Veyra's Circle wallet [`0x8F8E…eD6`](https://explorer.arc.io/address/0x8F8E0C9Fa2F67AED5b16e04f2716022aeB200eD6) | — |
| Circle Gateway | GatewayWallet [`0x7777…00eE`](https://explorer.arc.io/address/0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE) | Circle's testnet Gateway |
| ERC-8183 | — | [`0x0747EEf0706327138c69792bF28Cd525089e4583`](https://testnet.arcscan.app/address/0x0747EEf0706327138c69792bF28Cd525089e4583) |
| Veyra Evaluator | — | [`0x0d2C04580E081e222BBE5BF9818af337E2633eb7`](https://testnet.arcscan.app/address/0x0d2C04580E081e222BBE5BF9818af337E2633eb7) |

Authorization, escrow, evaluation and reputation all live on Arc, and Gateway is
where the agent's USDC comes from. Sub-second finality and USDC-denominated gas
are what make a per-job escrow sensible at cent scale.

> Veyra's contracts are deployed on Arc Testnet only, for evaluation, and have
> **not** had an independent third-party security audit. On Arc mainnet Veyra
> uses Arc's ERC-8004 registry and Circle Gateway, and deploys nothing of its own.

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
npm run nova-product-value:test && npm run nova-project-context:test
npm run nova-presentation:test && npm run nova-autonomy:test && npm run nova-arc-proof:test
npm run arc-registry:test && npm run arc-trust-api:test && npm run veyra-identity:test
npm run migration-access:test
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

- **Mainnet, with care.**
  - Veyra's identity and its Trust API are on Arc mainnet.
  - Owner-approved purchases settle on Arc mainnet and Base.
  - Veyra's contracts are on Arc Testnet only.
  - Autonomous spending is frozen, so the owner signs every payment.
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
