# Changelog

All notable changes to the Veyra platform will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0-beta.3] - 2026-08-15

### Security & Integrity
- **P6.1.2 Execution Rail Integrity & Economic Accounting Closure**:
  - **Mandatory EIP-712 Clearance**: Clearance generation and EIP-712 signing is now mandatory during `prepareExecution`; server-side persistence preserves full clearance payload and signature, preventing client-side forgery or omission.
  - **Onchain Clearance Pre-Verification**: Added onchain verification via `VeyraTrustGate.verifyClearance` immediately before irreversible consumption.
  - **Official x402 V2 Protocol Compliance**: Migrated x402 adapter to official `@x402/core` and `@x402/evm` implementation, parsing `payment-required`, constructing compliant signed `PaymentPayload`, and verifying `payment-response` headers.
  - **Irreversibility & Post-Payment Failure Accounting**: Budget handling now depends strictly on onchain economic settlement rather than generic service success. If funds move but downstream service fails, expenditure is permanently recorded as spent and state transitions to `SETTLED_SERVICE_FAILED`.
  - **Real ERC-8183 Deliverable and Settlement Verification**: Deliverable structures now require valid canonical schema and content hashing; settlement values and `JobCreated` arguments are strictly verified against onchain event logs.
  - **Real Reputation Arc Proof Registration**: Settled interactions dynamically recompute agent reputation and publish new snapshot hashes directly to `AgentCommerceProofRegistry` on Arc Testnet, recording verified `arcProofTx` receipts.
  - **Authentication Replay Hardening**: Replaced time-window header signatures with single-use nonce tracking and strict 60-second request binding to eliminate replay attacks.
  - **Live Acceptance Hardening**: Hardened `scripts/execution-live-acceptance.mts` to require live Arc RPC and real signing keys, strictly rejecting Anvil test keys.

---

## [0.2.0-beta.2] - 2026-08-15

### Security & Hardening
- **P6.1.1 Real Trust-Routed Execution Closure**:
  - Removed all production synthetic execution fallbacks; all production operations now strictly fail closed if live rails or required signing keys are unavailable.
  - Enforced strict database persistence in production; removed in-memory store fallbacks outside explicit test harness mode (`NODE_ENV=test`).
  - Added cryptographic caller authentication and session verification (`authenticateExecutionCaller`) across all execution API endpoints (`/mandates`, `/prepare`, `/[executionId]/execute`, `/autopilot`); cross-wallet access attempts now return 404 to eliminate enumeration risks.
  - Sanitized public and API mandate models (`sanitizeMandate`) to prevent leaking private nonces, internal authorization structures, or signatures.
  - Autopilot mode is now default-off and requires explicit opt-in via `VEYRA_AUTOPILOT_ENABLED=true`.
  - Added intermediate finality states `EVIDENCE_PENDING` and `COMPLETED_UNPROVEN` to decouple onchain economic settlement from downstream evidence indexing and proof anchoring.
  - Integrated real onchain clearance consumption on `VeyraTrustGate`, onchain `IERC8183AgenticCommerce` job creation and offchain independent evaluation, real HTTP 402 challenge/response with paid retries on Arc Testnet, and evidence feedback loop with dynamic reputation snapshot recomputation.
  - Added Live Acceptance test suite (`scripts/execution-live-acceptance.mts`) covering Scenarios A through E.

---

## [0.2.0-beta.1] - 2026-08-15

### Added
- **P6.1 Trust-Routed Execution Engine**: Safe execution infrastructure connecting counterparty selection, trust policy, signed clearance, and multi-rail settlement across ERC-8183 and x402.
- **3 Execution Modes**: `PREVIEW` (read-only preflight check), `PREPARE` (preflight revalidation, EIP-712 clearance issuance, caller-driven settlement), and `AUTOPILOT` (autonomous execution under active mandate).
- **EIP-712 Execution Mandates**: Cryptographically signed owner authorizations enforcing per-transaction, daily, and total USDC spending caps, allowed capabilities, rails, and minimum trust scores.
- **Atomic Budget Reservation**: Row-level locked PostgreSQL stored procedures (`reserve_mandate_budget`, `release_mandate_budget`, `settle_mandate_budget`) preventing overspending race conditions across concurrent agent executions.
- **Deterministic State Machine**: Strict 14-state execution lifecycle validator preventing invalid or premature state transitions.
- **Machine API & SDK Updates**: Added `/api/execution/v1/*` endpoints and full typed `client.execution.*` methods to `@veyra/sdk`.
- **Interactive UI & Verifiable Receipts**:
  - `/trust/mandates`: Dashboard for creating, signing, viewing, and revoking execution mandates.
  - `/execution/[publicId]`: Public execution receipt and cryptographic Arc proof viewer.
