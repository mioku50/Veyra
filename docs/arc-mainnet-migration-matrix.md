# Veyra — Arc Mainnet Migration Matrix

**Generated**: 2026-09-16  
**Basis**: Source code audit + live Arc Testnet chain reads  
**Scope**: Every hardcoded Testnet assumption, classified by change type and system boundary  
**Convention**: `BLOCKED` = value requires official Arc documentation before it can be written

---

## How to read this document

Each finding carries:
- **File / path** — exact file as it exists in the repository
- **Current Testnet assumption** — the literal value, identifier or pattern that is Testnet-specific today
- **Required Mainnet abstraction** — the correct future form (env var, config object, or removal)
- **System boundary** — which layer(s) the change touches: Contract state · DB state · Server API · Wallet behavior · UI

---

## Section 1 — Chain identity constants

These are the files that define what "Arc" means to every other layer. They are the root of the blast radius.

| # | File | Current Testnet assumption | Required Mainnet abstraction | Boundary |
|---|------|---------------------------|------------------------------|----------|
| C-1 | `lib/wallet/arc.ts` | `ARC_TESTNET_CHAIN_ID = 5_042_002`; `arcTestnetChain` (viem `defineChain`, `testnet: true`); hardcoded RPC `https://rpc.testnet.arc.network`; explorer `https://testnet.arcscan.app`; `name: "Arc Testnet"` | Replace with a `getArcChain(network: "testnet" \| "mainnet")` factory that reads chain ID, RPC, explorer from env. `testnet: false` on mainnet object. The `arcTestnet` export must not be imported directly by wallet clients — they import the factory result. | Server API · Wallet behavior · UI |
| C-2 | `lib/x402/usdc-assets.ts` | `USDC_BY_CHAIN_ID` has `5042002: "0x3600000000000000000000000000000000000000"` but **no mainnet Arc entry**. An unknown chain is explicitly unquotable. | Add `<ARC_MAINNET_CHAIN_ID>: "<ARC_MAINNET_USDC_ADDRESS>"` once Arc publishes the canonical mainnet chain ID and USDC address. Until then this entry is **BLOCKED**. | Server API |
| C-3 | `lib/execution/adapters/erc8183-lifecycle.ts` | `export const ARC_CHAIN_ID = 5_042_002` (used in `describePendingAction`, exported to callers) | Replace with `process.env.NEXT_PUBLIC_ARC_CHAIN_ID` parsed to number; keep constant only as a compile-time fallback for the Testnet build. | Server API · Wallet behavior |
| C-4 | `lib/execution/settlement-resolver.ts` | `chainForNetwork` maps `"arc-testnet"` / `"eip155:5042002"` → `arcTestnet`; no `"arc"` / `"eip155:<mainnet-id>"` branch. Absence means mainnet settlements cannot be looked up. | Add `"arc"`, `"arc-mainnet"`, `"eip155:<MAINNET_ID>"` cases mapping to an `arcMainnet` viem chain object. **BLOCKED** on mainnet chain ID. | Server API |
| C-5 | `lib/seller/external-fulfillment.ts` | `ARC_TESTNET_NETWORK = "eip155:5042002"` as the only accepted network for external sellers; `ARC_TESTNET_GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9"` hardcoded | Both must become env-var-driven. Gateway Wallet address on mainnet is **BLOCKED**. | Server API · Wallet behavior |
| C-6 | `lib/agent/execution.ts` | `TARGET_NETWORK = "Arc Testnet (chain ID 5042002)"` (string used in log/error messages) | Replace with a network label derived from `NEXT_PUBLIC_ARC_CHAIN_ID`. | Server API |
| C-7 | `lib/commerce/onchain-proof.ts` | `rpcUrl()` falls back to `arcTestnet.rpcUrls.default.http[0]`; diagnostic reports `ARC_TESTNET_CHAIN_ID` literally; `ARC_TESTNET_EXPLORER_URL` hardcoded as fallback for explorer links | `rpcUrl()` fallback → env `ARC_RPC_URL`; diagnostic chain ID → env-derived; explorer fallback → env `ARC_EXPLORER_URL`. | Server API · UI |

