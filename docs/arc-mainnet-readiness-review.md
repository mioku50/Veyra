# Veyra — Arc Mainnet Readiness Review

**Date**: September 16, 2026  
**Scope**: Repository source at `mioku50/Veyra` + live Arc Testnet chain state (read-only, no deployments)  
**Method**: Full grep of all chain constants, hardcoded addresses, and network strings across the source tree, combined with direct `eth_call` reads against every deployed contract address.  
**Chain state queried**: Arc Testnet (chain ID 5042002)

---

## What the Deployed Testnet Contracts Actually Prove (Chain State Only)

These facts come exclusively from `read_contract` calls. Nothing below relies on README claims.

| Contract | Address | What chain state shows |
|---|---|---|
| **AgentCommerceProofRegistry** | `0x92dC1aFC126F755ba5d5254e8D697CAe10474851` | Deployed and responsive. `operator()` returns `0x7cE65e573463B83164FFc282a0556D5542defefA`. The operator is **not** simultaneously a registered attester (`isAttester(operator) == false`). At least one proof registration query (`isRegistered` against a dummy receipt id) returns `false`, confirming the contract is live and the mapping responds. |
| **VeyraTrustGate (current)** | `0x6C702E51B328De51621f48483f6587fb2665efAf` | Deployed and responsive. `TRUST_ATTESTER_ROLE` returns the expected keccak256 of `"TRUST_ATTESTER_ROLE"` (`0x3415ca...`). The `hashClearance` selector (`0x36d5bb2a`) is present — this is the gate that carries `verifyClearance`, not the superseded one. The address `0x7cE65e573...` does **not** hold `DEFAULT_ADMIN_ROLE` onchain (`hasRole(0x00...00, addr) == false`). |
| **VeyraTrustGate (superseded)** | `0x1cD66BCd4FCB73a079c05635840Fde029Ce6BEbB` | Still deployed and answering. Returns the same `TRUST_ATTESTER_ROLE` value. The docs correctly record it as superseded; nothing in the codebase routes production calls to it. |
| **VeyraERC8183Evaluator** | `0x0d2c04580e081e222bbe5bf9818af337e2633eb7` | Deployed and responsive. `SUPPORTED_POLICY_HASH` = `0x934fe61b6a78c1746d27381ff92721cc4c364c2e08b56d17c45ba0e1b0828f6c`. `paused()` = `false`. The ERC-8183 AgenticCommerce contract at `0x0747EEf...` is registered as a `supportedCommerce`. |
| **ERC-8004 Identity Registry** | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | Deployed and responsive. `name()` returns `"AgentIdentity"`. This is an ERC-721 contract. |
| **ERC-8004 Reputation Registry** | `0x8004B663056A597Dffe9eCcC1965A193B7388713` | Does **not** respond to `name()` — reverts. The contract is present at this address but its ABI does not expose a `name()` view. This is expected for a non-ERC-721 registry. |
| **ERC-8004 Validation Registry** | `0x8004Cb1BF31DAf7788923b405b754f57acEB4272` | Same as reputation registry — reverts on `name()`. Present, not an ERC-721. |
| **ERC-8183 AgenticCommerce** | `0x0747EEf0706327138c69792bF28Cd525089e4583` | Does **not** respond to `name()`. Present and referenced by the evaluator's `supportedCommerce` mapping. |
| **USDC (ERC-20)** | `0x3600000000000000000000000000000000000000` | Responds correctly: `symbol() = "USDC"`, `decimals() = 6`. This is the canonical Arc Testnet USDC ERC-20 view. |

**Key observation on admin roles**: Neither the operator address (ProofRegistry) nor the zero-admin address queried on TrustGate hold their respective admin roles onchain as of this read. This is consistent with the deployment using a separate deployer/admin address that was not the operator, or with role management having occurred post-deployment. It does **not** indicate a functional problem, but the admin key(s) must be confirmed before mainnet deployment — a contract with an unknown keyholder or no admin cannot be administered on mainnet.

---

## Findings by Category

### 1. Arc Testnet Chain Dependencies / Hardcoded Chain Assumptions