- **Comprehensive Test Suites**: Unit tests (`execution:test`), negative/adversarial tests (`execution:negative-test`), and product acceptance tests (`execution:product-test`).

---

## [0.1.0-beta.2] - 2026-08-14

### Security & Maintenance
- **Next.js & ESLint Upgrade**: Upgraded `next` to `^16.3.1` (>= 16.2.11) and `eslint-config-next` to `^16.3.1`, resolving all upstream Next.js framework advisories and PostCSS vulnerabilities.
- **Dependency Audit**: Verified and reduced runtime vulnerabilities in `npm audit --omit=dev`.
- **Contract Documentation**: Documented canonical deployed address `0x1cD66BCd4FCB73a079c05635840Fde029Ce6BEbB` and Arcscan link for `VeyraTrustGate` on Arc Testnet.
- **CI / Release Gate**: Enforced strict branch protection on `main` requiring the Release Verification Suite.

---

## [0.1.0-beta.1] - 2026-08-14

### Added
- **Veyra Trust Stack & Public Hub (`/trust`)**: Unified entry point for verifying agents, selecting counterparties, evaluating transaction preflight policy, and independently evaluating ERC-8183 deliverables.
- **Evidence-Weighted Agent Reputation (ERC-8004)**: Deterministic 0–100 reputation score calculated across 6 dimensions with anti-Sybil protections, temporal decay, and self-rating exclusion.
- **Multi-Criteria Counterparty Selection**: Automated candidate discovery, filtering, and ranking engine with budget and performance constraints.
- **Trust Gate Transaction Preflight & EIP-712 Clearance**: Policy decision gate (`ALLOW`, `ALLOW_WITH_LIMITS`, `REQUIRE_EVALUATOR`, `REVIEW_REQUIRED`, `DENY`) with signed clearance tickets for Arc smart contracts.
- **Independent ERC-8183 Evaluator**: Fail-closed deliverable verification engine issuing cryptographic settlement verdicts.
- **Project 360 & Continuous Trust Monitoring**: Multi-source discovery across GitHub, onchain contracts, and live APIs with delta-tracking watchlists, alerts, and signed webhooks.
- **Veyra Agent API v1 & `@veyra/sdk`**: OpenAPI 3.0 specification (`public/openapi/veyra-agent-api-v1.json`) and typed TypeScript client.
- **Public System Status Endpoint**: Sanitized operational status at `/api/status`.

### Arc Integrations
- **Arc Testnet (Chain ID 5042002)**: Native USDC gas token abstraction and sub-second finality.
- **Smart Contract Suite**:
  - `VeyraTrustGate.sol`: Cryptographic preflight clearance enforcement on Arc.
  - `VeyraERC8183Evaluator.sol`: External evaluator contract for ERC-8183 job settlement.
  - `AgentCommerceProofRegistry.sol`: Onchain proof and execution receipt registry.

### Security
- Comprehensive secret scanner audit and environment variable sanitization.
- Fail-closed evaluation policies on all clearance and evaluator endpoints.
- Reentrancy and replay protections on clearance tickets and execution receipts.

### Known Limitations
- **Arc Testnet Only**: All contracts and payments operate exclusively on Arc Testnet. Real funds must not be used.
- **Unaudited Contracts**: Smart contracts are experimental and have not undergone an independent third-party audit.
- **Provider & RPC Availability**: Workflow execution depends on public Arc Testnet RPC and third-party data providers.