---

## Section 2 — ERC-8004 identity registry addresses

| # | File | Current Testnet assumption | Required Mainnet abstraction | Boundary |
|---|------|---------------------------|------------------------------|----------|
| I-1 | `lib/erc8004/types.ts` | `ARC_ERC8004_IDENTITY_REGISTRY = "0x8004A818…"` exported as a module constant | Move to env `NEXT_PUBLIC_ARC_ERC8004_IDENTITY_REGISTRY`. No env-override path exists today — it must be added. Mainnet address is **BLOCKED**. | Server API · Contract state |
| I-2 | `lib/erc8004/types.ts` | `ARC_ERC8004_REPUTATION_REGISTRY = "0x8004B663…"` | Same pattern as I-1. Mainnet address is **BLOCKED**. | Server API · Contract state |
| I-3 | `lib/erc8004/types.ts` | `ARC_ERC8004_VALIDATION_REGISTRY = "0x8004Cb1B…"` | Same pattern as I-1. Mainnet address is **BLOCKED**. | Server API · Contract state |
| I-4 | `lib/erc8004/client.ts:128` | `dbRecord.chain_id !== arcTestnet.id` — identity verification hard-rejects any record whose stored `chain_id` does not equal the Testnet ID | Replace `arcTestnet.id` with the configured chain ID. On a dual-network deployment this check must be scoped per-record, not globally. | Server API · DB state |
| I-5 | `app/api/erc8004/v1/readiness/route.ts` | `chainId === 5042002` guard; `evaluatorAddress` hardcoded `"0x0d2c04580e…"`; `network: "arc-testnet"` in JSON response | Chain ID from env; evaluator from env (already has override path); response `network` field from env-derived label. | Server API |
| I-6 | `lib/byoa/service.ts:1099–1162` | Three ERC-8004 registry addresses hardcoded in capability manifest builder; `network: "Arc Testnet"`, `chainId: 5042002` | All five values from env. The manifest is the published machine-readable identity document; it must name the chain it is live on. | Server API |
| I-7 | `app/.well-known/veyra-agent.json/route.ts` | `reputationRegistry` and `validationRegistry` hardcoded; `network: "arc-testnet"`, `chainId: 5042002` | Same env migration as I-6. This endpoint is what the Arc registry resolves. | Server API |
| I-8 | `app/api/erc8004/v1/agent/route.ts` | Same three addresses; `network: "arc-testnet"`, `chainId: 5042002`, `baseUrl` falls back to `"https://agent-commerce-six.vercel.app"` | All from env. The hardcoded `baseUrl` fallback must change. | Server API |

---

## Section 3 — ERC-8183 contract addresses

| # | File | Current Testnet assumption | Required Mainnet abstraction | Boundary |
|---|------|---------------------------|------------------------------|----------|
| E-1 | `lib/execution/adapters/erc8183-lifecycle.ts` | `DEFAULT_AGENTIC_COMMERCE = "0x0747EEf0…"` and `DEFAULT_EVALUATOR_CONTRACT = "0x0d2c0458…"` as module-level fallbacks | Already have env-override paths (`NEXT_PUBLIC_ERC8183_CONTRACT_ADDRESS`, `NEXT_PUBLIC_VEYRA_ERC8183_EVALUATOR_ADDRESS`). The hardcoded defaults must be cleared (or replaced with `""`) so an absent env var fails loudly instead of silently hitting the Testnet contract. Mainnet addresses require redeployment — see Section 8. | Contract state · Wallet behavior |
| E-2 | `app/api/erc8183/v1/evaluations/route.ts` | `if (chainId !== 5042002) → "Only Arc Testnet … supported"` — hard rejection | Replace with `if (chainId !== configuredChainId()) →` to accept mainnet chain ID once configured. | Server API |
| E-3 | `lib/execution/revalidation.ts` | Hardcoded fallback `"0x0d2c04580e081e222bbe5bf9818af337e2633eb7"` for evaluator | Must fall back to env only, never to a literal address. | Server API |
| E-4 | `app/api/erc8183/v1/evaluator/route.ts` | Same two address fallbacks; `network: "arc-testnet"`, `chainId: 5042002` | From env. | Server API |
| E-5 | `app/console/erc8183/page.tsx` | Same commerce address fallback; hardcoded example content hash contains `0x3600…` (USDC address visually reused as hash placeholder) | Address from env; example hash is a display concern — acceptable to leave as-is if clearly labeled "example". | UI |

