# Option C: the minimal real test on Arc mainnet (plan, not run)

This plan proves on Arc mainnet, with real USDC and MetaMask's real screens,
what [the fork tests](2026-09-24-option-c-architecture.md) showed:
- the grant;
- the cap;
- the fixed recipient;
- revocation;
- the return of the hot wallet's money.

A payment from the hot wallet is a separate, later step. It waits for the
signer changes.

**None of this has been run.** Every step that sends a transaction or moves
money needs the owner's go-ahead for that stage.

## Who and what

- **The test account, U.** A new MetaMask account used only for this test.
  It can be a second account in the owner's MetaMask, or a separate browser
  profile.
  - The owner's main wallet `0x8e52…8909` is not connected to the test
    page. It is not upgraded and not asked for any permission.
  - Funding U from it is a plain USDC transfer.
- **Nova's redeemer, N, and hot wallet, H.** Two new keys, made on the
  owner's machine for this test only.
  - They are kept in a file outside the repository, readable only by the
    owner.
  - They are never printed, committed or sent to Vercel.
  - N gets 0.05 USDC for gas. H gets nothing: it receives only through the
    permission.
- **Where it runs.** The owner's machine. For a single-owner pilot, it is the
  signer host, as the D1 notes decided.
- **Two small local tools,** in [`scripts/arc-c-pilot/`](../../scripts/arc-c-pilot/README.md):
  - **A test page.** It adds Arc, asks for the permission, shows and decodes
    MetaMask's answer, and has a revoke button.
  - **A script for Nova's side.** It simulates, redeems and sweeps, one
    command per step below.

  Neither touches Veyra's production app, its database or Vercel.
  *(Written on 25 September. They were run end to end on a local fork of Arc
  mainnet, with a stand-in for MetaMask built on MetaMask's own kit, and
  passed 50 of 50 checks. MetaMask itself has still not been used.)*

## Contracts on Arc mainnet (chain 5042, `0x13b2`)

RPC: `https://rpc.mainnet.arc.io`. Explorer: `https://explorer.arc.io`.
Arc's minimum base fee is 20 gwei.

| Contract | Address | Role in the test |
| --- | --- | --- |
| USDC | `0x3600000000000000000000000000000000000000` | The budget. As an ERC-20 it has 6 decimals, and it is also the gas |
| DelegationManager v1.3 | `0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3` | Checks and redeems the permission; `disableDelegation` |
| EIP7702StatelessDeleGator | `0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B` | What U is upgraded to |
| ERC20PeriodTransferEnforcer | `0x474e3Ae7E169e940607cC624Da8A15Eb120139aB` | The cap per period; `getAvailableAmount` |
| ValueLteEnforcer | `0x92Bf12322527cAA612fd31a0e810472BBB106A8F` | No native value |
| TimestampEnforcer | `0x1046bb45C8d673d4ea75321280DB34899413c069` | The expiry |
| RedeemerEnforcer | `0xE144b0b2618071B4E56f746313528a669c7E65c5` | Only N redeems |
| AllowedCalldataEnforcer | `0xc2b0d624c1c4319760C96503BA27C347F3260f55` | Only H receives |
| NonceEnforcer | `0xDE4f2FAC4B3D87A1d9953Ca5FC09FCa7F366254f` | Revoke everything: `incrementNonce(DelegationManager)` |

The fallback uses HybridDeleGator `0x48dBe696A4D990079e039489bA2053B36E8FFEC4`,
SimpleFactory `0x69Aa2f9fe1572F1B640E1bbc512f5c3a734fc77c` and EntryPoint v0.7
`0x0000000071727De22E5E9d8BAf0edAc6f37da032`. It is needed only if MetaMask
refuses at stage 1.

## The permission

**The request.** The page sends `wallet_requestExecutionPermissions` with:

```json
[{
  "chainId": "0x13b2",
  "to": "<N>",
  "permission": {
    "type": "erc20-token-periodic",
    "isAdjustmentAllowed": false,
    "data": {
      "tokenAddress": "0x3600000000000000000000000000000000000000",
      "periodAmount": "0x7a120",
      "periodDuration": 86400,
      "startTime": "<now>",
      "justification": "Veyra C pilot. Nova may move up to 0.50 USDC a day from this account to its payment wallet, for three days"
    }
  },
  "rules": [
    { "type": "expiry", "data": { "timestamp": "<now + 259200>" } },
    { "type": "redeemer", "data": { "addresses": ["<N>"] } },
    { "type": "payee", "data": { "addresses": ["<H>"] } }
  ]
}]
```

