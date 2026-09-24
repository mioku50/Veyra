# Other users' wallets on Arc mainnet: options C and D, checked without money

On 24 September the owner asked how other people could give Nova a wallet it
can spend from on its own, without a CLI. Five routes were compared in chat.
The owner then asked for two of them to be checked on Arc mainnet:

- **C. A smart account with an onchain limit.** The user's account lets
  Nova's key spend within a limit the chain enforces, and the user can revoke
  it.
- **D. A Gateway deposit with a delegate.** The user deposits a budget into
  Circle Gateway and authorises Nova's key as a delegate on that deposit.

The letters are the chat's. [The D1 wallet comparison](2026-09-23-d1-wallet-comparison.md)
uses C for the same idea, but its D is something else.

**How it was checked:**
- 24 September 2026, around 17:00 UTC.
- Arc mainnet over its public RPC:
  - the code at known contract addresses;
  - view calls;
  - simulations with `eth_call` and state overrides.
- Circle Gateway's public API: `/v1/info`, `/v1/x402/supported`, and
  `/v1/x402/verify` with throwaway keys. Nothing was settled.
- Circle's and Arc's documentation, through their MCP servers.
- Package sources:
  - Circle CLI 1.1.4;
  - `@circle-fin/x402-batching` 2.0.4 and 3.5.0;
  - `@x402/evm` 2.6.0;
  - `@metamask/smart-accounts-kit` 2.0.0 and
    `@metamask/delegation-deployments` 2.0.0.
- No funded key signed anything, nothing was broadcast, and no money moved.

The raw results are in [the evidence file](2026-09-24-arc-c-d-evidence.json).

## In short

- **C works on Arc mainnet in simulation**, with contracts that are already
  deployed there. The daily cap, the fixed recipient and revocation were all
  enforced. Three things remain:
  - a wallet flow for users;
  - a real run;
  - a decision on who holds Nova's keys.
- **D's decisive question is still open.** Gateway's delegate mechanism is
  live on Arc mainnet. What is not known is whether Circle accepts an x402
  payment *signed by a delegate*:
  - Circle does not document it;
  - Circle's own clients do not support it;
  - Circle's own Agent Wallet does not use it.

  One test would settle it. It costs about $0.002: two transactions from the
  owner's wallet. It was not run.
- **Even if D works, nothing limits it but the deposit.** C has a cap per
  period and a fixed recipient.
- **This reverses the chat's recommendation**, which put D first and C later.
  On what Arc mainnet has today, C comes first.

## This corrects the D1 comparison

[The D1 comparison](2026-09-23-d1-wallet-comparison.md) made three claims that
this check changes:

- **It said C needs "a custom module, then an audit".** On Arc mainnet the
  cap is MetaMask's delegation framework, not code Veyra would write, and it
  is already deployed.
- **It said C reaches the market "only through extra plumbing".** The
  plumbing is one hot wallet.
- **It said a smart account uses Gateway through an EOA delegate.** Circle's
  documentation says that for burn intents. Circle's own Agent Wallet CLI does
  it differently: the smart account deposits *for* its backing EOA with
  `depositFor`, and that EOA signs the payments.

## What Arc mainnet already has

| Piece | On Arc mainnet | Why it matters |
| --- | --- | --- |
| EIP-7702 | Supported. See the notes below. | A user's existing wallet address can become a smart account without moving funds |
| P256 precompile at `0x100` | Works: a valid signature returns 1, an invalid one returns nothing | Passkey accounts verify cheaply |
| ERC-4337 EntryPoints | v0.6, v0.7, v0.8 and v0.9 are all deployed | Smart accounts and bundlers |
| MetaMask's delegation framework, v1.3 | Deployed. See the notes below. | A cap per period that already exists onchain |
| Circle's modular wallet contracts | The MSCA v1 factory, its implementation and the Address Book module are deployed, byte-identical to Base. Circle documents the modular wallet service for Arc Testnet only, and there is no spending-limit module. | Not a route to a cap |
| Circle Paymaster | Not deployed, though it is on Base | Arc pays gas in USDC anyway |
| Safe 1.4.1 | Deployed, with its 4337 module and the Allowance Module 0.1.1 (`0xAA46…091C`) | Another way to build a cap |
| Coinbase SpendPermissionManager, Rhinestone Smart Sessions | Not deployed, though both are on Base at the same addresses | — |
| Permit2 | Deployed. The x402 exact Permit2 proxy is not, though it is on Base. | x402 on Arc means EIP-3009 |
| USDC (FiatTokenV2) | Accepts EIP-3009 from an address with code, through ERC-1271, in both forms. Details below. | A smart account can be the x402 payer, as far as the token is concerned |
| Gateway | See the notes below | D's building blocks |

**EIP-7702:**
- Arc's documentation says Arc targets the Osaka hard fork, EIP-7702
  included.
- The node estimates a type-4 transaction.
- 34 of 17,705 transactions in 1,600 recent blocks were type 4.

**MetaMask's delegation framework:**
- Deployed on Arc mainnet:
  - the DelegationManager;
  - the 7702 and hybrid DeleGators;
  - SimpleFactory;
  - the period, amount, target and redeemer enforcers.