---

## Section 4 — Veyra protocol contract addresses (own deployments)

| # | File | Current Testnet assumption | Required Mainnet abstraction | Boundary |
|---|------|---------------------------|------------------------------|----------|
| V-1 | `lib/trust-gate/address.ts` | `DEFAULT_VEYRA_TRUST_GATE_ADDRESS = "0x6C702E51…"` as module default; env-override path exists (`VEYRA_TRUST_GATE_ADDRESS` / `NEXT_PUBLIC_VEYRA_TRUST_GATE_ADDRESS`) | Clear the hardcoded default. Mainnet deployment required (new address, new attester key). The EIP-712 domain name `"Veyra Trust Gate"` and version `"1"` are in the contract constructor and **cannot be changed without redeployment**. | Contract state · Wallet behavior |
| V-2 | `lib/commerce/onchain-proof.ts` | `configuredRegistryAddress()` reads `AGENT_COMMERCE_PROOF_REGISTRY_ADDRESS` with no default — this is correct. But the constant `ARC_TESTNET_EXPLORER_URL` is still the hardcoded Testnet explorer. | Explorer URL from env only. Registry address env var name is fine — just requires a mainnet value. | Server API |
| V-3 | `lib/execution/executor.ts:466` | `chainId: 5042002 as const` hardcoded inside `agentIdentity` object passed to reputation computation | Read from env-derived constant, not literal. | Server API |
| V-4 | `lib/execution/executor.ts:481–495` | `"Publish to AgentCommerceProofRegistry on Arc Testnet"` comment; `publicClient = createPublicClient({ chain: arcTestnet, ... })` without RPC override in this call site | Comment stays accurate if network label is derived. `publicClient` creation must use the configured chain object and RPC URL. | Server API · Contract state |

---

## Section 5 — USDC / native gas assumptions

| # | File | Current Testnet assumption | Required Mainnet abstraction | Boundary |
|---|------|---------------------------|------------------------------|----------|
| U-1 | `lib/execution/adapters/erc8183-lifecycle.ts` | `ARC_USDC_ADDRESS = "0x3600000000000000000000000000000000000000"` used for ERC-20 `approve` and `allowance` calls | Read from env `NEXT_PUBLIC_ARC_USDC_ADDRESS`. The address `0x3600…` is unique to Arc Testnet. Mainnet USDC address is **BLOCKED**. | Contract state · Wallet behavior |
| U-2 | `lib/execution/settlement-resolver.ts` | `ARC_USDC_CONTRACT = "0x3600…"` used as expected payment asset | Same — env. | Server API |
| U-3 | `lib/byoa/x402-client.ts` | `asset: "0x3600…"` hardcoded in payment authorization construction | Env. | Wallet behavior |
| U-4 | `lib/x402.ts`, `lib/agent/execution.ts`, `lib/seller/external-fulfillment.ts` | Multiple `ARC_TESTNET_USDC = "0x3600…"` constants | All must read from env via a single `arcUsdcAddress()` utility rather than N independent constants. | Server API · Wallet behavior |
| U-5 | `app/api/seller/services/validation.ts:247–251` | Hard-rejects `expectedNetwork !== "eip155:5042002"` and `expectedAsset !== "0x3600…"` | Both checks must compare against configured values, not literals. This is a blocking validator — an Arc Mainnet seller service will fail onboarding until this is updated. | Server API |
| U-6 | `app/api/seller-workflows/execute/[serviceId]/versions/[version]/route.ts` | `expectedNetwork: "eip155:5042002"`, `expectedAsset: "0x3600…"` | From env. | Server API |
| U-7 | `lib/wallet/arc.ts` | `nativeCurrency.decimals = 18` on the `arcTestnetChain` definition — this is the native gas view (18 dec); the ERC-20 view is 6 dec. The distinction is correct but documented inline, not enforced. | Mainnet must declare the same dual-decimal structure. Confirm with Arc that native gas token decimals on mainnet are also 18. Until confirmed: **BLOCKED**. | Wallet behavior |

