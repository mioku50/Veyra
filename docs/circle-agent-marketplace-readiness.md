# Circle & Arc Ecosystem Compatibility Review

This document assesses Veyra's current readiness and architectural alignment with Circle and Arc developer standards, specifically evaluating compatibility for potential future listing in the Circle Agent Marketplace.

---

## 1. What Veyra Currently Satisfies

| Dimension | Status | Implementation Details |
| :--- | :---: | :--- |
| **Arc Testnet Native Gas** | :white_check_mark: | Deployed on Arc Testnet (`5042002`). Transactions use native USDC gas. |
| **x402 Micropayments** | :white_check_mark: | Full HTTP 402 payment flow with immutable upfront quotes and receipt verification. |
| **OpenAPI 3.0 Specification** | :white_check_mark: | Published at `public/openapi/veyra-agent-api-v1.json` with documented endpoints. |
| **ERC-8004 Identity & Validation** | :white_check_mark: | Integration with Arc Testnet ERC-8004 identity and reputation registries. |
| **ERC-8183 Independent Evaluation** | :white_check_mark: | Standardized evaluation bridge with EIP-712 signed verdicts for job release. |
| **Payout Wallet Model** | :white_check_mark: | Project-owned hosted payer and seller settlement accounts on Arc. |
| **Idempotency & Rate Limiting** | :white_check_mark: | Strict `Idempotency-Key` tracking and replay protection on paid runs. |

---

## 2. x402-Compatible Endpoints

The following Veyra endpoints support programmatic invocation and micro-settlement via x402:

- **Agent Trust Report**: `POST /api/agent/v1/quotes` & `POST /api/agent/v1/runs` (`agent_trust_report`)
- **GitHub Project Due Diligence**: `POST /api/agent/v1/quotes` & `POST /api/agent/v1/runs` (`github_due_diligence`)
- **Project 360 Full Analysis**: `POST /api/agent/v1/project-360/discoveries/{discoveryId}/quote`
- **Trust Decision Evaluation**: `POST /api/trust/v1/decisions`
- **Counterparty Selection**: `POST /api/trust/v1/counterparties/select`
- **ERC-8183 Evaluation**: `POST /api/erc8183/v1/evaluations`

---

## 3. Canonical Candidate Service for Circle Marketplace

As identified in P6.0 scope, the primary candidate for initial Circle Agent Marketplace indexing is:

- **Service Name**: `Veyra Agent Trust & Reputation Check`
- **Endpoint**: `GET /api/reputation/v1/agents/{agentId}` / `POST /api/trust/v1/decisions`
- **Pricing**: Micro-fee in USDC (e.g. 0.0004–0.002 USDC)
- **Response**: Structured JSON containing trust score (0–100), coverage %, 6-dimension breakdown, risk signals, and Arc proof hashes.

---

## 4. Remaining Requirements for Circle Agent Marketplace Listing

Before pursuing formal listing submission in post-beta phases (P6.1+):

1. **Production / Mainnet Deployment**: Deploy canonical contracts to Arc Mainnet once Arc Mainnet is live.
2. **Third-Party Security Audit**: Complete independent security audits of `VeyraTrustGate.sol` and `VeyraERC8183Evaluator.sol`.
3. **Automated Payout Splitting**: Implement Circle Developer-Controlled Wallets for automated vendor revenue distributions where multi-party sellers are involved.
4. **Marketplace Metadata Registration**: Register Veyra service manifests according to the finalized Circle Agent Marketplace schema.
