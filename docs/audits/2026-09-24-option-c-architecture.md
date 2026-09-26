# Option C on Arc mainnet: limits in sequence, the hot wallet, and how a user connects

On 24 September the owner asked to continue with option C. In option C, a
user's own account lets Nova move USDC within a limit the chain enforces. The
aim is a user flow that is safe without Circle's CLI, with every limit checked
before the first real pilot.

This note follows [options C and D, checked without money](2026-09-24-arc-autonomous-wallets-c-d.md).
The pilot is planned separately in
[the minimal real test](2026-09-24-option-c-pilot-plan.md).

**How it was checked:**
- **A local fork of Arc mainnet.** anvil, block 22,556,225, chain 5042.
  - Every step was a real transaction, mined in order: 55 steps for the
    EIP-7702 account and 9 for the fallback smart account.
  - MetaMask's contracts ran exactly as they are deployed on Arc.
  - No contract storage was written by hand.
- **One substitution: USDC.** On the fork, USDC at `0x3600…0000` ran a plain
  ERC-20. Arc's USDC moves balances through a native-coin precompile that
  exists only on Arc. The real token was checked on mainnet instead: once
  before, by simulation, and this time with a gas estimate for each pilot
  transaction.
- **MetaMask,** read from two sources:
  - its production feature flags;
  - the code of extension 13.49.0 and its two permission snaps.

  No wallet was created, and MetaMask's terms were not accepted.
- **Circle Gateway's fee estimate** for a transfer from Arc to Arc, unsigned.
- Nothing was broadcast to Arc mainnet and no money moved.

The raw results are in [the evidence file](2026-09-24-option-c-evidence.json).

## In short

- **The limit holds across separate transactions.**
  - Two transfers that together exceed the daily cap: the second is refused.
  - A new period gives exactly one new cap, and unused allowance does not
    carry over.
  - Three transfers in one block: the ones that fit pass, and the rest are
    refused.
- **Only `USDC.transfer` to the hot wallet passes.** These were all refused:
  - another recipient or another token;
  - `approve`, `increaseAllowance` and `transferFrom`;
  - extra calldata or attached native value;
  - batch mode or try mode;
  - a stranger as the redeemer, or a stranger through Nova's own
    sub-delegation;
  - a permission signed for Base.
- **Revocation works the way a user would actually do it.**
  - Refused from the block where the user's `disableDelegation` lands.
  - One call to the nonce enforcer revokes every permission the account
    granted through MetaMask.
  - Expiry works on its own.
  - A pause of the DelegationManager does not block revocation.
- **Switching the account back to a plain EOA is not a revocation.** The
  permission comes back if the account is upgraded again (R13).
- **By its code and configuration, MetaMask already offers this on Arc
  mainnet:**
  - EIP-7702 to the same DeleGator;
  - the `erc20-token-periodic` permission with expiry, redeemer and payee
    rules.

  Nobody has yet seen it in the real UI. That needs a MetaMask wallet:
  either the owner's own, or a test profile in which the agent would accept
  MetaMask's terms. That is the owner's decision.

  *(Seen on 26 September, and it does not work. MetaMask showed the dialog
  with the right terms, then refused to sign: "External signature requests
  cannot sign delegations for internal accounts." Its delegation-contract
  table has no Arc mainnet. Autonomy is now frozen. See
  [autonomy frozen](2026-09-26-autonomy-frozen.md).)*
- **The fallback works too.** A separate HybridDeleGator smart account,
  deployed through MetaMask's factory, enforced the same limits. Its owner
  revoked and withdrew through UserOps that they submitted themselves.
- **The daily cap is not Nova's spending limit.** It limits how fast money
  reaches the hot wallet. What Nova can spend is bounded by three other
  things:
  - Veyra's mandate;
  - the signer host's own limits;
  - the hot wallet's balance, which Veyra keeps under a ceiling.

  Money already in the hot wallet is under Veyra's key. Revocation stops only
  new transfers into it.