---

## Section 6 — x402 / payment rail

| # | File | Current Testnet assumption | Required Mainnet abstraction | Boundary |
|---|------|---------------------------|------------------------------|----------|
| X-1 | `lib/execution/settlement-resolver.ts` | `chainForNetwork` maps only `"arc-testnet"` / `"eip155:5042002"` to an Arc chain object. An x402 payment on mainnet would return `null` and stay permanently unresolved. | Add mainnet Arc mapping. **BLOCKED** on mainnet chain ID. | Server API |
| X-2 | `lib/counterparty-selection/marketplace-source.ts` | x402 catalogue probed at Circle's marketplace endpoint; network filter built around known chain IDs including `"eip155:130"` (Unichain). Arc Mainnet is absent from the probed network list. | Add Arc Mainnet network key once ID is known. | Server API |
| X-3 | Multiple API routes (`app/api/agent/v1/quotes/route.ts`, `reports/[reportId]/route.ts`, etc.) | `network: "arc-testnet"` emitted as machine-readable string in 9+ API response fields | Each must emit a network value derived from the current deployment's env configuration. These strings appear in downstream agent tooling. | Server API |
| X-4 | `app/api/execution/v1/mandates/route.ts` and `activate/route.ts` | Default `network = "eip155:5042002"` in mandate creation | Default from env. | Server API · Wallet behavior |

---

## Section 7 — viem/chains `arcTestnet` import coupling

Twenty-three source files import `arcTestnet` from `viem/chains` directly (confirmed by grep). `viem/chains.arcTestnet` resolves to the Testnet chain object at the library level. On mainnet these callers would need `arcMainnet` — which may not yet exist as a named viem export.

| # | Files (representative) | Current assumption | Required abstraction |
|---|------------------------|-------------------|----------------------|
| VL-1 | `lib/erc8183/client.ts`, `lib/erc8183/evaluator.ts`, `lib/erc8183/client-transactions.ts` | `chain: arcTestnet` passed to `createWalletClient` / `createPublicClient` | Import from a single project-internal `@/lib/arc-chain` module that returns the configured chain object. | 
| VL-2 | `lib/agent-trust/contract.ts`, `lib/commerce/onchain-proof.ts`, `lib/counterparty-selection/proof.ts` | Same | Same |
| VL-3 | `lib/execution/adapters/erc8183-lifecycle.ts`, `lib/execution/adapters/erc8183.ts`, `lib/execution/adapters/x402.ts`, `lib/execution/executor.ts` | Same | Same |
| VL-4 | `app/api/erc8004/v1/validations/respond/route.ts`, `app/evaluators/erc8183/page.tsx` | Same | Same |
| VL-5 | `lib/execution/settlement-resolver.ts` | `arcTestnet.id` used in conditional branch | `configuredChainId()` |

The abstraction is one file: `lib/arc-chain.ts` exporting `getArcChain()`. All 23 import sites become a one-line change each.

---

## Section 8 — Contract redeployment requirements

All three Veyra-owned contracts are non-upgradeable. Their onchain state is Testnet state. Nothing migrates.