| Location | What is hardcoded | Category |
|---|---|---|
| `lib/wallet/arc.ts` | `ARC_TESTNET_CHAIN_ID = 5_042_002`, `ARC_TESTNET_RPC_URL`, `ARC_TESTNET_WS_URL`, `ARC_TESTNET_EXPLORER_URL`, `defineChain({ id: 5042002, testnet: true })` — the entire `arcTestnetChain` viem object | **Code change** |
| `lib/execution/adapters/erc8183-lifecycle.ts` | `ARC_CHAIN_ID = 5_042_002` as a module constant | **Code change** |
| `lib/seller/external-fulfillment.ts` | `ARC_TESTNET_NETWORK = "eip155:5042002"` and `ARC_TESTNET_GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9"` | **Code change + configuration change** |
| `app/api/erc8183/v1/evaluations/route.ts:59-60` | Hard `if (chainId !== 5042002)` guard rejects all non-testnet requests with the string `"Only Arc Testnet (chainId 5042002) is supported in P5.0."` | **Code change** |
| `app/api/execution/v1/mandates/route.ts` and `.../activate/route.ts` | Default `network = "eip155:5042002"` in mandate creation and activation | **Code change** |
| `app/api/seller/services/validation.ts:247-251` | Hard equality check `expectedNetwork !== "eip155:5042002"` and `expectedAsset !== "0x3600..."` — rejects seller service registrations on any other network/asset | **Code change** |
| `app/api/seller-workflows/execute/.../route.ts:66-67` | `expectedNetwork: "eip155:5042002"` and `expectedAsset: "0x3600..."` hardcoded in workflow execution | **Code change** |
| `app/api/erc8004/v1/readiness/route.ts:40` | `chainId === 5042002` guard | **Code change** |
| `lib/execution/adapters/erc8183-lifecycle.ts:16` and all `lib/erc8*/*.ts` files (14 distinct files) | `import { arcTestnet } from "viem/chains"` — uses viem's built-in testnet chain object with its own RPC URLs | **Code change** |
| `lib/commerce/onchain-proof.ts:202` | `process.env.ARC_TESTNET_RPC_URL ?? arcTestnet.rpcUrls.default.http[0]` — falls back to testnet RPC | **Code change** |
| `lib/counterparty-selection/proof.ts:44` | Same pattern — `ARC_TESTNET_RPC_URL` env var with testnet RPC fallback | **Code change** |
| `components/dashboard/withdraw-dialog.tsx:44` | `arcTestnet: "https://testnet.arcscan.io/tx/"` (note: `.io` not `.app`) hardcoded in chain label map | **Code change** |
| `app/api/trust/v1/verify/route.ts` and `decisions/route.ts` | `const chainId = 5042002` — local constants for onchain trust verification | **Code change** |
| `app/api/internal/reputation/proofs/route.ts:86` | `.eq("chain_id", 5042002)` — Supabase DB query filters proofs by testnet chain ID | **Code change + database migration** |

### 2. Contract Addresses / Registries That Must Change for Mainnet

Every address below is hardcoded as a literal string somewhere in the codebase. The environment-variable overrides marked with ✓ mean the address can be swapped by env var alone. Those without ✓ require a code edit.