## Test results

**The permission.** Every test used the permission MetaMask's snap builds for
`erc20-token-periodic` when all three rules are requested. Its six caveats:
- 1.00 USDC per 86,400 s from a start time;
- value at most 0;
- an expiry;
- redeemer: Nova's key only;
- payee: the hot wallet only;
- the account's current nonce.

The user's account was a throwaway EOA upgraded to MetaMask's
`EIP7702StatelessDeleGator` by a real type-4 transaction (S1).

### Limits, in separate transactions

| # | What Nova tried | Result |
| --- | --- | --- |
| L1 | 0.60 to the hot wallet | Allowed |
| L2 | 0.60 more, next transaction (1.20 in total) | Refused: `transfer-amount-exceeded` |
| L3 | 0.40, next transaction (exactly 1.00) | Allowed |
| L4 | 0.01 more in the same period | Refused |
| P1 | 0.01, one second before the period ends | Refused |
| P2 | 1.00 in the first second of the next period | Allowed |
| P3 | 0.01 more in that period | Refused |
| P4 | 1.50 at once, after three idle periods | Refused: nothing carries over |
| P5 | 1.00 in the same situation | Allowed |
| C1–C3 | Three transfers of 0.40, one block, consecutive nonces | First two allowed, third refused; 0.20 left |
| C4 | A stranger's transfer in the same block | Refused: `InvalidDelegate()` |
| M1–M3 | Two active permissions, 1.00 through each, then 0.01 more | 1.00 and 1.00 allowed, then refused |

**What M1–M3 mean.** Each permission has its own cap, so the cap limits a
permission, not an account. Veyra has to hold exactly one active permission
per user, and check for others before it relies on the cap. MetaMask's dialog
warns the user about similar permissions already granted.

### Recipient, token and call

