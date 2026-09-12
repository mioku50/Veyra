# Veyra

[![Release](https://img.shields.io/badge/release-v0.2.0--beta.8-blue.svg)](https://github.com/mioku50/Veyra/releases/tag/v0.2.0-beta.8)
[![CI](https://github.com/mioku50/Veyra/actions/workflows/release-gate.yml/badge.svg)](https://github.com/mioku50/Veyra/actions/workflows/release-gate.yml)
[![Network](https://img.shields.io/badge/network-Arc%20Testnet%20(5042002)-emerald.svg)](https://testnet.arcscan.app)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Live](https://img.shields.io/badge/live-agent--commerce--six.vercel.app-34e39b.svg)](https://agent-commerce-six.vercel.app)

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
· [Run a decision](https://agent-commerce-six.vercel.app/run), the flow below end to
end in the browser
· [Decision log](https://agent-commerce-six.vercel.app/executions), every trust-routed
action, authorization and onchain settlement as it happened

---

## The one flow

```text
        "Research the latest developments in Ambient"      ← intent
                    budget 0.10 USDC · optimize for trust
                              │
                    ┌─────────▼─────────┐
       DISCOVER     │  ERC-8004 agents  │  Circle x402 marketplace
                    └─────────┬─────────┘
                              │  4 candidates
                    ┌─────────▼─────────┐
       VERIFY       │  live endpoint probe · catalog drift  │
                    │  latency · settlement history · identity │
                    └─────────┬─────────┘
                              │  evidence coverage caps the trust tier
                    ┌─────────▼─────────┐
       DECIDE       │  ALLOW · ALLOW_WITH_LIMITS           │
                    │  REQUIRE_EVALUATOR · REVIEW · DENY   │   fails closed
                    └─────────┬─────────┘
                              │  EIP-712 clearance, bound to endpoint + amount
                    ┌─────────▼─────────┐
       EXECUTE      │  x402 / Nanopayments  │  ERC-8183 escrow  │
                    └─────────┬─────────┘
                              │
       LEARN        │  observed outcome → reputation on Arc  │
```

One decision core. Two ways to spend. Every score traceable to the evidence that
produced it.

---

## Why this exists

An autonomous agent with a funded wallet will pay whoever answers first. It has no
way to tell a service that has settled 147 payments from one that was listed an
hour ago, and no way to notice that the price in the catalog is not the price the
endpoint is currently charging.

Veyra answers the question that comes before "how do I pay this": **should I pay
this endpoint at all, and for how much.**

A first-contact endpoint never reaches `ALLOW` — not because it is bad, but
because no settlement history exists for a counterparty nobody has paid yet. Veyra
reports the absence of evidence instead of scoring around it, and bounds the
exposure accordingly.

---

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

- Full transaction-by-transaction record: **[docs/PROOF_OF_LIVE_ERC8183.md](docs/PROOF_OF_LIVE_ERC8183.md)**
- Live decision log: **[agent-commerce-six.vercel.app/executions](https://agent-commerce-six.vercel.app/executions)**

---

## Two rails, one decision core

The same engine, policy tiers, and EIP-712 clearance serve both. What differs is
the candidate source and the shape of the evidence.

| | **API purchase** | **Agent job** |
| :--- | :--- | :--- |
| Discover | Circle x402 marketplace | ERC-8004 IdentityRegistry on Arc |
| Evidence | live 402 probe, catalog drift, latency | onchain settlement history, evaluator verdicts |
| Execute | x402 / Gateway Nanopayments | ERC-8183 job with USDC escrow |
| Verify | response validity, settlement | independent evaluator verdict, signed EIP-712 |

Discovery may see the whole Circle marketplace. Executable policy may still
require a Gateway-compatible route, so the payment is funded from the agent's
Arc balance regardless of where the endpoint lives.

---

## Evidence, not scores

A trust score is worth nothing if you cannot see what produced it. Every decision
exposes the evidence underneath it:

- **Live endpoint probe** — the 402 challenge as it is *right now*, compared against what the catalog advertises. A price or payee that changed since indexing is exactly the condition an agent must not pay through blindly.
- **Onchain settlement history** — ERC-8183 jobs completed, evaluator verdicts, USDC actually moved on Arc.
- **Repository and project analysis** — maintainer velocity, release health, adoption risk.
- **Treasury health** — USDC inflow/outflow, counterparty concentration, runway signals.
- **Paid API quality** — latency distribution, uptime, response validity, payment reliability.
- **Continuous monitoring** — drift and availability tracked over time, not sampled once.

These are inputs to a decision, not separate products.

---

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
priority. It does not choose who gets paid. Ranking, policy, exposure limits, and
the signed authorization are deterministic and reproducible from the evidence, so
the same inputs always produce the same decision and that decision can be audited
after the fact.

---

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

Arc is where the authorization, escrow, evaluation, and reputation live, and —
through Gateway — where the agent's USDC is funded from. Sub-second finality and
USDC-denominated gas make a per-job escrow economically sensible at cent scale.

> Smart contracts are deployed on Arc Testnet for evaluation and have **not**
> undergone an independent third-party security audit.

---

## Quickstart

```bash
git clone https://github.com/mioku50/Veyra.git
cd Veyra
npm install
cp .env.example .env.local
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Ask Veyra before paying an endpoint

```bash
curl -s -X POST "$VEYRA_BASE_URL/api/trust/v1/marketplace/select" \
  -H "authorization: Bearer $VEYRA_MACHINE_TOKEN" \
  -H "content-type: application/json" \
  -d '{"capability":"market_research","budgetUsdc":0.02,"maxPriceUsdc":0.02,"limit":5}'
```

`granted: false` means do not pay. `maxExposureUsdc` is the ceiling for the call.
The clearance is cryptographically bound to one resource and is not transferable
to another.

### TypeScript SDK

```bash
npm run machine:sdk-build
```

```typescript
import { VeyraClient } from "./sdk/typescript/src/index.js";

const veyra = new VeyraClient({ baseUrl, token });

const decision = await veyra.trustGate.evaluate({
  subject: agentWallet,
  counterparty: providerWallet,
  action: "erc8183_job",
  amountUsdc: 0.05,
});

if (!decision.granted) throw new Error(decision.reasons.join(", "));
```

Machine-readable API: [`/openapi/veyra-agent-api-v1.json`](public/openapi/veyra-agent-api-v1.json) ·
SDK source: [`sdk/typescript`](sdk/typescript)

---

## Verification

The full deterministic suite runs locally with no secrets:

```bash
npm run lint
npm run machine:sdk-build

npm run erc8004:test
npm run erc8183:test
npm run reputation:test
npm run trust-gate:test
npm run counterparty:test
npm run project-360:test
npm run monitoring:test

cd contracts && forge test && cd ..
npm run build
```

---

## Documentation

| | |
| :--- | :--- |
| [Architecture](docs/architecture.md) | How the decision core, rails, and evidence loop fit together |
| [Proof of live ERC-8183](docs/PROOF_OF_LIVE_ERC8183.md) | Transaction-level record of a settled job on Arc |
| [Trust-routed execution](docs/trust-routed-execution.md) | Clearance, mandates, and the execution state machine |
| [Contracts](docs/contracts.md) | Deployed addresses, ABIs, and verification |
| [Agent API](docs/agent-api.md) · [Webhooks](docs/webhooks.md) | Machine surface for autonomous callers |
| [Operations](docs/operations.md) | Running and monitoring a deployment |

---

## Security

- **Testnet only.** Veyra runs on Arc Testnet. Never use keys that control real assets.
- **Unaudited.** Contracts and protocol implementations are experimental.
- **Disclosure.** See [SECURITY.md](SECURITY.md). Do not open public issues for active vulnerabilities.

---

## License

Licensed under the [Apache License 2.0](LICENSE).

Portions of this codebase are derived from or incorporate open-source materials
created by Circle Internet Group, Inc., also under Apache-2.0. See [NOTICE](NOTICE)
for third-party attribution.

Veyra is an independent project and is not affiliated with or endorsed by Circle
Internet Group, Inc. or Arc.

Copyright © 2026 Veyra Contributors.