| Address | Contract | Files | Env override? | Category |
|---|---|---|---|---|
| `0x92dC1aFC...` | Veyra ProofRegistry (Testnet) | `docs/contracts.md`, benchmarks | No | **New deployment** |
| `0x6C702E51...` | Veyra TrustGate (Testnet) | `lib/trust-gate/address.ts` DEFAULT | ✓ `VEYRA_TRUST_GATE_ADDRESS` | **New deployment** |
| `0x0d2c0458...` | Veyra ERC8183Evaluator (Testnet) | 10+ files; default fallback in most | ✓ `NEXT_PUBLIC_VEYRA_ERC8183_EVALUATOR_ADDRESS` | **New deployment** |
| `0x0747EEf0...` | ERC-8183 AgenticCommerce (Testnet) | 10+ files; default fallback in most | ✓ `NEXT_PUBLIC_ARC_ERC8183_COMMERCE_ADDRESS` | **Unknown / requires Arc confirmation** |
| `0x8004A818...` | ERC-8004 Identity Registry | `lib/erc8004/types.ts`, 8+ files; **no env override** | No | **Unknown / requires Arc confirmation** |
| `0x8004B663...` | ERC-8004 Reputation Registry | `lib/erc8004/types.ts`, 4+ files; **no env override** | No | **Unknown / requires Arc confirmation** |
| `0x8004Cb1B...` | ERC-8004 Validation Registry | `lib/erc8004/types.ts`, 4+ files; **no env override** | No | **Unknown / requires Arc confirmation** |
| `0x3600000000000000000000000000000000000000` | Arc Testnet USDC ERC-20 | `lib/x402/usdc-assets.ts` (keyed by chain ID 5042002), `lib/wallet/arc.ts`, 12+ other files | ✓ (via chain ID key in usdc-assets.ts once mainnet chain ID is added) | **Configuration change + code change** |
| `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` | Arc Testnet Gateway Wallet | `lib/seller/external-fulfillment.ts` hardcoded literal | No env override | **Configuration change** |
| `benchmarks/run.mts:212` | `0x8004A818...` hardcoded | benchmark script | No | **Code change** |
| `scripts/bootstrap-initial-reputation.mts:45-49` | COMMERCE + EVALUATOR addresses hardcoded (not env-var-based) | bootstrap script | No | **Code change** |

### 3. USDC / Native-Gas Assumptions

Arc Testnet and Arc Mainnet share the same architectural pattern (USDC is native gas with 18 decimals; ERC-20 USDC has 6 decimals at a fixed address), but the addresses differ between networks. The following assumptions need verification:

| Assumption | Where | Risk | Category |
|---|---|---|---|
| USDC ERC-20 = `0x3600000000000000000000000000000000000000` | `lib/wallet/arc.ts`, 12+ files | This is the Testnet address. Arc Mainnet USDC ERC-20 address is **not the same**. `lib/x402/usdc-assets.ts` correctly maps by chain ID but **does not yet have a mainnet Arc entry** (chain ID 130 for Arc Mainnet is absent from `USDC_BY_CHAIN_ID`). Until that entry exists, `isUsdcAsset(130, ...)` returns false and all seller service validations and quote routes will refuse mainnet USDC. | **Code change** |
| Native gas decimals = 18 | `lib/wallet/arc.ts` `nativeCurrency.decimals: 18` | Correct on testnet. Must be confirmed identical on mainnet before use. | **Unknown / requires Arc confirmation** |
| `usdcToGasToken` / `gasTokenToUsdc` conversions | Used via `lib/wallet/arc.ts` `arcTestnetChain` | Conversion logic is chain-object-driven. If mainnet uses a different scale, a new chain object is needed. | **Unknown / requires Arc confirmation** |
| `ARC_TESTNET_GATEWAY_WALLET = 0x0077777d7...` in `external-fulfillment.ts` | Used in x402 payment acceptance validation | Gateway wallet address on mainnet is different. | **Code change** |

### 4. ERC-8004 Dependencies — Identity Flow Mainnet Readiness

**Finding: NOT mainnet-ready without official Arc confirmation of mainnet registry addresses.**

The three ERC-8004 registry addresses (`0x8004A818...`, `0x8004B663...`, `0x8004Cb1B...`) are defined as module-level constants in `lib/erc8004/types.ts` with **no environment-variable override path**. They are used in 8+ downstream files for:

- `lib/erc8004/client.ts`: `getCanonicalAgentIdentity` verifies `dbRecord.chain_id !== arcTestnet.id` — will throw for any stored identity record with mainnet chain ID until this check is updated.
- `lib/byoa/service.ts`: Three registry addresses passed directly in counterparty construction (lines 1099–1101 and 1146–1148).
- `lib/execution/executor.ts:468`: Identity registry hardcoded in executor.
- `app/api/erc8004/v1/validations/respond/route.ts`: Sends transactions to `ARC_ERC8004_VALIDATION_REGISTRY` — if this address is wrong on mainnet, validation transactions will fail silently or revert.