| Contract | Testnet address (confirmed live) | What is stored onchain today | Mainnet requirement |
|----------|----------------------------------|------------------------------|---------------------|
| `AgentCommerceProofRegistry` | `0x92dC1aFC126F755ba5d5254e8D697CAe10474851` | operator = `0x7cE65e573463B83164FFc282a0556D5542defefA`; attester ≠ operator (confirmed by `isAttester(operator) = false`). Proof registry function (`isRegistered`) returns false for test ID — no proofs readable with a random key, consistent with an active system. | Fresh deploy with new operator, new attester. New env var `AGENT_COMMERCE_PROOF_REGISTRY_ADDRESS`. Requires independent security audit before mainnet. |
| `VeyraTrustGate` | `0x6C702E51B328De51621f48483f6587fb2665efAf` | EIP-712 domain `"Veyra Trust Gate"` version `"1"`. `TRUST_ATTESTER_ROLE` confirmed. Admin role holder not confirmed (public `hasRole` probe of operator address returned false — admin is a different address). Superseded gate `0x1cD66BCd…` still live but unused. | Fresh deploy. EIP-712 domain name and version are baked in; any change requires a new deploy anyway. New attester key (never reuse Testnet key on mainnet). |
| `VeyraERC8183Evaluator` | `0x0d2c04580e081e222bbe5bf9818af337e2633eb7` | `SUPPORTED_POLICY_HASH = 0x934fe61b6a78c1746d27381ff92721cc4c364c2e08b56d17c45ba0e1b0828f6c`; `paused = false`; AgenticCommerce `0x0747EEf0…` is whitelisted. `SUPPORTED_POLICY_HASH` is `immutable` — cannot change without redeployment. | Fresh deploy. If the policy hash is the same (`computePolicyHash` is deterministic), the same hash can be passed to the constructor. If Arc Mainnet ships a different `AgenticCommerce` address, that address must be whitelisted via `setSupportedCommerce`. |

The Arc Ecosystem standard contracts (`AgenticCommerce 0x0747EEf0…`, ERC-8004 registries `0x8004A818…`, `0x8004B663…`, `0x8004Cb1B…`) are owned and operated by Arc. Their mainnet addresses are **BLOCKED** pending official Arc publication.

---

## Section 9 — Database state (Supabase migrations)

| # | Migration file | Current assumption | Impact |
|---|----------------|--------------------|--------|
| DB-1 | `20260720120100_user_paid_hosted_workflows.sql` | `chain_id bigint NOT NULL DEFAULT 5042002 CHECK (chain_id = 5042002)` on `hosted_checkouts` and payment tables | The `CHECK` constraint hard-rejects mainnet chain IDs at the DB layer. A new migration must either drop the constraint and replace it with an allowlist, or add a mainnet-scoped parallel table. Existing Testnet rows must never be relabelled. |
| DB-2 | `20260722120000_phase28_bring_your_own_agent.sql` | Same `chain_id DEFAULT 5042002 CHECK (chain_id = 5042002)` on BYOA agent table; `network CHECK (network = 'eip155:5042002')` | Same as DB-1. |
| DB-3 | `20260807000000_p50_erc8183_evaluator.sql` | `chain_id DEFAULT 5042002`; unique constraint `(chain_id, agentic_commerce, job_id)` | Unique constraint scopes jobs per chain — this is correct design. Migration needed to lift the `DEFAULT` and `CHECK`. |
| DB-4 | `20260807120000_p52_erc8004_bridge.sql` | `chain_id DEFAULT 5042002` on ERC-8004 validation links | Same migration pattern. |
| DB-5 | `20260727160000_p21_external_seller_marketplace.sql` | `expected_network CHECK (expected_network = 'eip155:5042002')` on store services | Constraint must be relaxed to accept mainnet. Existing Testnet service records remain valid. |
| DB-6 | `20260721120000_phase272_seller_security_closure.sql` | Same `expected_network` constraint | Same. |
| DB-7 | `app/api/internal/reputation/proofs/route.ts:86` | `.eq("chain_id", 5042002)` hardcoded in server query | Must read from configured chain ID, or query must be scoped by `chain_id` coming from the evaluation record itself. |

---

## Section 10 — Explorer URL hardcoding (UI)