`0x7a120` is 500,000 base units, which is 0.50 USDC. `startTime` and
`timestamp` are sent as numbers of Unix seconds, not strings.

**What Veyra expects back.** The delegation must decode to exactly this:
- delegator U, delegate N, root authority;
- six caveats, in this order:

| Enforcer | Terms |
| --- | --- |
| ERC20PeriodTransfer | USDC ‖ 500000 ‖ 86400 ‖ startTime: 116 bytes, packed |
| ValueLte | 0 |
| Timestamp | 0 ‖ expiry: two `uint128` |
| Redeemer | N, 20 bytes |
| AllowedCalldata | 4 ‖ H padded to 32 bytes |
| Nonce | U's current nonce at the NonceEnforcer |

If any of it differs, the permission is not used.

## Steps

### Stage 0: preflight (read-only, free)

| # | Check | Expected |
| --- | --- | --- |
| T0 | Code at every contract above | Present |
| | `DelegationManager.paused()` | `false` |
| | The gas price | At least 20 gwei |
| | MetaMask's production flags | Still list `0x13b2` with `0x63c0…E32B` |

### Stage 1: MetaMask's real screens (the owner, about $0.001–0.003)

Stage 1 is the real UI check of EIP-7702 on Arc mainnet, done before any real
budget is in the account.

| # | Who | Step | Expected |
| --- | --- | --- | --- |
| T1 | Owner | Create the test account and send it 0.02 USDC on Arc | Balance 0.02 |
| T2 | Owner | Open the test page, connect **only** the test account, add or switch to Arc | MetaMask on Arc, test account selected |
| T3 | Owner | Ask for the permission | MetaMask's dialog shows USDC, 0.50 per day, the start, the expiry, *Redeemers* N, *Payees* H, and "This account will be upgraded to a smart account to complete this permission." Take a screenshot |
| T4 | Owner | *Grant*, then confirm the upgrade transaction | The upgrade costs about $0.001. The page receives `context`, `delegationManager` and `dependencies`. U's code is `0xef0100` followed by `63c0…e32b`. The delegation decodes as above |

**Stop at T3 if:**
- the dialog does not appear;
- MetaMask calls the account unsupported;
- the terms shown differ from those requested.

Nothing has been signed at that point. Record the message. The fallback,
HybridDeleGator, then applies, as a separate plan.

### Stage 2: the limits on mainnet (Nova's script, about $0.015)

| # | Who | Step | Expected | Cost |
| --- | --- | --- | --- | --- |
| T5 | Owner | Send 1.00 USDC to U and 0.05 USDC to N | Balances: U about 1.02, N 0.05 | — |
| T6 | Script | Free simulations (`eth_call` from N on the latest block), listed below | Each as listed | $0 |
| T7 | Script | N moves 0.30 to H | Success. U −0.30, H +0.30 | about $0.0076 |
| T8 | Script | N moves 0.30 again, the same day: a **real** transaction that should fail | Refused, `transfer-amount-exceeded`. Balances unchanged | about $0.0024 |
| T9 | Script | N moves 0.20 to H | Success. The period's 0.50 is used. `getAvailableAmount` returns 0 | about $0.005 |

### Stage 3: revocation and return (the owner and the script, about $0.003)

| # | Who | Step | Expected | Cost |
| --- | --- | --- | --- | --- |
| T10 | Owner | Revoke in MetaMask's own screen; if it cannot be found, use the page's button, which sends `disableDelegation` from U | A `DisabledDelegation` event for the permission's hash | about $0.0019 |
| T11 | Script | Simulate a 0.10 top-up. Optionally, send one real transaction | Refused, `CannotUseADisabledDelegation()` | $0, or about $0.0014 |
| T12 | Script | Sweep H back to U: all of it minus the sweep's gas | H is empty. U holds 1.02 minus the owner's gas | about $0.001 |
| T13 | Owner, optional | Switch the account back to a regular account in MetaMask, then simulate a top-up | Refused. The permission stays disabled even if the account is upgraded again, because it was revoked first | about $0.001 |

### Later, separately: one payment from H

This step needs the D1 signer changes 1, 3, 4 and 6: the payer from the
mandate, the budget reservation, the mandate in the ledger, and the
signature queue. Then:
1. a new permission;
2. H pays one Exa search on Arc, $0.007, through `quoteX402Call`, a
   signature, `settleX402Call` and reconciliation.

It is not part of the minimal test.

