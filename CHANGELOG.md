# Changelog

All notable changes to the Veyra platform will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0-beta.1] - 2026-09-27

Six weeks and 198 commits after 0.2.0-beta.8. Veyra now has a personal agent,
Nova, in front of its decision engine. It also has its first presence on Arc
mainnet: an ERC-8004 identity and a paid Trust API. Autonomous spending is
frozen, so the owner signs every payment.

### Veyra on Arc mainnet
- **ERC-8004 identity, agentId 298.**
  - Registered on 27 September in Arc's IdentityRegistry
    (`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`), from Veyra's own
    developer-controlled Circle wallet (`0x8F8E0C9Fa2F67AED5b16e04f2716022aeB200eD6`).
  - The agentURI is `/.well-known/agent-registration.json` on Veyra's own
    domain, and the file names the identity back.
  - `npm run veyra-identity` has four steps: `entity-secret`, `wallet`, `check`
    and `register`. The owner runs them, and they never print a credential.
- **The Trust API on Arc mainnet.**
  - `history` costs 0.005 USDC and `select` 0.02 USDC, at `/api/x402/v1/arc/*`.
  - Both are paid only on Arc, through Circle's mainnet Gateway
    (`GatewayWalletBatched`), to Veyra's Circle wallet.
  - Credits earned on testnets are refused there.
  - `select` signs no clearance there, because the TrustGate is on Arc
    Testnet only.
  - The OpenAPI document is at `/openapi/veyra-arc-trust-api.json`. The x402
    catalogue lists both products and names the identity in an `erc8004` field.
- **A paid request is checked before it is settled.** x402 has no refund, so a
  request that cannot be served is refused while it is still unpaid, on every
  rail. On the way, two more faults were fixed:
  - `select` refused its own published `requesterWallet`;
  - the engine's refusals came back as 503 rather than 400.

### Nova, the personal agent
- **The front door creates Nova.**
  - It belongs to the person who made it, who proves ownership with a key
    they keep.
  - It reads official publications, release notes and payment changes against
    the owner's goal and project context.
  - It explains what changed, with source excerpts.
- **A scheduled brief.**
  - It reads Arc first, then Base, with one card per endpoint.
  - It says which chain a price is on.
  - An empty brief says whether it was a quiet day or a failure.
- **Ask Nova.** The owner's question is answered from Arc's and Circle's
  documentation first, at no charge. Only when that does not answer is a tool
  on Arc chosen for the question and priced for the owner to approve.
- **Owner-approved purchases.**
  - They are signed in the owner's own wallet, on Arc mainnet and Base.
  - The first on Arc mainnet settled on 24 September: an Exa search for
    $0.007.
- **Receipts that last**, on Arc Testnet:
  - verified purchases in the proof registry;
  - standing counted from what was bought;
  - an ERC-8004 identity owned by the person.
- **Feedback.** An owner can:
  - rate a card, with reasons;
  - dismiss an announcement as "less of this", and take it back;
  - name what Nova missed;
  - correct the project context a line at a time.
- **Reading.**
  - Readings are grounded in public sources, and a failed reading says which
    step failed.
  - The model reads the whole article.
  - Production reads with deepseek-v4.1-flash.

### Discovery
- **The x402 market on Arc and Base, one record per offer.** On 23 September
  Circle's catalogue listed 482 offers on Arc mainnet. All of them are paid
  through a Gateway deposit.
- **The ERC-8004 registry on Arc mainnet is read daily.** Its x402 offers join
  Circle's in selection and on Nova's cards.
- **Veyra is never its own candidate.** A listing on Veyra's hosts, or paid to
  its wallet, is dropped.

### Decision and payment
- **The decision screen (`/run`):**
  - the user's own wallet pays;
  - Gateway can be funded from the panel;
  - the signature is shown before the wallet asks for it.
- **The verdict is free and the signed clearance is sold.** Reporting an
  outcome earns a credit toward the next one.
- **ERC-8183** has a role-separated lifecycle with real USDC escrow. A live job
  is recorded on Arc Testnet.
- **The decision a payment rests on outlives the request that made it.** The
  relay no longer asks the buyer what Veyra decided.
- **Arc mainnet is in the payment tables.**

### Autonomy
- **The D0 shadow rehearsal.**
  - The owner signed a PREVIEW mandate.
  - Every pass decided a purchase for real and paid for it never.
  - The epoch ended on 22 September, when its mandate expired, and was not
    renewed.
- **Frozen on 26 September, for every user.**
  - `AUTONOMY_FROZEN` is a constant in the code, not a setting.
  - The autopilot route answers 503, and new AUTOPILOT mandates are refused.
  - Owner-approved purchases are unchanged.