| # | File | Hardcoded value | Abstraction |
|---|------|-----------------|-------------|
| UI-1 | `app/dashboard/page.tsx:67` | `const EXPLORER_BASE = "https://testnet.arcscan.app"` — file-local constant | Replace with `configuredExplorerUrl()` from `lib/commerce/onchain-proof.ts` (already exists and reads from env). |
| UI-2 | `app/api/agent/v1/reports/[reportId]/route.ts:86,312` | `https://testnet.arcscan.app/tx/${proof.transactionHash}` string template | `${configuredExplorerUrl()}/tx/${...}` |
| UI-3 | `app/api/erc8004/v1/validations/respond/route.ts:307` | `arcscanUrl: \`https://testnet.arcscan.app/tx/${txHash}\`` | Same. |
| UI-4 | `app/evaluations/[publicId]/page.tsx:105`, `app/executions/page.tsx:171,349`, `app/run/run-client.tsx:974` | `testnet.arcscan.app` in `<a href>` attributes | All must read explorer base from env/config. |
| UI-5 | `app/agents/veyra/page.tsx:158,170,182` | `testnet.arcscan.app/address/…` | Same. |
| UI-6 | `app/nova/nova-client.tsx:1521` | `testnet.arcscan.app/address/…` | Same. |
| UI-7 | `lib/monitoring/service.ts:1254,1275` | `testnet.arcscan.app/tx/…` | Same. |
| UI-8 | `lib/counterparty-selection/proof.ts` | `testnet.arcscan.app` in proof publication | Same. |
| UI-9 | `components/dashboard/withdraw-dialog.tsx:44` | `"arcTestnet": "https://testnet.arcscan.io/tx/"` — note different domain (`arcscan.io` vs `arcscan.app`) | Confirm canonical explorer domain with Arc, then unify behind one env var. |
| UI-10 | `app/agents/veyra/page.tsx:104` | `Arc Testnet (5042002)` as a visible chip | Must become `{networkLabel} ({chainId})` from env. |
| UI-11 | `app/agents/veyra/page.tsx:150` | `"Identity NFT token on Arc Testnet"` | Network label from env. |
| UI-12 | `app/agent-launch/agent-launch-client.tsx:203,252,321,359,396,561,588` | Eight references to "Arc Testnet" in error messages and labels | All from env-derived network label. |
| UI-13 | `app/console/erc8183/page.tsx:77,111,148` | `chainId: 5042002`, `"Arc Testnet"`, `"Chain ID: 5042002"` | From env. |
| UI-14 | Multiple console badge components | `<Badge>Arc Testnet · chain 5042002</Badge>` pattern in ~8 files | Network label from env. |

---

## Section 11 — Environment variables requiring new mainnet values

The following env vars exist and have an override path. They need a new value for mainnet — no code change required in most cases, only a new deployment configuration.

| Env var | Testnet value currently used | Mainnet requirement |
|---------|------------------------------|---------------------|
| `NEXT_PUBLIC_ARC_CHAIN_ID` | `5042002` | **BLOCKED** — official Arc Mainnet chain ID |
| `ARC_TESTNET_RPC_URL` / `ARC_RPC_URL` | `https://rpc.testnet.arc.network` | **BLOCKED** — official Arc Mainnet RPC endpoint |
| `NEXT_PUBLIC_ARC_EXPLORER_URL` | `https://testnet.arcscan.app` | **BLOCKED** — official Arc Mainnet explorer URL |
| `VEYRA_TRUST_GATE_ADDRESS` / `NEXT_PUBLIC_VEYRA_TRUST_GATE_ADDRESS` | `0x6C702E51…` | New deployment address — requires deploy first |
| `NEXT_PUBLIC_VEYRA_ERC8183_EVALUATOR_ADDRESS` | `0x0d2c0458…` | New deployment address |
| `NEXT_PUBLIC_ARC_ERC8183_COMMERCE_ADDRESS` | `0x0747EEf0…` | **BLOCKED** — Arc Mainnet `AgenticCommerce` address |
| `NEXT_PUBLIC_VEYRA_PROOF_REGISTRY_ADDRESS` / `AGENT_COMMERCE_PROOF_REGISTRY_ADDRESS` | `0x92dC1aFC…` | New deployment address |
| `NEXT_PUBLIC_APP_URL` | Falls back to `https://agent-commerce-six.vercel.app` | Mainnet deployment URL |
| `ERC8183_CLIENT_PRIVATE_KEY` / `BUYER_PRIVATE_KEY` | Testnet key | New mainnet wallet (never reuse Testnet keys on mainnet) |
| `ERC8183_EVALUATOR_ATTESTER_PRIVATE_KEY` | Testnet attester key | New mainnet attester |
| `ERC8183_EVALUATOR_RELAYER_PRIVATE_KEY` | Testnet relayer key | New mainnet relayer |
| `AGENT_COMMERCE_PROOF_ATTESTER_PRIVATE_KEY` | Testnet proof attester | New mainnet attester |
| `VEYRA_TRUST_ATTESTER_PRIVATE_KEY` | Testnet trust attester | New mainnet trust attester |