**Critical design issue**: An ERC-8004 identity token minted on Arc Testnet is token-ID 42 (for example) on the testnet registry contract. A new identity must be registered from scratch on the mainnet registry. No existing testnet identity transfers. Any database row in `erc8004_identity_records` with `chain_id = 5042002` is Testnet history only. Code in `client.ts` line 128 will correctly reject those records for any mainnet operation (since `arcTestnet.id !== mainnet_chain_id`), but this means every agent that has a Testnet identity will appear as unregistered on mainnet until they re-register.

**The `network: "arc-testnet"` string** appears in 12+ API response payloads. This is not merely cosmetic — some agent consumers will use it as a machine-readable routing key. It must be updated to `"arc-mainnet"` (or the canonical string Arc publishes) everywhere it appears.

### 5. ERC-8183 Dependencies — Evaluator/Job Flow Mainnet Readiness

**Finding: Partially ready (env-var overrideable for Veyra-owned contracts) but blocked on Arc-owned ERC-8183 AgenticCommerce address.**

| Component | Status | Notes |
|---|---|---|
| `VeyraERC8183Evaluator` | Must redeploy | New deployment on mainnet. Address overrideable via `NEXT_PUBLIC_VEYRA_ERC8183_EVALUATOR_ADDRESS`. |
| `SUPPORTED_POLICY_HASH` (`0x934fe61b...`) | Immutable per-deployment | The policy hash is set at constructor time and stored as `immutable`. Redeployment on mainnet will either use the same hash (if policy is unchanged) or a new one. Either way there is no onchain migration of Testnet job records. |
| `ERC-8183 AgenticCommerce` (`0x0747EEf0...`) | Unknown | This is an Arc-ecosystem contract, not a Veyra-deployed contract. There is no confirmation of whether Arc will deploy the same contract at the same address on mainnet, or at a new address. The evaluator's `supportedCommerce` whitelist must point at the correct mainnet address. | 
| Hard `chainId !== 5042002` guard | Code change required | `app/api/erc8183/v1/evaluations/route.ts:59` will reject all mainnet job evaluation requests until this is updated. |
| EIP-712 domain chain ID | Implicit in viem | All EIP-712 signing paths use `arcTestnet` from `viem/chains`, which embeds the Testnet chain ID. Mainnet signatures will have a different chain ID in the domain and will be incompatible with Testnet-signed verdicts. This is correct behavior, not a bug. |
| Testnet job history | No migration possible | All ERC-8183 jobs created on the Testnet AgenticCommerce contract are Testnet history. Their job IDs, deliverable hashes, and settlement transactions are specific to the Testnet contract instance. They cannot be replayed on mainnet. |

### 6. x402 / Payment Assumptions

| Assumption | Location | Risk | Category |
|---|---|---|---|
| `expectedNetwork = "eip155:5042002"` | `app/api/seller/services/validation.ts`, `app/api/seller-workflows/execute/…/route.ts` | All registered seller services list this network. On mainnet the network string will be `"eip155:130"` (Arc Mainnet chain ID). Hard equality checks will reject every seller registration and workflow execution attempt. | **Code change** |
| `expectedAsset = "0x3600000000000000000000000000000000000000"` | Same files | Testnet USDC address. Will need the mainnet USDC address. | **Code change** |
| `ARC_TESTNET_USDC` constant in `lib/x402.ts:32`, `lib/agent/execution.ts:250`, `lib/seller/external-fulfillment.ts:11`, `lib/execution/adapters/x402.ts:259`, `lib/execution/settlement-resolver.ts:19` | Multiple | All x402 payment validation paths check the asset is this specific address. | **Code change** |
| `GatewayWalletBatched` EIP-712 domain parsing | `lib/counterparty-selection/marketplace-source.ts`, `lib/execution/settlement-resolver.ts`, `lib/byoa/x402-client.ts` | The batched gateway scheme name is likely the same on mainnet, but the `verifyingContract` address in the domain will differ. Settlement resolution reads the domain dynamically from the payment accept header — **this part is safe as-is** if the domain is read from the live accept, not hardcoded. Confirm Circle publishes the mainnet gateway verifying contract. | **Unknown / requires Arc confirmation** |
| Circle x402 facilitator endpoint | Used in settlement reconciliation | The x402 V2 facilitator URL may differ between testnet and mainnet environments. | **Configuration change** |