| # | What Nova tried | Refused by |
| --- | --- | --- |
| V1 | Transfer to someone else | `AllowedCalldataEnforcer:invalid-calldata` |
| V2 | Another ERC-20 to the hot wallet | `ERC20PeriodTransferEnforcer:invalid-contract` |
| V3, V4 | `approve` / `increaseAllowance` for 1,000 USDC | `invalid-method` |
| V5 | `transferFrom(user, hot wallet)` | `invalid-execution-length` |
| V6 | `transfer` with 32 extra bytes | `invalid-execution-length` |
| V7 | Native value (Arc's gas USDC) to the hot wallet | `invalid-execution-length` |
| V8 | `transfer` with native value attached | `ValueLteEnforcer:value-too-high` |
| V9 | Batch mode, two transfers | `CaveatEnforcer:invalid-call-type` |
| V14 | Try mode (failures not reverted) | `CaveatEnforcer:invalid-execution-type` |
| V10 | A stranger redeems | `InvalidDelegate()` |
| V11 | Nova sub-delegates to a stranger, who redeems | `RedeemerEnforcer:unauthorized-redeemer` |
| X1 | A permission signed for Base (chain 8453) | `InvalidERC1271Signature()` |

**Two notes on these results:**
- **V13, a valid transfer after all of the above, passed.** A refused attempt
  leaves no trace.
- **V12 shows what the redeemer rule adds.** Without it, a stranger could
  redeem through Nova's sub-delegation, though only to the hot wallet and
  only within the cap. The pilot keeps the rule.

### Revocation, as the user and Nova would do it

| # | Step | Result |
| --- | --- | --- |
| R1, R2 | The user calls `disableDelegation`; Nova then redeems | Refused: `CannotUseADisabledDelegation()` |
| R3 | The hot wallet pays a seller from money pulled earlier | Allowed. Revocation does not reach the hot wallet |
| R4 | Veyra sends the rest back to the user | Allowed |
| R5, R6 | The user re-enables the same permission; Nova redeems | Allowed. Only the user can re-enable |
| R7, R8 | The user calls `NonceEnforcer.incrementNonce(DelegationManager)`; Nova redeems | Refused: `invalid-nonce`. This revokes every permission the account granted through MetaMask |
| R9–R11 | The user switches the account back to a plain EOA; Nova redeems | Refused while plain |
| R12, R13 | The user upgrades again; Nova redeems the old permission | **Allowed.** Switching back only paused it |
| R14 | A revocation and a redemption in one block, revocation first | Redemption refused |
| R15 | The same, redemption first | Redemption allowed |
| E1, E2 | A permission with a one-hour expiry, used inside and after the hour | Allowed, then `TimestampEnforcer:expired-delegation` |
| Z1, Z2 | The DelegationManager's owner pauses it; Nova redeems | Refused: `EnforcedPause()` |
| Z3, Z4 | While paused, the user disables one permission and bumps the nonce | Both allowed |
| Z6 | After unpausing, Nova redeems a permission the user did not touch | Refused: the nonce bump covered it |

**What R14 and R15 mean.** Whichever transaction the block orders first
wins. A leaked Nova key could jump ahead of a revocation with a higher tip and
take what is left of the current period, but no more.

**What R11 hides.** The permission's signature passes as a plain EOA
signature, and every enforcer runs. The transfer fails only because the
account has no code to execute it.

**The DelegationManager's owner.** On Arc the owner, `0xB040…9f44`, is an EOA,
not a contract. A pause stops redemptions and moves nothing.

### The fallback: a separate HybridDeleGator account

| # | Step | Result | Gas (fork) |
| --- | --- | --- | --- |
| H1 | The user's EOA deploys a HybridDeleGator it owns through SimpleFactory | Allowed; the proxy points to `HybridDeleGatorImpl` | 186,725 |
| H2–H5 | Same permission: 0.60, then 0.60 more, then another recipient, then a stranger | Allowed, then refused three times | 356,825 for H2 |
| H6 | The owner calls the account's `disableDelegation` directly | Refused: `NotEntryPointOrSelf()` | — |
| H7 | The owner signs a UserOp for `disableDelegation` and submits it to EntryPoint v0.7 | Allowed; the account paid its own prefund | 202,456 |
| H8 | Nova redeems | Refused: `CannotUseADisabledDelegation()` | — |
| H9 | The owner withdraws the rest to its EOA by a UserOp | Allowed | 118,062 |

The owner needed no bundler and no paymaster. On Arc, the account's own USDC
pays for its UserOps.

### Cost on Arc mainnet, with the real USDC

The gas price was 20 gwei, Arc's minimum base fee. Estimates come from
`eth_estimateGas` on mainnet state, except where marked.

| Transaction | Who pays | Gas | Cost |
| --- | --- | --- | --- |
| Upgrade the account (type 4) | User | 36,844 (fork) – 46,382 | $0.0007–0.0009 |
| Grant the permission | User | none: a signature | $0 |
| Top-up, first use of a permission | Nova | 355,000–380,000 | $0.0071–0.0076 |
| Later top-ups | Nova | about 100,000 less, by the fork | about $0.005 |
| A refused top-up still costs | Nova | about 120,000 (fork) | about $0.0024 |
| `disableDelegation` | User | 94,745 | $0.0019 |
| `incrementNonce` (revoke all) | User | 46,284 | $0.0009 |
| Sweep from the hot wallet back to the user | Hot wallet | 49,338 | $0.0010 |
| Hybrid: deploy / revoke by UserOp / withdraw by UserOp | User | 186,725 / 202,456 / 118,062 (fork) | $0.004 / $0.004 / $0.0024 |
| Gateway: send a Gateway balance to an Arc address | Gateway balance | — | $0.0035 plus a mint transaction, or $0.0179 with Circle's forwarder |

**Two things follow from these costs:**
- **Nova simulates every top-up with `eth_call` first.** A refused top-up
  costs gas. A simulation costs nothing.
- **Topping up per payment would double the cost of a cheap purchase.** An
  Exa search costs $0.007, so the hot wallet keeps a small float instead.

## Which wallet

**MetaMask, upgrading the user's existing account with EIP-7702.** Evidence,
all read on 24 September:

- **The 7702 flag.** MetaMask's production feature flags
  (`client-config.api.cx.metamask.io`, `environment=prod`) list `0x13b2` in
  `confirmations_eip_7702.supportedChains`. Arc's entry names
  `0x63c0…E32B`, the DeleGator tested here.
  - The entry is signed. The signature recovers to the key the extension
    carries for these entries.
  - The flag read the same at 17:49 and 21:48 UTC.
- **The permission types.** The same flags enable `erc20-token-periodic`,
  among others, as an Advanced Permission.
- **The snap.** MetaMask's `gator-permissions-snap` 2.5.0 accepts three rules
  for `erc20-token-periodic`: `expiry`, `redeemer` and `payee`, the payee
  limited to one address.
  - It has no Arc entry of its own, so it falls back to chain 1's table.
    That table holds the same v1.3 addresses that are deployed on Arc.
  - Its dialog shows the amount, the period, the start, the expiry, the
    redeemers, the payees and the account's balance.
  - When the account is not yet upgraded, it warns: "This account will be
    upgraded to a smart account to complete this permission." After *Grant*,
    it asks MetaMask to upgrade the account (`wallet_upgradeAccount`),
    which is a transaction the user confirms. Then it signs the permission.
  - If MetaMask reports that the account cannot be upgraded, *Grant* is
    disabled.
- **A site cannot ask MetaMask to sign a raw delegation for the user's own
  account.** MetaMask refuses unless the request decodes to one of its known
  permissions. So the site has to use `wallet_requestExecutionPermissions`.
- **Revocation in the wallet.** MetaMask keeps a list of granted permissions
  and has a revoke action. The screens were not clicked through.

**Why this wallet.**
- The user keeps their address and their key.
- The user sees MetaMask's own dialog, not Veyra's.
- MetaMask builds exactly the permission tested above, with the same
  contracts.
- The user's own payments from the account still work: the earlier
  simulation had them sign x402 payments as before (C8).

**Not yet seen in the real UI.** Creating even a throwaway MetaMask wallet
means accepting MetaMask's terms. That was left to the owner. The pilot's
first step is exactly this check, with about $0.02.

*(Corrected on 26 September. The owner ran that step, and MetaMask refused to
sign. The evidence above came from MetaMask's feature flags and its permission
snap. The decoder that decides whether MetaMask signs uses another table, and
that table has no Arc mainnet. See
[autonomy frozen](2026-09-26-autonomy-frozen.md).)*

**The fallback: for wallets without 7702, or accounts MetaMask cannot
upgrade.** The user's EOA deploys a HybridDeleGator that it owns, and moves
the budget into it.
- The user signs the delegation as ordinary EIP-712 data. MetaMask's rule
  above does not apply, because the delegator is the new smart account, not
  the user's own account.
- Revoking and withdrawing need a UserOp signed by the user's key (H6–H9).
  Veyra's page can build one, and the user's EOA can submit it itself.
- **The cost of the fallback:**
  - the budget moves to a new address;
  - the user needs a page or tool that builds UserOps to leave.

  So it is the fallback, not the default.

**Other routes stay closed on Arc mainnet** (see the C/D note):
- Coinbase's SpendPermissionManager and Rhinestone's Smart Sessions are not
  deployed.
- Circle's modular wallets have no limit module.

## The architecture

| Part | What it is | What it can do | What it cannot do |
| --- | --- | --- | --- |
| **U**, the user's account | Their MetaMask EOA, upgraded to `EIP7702StatelessDeleGator` | Everything, with the user's key: pay, revoke, re-enable, switch back | — |
| **P**, the permission | A delegation from U to N, with the six caveats above | Let N move USDC from U to H, up to the cap per period, until expiry | Pay anyone else, move another token, approve, carry allowance over, outlive a revocation |
| **N**, Nova's redeemer key | An EOA held by Veyra, with a little USDC for gas | Call `redeemDelegations` to top up H | Sign for U; revoke P; send anywhere but H |
| **H**, Nova's hot wallet for this user | An EOA on the signer host, one per user | Sign x402 payments (EIP-3009) through Veyra's boundary; later, deposit into Gateway for itself; send money back to U | Pull from U |
| **G**, H's Gateway balance | Optional, for Gateway-only sellers; not in the pilot | Pay Gateway sellers, by H's signature | — |

```text
User's account U (MetaMask, EIP-7702)
  │  permission P: ≤ cap per period, USDC.transfer to H only, redeemed by N only, until expiry
  ▼
N (Veyra) ── redeemDelegations ──▶ DelegationManager ──▶ U: USDC.transfer(H, x)
                                                           │   top-ups only under the float rules below
                                                           ▼
H (signer host) ── x402: quoteX402Call → host signs EIP-3009 from H → settleX402Call → reconciliation
                ├─ Gateway, later: deposit for itself; payments signed by H
                └─ sweep back to U on revocation, expiry or excess
```

**Why H is needed at all.** An x402 payment is an EIP-3009 authorization
signed for the payer. The user's DeleGator accepts only the user's own key
for that (C9 in the C/D note). So Nova cannot pay from U. It pays from H,
which the permission fills.

**Where the keys live.**
- **In production, N and H in different places.** N sits with Veyra's
  server as a top-up job, and H on the signer host.
  - A breach of Veyra's server yields N, which can only move the user's
    money into H, and forged quotes, which the host signs only within its
    own limits.
  - A breach of the host yields H, which can spend only what H already
    holds.
- **In the one-owner pilot, both on the owner's machine,** with at most $1
  at risk.

**Veyra's execution boundary is unchanged.** Sellers are paid only through
`quoteX402Call`, a signature, `settleX402Call` and reconciliation, as in the
[signer note](2026-09-23-d1-operational-signer.md). H is that note's
operational signer.

For the payment leg, four of that note's changes are still needed:
- **Change 1.** The payer comes from the mandate: here, H.
- **Change 3.** The claim reserves the mandate's budget.
- **Change 4.** The attempt records its mandate.
- **Change 6.** A queue of signature requests.

Change 2, smart-account signatures, is not needed, because H is an EOA.
Change 5, Arc mainnet in the payment tables, is in place.

**New, and not payments.** C adds four parts. None of them quotes, signs an
x402 payment or pays a seller:
- **A permission record:** the terms, the delegation hash and its status.
- **The top-up job (N):** it can reach only H, and the chain enforces that.
- **A watcher for revocation and expiry.**
- **The sweep:** it goes only to U, and the host enforces that.

**The one change to the host's rules.** Besides EIP-3009 authorizations, the
host may send exactly two kinds of transaction:
- `USDC.transfer(U, x)`, back to the account that granted the permission;
- later, a Gateway deposit for itself, up to the Gateway ceiling.

It sends nothing else.

## Controlling the hot wallet

### Four limits, not one

| Limit | What it bounds | Enforced by | Changed by |
| --- | --- | --- | --- |
| **The cap per period** in P | How fast money moves from U into H | The chain | Only the user: a new permission |
| **The ceiling F** | How much H holds at once: its USDC, its Gateway balance, reserved authorizations and top-ups in flight | Veyra's top-up job: it stops topping up at F | Veyra |
| **The mandate** | What Nova spends: per payment, per day in the account owner's time zone, in total | Veyra's decision and the budget reservation | The account owner, by approving a new mandate |
| **The host's own limits** | What H signs: per payment and per day, from the host's own ledger | The signer host, whatever Veyra's server says | Whoever runs the host |

**Why the daily cap is not a daily spending limit.** Take a cap of 0.50 a day
and a ceiling of 0.50.
- H starts the day full, at 0.50.
- Nova spends it in the morning.
- N tops up with the new period's 0.50.
- Nova spends that too.

That is 1.00 in one calendar day. In general, one day's spending can reach F
plus one period's cap, and Gateway spending adds to it. Only the mandate
limits spending per day. The cap limits the rate of refills, and F limits
the stock.

**Numbers for the pilot:**
- cap 0.50 a day;
- F = 0.50;
- no Gateway;
- mandate 0.05 per payment, 0.50 per day, 1.00 in total.

**Defaults proposed for users:**
- **The cap:** chosen by the user, $1 a day by default.
- **F:** the smaller of the cap and $1, plus at most $0.50 of Gateway
  balance, and only for users whose purchases need Gateway.
- **Expiry:** at most 30 days, renewed by a new grant.
- **A global ceiling:** Veyra also keeps one ceiling on the sum of F across
  all users.

### Top-up rules

N tops up H only when all of these hold:

1. Autopilot is on (`VEYRA_AUTOPILOT_ENABLED`), and the user's mandate is
   active and has budget left.
2. H's USDC is below the low-water mark, a quarter of F.
3. Every outflow from H since the last top-up matches Veyra's ledger:
   - a settled payment;
   - a Gateway deposit;
   - a sweep.
4. A simulation of the exact redemption succeeds on the latest block.

**The amount** is the smallest of:
- F minus H's current holdings (its USDC, its Gateway balance, reserved
  authorizations and top-ups in flight);