The following env vars exist in code but are **missing from `.env.example`** and have no current default override path — they must be added to the env var surface as part of mainnet prep:

- `NEXT_PUBLIC_ARC_USDC_ADDRESS` — does not exist yet; needed for U-1 to U-4
- `NEXT_PUBLIC_ARC_ERC8004_IDENTITY_REGISTRY` — does not exist yet; needed for I-1
- `NEXT_PUBLIC_ARC_ERC8004_REPUTATION_REGISTRY` — does not exist yet; needed for I-2
- `NEXT_PUBLIC_ARC_ERC8004_VALIDATION_REGISTRY` — does not exist yet; needed for I-3

---

## Section 12 — Dual-network data semantics

This section does not describe code changes. It describes the semantic model that governs data integrity across both networks.

### 12.1 Nova product identity vs ERC-8004 identity

These are two separate concepts that happen to be linked on Testnet:

- **Nova product identity** is a row in Veyra's Supabase database. It is created when a user completes the "create your agent" flow. It has no chain dependency. It is portable.
- **ERC-8004 identity** is an NFT token minted on a specific chain. It is an assertion, made by the identity registry on that chain, that a specific wallet owns a specific agent ID at a specific registry address.

The link (`nova_agents.arc_identity_chain_id`, `nova_agents.arc_identity_token_id`, `nova_agents.arc_identity_registry`) is chain-scoped. On Testnet today, Veyra's Testnet ERC-8004 agent ID (`getCanonicalVeyraAgentIdentity`) is what gets validated against. A Mainnet ERC-8004 identity is a completely separate NFT with a different token ID on a different registry at a different chain ID. **It is not the same identity.** The Testnet identity record is not "upgraded" — it stays as a Testnet record. Mainnet identity requires a new minting transaction on the mainnet registry.

### 12.2 Testnet agentId vs Mainnet agentId

ERC-8004 agent IDs are integer token IDs assigned by the registry contract at mint time. The same agent cannot hold the same token ID on both networks unless two independent registries happen to issue the same integer in the same sequence, which cannot be relied upon. Any code that stores `agent_id` without also storing `chain_id` and `registry_address` will conflate Testnet and Mainnet identities. Confirmed from code: `erc8004_identity_records` stores `chain_id`, `registry_address`, and `agent_id` together — the schema is correct. The application-layer verification in `lib/erc8004/client.ts` checks `chain_id === arcTestnet.id` — this check must be parameterized (see I-4).

### 12.3 Testnet proofs vs Mainnet proofs

`AgentCommerceProofRegistry` stores a `Proof` struct containing `buyer`, `seller`, `amount`, `requestHash`, `responseHash`, and `timestamp`. The contract has no chain identifier in its storage — it is an address on a chain, and the chain is implicit. A proof from the Testnet registry is a fact about a Testnet transaction between Testnet wallets at a Testnet USDC address. A proof from the Mainnet registry will be a fact about a Mainnet transaction. They are different facts. The Veyra database table `agent_commerce_proofs` stores `transaction_hash` and links to `agent_passport_id`. It does not today store a `chain_id` on the proof row itself (confirmed from `20260717190000_add_onchain_proof_metadata.sql` — adds `onchain_chain_id bigint` but does not enforce it). Before mainnet, every proof row must carry a `chain_id` and the display layer must never show Testnet proof transactions as Mainnet history.

### 12.4 Chain-scoped standing and reputation