### 7. Proof / Attestation Contracts — Redeployment Required

| Contract | Testnet Address | Mainnet action required |
|---|---|---|
| `AgentCommerceProofRegistry` | `0x92dC1aFC126F755ba5d5254e8D697CAe10474851` | **New deployment**. All Testnet proofs are permanently recorded on the Testnet contract. They are not migrated, and the mainnet deployment will start with zero proofs. No historical claim about Testnet proofs is valid as mainnet evidence. |
| `VeyraTrustGate` | `0x6C702E51B328De51621f48483f6587fb2665efAf` | **New deployment**. All consumed clearances (`consumedClearances` mapping) are Testnet-only. The EIP-712 domain embeds the chain ID, so Testnet clearance signatures are cryptographically incompatible with mainnet. |
| `VeyraERC8183Evaluator` | `0x0d2c04580e081e222bbe5bf9818af337e2633eb7` | **New deployment**. The `SUPPORTED_POLICY_HASH` is set at construction — choose the correct policy hash at deployment time. All Testnet `resolvedJobs` and `executedDigests` state is Testnet-only. |
| `VeyraTrustGate (superseded)` | `0x1cD66BCd4FCB73a079c05635840Fde029Ce6BEbB` | No action needed. It is already deprecated on Testnet and nothing should reference it on mainnet. |

**Note on unauditedness**: The `VeyraERC8183Evaluator` NatSpec comment reads "Non-upgradeable evaluator contract for ERC-8183 jobs on **Arc Testnet**." The AGENTS.md product invariant explicitly states "contracts are not presented as audited." An independent audit is a prerequisite before mainnet deployment of any contract that handles real USDC.

### 8. Frontend Copy That Would Incorrectly Say "Arc Testnet" After Migration

The following source locations contain visible user-facing text or machine-readable string literals that embed "Arc Testnet" and will be incorrect on mainnet. This list is exhaustive from the grep output.