- The enforcers are byte-identical to Base.
- The DelegationManager and the DeleGators differ from Base in about 32
  bytes. That is consistent with a chain-specific EIP-712 value fixed at
  deployment.
- The DelegationManager has the same owner as on Base, and it is not paused.
- MetaMask's own deployment list names Arc Testnet but not Arc mainnet.

**USDC (FiatTokenV2):**
- Tested with a contract payer whose signature check always accepts, and
  with one that always rejects.
- The accepting payer succeeds.
- The rejecting payer fails with "FiatTokenV2: invalid signature".

**Gateway:**
- The Wallet and the Minter are on domain 26.
- USDC is supported, and the delegate functions are present.
- The trustless withdrawal delay is 1,209,600 blocks, about 7.1 days.
- Circle's batched facilitator lists `eip155:5042`.

## Option C, simulated

**The setup:**
- **The user** is a throwaway EOA. State overrides give it:
  - the EIP-7702 designator for MetaMask's `EIP7702StatelessDeleGator`;
  - 5 USDC.
- **The delegation.** The user signs a delegation to a throwaway "Nova" key,
  built with MetaMask's kit for chain 5042. It allows:
  - at most 1.00 USDC per 24 hours (`ERC20PeriodTransferEnforcer`);
  - `transfer` only to one throwaway "hot wallet" (`AllowedCalldataEnforcer`).
- **The call.** Nova's key calls `redeemDelegations` on the DelegationManager
  deployed on Arc mainnet.

| # | What was tried | Result |
| --- | --- | --- |
| C1 | Nova moves 0.50 USDC to the hot wallet | Succeeds |
| C2 | Nova moves 1.50 USDC at once | Refused: `transfer-amount-exceeded` |
| C3 | Nova moves 0.60 USDC, then 0.60 more, in one transaction | Refused: `transfer-amount-exceeded` |
| C4 | Nova moves 0.50 USDC to another address | Refused: `invalid-calldata` |
| C5 | Someone other than Nova redeems the delegation | Refused: `InvalidDelegate()` |
| R1, R2 | Nova redeems before and after the user disables the delegation | Succeeds, then refused: `CannotUseADisabledDelegation()` |
| R3 | The user calls `disableDelegation` | Succeeds |
| C8 | The user pays an x402 seller from the upgraded account, signing as usual | Succeeds |
| C9 | Nova signs an x402 payment from the user's account | Refused: `FiatTokenV2: invalid signature` |

Arc's RPC does not support `eth_simulateV1`, so no sequence of two
transactions could be run. Instead:
- the cap across payments was tested inside one transaction (C3);
- revocation was tested by writing the DelegationManager's
  `disabledDelegations` entry directly (R2).

### What it means

- **Nova's key is bounded three ways.** It can move at most the cap per
  period, only to the named recipient, and only until the user disables it.
- **Nova pays from the hot wallet**, because it cannot sign x402 payments for
  the user's account (C9). It can pay in two ways:
  - **Directly, with an EIP-3009 authorization.** The owner's Exa purchase on
    Arc on 24 September was paid this way.
  - **From a Gateway balance the hot wallet deposits for itself.** That is
    Circle's documented pattern, and what the Agent Wallet CLI does.

  The Gateway route matters on Arc. All 482 offers in Circle's catalogue there
  are paid through Gateway, and only Exa's two also take a plain wallet payment
  ([Arc-first note](2026-09-23-arc-first-market-and-discovery.md)).
- **The user can still pay with their own key** from the upgraded account
  (C8).
- **A smart account can be the x402 payer itself, through ERC-1271, but that
  is not recommended.** An ERC-1271 check can only read, not record, so it can
  cap one payment but not a running total. No module on Arc does this.

### Not verified for C

1. **The user's wallet.** Nobody knows yet whether a wallet will upgrade an
   EOA to MetaMask's DeleGator on chain 5042. MetaMask's kit lists Arc
   Testnet, not mainnet.

   A fallback needs no 7702:
   - create a HybridDeleGator smart account through SimpleFactory, owned by
     the user's EOA or a passkey;
   - fund it.

   It uses the same contracts, but it was not simulated.
2. **A real run.** One of each:
   - an upgrade or a deployment;
   - a signed delegation;
   - a redemption;
   - an x402 payment from the hot wallet.

   Gas on Arc costs a fraction of a cent per step.
3. **Custody.**
   - Veyra would hold Nova's redeeming key and the hot wallet's key.
   - Whatever sits in the hot wallet is under Veyra's control: at most one
     period's cap if Nova spends as it goes, plus any Gateway deposit it
     makes.

   That is bounded custody. Whether to accept it, legal side included, is the
   owner's decision.
4. **Liveness.** The DelegationManager's owner, the same as on Base, can pause
   it. A pause stops redemptions. It cannot move funds.