- what is left of the period, from the enforcer's `getAvailableAmount`;
- what the mandate can still spend;
- the user's USDC minus $0.05.

It is at least $0.10, so that gas stays under a few percent.

**Why leave $0.05 with the user.** On Arc, USDC is also the gas. An account
emptied to zero cannot pay for its own revocation.

### Stop rules

The top-up job stops, and the host stops signing new payments for that user,
when any of these happens:

- **The permission is no longer usable.** Any of:
  - it was disabled;
  - its nonce is stale;
  - it expired;
  - the account no longer carries MetaMask's DeleGator.

  This is checked by the pre-send simulation and by watching the manager's
  `DisabledDelegation` events.
- **The ledger does not match.** Money left H or its Gateway balance that
  the ledger does not explain.
- **H holds more than F.** The excess goes back to U.
- **Veyra's side switched off.** Any of:
  - the mandate was revoked or expired;
  - its budget is used up;
  - autopilot is off.
- **Something failed unexpectedly.** A top-up or payment failed with anything
  other than a known refusal.
- **The DelegationManager is paused.** It fails closed on its own.

A stop is final for a revocation or an expiry. For the other causes it is a
pause, until the owner has looked.

### Independent revocation

**The user can revoke without Veyra.** Each way needs about $0.001–0.002 of
USDC in the account for gas.
1. **MetaMask's own revoke** for granted permissions. It sends
   `disableDelegation` from the account.