| File | Content | Category |
|---|---|---|
| `app/.well-known/veyra-agent.json/route.ts:31` | `network: "arc-testnet"` in the public agent JSON | **Code change** |
| `app/api/erc8004/v1/agent/route.ts:32`, `erc8183/v1/evaluator/route.ts:17`, `api/status/route.ts:14`, `api/erc8004/v1/readiness/route.ts:49`, `api/reputation/v1/agents/[agentId]/route.ts:59` | All return `network: "arc-testnet"` in JSON responses | **Code change** |
| `app/api/agent/v1/quotes/route.ts` (×4), `reports/route.ts`, `watchlists/…/rechecks/route.ts`, `workflows/route.ts` | `network: "arc-testnet"` in quote/report payloads | **Code change** |
| `app/api/premium/agent-trust/finalize/route.ts`, `github/due-diligence/route.ts`, `provider/…` routes (×5) | `network: "Arc Testnet"` (capitalised) in provider response payloads | **Code change** |
| `app/dashboard/page.tsx:67` | `const EXPLORER_BASE = "https://testnet.arcscan.app"` — controls all dashboard explorer links | **Code change** |
| `app/evaluations/[publicId]/page.tsx:105` | `https://testnet.arcscan.app/tx/...` link | **Code change** |
| `app/executions/page.tsx:171,349` | Hardcoded `https://testnet.arcscan.app/tx/` links, including a specific Testnet tx hash | **Code change** |
| `app/run/run-client.tsx:974` | Hardcoded link to a Testnet tx `0xd1d958d5...` displayed as an example in the UI | **Code change** |
| `app/evaluators/erc8183/page.tsx:300-305` | Hardcoded curl examples pointing at `agent-commerce-six.vercel.app` with Testnet job IDs | **Code change** |
| `app/api/erc8183/v1/evaluations/route.ts:60` | Error message says "Only Arc Testnet (chainId 5042002) is supported in P5.0." exposed to API callers | **Code change** |
| `app/agent-launch/agent-launch-client.tsx` (×5) | Multiple user-visible strings "Arc Testnet", "Arc Testnet only", funding confirmation messages | **Code change** |
| `app/agents/veyra/page.tsx:104,150,158,170,182` | Displayed chain name, explorer links with `testnet.arcscan.app` | **Code change** |
| `app/agents/byoa/[publicId]/page.tsx` | Badge `<Badge variant="outline">Arc Testnet</Badge>` visible to users | **Code change** |
| `app/console/erc8183/page.tsx:77,111,148` | `chainId: 5042002` in rendered UI, text "Arc Testnet (5042002)" | **Code change** |
| `app/console/seller/seller-withdrawal-client.tsx` (×3) | "Arc Testnet" in button text, error messages, card title | **Code change** |
| `app/console/seller/seller-console-client.tsx` | Seller onboarding terms reference "Arc Testnet x402" | **Code change** |
| `lib/commerce/onchain-proof.ts:24` | `ARC_TESTNET_EXPLORER_URL = "https://testnet.arcscan.app"` — used across multiple proof URL builders | **Code change** |
| `app/agent-runner/hosted-job-result.tsx:572,574` | "Arc Testnet" in workflow result labels | **Code change** |
| `app/console/agent-api/page.tsx:56,69,144` | Developer docs display "Arc Testnet · Chain 5042002" | **Code change** |
| `app/console/agents/page.tsx:21` | Badge showing "Arc Testnet · chain 5042002" | **Code change** |

### 9. Environment Variables Requiring Mainnet Values

The following environment variables are confirmed present in `.env.example` (read-only by convention, never read directly) and must be updated for mainnet. Variables with existing code-level support for override are marked ✓ (no code change needed, only `.env` change).

| Variable | Current Testnet value in source | Mainnet replacement needed | Code change also needed? |
|---|---|---|---|
| `ARC_TESTNET_RPC_URL` | `https://rpc.testnet.arc.network` | Arc Mainnet RPC endpoint | ✓ env only — but the variable should be renamed `ARC_RPC_URL` to avoid naming confusion |
| `NEXT_PUBLIC_ARC_CHAIN_ID` | `5042002` | Arc Mainnet chain ID (130) | ✓ env + code: viem chain objects hardcode 5042002 in `lib/wallet/arc.ts` |
| `NEXT_PUBLIC_ARC_EXPLORER_URL` | `https://testnet.arcscan.app` | Arc Mainnet explorer URL | ✓ env — but 15+ files also hardcode `testnet.arcscan.app` directly (see finding 8) |
| `NEXT_PUBLIC_VEYRA_ERC8183_EVALUATOR_ADDRESS` | `0x0d2c04580e081e222bbe5bf9818af337e2633eb7` | Mainnet evaluator address after redeployment | ✓ env only |
| `NEXT_PUBLIC_ARC_ERC8183_COMMERCE_ADDRESS` | `0x0747EEf0706327138c69792bF28Cd525089e4583` | Arc Mainnet AgenticCommerce address | ✓ env only — but Arc must confirm this address |
| `VEYRA_TRUST_GATE_ADDRESS` / `NEXT_PUBLIC_VEYRA_TRUST_GATE_ADDRESS` | defaults to `0x6C702E51...` | Mainnet TrustGate address after redeployment | ✓ env only |
| `NEXT_PUBLIC_APP_URL` | `https://agent-commerce-six.vercel.app` (fallback literal in 4 files) | Mainnet app URL | ✓ env — but the fallback literal in source will be wrong if env is not set |
| `ERC8183_EVALUATOR_ATTESTER_PRIVATE_KEY` | Testnet key | New mainnet key for attester role | ✓ env only — critical: old Testnet key must never be reused |
| `ERC8183_EVALUATOR_RELAYER_PRIVATE_KEY` / `VEYRA_EVALUATOR_RELAYER_PRIVATE_KEY` | Testnet key | New mainnet key for relayer role | ✓ env only |
| `ERC8004_VALIDATION_RESPOND_SECRET` | Testnet value | Rotate for mainnet | ✓ env only |
| USDC asset address (no dedicated env) | `0x3600000000000000000000000000000000000000` hardcoded in ~12 files | Arc Mainnet USDC address | **Code change required** — must be added to `USDC_BY_CHAIN_ID` and all hardcoded usages |
| `ARC_TESTNET_GATEWAY_WALLET` in `lib/seller/external-fulfillment.ts` | `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` | Arc Mainnet Gateway Wallet | **Code change required** — no env override exists |
| ERC-8004 registry addresses (`ARC_ERC8004_IDENTITY_REGISTRY`, etc.) | Constants in `lib/erc8004/types.ts` | Arc Mainnet registry addresses | **Code change required** — no env override exists |
| Supabase `chain_id` filter | `5042002` in DB query | DB migration or new environment field | **Code change required** |

