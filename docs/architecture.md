# Veyra Architecture

Veyra provides the **Trust Infrastructure for Agentic Commerce** on Arc Testnet. It organizes identity, reputation, policy decisions, execution, and independent verification into a continuous, feedback-driven architecture.

---

## 3-Layer System Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│                       EVIDENCE LAYER                        │
│  GitHub Health · Project 360 · API Quality · Treasury Flow  │
│  Execution Receipts · Settlement Histories · Onchain Probes │
└──────────────────────────────┬──────────────────────────────┘
                               │ Structured Signals & Weights
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                        TRUST LAYER                          │
│  ERC-8004 Identity · Evidence-Weighted Reputation Engine    │
│  Counterparty Selection Matrix · Trust Gate Policy Preflight│
└──────────────────────────────┬──────────────────────────────┘
                               │ Signed Clearance / Policy Verdicts
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                      EXECUTION LAYER                        │
│  x402 Payments · ERC-8183 Job Settlement · Veyra Evaluator  │
│  Arc Proof Registry · Onchain Settlement with USDC Gas      │
└──────────────────────────────┬──────────────────────────────┘
                               │ New Execution Evidence
                               └───────────────────────────────► (Feeds back into Evidence Layer)
```

---

## 1. Evidence Layer

The Evidence Layer gathers, standardizes, and hashes multi-source objective facts about agents, repositories, APIs, and smart contracts:

- **GitHub Repository Analysis**: Commit velocity, maintainer distribution, release frequency, license hygiene, and dependency health.
- **Project 360 Multi-Source Graph**: Cross-source candidate discovery mapping GitHub repositories to onchain contract deployments and active API endpoints.
- **Paid API Quality Probes**: Observed uptime, latency distribution (P50/P95), payment transaction reliability, and schema validity.
- **Treasury Flow Analysis**: Onchain USDC inflow/outflow, burn rate, counterparty concentration (Herfindahl-Hirschman Index), and runway metrics.
- **Historical Settlement Evidence**: Cryptographic receipts from completed x402 calls and ERC-8183 job evaluations.

---

## 2. Trust Layer

The Trust Layer transforms raw observations into actionable, policy-enforcing trust decisions:

- **ERC-8004 Identity Integration**: Canonical onchain identity registration and verification bridge.
- **Evidence-Weighted Reputation Engine**: Calculates a deterministic trust score (0–100) across 6 dimensions with anti-Sybil damping, self-rating exclusion, and temporal decay for stale evidence.
- **Multi-Criteria Counterparty Selection**: Automated evaluation and ranking of multiple candidate agents based on capabilities, verified reputation, latency, and budget constraints.
- **Trust Gate Transaction Preflight**: Fail-closed policy evaluation (`ALLOW`, `ALLOW_WITH_LIMITS`, `REQUIRE_EVALUATOR`, `REVIEW_REQUIRED`, `DENY`) that issues cryptographic EIP-712 clearance tickets before execution begins.

---

## 3. Execution Layer

The Execution Layer facilitates safe payment, work evaluation, and onchain settlement on Arc:

- **x402 Micropayments**: Native HTTP 402 payment protocol integration with USDC gas abstraction on Arc.
- **ERC-8183 Agentic Commerce Protocol**: Standardized smart contracts coordinating job creation, fund escrow, evaluator authorization, and release.
- **Independent Veyra ERC-8183 Evaluator**: Non-custodial evaluator service that inspects submitted deliverables against contract policy hashes and issues onchain settlement verdicts.
- **Arc Proof Registry**: Onchain contract recording immutable cryptographic proof hashes for completed workflows and evaluations.

---

## The Feedback Loop

The core innovation of Veyra is the closed-loop trust lifecycle:

1. **Evidence**: Raw signals and past performance metrics are ingested.
2. **Reputation**: Signals are weighted and normalized into deterministic scores.
3. **Policy**: Trust Gate evaluates planned transactions against risk limits and issues clearance.
4. **Execution**: The agent executes the transaction or job on Arc.
5. **Evaluation**: Veyra Evaluator independently verifies the output.
6. **New Evidence**: The verified outcome generates a new proof receipt, immediately updating the agent's reputation for future selections.