2. **The same transaction from any tool that can send calldata.**
3. **Revoke everything at once, with no site at all.** Send, from the
   account:
   - to `0xDE4f2FAC4B3D87A1d9953Ca5FC09FCa7F366254f` (the nonce enforcer);
   - with data
     `0xf5743c4c000000000000000000000000db9b1e94b5b69df7e401ddbede43491141047db3`.

   This is `incrementNonce(DelegationManager)`. It ends every MetaMask
   permission the account has granted (R7, Z4).
4. **Wait for the expiry.**
5. **Move the USDC out.** A permission cannot pull what is not there.

Veyra's own Revoke button is a convenience, not a requirement.

**Veyra can stop Nova without the user:**
- switch autopilot off;
- revoke the mandate;
- stop the top-up job and the host;
- sweep.

What Veyra cannot do is revoke P on the chain. Only the delegator can. A
leaked N stays usable until the user revokes or P expires, although
everything it moves still lands in H.

**Rotating N or H needs the user.** Both addresses are inside the signed
permission, so a new key means a new grant.

### Gateway funds

Gateway is not in the pilot. When it is used:

- **Deposits.** H deposits for itself, only for sellers that take Gateway
  payments, and up to the Gateway part of F. H's Gateway balance counts
  toward F.
- **How long signatures stay valid.** Each Gateway payment H signs stays
  valid for up to seven days:
  - Circle's batched facilitator on Arc asks for at least 604,800 s;
  - Circle's client signs for 7 days and 100 s.

  Veyra reserves each signed authorization until it sees it settled or
  expired. What H can still spend is the balance minus these reservations.