### Security
- The payment records and their SECURITY DEFINER functions are closed to
  Supabase's client roles. A release-gate check now keeps every table under
  RLS and every definer function closed.
- The public ledger no longer publishes the signatures that spend it.
- One signature no longer opens every route, and a nonce is checked before it
  is spent.
- A signed sentence names the server it is addressed to.
- The body a signature covers is bound to it.
- Nineteen scripts no longer turn off TLS verification for the whole process.
- A caller can no longer name an address for Veyra's own key to pay.
- A seller's word about its own payment is no longer Veyra's strongest economic
  claim.
- The x402 allowlist checks the whole pair, not each half of it.

### Fixed
- **The execution ledger records purchases.**
  - It had recorded none: every insert named columns that no migration had
    declared, and the failure was swallowed on purpose.
  - It could not record any state after the money left.
- **A lost response** is no longer recorded as proof that nothing was paid.
- **Reconciliation** settles into the budget day the reservation was taken in,
  not the day it happens to run.
- **A Gateway-batched payment** is no longer judged by asking USDC about a nonce
  it never saw. Such a payment used to be recorded as rejected, and later
  released as unused.
- **Two migrations** shared a version, so only one of them would reach a fresh
  database.
- **The release gate** was red for a missing key rather than a bug.

---

## [0.2.0-beta.8] - 2026-08-15

### Security, Cryptographic Authorization Binding & Exact Settlement
- **P6.1.3d x402 Authorization-Bound Settlement Resolution**:
  - **Complete x402 Context Enforcement**: `RealArcSettlementResolver` strictly requires complete canonical context (`payerWallet`, `payTo`, `asset`, `authorizedAmountAtomic`, `authorizationNonce`, `authorizationValidBefore`). Missing context leaves execution safely in `SETTLEMENT_UNVERIFIED`.
  - **Exact Integer Atomic Amount Match**: Replaced floating-point comparisons (`amountUsdc <= maxAllowedUsdc`) with exact base unit matching (`transfer.value === expectedAmountAtomic`, e.g. 10000 = 0.01 USDC).
  - **EIP-3009 Authorization Binding**: Verified transaction corresponds to the exact stored authorization via decoded EIP-3009 calldata (`receiveWithAuthorization` / `transferWithAuthorization`) and/or `AuthorizationUsed` USDC contract event logs matching `authorizer`, `recipient`, `nonce`, and `validBefore`.
  - **Protected Reverted Transactions**: Arbitrary reverted transaction receipts no longer release budget. A revert proves failure only if the reverted transaction is cryptographically bound to the execution's authorization.
  - **Anti-Cheat V6**: Added static analysis regression checks preventing loose amount matching, missing payer fallbacks, and unbound reverted transaction acceptance.

---

## [0.2.0-beta.7] - 2026-08-15

### Security, Settlement Certainty & Decoupled Resolver
- **P6.1.3c Zero Synthetic Reconciliation & Settlement Certainty Closure**:
  - **Zero Magic Test Strings**: Completely eliminated all synthetic transaction string handling (`0xsettled_canonical`, `0xsettled_tx_hash`, `0xreverted_tx`) and placeholder addresses (`0x111111...`) from production reconciliation.
  - **Decoupled `SettlementResolver` Interface**: Introduced `SettlementResolver`, `RealArcSettlementResolver`, and `MockSettlementResolver` in `lib/execution/settlement-resolver.ts` for clean dependency injection in tests without `NODE_ENV` branches in production code.
  - **Strict Transaction Hash Validation**: Validated candidate transaction hashes against `/^0x[0-9a-fA-F]{64}$/` in both resolver and public reconcile API route.
  - **Eliminated Arbitrary Expiry Budget Release**: Removed time-based budget release (`Date.now() - createdAt > 15m`); budget reservations are held until canonical positive or negative proof is established.
  - **Anti-Cheat V5**: Added static analysis regression checks ensuring zero magic strings and zero arbitrary time-based failure releases in execution code.

---

## [0.2.0-beta.6] - 2026-08-15