The reputation system computes `trustScore`, `confidence`, and `canonicalHash` from evidence. Evidence is sourced from ERC-8183 jobs and x402 transactions on Arc. All three are chain-specific. A reputation snapshot on Testnet is provably unrelated to standing on Mainnet. The existing DB schema stores `chain_id` on evaluation records (ERC-8183 jobs), which is correct. The query in `app/api/internal/reputation/proofs/route.ts` already filters `.eq("chain_id", 5042002)` — but that literal must become a configured constant, and if Veyra operates on both networks simultaneously the reputation API must accept and scope by `chainId` rather than assuming a single global chain.

### 12.5 Preserving all historical Testnet links

The Testnet deployment (`agent-commerce-six.vercel.app`) is the live product. Its decision history, reputation records, proof hashes, Arcscan transaction links, and ERC-8004 validation records are public. The requirement is:

1. The Testnet deployment must remain accessible and its data intact. It is not shut down when Mainnet launches — it becomes the public beta and historical record.
2. Testnet Arcscan links (`testnet.arcscan.app/tx/…`) must remain valid. No data rewriting.
3. API responses that today emit `"network": "arc-testnet"` will continue to be accurate for Testnet-era records. Mainnet-era records emit a different network string.
4. A Mainnet deployment is a distinct Vercel project (or deployment target) with its own `.env`. It is not a configuration swap on the existing deployment.
5. Agent pages that show both Testnet history and (future) Mainnet history must label each record by chain. Showing Testnet proof transactions on a Mainnet agent profile as if they are Mainnet proofs would be a factual error.

---

## Section 13 — Suggested migration order

This order preserves Testnet continuity at every step and gates each phase on the previous one being verified.

```
Phase 0  PREREQUISITE
  └── Independent security audit of all three Solidity contracts
       (stated as required in contracts' own NatSpec and AGENTS.md invariant)
       Nothing else begins until audit findings are resolved.

Phase 1  WAIT FOR OFFICIAL ARC MAINNET FACTS
  └── Obtain from Arc official documentation:
        - Arc Mainnet chain ID                           [BLOCKED]
        - Arc Mainnet RPC endpoint                       [BLOCKED]
        - Arc Mainnet explorer URL                       [BLOCKED]
        - Arc Mainnet USDC ERC-20 address                [BLOCKED]
        - Arc Mainnet AgenticCommerce address            [BLOCKED]
        - Arc Mainnet ERC-8004 registry addresses (x3)  [BLOCKED]
        - Arc Mainnet Gateway Wallet address             [BLOCKED]
        - Confirm native gas token decimals on mainnet   [BLOCKED]

Phase 2  CODE ABSTRACTIONS (no mainnet values yet)
  ├── Create lib/arc-chain.ts factory (replaces all arcTestnet imports)
  ├── Create arcUsdcAddress() utility (replaces N independent constants)
  ├── Add env vars for ERC-8004 registries (I-1, I-2, I-3)
  ├── Add env var NEXT_PUBLIC_ARC_USDC_ADDRESS
  ├── Parameterize all chain ID guards (C-3, C-4, E-2, I-4, I-5)
  ├── Replace all testnet.arcscan.app hardcodes with configuredExplorerUrl() (UI-1 to UI-9)
  ├── Clear hardcoded fallback addresses in lifecycle/revalidation (E-1, E-3)
  └── DB migration: lift chain_id CHECK constraints; add chain_id to proof rows

Phase 3  DEPLOY CONTRACTS TO MAINNET
  ├── AgentCommerceProofRegistry (new operator, new attester)
  ├── VeyraTrustGate (new admin, new attester key pair)
  └── VeyraERC8183Evaluator (new admin, new attester, with mainnet AgenticCommerce address)

Phase 4  CONFIGURE MAINNET ENV
  └── New deployment env with all Phase 1 + Phase 3 values

Phase 5  REGISTER MAINNET IDENTITY
  └── Mint new ERC-8004 identity on mainnet registry
       (Testnet identity is NOT transferred — it stays Testnet)

Phase 6  VALIDATE
  ├── Testnet deployment still healthy, data intact
  ├── Mainnet deployment: probe /api/erc8004/v1/readiness
  ├── Mainnet deployment: submit one ERC-8183 job end-to-end
  └── Confirm Testnet Arcscan links still resolve
```

---

*This document is a read-only analysis. No code was modified and no contracts were deployed in its preparation.*