- **H's key controls the whole Gateway balance.** A burn intent signed by H
  can send it to any recipient, on any chain, at once. So it is as exposed as
  H's own USDC.
- **Two ways out:**
  - **Fast:** a burn intent from Arc to Arc naming U. Circle charges $0.0035,
    plus the mint transaction, or $0.0179 in total with Circle's forwarder.
  - **Without Circle's API:** `initiateWithdrawal`, then 1,209,600 blocks
    (about seven days), then `withdraw` to H, then the sweep.

  Circle documents that a transfer from a chain to the same chain has no
  transfer fee.
- **After a revocation:**
  - H signs nothing new;
  - it keeps enough for the reserved authorizations;
  - it sends the rest to U at once;
  - the remainder follows when the last reservation settles or expires,
    within seven days.

### Money already in the hot wallet

- **The chain stops new transfers into H** from the block where the
  revocation lands. A top-up ordered before it in the same block still goes
  through (R15), up to the rest of the current period.
- **Money already in H stays under Veyra's key.** The user's revocation does
  not touch it: in R3, H paid a seller afterwards.
- **What Veyra commits to do:**
  1. After a revocation or an expiry, let payments already signed finish.
     - A quote lives at most 180 s.
     - A wallet authorization lives at most an hour, by the host's rule.
     - Unused wallet authorizations can be cancelled at once with USDC's
       `cancelAuthorization`.
  2. Send the rest back to the account that granted the permission, and to
     no other address.

  The sweep costs about $0.001, paid from H's own balance.