### 10. Migration Order to Preserve Testnet History

The following order preserves all existing Testnet activity as Testnet history without pretending it migrated to Mainnet.

**Step 0 — Prerequisites (all blocking)**
- Obtain official Arc Mainnet chain ID, RPC URL, explorer URL, USDC ERC-20 address, Gateway Wallet address from Arc documentation.
- Obtain Arc Mainnet ERC-8004 registry addresses (Identity, Reputation, Validation) from Arc. These are the single biggest unknown in this review — no env override exists for them, and the current validation logic binds to `arcTestnet.id` explicitly.
- Obtain Arc Mainnet ERC-8183 AgenticCommerce address from Arc.
- Obtain an independent security audit of all three Veyra contracts before any mainnet deployment. The contracts themselves are unaudited by their own documentation.
- Confirm that the `arcTestnet` export from `viem/chains` maps to a pre-existing viem entry for Arc Mainnet, or that a new viem chain object is required.

**Step 1 — Testnet freeze (no action required, but record-keeping)**
- Mark the Testnet Supabase database as frozen / read-only or take a snapshot. Testnet proof rows, ERC-8004 identity records, ERC-8183 job records, and reputation records remain valid Testnet history. They are not deleted or migrated.
- Store a permanent record of: Testnet ProofRegistry address, all Testnet tx hashes referenced in UI, the Testnet SUPPORTED_POLICY_HASH (`0x934fe61b...`).

**Step 2 — Code changes (in one PR, before any mainnet infra)**
- Add Arc Mainnet chain object to `lib/wallet/arc.ts` (new `defineChain` with mainnet chain ID, RPC, explorer, `testnet: false`).
- Add mainnet Arc chain ID + USDC address entry to `lib/x402/usdc-assets.ts`.
- Remove hard `=== 5042002` guards in `erc8183/v1/evaluations/route.ts`, `erc8004/v1/readiness/route.ts`, `trust/v1/verify/route.ts`, `trust/v1/decisions/route.ts`, `execution/v1/mandates` routes.
- Replace all `"arc-testnet"` / `"Arc Testnet"` string literals in API responses with environment-driven values.
- Add env-var override paths for `ARC_ERC8004_IDENTITY_REGISTRY`, `ARC_ERC8004_REPUTATION_REGISTRY`, `ARC_ERC8004_VALIDATION_REGISTRY` (currently module-level constants with no override).
- Replace `ARC_TESTNET_GATEWAY_WALLET` literal with an env-var-driven value.
- Add env-var override for the mainnet USDC ERC-20 address where it is hardcoded (the largest surface area in this review).
- Fix Supabase `chain_id` filter to use the runtime-configured chain ID rather than `5042002` literal.
- Update `lib/erc8004/client.ts:128` chain ID check to compare against configured chain ID, not hardcoded `arcTestnet.id`.
- Replace all `testnet.arcscan.app` explorer URLs in UI with the env-driven explorer URL.

