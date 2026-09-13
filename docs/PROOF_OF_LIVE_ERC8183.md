# Proof of Live ERC-8183 Settlement on Arc

**Status:** verified on Arc Testnet (chain ID `5042002`) on 2026-09-12.

This document records a full ERC-8183 job lifecycle — creation, USDC escrow,
deliverable submission, independent evaluation, and payout — executed against the
canonical Arc reference implementation by Veyra's own execution adapter. Every
claim below is backed by a transaction hash that can be checked on
[testnet.arcscan.app](https://testnet.arcscan.app).

## Contracts

| Role | Address |
| :--- | :--- |
| ERC-8183 AgenticCommerce (Arc reference) | [`0x0747EEf0706327138c69792bF28Cd525089e4583`](https://testnet.arcscan.app/address/0x0747EEf0706327138c69792bF28Cd525089e4583) |
| ↳ implementation behind its ERC-1967 proxy | `0xa316fd02827242d537f84730f8a37d0ba5fd351a` |
| VeyraERC8183Evaluator | [`0x0d2C04580E081e222BBE5BF9818af337E2633eb7`](https://testnet.arcscan.app/address/0x0d2C04580E081e222BBE5BF9818af337E2633eb7) |
| USDC (ERC-20 interface, 6 decimals) | `0x3600000000000000000000000000000000000000` |

Evaluator configuration read from chain at the time of the run:
`supportedCommerce(0x0747EEf…) = true`, attester holds `ATTESTER_ROLE`,
`paused() = false`, `SUPPORTED_POLICY_HASH = 0x934fe61b6a78c1746d27381ff92721cc4c364c2e08b56d17c45ba0e1b0828f6c`.

## Job #186207 — full lifecycle

Driven end to end by `Erc8183ExecutionAdapter.advance()`.

| # | Phase transition | Role | Signer | Selector | Gas | Transaction |
| :-- | :--- | :--- | :--- | :--- | --: | :--- |
| 1 | → `CREATED_AWAITING_BUDGET` | client | `0x26d93364…` | `createJob` `0x41528812` | 180 528 | [`0x0f0c3e5c…`](https://testnet.arcscan.app/tx/0x0f0c3e5ce89423bb43a5f206d8cf46269f70793cac4e7dd2730cc638757cf392) |
| 2 | → `BUDGETED_AWAITING_FUNDING` | provider | `0xdCF6eF66…` | `setBudget` `0xdd4ae9d4` | 82 124 | [`0x203b5d21…`](https://testnet.arcscan.app/tx/0x203b5d2184b483bdef784c0d77642480b06248c15249a67211c1595c7e51736c) |
| 3 | → `FUNDED_AWAITING_SUBMISSION` | client | `0x26d93364…` | `fund` `0xe25ba707` | 96 084 | [`0xf6c15391…`](https://testnet.arcscan.app/tx/0xf6c15391dc6e57d3a8d493b88c8d750d45862cafc2efb7e9c9abc009f5bd7193) |
| 4 | → `SUBMITTED_AWAITING_EVALUATION` | provider | `0xdCF6eF66…` | `submit` `0x9e63798d` | 41 723 | [`0x1d1166e5…`](https://testnet.arcscan.app/tx/0x1d1166e5306822414f7f7203b3dd8c98670f178fe32ef0b4dd2234339cd34cbd) |
| 5 | → `COMPLETED` | evaluator | `0xF6665603…` | `executeVerdict` `0x9a1a58ef` | 159 801 | [`0xd1d958d5…`](https://testnet.arcscan.app/tx/0xd1d958d5014a3584a21c7e67444091af25c64940aa4759c928fa2962d0995a22) |

**Final state:** `getJob(186207)` returns `budget = 50000` (0.05 USDC),
`status = 3 (Completed)`, provider paid 0.05 USDC.

**Cost and latency:** 560 260 gas across the five lifecycle transactions at
21 gwei — **0.0118 USDC**, about 1.2 cents for a complete escrowed, independently
evaluated job. Wall-clock time from `createJob` to payout: **19 seconds**
(block timestamps 1789245117 → 1789245136), including four sequential receipt
waits. An ERC-20 `approve` is an additional transaction whenever the client's
allowance is short.

Three distinct signers appear in the `from` column. That is the point: the client,
the provider, and the evaluator relayer are separate parties, and the contract
recorded them as such.

## Evaluation

The verdict was produced by Veyra's deterministic policy engine and signed
EIP-712 by the attester, then relayed to `VeyraERC8183Evaluator.executeVerdict()`,
which verified the signature and called `complete()` on the commerce contract.
All eleven policy checks passed:

```
[PASS] chain_allowlisted             Chain ID 5042002 is allowlisted.
[PASS] evaluator_match               Job evaluator matches Veyra contract.
[PASS] job_status_submitted          ERC-8183 Job status is Submitted (2).
[PASS] job_not_expired               Job active until timestamp 1789248717.
[PASS] submitted_event_count         Exactly one JobSubmitted log found onchain.
[PASS] deliverable_hash_match        Onchain deliverableHash matches calculated
                                     0xb474b5ce…02c6.
[PASS] policy_schema_identifiers     Policy and Schema identifiers match V1.
[PASS] content_uri_https             Content URI uses HTTPS protocol.
[PASS] http_status_ok                HTTP status 200 OK.
[PASS] content_raw_hash_match        Raw content keccak256 matches commitment
                                     0x16fdc58d…1e1b.
[PASS] structured_schema_compliance  Payload conforms to
                                     veyra.structured-deliverable.v1.
```

The deliverable was fetched over HTTPS from
`https://agent-commerce-six.vercel.app/canary-deliverable.json` and its raw body
hashed to the committed `contentHash`. The evaluator never trusts the submitter's
word about what was delivered; it re-fetches and re-hashes.

## Role separation is enforced, not described

Veyra orchestrates the job. It does not play every part in it. With no provider
key present, the adapter opens the job and stops, reporting exactly what the
counterparty still owes rather than signing on its behalf — job **#186208**:

```json
{
  "phase": "CREATED_AWAITING_BUDGET",
  "executionState": "WAITING_FOR_PROVIDER",
  "success": false,
  "failureCode": null,
  "economicCommitted": false,
  "pendingAction": {
    "role": "provider",
    "chainId": 5042002,
    "contract": "0x0747EEf0706327138c69792bF28Cd525089e4583",
    "functionName": "setBudget(uint256,uint256,bytes)",
    "args": ["186208", "<amount in USDC base units>", "0x"],
    "expectedSigner": "0xdCF6eF666d02DCF5CEF229b59f9Dab61e1Ef14aF",
    "reason": "Veyra holds no key for the provider; the counterparty must sign this step."
  }
}
```

`failureCode` is `null` because waiting on a counterparty is not a failure, and
`economicCommitted` is `false` because no USDC moved. Signing for the provider
requires `ERC8183_ALLOW_PROVIDER_SIMULATION=true` and is flagged
`simulated: true` on every step it produces, so a simulated run can never be
mistaken for an arm's-length one. Job #186207 above was such a run: steps 2 and 4
carry that flag.

## The provider prices the job; Veyra caps what it will escrow

In the canonical contract the *provider* calls `setBudget`, so between `createJob`
and `fund` the counterparty can name any price. The budget is therefore untrusted
input, and `fundEscrow` refuses to escrow above the ceiling carried by the
clearance — job **#186209**, provider asking 0.05 USDC against a 0.02 authorization:

```
provider priced at:  0.05 USDC
client authorized :  0.02 USDC
refused: ERC8183_BUDGET_MISMATCH - Job 186209 demands 50000 base units,
         authorized ceiling is 20000.
phase after refusal: BUDGETED_AWAITING_FUNDING   (no USDC escrowed)
```

The job stays open at the funding phase and no money moves. `setBudget` separately
verifies that the price written on chain is the one that was requested.

## Defects this run found and fixed

The lifecycle was rebuilt because a live run proved the previous adapter could not
have settled a job. Each finding below was confirmed against chain, not inferred.

**1. The adapter called functions that do not exist.** Its inline ABI declared
`createJob(address,address,uint256,uint64,string)` and `submitJob(uint256,bytes32)`.
Neither selector is present in the deployed implementation. Confirmed by
`eth_call`:

```
createJob(address,address,uint256,uint64,string)  -> execution reverted
submitJob(uint256,bytes32)                        -> execution reverted
createJob(address,address,uint256,string,address) -> 186204   (canonical, control)
```

The adapter now uses `ERC8183_AGENTIC_COMMERCE_ABI` from `lib/erc8183/abi.ts`,
which matches the deployed contract exactly — verified field by field against a
decoded `getJob` response, including the `Status` enum where `Funded = 1` and
`Completed = 3`.

**2. Escrow was never funded.** Neither `setBudget` nor `fund` was called anywhere
in the codebase. Jobs could be opened, but no USDC was ever placed in escrow, so
`complete()` had nothing to pay out. Both calls are now explicit lifecycle
transitions owned by the correct role.

**3. The wrong hash was committed on chain.** The adapter submitted the raw
`contentHash` while the evaluator recomputes `computeDeliverableHash()` over the
whole envelope and treats a mismatch as a *critical* failure. Every job would have
been deterministically rejected. Both sides now derive the commitment from
`prepareDeliverableCommitment()`, so they cannot drift.

**4. Settlement amounts were overstated by 10¹².** Arc mirrors every USDC movement
into two `Transfer` events — one on the 18-decimal native pseudo-token
`0xffff…fffe`, one on the 6-decimal ERC-20 interface. They are two views of one
balance. The adapter matched whichever came first and divided by `1e6`, reporting
`50000000000` instead of `0.05` for the same payout. It now filters on the USDC
ERC-20 address before reading an amount.

**5. Clearance consumption was bound to the wrong signer.** `VeyraTrustGate`
enforces `msg.sender == clearance.executor`, but the adapter always consumed with
the evaluator relayer. Any clearance issued for a different executor would revert
with `UnauthorizedExecutor`. The signer is now selected by the clearance itself,
and a clearance naming an executor Veyra cannot sign for fails closed with
`CLEARANCE_EXECUTOR_UNAVAILABLE`.

## Reproducing

Requires funded Arc Testnet wallets for the client and provider roles
([Circle Faucet](https://faucet.circle.com)) and the evaluator attester/relayer
keys. Role keys are resolved by `resolveRoleSigners()` in
`lib/execution/adapters/erc8183-lifecycle.ts`:

| Role | Environment variable |
| :--- | :--- |
| client | `ERC8183_CLIENT_PRIVATE_KEY` (falls back to `BUYER_PRIVATE_KEY`) |
| provider | `ERC8183_PROVIDER_PRIVATE_KEY`, only when `ERC8183_ALLOW_PROVIDER_SIMULATION=true` |
| evaluator attester | `ERC8183_EVALUATOR_ATTESTER_PRIVATE_KEY` |
| evaluator relayer | `ERC8183_EVALUATOR_RELAYER_PRIVATE_KEY` |

A missing client or evaluator key is an error rather than a fallback to another
role's key, and a client that resolves to the same address as the provider is
rejected outright.

## Related

- Lifecycle state machine: `lib/execution/adapters/erc8183-lifecycle.ts`
- Rail adapter: `lib/execution/adapters/erc8183.ts`
- Deterministic evaluation policy: `lib/erc8183/policy.ts`
- Evaluator contract: `contracts/src/VeyraERC8183Evaluator.sol`
- Arc ERC-8183 quickstart: https://docs.arc.network/arc/tutorials/create-your-first-erc-8183-job