- **The user cannot force this on the chain.** What bounds it is F. That is
  Veyra's rule, not the chain's, and the product has to say so.

### If a key leaks

| Leaked | What the attacker can do | What bounds the loss | What stops it |
| --- | --- | --- | --- |
| N | Move the cap per period from U, only to H | Nothing is lost directly, since the money lands in H. But H's stock can exceed F | The user's revocation, or the expiry |
| H | Spend H's USDC and Gateway balance, at once, anywhere | F, plus at most one top-up that N makes before it sees an unexplained outflow | N's reconciliation check. The money already in H is lost |
| N and H (one host) | Pull the cap every period and spend it | F plus the cap for each period until the user revokes. Never beyond the expiry or the account's balance | The user's revocation, or the expiry |
| Veyra's server, not the keys | Forge a clearance, so the host signs a payment to a payee the forged quote names | The host's own per-payment and daily limits, and H's balance | The host's ledger, and the owner stopping the host. An allowlist of payees on the host would narrow this further |
| The DelegationManager's owner (an EOA) | Pause redemptions | Nothing moves | Revocation still works during a pause (Z3, Z4) |
| The user's key | Everything in the account | The account | Outside Veyra |

## How a user connects

**Before:**
- MetaMask with a regular account (13.49.0 is the version read);
- USDC on Arc mainnet in that account: the budget, plus about $0.01 for gas.

**The steps:**

1. **Connect and switch to Arc.** On Veyra's autopilot page, the user
   connects MetaMask. Veyra asks it to add or switch to Arc with
   `wallet_addEthereumChain`, using the values already in `lib/wallet/arc.ts`.