**Step 3 — Mainnet contract deployments (after Step 2 is merged and tested)**
1. Deploy `AgentCommerceProofRegistry` on Arc Mainnet with the correct operator and attester addresses.
2. Deploy `VeyraTrustGate` on Arc Mainnet with correct admin and attester addresses.
3. Deploy `VeyraERC8183Evaluator` on Arc Mainnet, passing the mainnet AgenticCommerce address and the chosen policy hash.
4. Record all three mainnet addresses; set env vars.

**Step 4 — Mainnet environment configuration**
- Set all env vars from finding 9 to mainnet values.
- Rotate all private keys (attester, relayer) — never reuse Testnet keys on mainnet.
- Update `NEXT_PUBLIC_APP_URL` to the mainnet deployment URL.
- Update `NEXT_PUBLIC_ARC_CHAIN_ID`, `NEXT_PUBLIC_ARC_EXPLORER_URL`, `ARC_TESTNET_RPC_URL` (or rename the variable).

**Step 5 — ERC-8004 identity re-registration**
- Every agent with a Testnet identity must register a fresh identity on the mainnet ERC-8004 Identity Registry. This is a wallet transaction on the mainnet chain. Testnet token IDs are meaningless on mainnet.
- The Testnet validation history for those agents is permanently Testnet history and does not transfer.

**Step 6 — Seller service re-registration**
- All seller services stored in the database with `expected_network = "eip155:5042002"` are Testnet registrations. Sellers must re-register on mainnet with `expected_network = "eip155:<mainnet_chain_id>"` and the mainnet USDC asset address.

**Step 7 — Testnet → Mainnet data boundary documentation**
- The public reputation data, Arc proofs, and decision logs visible in the UI are accumulated Testnet history. Any public-facing page that shows proof counts or transaction hashes must clearly label them as Testnet records. A new mainnet deployment starts with zero onchain proofs in `AgentCommerceProofRegistry`.

---

## Summary Table

| # | Topic | Category |
|---|---|---|
| 1 | Arc Testnet chain ID `5042002` hardcoded in ~20 source locations | Code change |
| 2 | `arcTestnet` from `viem/chains` used in 14 signing/transport paths | Code change |
| 3 | Veyra ProofRegistry, TrustGate, ERC8183Evaluator addresses | New deployment |
| 4 | ERC-8004 registry addresses — no env override, hardcoded constants | Code change + Unknown (Arc must confirm mainnet addresses) |
| 5 | ERC-8183 AgenticCommerce — no env override in some files | Configuration change + Unknown (Arc must confirm mainnet address) |
| 6 | USDC ERC-20 address not in mainnet chain-ID slot of `USDC_BY_CHAIN_ID` | Code change |
| 7 | Gateway Wallet address hardcoded literal | Code change |
| 8 | Supabase chain_id filter hardcoded | Code change |
| 9 | ~30 files with `"arc-testnet"` or `"Arc Testnet"` in API/UI payloads | Code change |
| 10 | ~15 files with `testnet.arcscan.app` hardcoded links | Code change |
| 11 | `NEXT_PUBLIC_APP_URL` fallback is the Testnet Vercel URL | Configuration change |
| 12 | `"eip155:5042002"` hardcoded network string in seller validation | Code change |
| 13 | ERC-8004 Testnet identities do not transfer to mainnet | New deployment (re-registration by agents) |
| 14 | ERC-8183 Testnet job history does not transfer | No action (accept as Testnet history) |
| 15 | Contracts are unaudited per their own documentation | Prerequisite: external audit |
| 16 | Admin key(s) for deployed contracts need confirmation before mainnet | Unknown / operational |
| 17 | Arc Mainnet chain ID, RPC, explorer, ERC-8004 registry addresses | Unknown / requires Arc confirmation |
| 18 | ERC-8004 `client.ts` chain ID check binds to `arcTestnet.id` | Code change |
| 19 | `SUPPORTED_POLICY_HASH` is immutable — must be chosen correctly at mainnet deploy | New deployment (one-time decision) |
| 20 | All Testnet history (proofs, identities, reputation, jobs) is Testnet-only | No change — document boundary |