### Security, Protocol Integrity & Economic Provenance
- **P6.1.3b Canonical x402 Settlement Reconciliation Fix**:
  - **Server-Derived Reconciliation**: Removed client-declared `settled`, `paymentTx`, and `actualSettledAmountUsdc` from `POST /api/execution/v1/[executionId]/reconcile`. Clients cannot declare or forge settlement status.
  - **Onchain & Canonical Source Verification**: `reconcileExecutionSettlement` resolves settlement from canonical sources (x402 facilitator lookup, persisted response context, or Arc Testnet RPC receipt verification matching payer, recipient, Arc USDC asset, and budget bounds).
  - **Reconciliation Context Persistence**: Persisted `x402Context` (payer, recipient, asset, network, authorization nonce/signature/validBefore, resource, paymentRequirementsHash, timestamp) for later authoritative verification.
  - **Verified Failure & Reservation Release**: Budget reservations are released only upon canonical proof that payment authorization expired or failed onchain; otherwise execution remains `SETTLEMENT_UNVERIFIED`.
  - **Economic Provenance Fix**: Corrected reputation evidence buyer address to real buyer wallet (`mandate.ownerWallet` / subject wallet / payer wallet) instead of counterparty wallet, strictly enforcing `buyer != provider` to eliminate self-rating.
  - **Exact-Once Atomic Reconciliation**: Transition from `SETTLEMENT_UNVERIFIED` is atomically guarded (`transitionExecutionAttemptStateAtomic`) to prevent duplicate settlement, double-spend, or race conditions.

---

## [0.2.0-beta.5] - 2026-08-15

### Security, Settlement Finality & Reconciliation
- **P6.1.3a x402 Unverified Settlement Finality Fix**:
  - **Non-Success Unverified Settlement**: When `PAYMENT-RESPONSE` is missing or cannot be decoded, `X402ExecutionAdapter` strictly returns `success: false`, `economicCommitted: true`, `economicSettled: false`, `actualSettledAmountUsdc: 0`, and `failureCode: PAYMENT_SETTLEMENT_UNVERIFIED`.
  - **Explicit `SETTLEMENT_UNVERIFIED` State**: Added dedicated non-terminal execution state `SETTLEMENT_UNVERIFIED` to prevent premature completion or improper failure mapping when service succeeds before settlement proof arrives.
  - **Conservative Budget Accounting**: Budget reservations are strictly held and never released automatically or marked as confirmed spent while settlement is unverified.
  - **Reputation Evidence Guard**: Guaranteed zero positive or negative reputation feedback ingestion until settlement outcome is authoritatively verified.
  - **Settlement Reconciliation**: Added `reconcileExecutionSettlement` engine logic and authenticated `POST /api/execution/v1/[executionId]/reconcile` endpoint supporting exact-once budget settlement or reservation release upon canonical confirmation.
  - **UI Status Badge**: Added dedicated amber `SETTLEMENT UNVERIFIED` badge in `/executions` audit log.

---

## [0.2.0-beta.4] - 2026-08-15

### Security, Integrity & UX
- **P6.1.3 Real Rail Verification & Execution UX Closure**:
  - **Official x402 V2 Protocol Compliance**: Integrated `@x402/core` (`x402Client`, `x402HTTPClient`) and `@x402/evm` (`ExactEvmScheme`) for cryptographic payment authorization on Arc Testnet; parsed `accepts[]` payment options; removed synthetic fallback transaction hashes (`PAYMENT_SETTLEMENT_UNVERIFIED` fail-closed when payment-response header is missing).
  - **Real ERC-8183 Provider Lifecycle**: Introduced `WAITING_FOR_PROVIDER` execution state; eliminated provider deliverable impersonation; created `POST /api/execution/v1/[executionId]/provider-submission` endpoint with cryptographic provider wallet signature verification; derived settlement amounts from verified chain event logs.
  - **Deterministic Reputation Snapshots & Real Proof Values**: Replaced `Math.random()` and `Date.now()` snapshot ID mutations with deterministic keccak256 computation; eliminated fake 0.01 economic proof value fallbacks; added onchain `ProofRegistry.isRegistered` receipt status verification.
  - **Strict Live Acceptance Suite**: Measured before/after balance and spend deltas across Scenarios A through E; verified real provider lifecycle in Scenario B; invoked real `X402ExecutionAdapter` in Scenario C when configured; verified zero economic side-effects on policy violations.
  - **Execution UX & Navigation**: Added dedicated "Execute" sidebar section; created `/executions` public audit explorer with status badges and search; updated `/trust/mandates` copy to canonical specification; added "Authorize & Execute" card to homepage.
  - **Trust UX Semantics & Label Accuracy**: Implemented deterministic `getTrustDisplayLabel` function preventing misleading "Highly Trusted" claims when evidence or confidence is insufficient; improved Trust Gate CTA contrast and added "Try Example" demo button; replaced "Featured Production Evaluator" with "Veyra Arc Testnet Evaluator"; updated x402 badge to "x402 Enabled".
  - **Anti-Cheat V4 & Extended Test Suite**: Added automated static analysis and regression checks in `execution:product-test` verifying zero synthetic hashes, fake deliverables, or fabricated values; updated public beta release gate.

---

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