2. **Read the terms first.** Before any wallet prompt, Veyra states, in
   plain words:
   - how much per day, to which address (Nova's payment wallet for this
     user), used by whom (Veyra's redeemer), until when;
   - the most that payment wallet ever holds;
   - that money already moved there is spent only through Veyra's checks,
     and comes back on revocation;
   - how to revoke, including without Veyra.
3. **Veyra asks MetaMask for the permission:**

   ```json
   [{
     "chainId": "0x13b2",
     "to": "<N, Veyra's redeemer>",
     "permission": {
       "type": "erc20-token-periodic",
       "isAdjustmentAllowed": false,
       "data": {
         "tokenAddress": "0x3600000000000000000000000000000000000000",
         "periodAmount": "<cap in USDC base units, hex>",
         "periodDuration": 86400,
         "startTime": "<now, unix seconds>",
         "justification": "Nova may move up to <cap> USDC a day from this account to its payment wallet, until <date>"
       }
     },
     "rules": [
       { "type": "expiry", "data": { "timestamp": "<unix seconds>" } },
       { "type": "redeemer", "data": { "addresses": ["<N>"] } },
       { "type": "payee", "data": { "addresses": ["<H for this user>"] } }
     ]
   }]
   ```

   The method is `wallet_requestExecutionPermissions`. `periodDuration`,
   `startTime` and `timestamp` are numbers, not strings.
   `isAdjustmentAllowed: false` keeps the terms as stated. To change them,
   Veyra asks again.
4. **MetaMask shows its own dialog,** with the upgrade warning. The user
   clicks *Grant*, then confirms the upgrade transaction (about $0.001).
   MetaMask signs the permission itself.
5. **Veyra checks the answer before using it.** It receives `context`,
   `delegationManager` and `dependencies`. Then:
   - **The delegation.** It decodes it: delegator = the user, delegate = N,
     and the six caveats with exactly the requested terms.
   - **The account.** Its code is `0xef0100` followed by
     `63c0c19a282a1b52b07dd5a65b58948a07dae32b`.
   - **Two simulations on the latest block.** A small top-up to H passes,
     and one to any other address fails.

   Anything different is not used, and the user is asked to revoke it.
6. **Veyra issues Nova's AUTOPILOT mandate,** with H as the payer
   (`subjectWallet`). It sets limits per payment, per day and in total, and
   expires no later than the permission. The user approves it as today. Its
   limits are what Nova may spend.
7. **In use:**
   - Nova's top-ups appear in the user's MetaMask activity as transfers from
     their account to the payment wallet.
   - Every payment appears in Veyra's ledger with the seller, the amount and
     the settlement.
8. **To stop:** revoke in MetaMask, or with Veyra's button, or let it
   expire. Veyra then sweeps the payment wallet back and shows the
   transaction.
9. **To leave the smart account (optional):** switch back to a regular
   account in MetaMask, but only after revoking. Switching back alone pauses
   the permission, and it returns if the account is upgraded again.

**The fallback path** replaces steps 3–5 with:
- the user deploys their own HybridDeleGator;
- the user moves the budget into it;
- the user signs the delegation.

Revoking and withdrawing are UserOps built on Veyra's page and submitted by
the user's EOA.

## Not verified

1. **MetaMask's real UI on Arc mainnet:**
   - the permission dialog;
   - the upgrade confirmation;
   - the revoke screen.

   This is the pilot's first step. What MetaMask's "switch back to a regular
   account" does to granted permissions is also unseen.
2. **Real USDC in sequence.** The sequences ran against a stand-in token.
   Single steps against the real token were simulated or estimated on
   mainnet.
3. **A payment from H.** The owner's Exa purchase on Arc was a plain EOA's
   EIP-3009 authorization, so H should be accepted the same way. It still
   waits on the signer changes above.
4. **The top-up job, the watcher and the sweep** are designed here, not
   built.
5. **Bounded custody.** Veyra holds up to F per user in H. Accepting that,
   legal side included, is the owner's decision, as the C/D note said.

## Not done

- No MetaMask wallet was created, and MetaMask's terms were not accepted.
- Nothing was sent to Arc mainnet, and no money moved.
- Nothing was built in Veyra's app.