## Negative tests

**Real transactions, recorded on the chain:**
- T8: over the cap;
- optionally, T11: after revocation.

**Free, by simulation on the live chain before T7 and after T10:**

| Attempt | Expected refusal |
| --- | --- |
| 0.30 to an address other than H | `AllowedCalldataEnforcer:invalid-calldata` |
| 0.60 at once | `ERC20PeriodTransferEnforcer:transfer-amount-exceeded` |
| The same call aimed at another token contract | `invalid-contract` |
| `approve(H, …)`, `transferFrom(U, H, …)` | `invalid-method`, `invalid-execution-length` |
| A transfer with native value attached | `ValueLteEnforcer:value-too-high` |
| Batch mode, try mode | `invalid-call-type`, `invalid-execution-type` |
| Redeemed from an address other than N | `InvalidDelegate()` |
| Through a sub-delegation N signs to another key | `RedeemerEnforcer:unauthorized-redeemer` |

The fork tests already covered the rest:
- a period rollover;
- parallel attempts;
- expiry;
- a permission signed for another chain;
- the manager's pause.

A second day of top-ups would repeat the rollover on mainnet, if the owner
wants to leave the test running.

## Expected costs

| Who | What | About |
| --- | --- | --- |
| The test account | Upgrade and revoke, plus an optional switch back | $0.003–0.004 |
| N | Two top-ups, one refused top-up, an optional refused one after revocation | $0.015–0.017 |
| H | The sweep | $0.001 |
| **Total** | | **about $0.02** |

**What is at risk:**
- at most the 1.02 USDC in the test account;
- at most 0.50 in H at any time;
- N's 0.05 of gas money.

The permission expires in three days whatever happens.

## If something goes wrong

| What goes wrong | What to do |
| --- | --- |
| No dialog on Arc, or MetaMask calls the account unsupported | Stop. Nothing was signed. Record the message. The fallback plan applies |
| The upgrade transaction stays pending | Arc silently drops transactions priced under 20 gwei. Use MetaMask's speed-up or cancel |
| The permission Veyra receives differs from the request | Do not use it. Revoke it (T10), then ask again |
| A top-up fails unexpectedly | Nothing moved, because a redemption is all or nothing. Stop and read the revert reason |
| MetaMask's revoke screen is missing or fails | Use one of the other ways (below) |
| N's or H's key is lost or leaks | H's alone: at most what H holds, 0.50. Both: at most the test account's 1.02. Revoke at once; the permission expires in three days anyway |
| The sweep fails | The money stays in H, under the owner's key. Retry with a higher fee |
| The test account's key or MetaMask is lost | The account is still an ordinary EOA underneath, and the seed phrase restores it. The permission lapses after three days |
| The DelegationManager is paused | Top-ups fail closed. Revocation still works |
| Undo everything | Revoke (T10), sweep (T12), switch back (T13), send the USDC home |

**Other ways to revoke, if MetaMask's screen fails:**
- the page's button, which sends `disableDelegation` from U;
- the revoke-all transaction to the NonceEnforcer: data
  `0xf5743c4c000000000000000000000000db9b1e94b5b69df7e401ddbede43491141047db3`;
- moving U's USDC away.

## Passes if

1. MetaMask shows the permission dialog and the upgrade prompt on Arc mainnet,
   with the requested terms. Screenshots are kept.
2. The delegation Veyra receives decodes to exactly the six caveats above.
3. T7 and T9 succeed. T8 is refused with `transfer-amount-exceeded`. Every
   simulation in T6 is refused as listed.
4. After T10, T11 is refused with `CannotUseADisabledDelegation()`.
5. After T12, H holds nothing, and U holds 1.02 minus the owner's gas.
6. Every transaction hash is recorded in a follow-up note.

## What this test does not show

- Wallets other than MetaMask, and accounts MetaMask cannot upgrade.
- Gateway.
- A payment from H.
- Custody of N and H for other users. There, N sits with Veyra's server and
  H on the signer host, as in the architecture note.

## Decisions for the owner

1. **Who does stage 1.** Either the owner, in their own MetaMask with a new
   account, or the agent, in a throwaway browser profile. The agent's way
   means accepting MetaMask's terms, which needs the owner's explicit
   consent.
2. **Funding.** 0.02 USDC to the test account for stage 1. Then 1.00 more to
   the test account and 0.05 to N for stage 2.
3. **A go-ahead for each stage.** The two tools are written. Each command
   that sends a transaction shows it and waits for `send` to be typed.
