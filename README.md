# Veyra

[![Release](https://img.shields.io/badge/release-v0.2.0--beta.8-blue.svg)](https://github.com/mioku50/Veyra/releases/tag/v0.2.0-beta.8)
[![CI](https://github.com/mioku50/Veyra/actions/workflows/release-gate.yml/badge.svg)](https://github.com/mioku50/Veyra/actions/workflows/release-gate.yml)
[![Network](https://img.shields.io/badge/network-Arc%20Testnet%20(5042002)-emerald.svg)](https://testnet.arcscan.app)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

> **Trust Infrastructure for Agentic Commerce on Arc.**
> 
> Verify agents and services, evaluate counterparties before money moves, independently evaluate ERC-8183 work, and turn completed interactions into verifiable reputation on Arc.

---

## At a Glance

| Question | Answer |
| :--- | :--- |
| **What is Veyra?** | A unified trust and verification platform for autonomous AI agents and human operators. |
| **What problem does it solve?** | Unsafe autonomous payments, unverified agent counterparties, lack of verifiable reputation, and unaudited offchain work settlement. |
| **Why Arc?** | Arc provides native USDC gas abstraction, sub-second finality, predictable settlement costs, and onchain verification primitives. |
| **What can I try right now?** | Explore the [Trust Hub](https://agent-commerce-six.vercel.app/trust), inspect [Agent Trust](https://agent-commerce-six.vercel.app/reputation), evaluate transaction policies with [Trust Gate](https://agent-commerce-six.vercel.app/trust-gate), rank counterparties in the [Selection Matrix](https://agent-commerce-six.vercel.app/trust/select), verify work with [ERC-8183 Evaluator](https://agent-commerce-six.vercel.app/evaluators), or run [Project 360](https://agent-commerce-six.vercel.app/project-360) and [GitHub Due Diligence](https://agent-commerce-six.vercel.app/agent-runner). |
| **Is this experimental?** | **Yes.** Veyra is currently running on **Arc Testnet** (Chain ID `5042002`). Smart contracts are experimental and unaudited. |

---

## Architecture Lifecycle

Veyra unifies identity, reputation, policy, execution, and settlement into a continuous cryptographic feedback loop on Arc:

```text
ERC-8004 Identity
       ↓
Evidence-Weighted Reputation
       ↓
Multi-Criteria Counterparty Selection
       ↓
Trust Gate Policy Preflight
       ↓
EIP-712 Signed Clearance
       ↓
ERC-8183 / x402 Execution
       ↓
Independent ERC-8183 Evaluation
       ↓
Onchain Arc Settlement
       ↓
Observed Evidence Loop
```

---

## Core Capabilities

### 1. Agent Trust & Reputation (ERC-8004)
Inspect agent identity, evidence coverage, execution history, and deterministic reputation scores (0–100) before initiating transactions. Self-rating is strictly filtered and multi-source evidence is weighted with temporal decay.

### 2. Multi-Criteria Counterparty Selection
Programmatically discover, filter, and rank candidate agents based on historical reputation, observed latency, availability, pricing, and budget constraints.

### 3. Trust Gate Transaction Preflight
Execute pre-transaction policy checks before an ERC-8183 job, x402 payment, or service purchase. Decisions fail closed (`ALLOW`, `ALLOW_WITH_LIMITS`, `REQUIRE_EVALUATOR`, `REVIEW_REQUIRED`, `DENY`) and issue EIP-712 signed clearance tickets for onchain consumption.

### 4. Independent ERC-8183 Evaluator
A non-custodial, fail-closed evaluation service that independently verifies submitted deliverables (e.g. schema compliance, hash validation, policy satisfaction) and signs onchain verdicts to authorize job settlement on Arc.

### 5. Evidence Workflows
Structured analysis pipelines that generate verifiable reports and onchain proof trails:
- **Project 360**: Multi-source discovery across GitHub, onchain contracts, and live APIs.
- **GitHub Project Due Diligence**: Repository health, maintainer velocity, and adoption risks.
- **Treasury Health**: Onchain USDC inflow/outflow analysis, counterparty concentration (HHI), and runway signals.
- **Paid API Quality**: Latency, uptime, response validity, and payment reliability benchmarking.

### 6. Continuous Trust Monitoring
Turn one-time snapshots into verifiable history. Watchlists track agent drift, risk signals, and endpoint availability, emitting alerts and signed, retryable webhooks.

### 7. Veyra Agent API & SDK
Full machine-readable API for autonomous AI agents with an OpenAPI 3.0 specification ([`/openapi/veyra-agent-api-v1.json`](https://agent-commerce-six.vercel.app/openapi/veyra-agent-api-v1.json)) and a typed, dependency-free TypeScript SDK in [`sdk/typescript`](sdk/typescript).

---

## Arc Integration Details

Veyra leverages the Arc Testnet ecosystem for deterministic execution and settlement:

- **Network**: Arc Testnet
- **Chain ID**: `5042002` (hex: `0x4CEF52`)
- **Native Gas**: USDC (18 decimals for native gas, 6 decimals for ERC-20 token)
- **RPC Endpoint**: `https://rpc.testnet.arc.network`
- **Explorer**: [https://testnet.arcscan.app](https://testnet.arcscan.app)
- **Standards & Contracts**:
  - **ERC-8004**: Onchain Agent Identity and Validation Registries.
  - **ERC-8183**: Agentic Commerce job contracts with external evaluator authorization.
  - **Veyra Trust Gate**: EIP-712 clearance ticket verifier contract.
  - **Veyra Proof Registry**: Onchain record of verified execution and evaluation receipts.

*Note: Smart contracts are deployed on Arc Testnet for evaluation and testing purposes and have not undergone an independent third-party security audit.*

---

## Developer Quickstart

### 1. Clone and Install

```bash
git clone https://github.com/mioku50/Veyra.git
cd Veyra
npm install
cp .env.example .env.local
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### 2. Using the TypeScript SDK

Build the SDK from the repository workspace:

```bash
npm run machine:sdk-build
```

#### Read Agent Reputation:
```typescript
import { VeyraClient } from "./sdk/typescript/src/index.js";

const client = new VeyraClient({
  baseUrl: process.env.NEXT_PUBLIC_APP_URL || "https://agent-commerce-six.vercel.app",
  credential: process.env.VEYRA_API_KEY || "anonymous",
});

const reputation = await client.getAgentReputation("agent_01");
console.log(`Trust Score: ${reputation.trustScore}/100 (${reputation.statusLabel})`);
```

#### Preflight a Transaction with Trust Gate:
```typescript
const decision = await client.requestTrustDecision({
  subjectAgentId: "agent_01",
  action: "erc8183_job_settlement",
  requestedValueUsdc: 5.0,
  executorWallet: "0xYourWalletAddress...",
});

if (decision.decision.decision === "ALLOW") {
  console.log("Approved! Signed clearance:", decision.signature);
}
```

#### Select Optimal Counterparty:
```typescript
const selection = await client.selectCounterparty({
  taskType: "github_due_diligence",
  budgetUsdc: 10.0,
  candidates: [
    { agentId: "agent_01", quotedPriceUsdc: 2.5 },
    { agentId: "agent_02", quotedPriceUsdc: 1.8 },
  ],
});
console.log("Selected Agent:", selection.selectedAgentId);
```

---

## Verification & Testing

Run the full local deterministic test suite (no secrets required):

```bash
# Lint code
npm run lint

# Compile and typecheck SDK
npm run machine:sdk-build

# Run deterministic test suites
npm run erc8004:test
npm run erc8183:test
npm run reputation:test
npm run trust-gate:test
npm run counterparty:test
npm run project-360:test
npm run monitoring:test

# Run Foundry smart contract tests
cd contracts && forge test && cd ..

# Build Next.js application
npm run build
```

---

## Security & Responsible Disclosure

- **Testnet Only**: Veyra is deployed exclusively on **Arc Testnet**. Never use real production funds or private keys with real assets.
- **Unaudited Software**: Smart contracts and protocol implementations are experimental.
- **Reporting Vulnerabilities**: If you discover a security issue, please consult [SECURITY.md](SECURITY.md) for responsible disclosure instructions. Do not open public GitHub issues for active vulnerabilities.

---

## License & Third-Party Notices

This project is licensed under the [Apache License 2.0](LICENSE).

Portions of this codebase are derived from or incorporate open-source materials created by Circle Internet Group, Inc. (licensed under Apache-2.0). See [NOTICE](NOTICE) for full third-party attribution and copyright details.

Copyright © 2026 Veyra Contributors.
