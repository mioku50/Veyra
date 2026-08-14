# Changelog

All notable changes to the Veyra platform will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