*(Later on 24 September, [option C in sequence](2026-09-24-option-c-architecture.md)
changed four points here:*
- *MetaMask's production configuration enables EIP-7702 on Arc mainnet to this
  DeleGator, and its permission snap builds exactly this permission. The real
  screens are still unseen.*
- *The HybridDeleGator fallback was run on a fork of Arc mainnet, including
  revocation and withdrawal.*
- *Revocation, and the cap across separate transactions, were run as real
  transactions on the fork, with no storage written by hand.*
- *The chain does not bound the hot wallet's balance. The cap limits how fast
  money arrives, and Veyra's own ceiling limits how much sits there. "At most
  one period's cap" holds only while Veyra keeps that ceiling.)*

## Option D

**What exists on Arc mainnet:**
- **The delegate functions.** The Gateway Wallet has `addDelegate`,
  `removeDelegate` and `isAuthorizedForBalance`. A depositor is authorised
  for their own balance; a stranger is not.
- **The facilitator.** Circle's batched facilitator settles on
  `eip155:5042`.
- **Adding a delegate from the owner's wallet** simulates without error, with
  no deposit:
  - `addDelegate`: 62,191 gas, about $0.0013;
  - `removeDelegate`: 36,446 gas, about $0.0007.

**What Circle documents:**
- **A delegate signs burn intents.** Those are Gateway transfers, made for a
  depositor. This is how a smart-account depositor uses Gateway: "a full
  allowance for the deposited USDC".
- **Removing a delegate is not retroactive for burn intents.** Burn intents
  it signed earlier stay valid. The API stops accepting new ones once the
  removal is final.
- **App Kit's delegate spend** is `unifiedBalance.spend` with
  `sourceAccount`. It moves funds out of the user's balance, for example to
  Nova's hot wallet. It was not probed.

**Evidence against delegates signing x402 payments:**
- Circle's error table says of `invalid_signature`: "check the signing key
  matches `from`".
- Circle's x402-batching client, in both 2.0.4 and 3.5.0, sets `from` to
  the signer. It has no delegate or depositor option for payments.
- Circle's Agent Wallet CLI deposits with `depositFor(USDC, backingEOA)` and
  signs with that EOA, so it never needs a delegate for payments.

**What Circle's verify endpoint did with throwaway keys:**
- The probe ran against production, on `eip155:5042`, and settled nothing.
- **T1: `from` = A, signed by A, no deposit.** Answer: `isValid: true`.
  Verify checks the signature, not the balance, as `settlement-resolver.ts`
  already records.
- **T2: `from` = B, signed by A.** Answer: `invalid_signature`.

### The test that would decide D

It was not run: it needs the owner's go-ahead and two signatures from the
owner's wallet. It costs about $0.002.

1. Veyra generates a throwaway key D locally.
2. The owner calls `addDelegate(USDC, D)` on Arc mainnet from
   `0x8e52…8909`. The owner's Gateway balance on Arc is 0, so nothing is
   exposed.
3. Veyra calls `/v1/x402/verify` with `from` set to the owner and a signature
   by D:
   - `isValid: true` means Circle accepts x402 payments signed by a delegate;
   - `invalid_signature` means it does not.
4. The owner calls `removeDelegate(USDC, D)`, and D is thrown away.

### If the test passes, D still has these limits

- **Nothing caps the delegate but the deposit.** It can spend all of it.
- **Signed payments outlive revocation, possibly.** Payment authorizations
  are signed for at least 7 days (Circle's `minValiditySeconds` is 604,800).
  Circle does not say whether it settles those signed before
  `removeDelegate`.
- **Getting the money out** is instant through Circle's API with the
  depositor's signature. Without the API it takes 7 days: 1,209,600 blocks.

## C and D side by side

| | C (simulated) | D (if the test passes) |
| --- | --- | --- |
| Onchain cap | Per period, enforced by `ERC20PeriodTransferEnforcer` | None: the deposit is the cap |
| Where Nova can send money | One fixed address: Nova's hot wallet | Any seller or address |
| Revocation | `disableDelegation`, effective from the next block | `removeDelegate`. What happens to payments already signed is undocumented. |
| Where the user's money sits | In the user's own account until Nova pulls it | In the user's Gateway deposit |
| What Veyra holds | The redeeming key and the hot wallet, with at most one period's float | The delegate key, over the whole deposit |
| Sellers that take only Gateway (most of Arc) | Yes, from the hot wallet's own Gateway deposit | Yes, directly |
| Sellers that take a wallet payment (Exa) | Yes, from the hot wallet | Only after a Gateway transfer to a hot wallet |
| What the user needs | A wallet that upgrades on Arc (unverified), or a smart account | Any wallet: a deposit and an `addDelegate` |
| Verified on Arc mainnet | The contracts; the cap, fixed recipient and revocation in simulation | The contracts. The x402 question is open. |

## Next steps (none taken)

1. **Run D's decisive test.** About $0.002: two transactions the owner signs.
2. **Try C for real.** Before one real run on Arc mainnet, decide:
   - the account type: EIP-7702 or a HybridDeleGator;
   - where Nova's two keys live;
   - a test cap, such as $0.10 a day.

   *(Planned in [the minimal real test](2026-09-24-option-c-pilot-plan.md).)*
3. **Decide on bounded custody.** The owner's decision comes before either
   route reaches other users.
