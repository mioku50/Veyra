# Veyra

[![Release](https://img.shields.io/badge/release-v0.2.0--beta.8-blue.svg)](https://github.com/mioku50/Veyra/releases/tag/v0.2.0-beta.8)
[![CI](https://github.com/mioku50/Veyra/actions/workflows/release-gate.yml/badge.svg)](https://github.com/mioku50/Veyra/actions/workflows/release-gate.yml)
[![Network](https://img.shields.io/badge/network-Arc%20Testnet%20(5042002)-emerald.svg)](https://testnet.arcscan.app)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Live](https://img.shields.io/badge/live-veyras.vercel.app-7b6cff.svg)](https://veyras.vercel.app)

> ## Veyra decides. Circle pays.
>
> **Before an agent spends USDC, Veyra decides whether it should pay, whom, and how much.**

Circle gives an agent a wallet, a marketplace, and a way to pay. Veyra is the
independent layer in front of that: it measures the evidence available about a
counterparty, ranks the alternatives, enforces budget and risk policy, and issues
a signed authorization bound to one endpoint and one amount. After execution, the
observed outcome becomes new reputation on Arc.

`ERC-8004` · `ERC-8183` · `x402` · `Gateway Nanopayments` · `USDC` · `Arc`

**Live on Arc Testnet — [veyras.vercel.app](https://veyras.vercel.app)**
· [Run a decision](https://veyras.vercel.app/run), the flow below end to
end in the browser
· [Decision log](https://veyras.vercel.app/executions), every trust-routed
action, authorization and onchain settlement as it happened

## The one flow

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

Discovery may see the whole Circle marketplace; executable policy may still
require a Gateway-compatible route, so payment is funded from the agent's Arc
balance wherever the endpoint lives.

A trust score is worth nothing if you cannot see what produced it, so every
decision exposes its evidence: the live 402 challenge against the advertised one,
settled ERC-8183 jobs and evaluator verdicts on Arc, observed latency and uptime
over time, and project and treasury signals. These are inputs to a decision, not
separate products.

## Primitives

The standards Veyra is built on, in the role each one actually plays:

| Primitive | Role |
| :--- | :--- |
| **ERC-8004** | Agent identity and reputation registries on Arc |
| **ERC-8183** | Job lifecycle: escrow, deliverable, evaluation, settlement |
| **Veyra Trust Gate** | EIP-712 clearance, verified and consumed onchain |
| **Veyra Evaluator** | Independent, fail-closed verdicts that authorize ERC-8183 payout |
| **x402 / Nanopayments** | Gas-free USDC payment for API calls, settled in batches via Gateway |
| **Mandates** | Standing budget and capability limits an agent operates under |

### LLM forms the intent. Veyra makes the financial decision.

The language model turns a request into a structured intent — capability, budget,
priority. It does not choose who gets paid. Ranking, policy, exposure limits and
the signed authorization are deterministic and reproducible from the evidence, so
the same inputs always produce the same decision, and it can be audited later.

### Veyra is itself an x402 resource

Discoverable and payable by the machinery it verifies, at
[`/.well-known/x402`](https://veyras.vercel.app/.well-known/x402). The
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
(cd contracts && forge test)
```

## Documentation

| | |
| :--- | :--- |
| [Architecture](docs/architecture.md) | How the decision core, rails, and evidence loop fit together |
| [Proof of live ERC-8183](docs/PROOF_OF_LIVE_ERC8183.md) | Transaction-level record of a settled job on Arc |
| [Trust-routed execution](docs/trust-routed-execution.md) | Clearance, mandates, and the execution state machine |
| [Contracts](docs/contracts.md) | Deployed addresses, ABIs, and verification |
| [Agent API](docs/agent-api.md) · [Webhooks](docs/webhooks.md) | Machine surface for autonomous callers |
| [Operations](docs/operations.md) | Running and monitoring a deployment |
| [Benchmarks](benchmarks/README.md) | Decision accuracy against ground truth fixed before the run |

## Security

- **Testnet only.** Never use keys that control real assets.
- **Unaudited.** Contracts and protocol implementations are experimental.
- **Disclosure.** See [SECURITY.md](SECURITY.md) — no public issues for active vulnerabilities.
- **Scope.** External seller commerce remains an internal capability. It is not the
  primary catalog or product positioning.

## License

Licensed under the [Apache License 2.0](LICENSE). Portions derive from
open-source material by Circle Internet Group, Inc., also Apache-2.0 — see
[NOTICE](NOTICE). Veyra is independent and is not affiliated with or endorsed by
Circle Internet Group, Inc. or Arc.

Copyright © 2026 Veyra Contributors.
