# D1 — which wallet Nova would pay from, compared without money

The owner asked for this comparison before gate V closes, so that the choice
is ready when it does. Nothing here moved money, created a wallet, opened a
session or accepted terms.

**Sources, all read-only:**
- Circle's agent-stack documentation, fetched on 2026-09-23.
- The Circle CLI 1.1.4 package source. The package is Apache-2.0 and ships its
  TypeScript source inside its source map.
- The Arc documentation.
- Two `eth_getCode` calls to Arc Testnet.
- The owner's own agent, for the market it buys from.

It updates the D1 section of the
[D0/D1 readiness note](2026-09-20-nova-d0-d1-readiness.md), whose acceptance
matrix is still **not run**.

## Where Nova's money would go

> **Corrected the same day.** This section concluded that nothing could be
> bought on Arc. That described Veyra, not the market. Veyra's discovery asks
> Circle's catalogue only for Base and does not know Arc mainnet as a network.
> Asked for Arc mainnet, the same catalogue lists 482 offers. Exa search is
> sold there from a wallet at $0.007, the same price as on Base. See
> [Arc first](2026-09-23-arc-first-market-and-discovery.md). The table below
> is what the owner's agent had seen, not what exists.

The owner's agent has seen 45 distinct paid endpoints:

| Network | Endpoints | How they are paid |
| --- | --- | --- |
| Base | 22 | From a wallet: an EIP-3009 authorization |
| Base | 11 | From a Circle Gateway deposit |
| Not recorded | 12 | — |
| Arc | 0 | Never asked for |

Every paid research so far settled on Base.

~~So an operational wallet has to pay on Base, or through Gateway. A wallet
that can only pay on Arc would have nothing to buy today.~~ Wrong, as the note
above says. An operational wallet can pay on Arc from a wallet balance (Exa,
CRA and a few others) or through Gateway (most of the Arc catalogue), once
Veyra knows Arc mainnet.

## The three open questions

### Does Circle Agent Wallet work on Arc?

Yes. Agent Wallets support Arc mainnet (`ARC`) and Arc Testnet
(`ARC-TESTNET`), alongside Base and six other chains.

Spending budgets are EVM-wide, so one cap covers Base and Arc together.
Spending policies exist on mainnet only. Testnet rejects them, so no test of a
cap can be free.

### Does the cap cover a signature Veyra asks for?

Veyra would ask for a signature through `circle wallet sign typed-data`.
Circle's own x402 payment (`circle services pay`) makes the same backend call,
`POST /user/sign/typedData`, followed by the same challenge. The CLI sends
nothing that marks a payment as a payment.

Circle documents that limits apply to x402 payments. If they do, the backend
enforces them on the typed data itself. In that case, a signature Veyra asks
for is covered exactly as much as Circle's own payment.

The CLI enforces nothing locally. It checks only that the new limits are in
order (per transaction ≤ daily ≤ weekly ≤ monthly) before sending them.

What remains unproven is every other kind of typed data, and contract calls:
- **An EIP-2612 permit.** It lets a spender pull USDC later with no further
  signature from the wallet.
- **`circle wallet execute "approve(...)"`.** It does the same through a
  contract call.

Whether the backend refuses these or counts them decides whether the cap binds
a compromised runtime. Only a mainnet test can show it.

### Can it run from Veyra's server?

Not from a Vercel function.

- **Where the session lives.** The CLI session holds a user token, an
  encryption key, an encrypted user secret and a storage key. It is kept in
  the OS keychain, or, where there is none, in a file with permissions 0600
  under `CIRCLE_CLI_HOME`.
- **How long it lasts.** A session lasts 28 days, and a new one needs a code
  sent to the owner's email.
- **Why not Vercel.** A Vercel function has no keychain and no disk that
  survives between calls. The signer belongs on a small host that stays up.
- **Upgrades.** Circle can set a minimum CLI version remotely, and the CLI
  refuses to work below it. An unattended signer has to be kept up to date.

### Also established

- **The runtime cannot raise its own limit.**
  - A limit change opens a separate human session, confirmed by a code sent by
    email.
  - The CLI refuses an `--email` different from the agent session's.
  - By the CLI's own account of the backend, the server checks that this
    email owns the wallet before it writes the policy.

  So the runtime can raise its limit only if it can read the owner's inbox.
- **Agent wallets are smart contract accounts on every EVM chain.**
  - Their x402 signatures are ERC-1271 signatures. Whether each seller's
    facilitator accepts one has to be tested per seller.
  - Gateway accepts only EOA signatures on burn intents. A smart account uses
    Gateway through an EOA delegate.
- **Arc supports ERC-4337 and EIP-7702.** The v0.7 EntryPoint is deployed on
  Arc Testnet (16,035 bytes of code), and so is the Gateway Wallet.
- **Circle's modular wallets have no spending-limit module.** They ship two:
  the passkey signer and an address book.

## The options

| | A. Circle Agent Wallet | B. Developer-controlled wallet | C. Smart account with onchain permissions | D. A small isolated key and balance |
| --- | --- | --- | --- | --- |
| Where the cap lives | Circle's backend: per transaction and rolling daily, weekly and monthly, plus recipient and contract lists | Veyra's code only | A module onchain | The balance itself |
| Who can change it | Only with a code sent to the owner's email | Whoever holds Veyra's entity secret | The owner's key onchain | Nobody; the balance is what it is |
| The owner can stop it without Nova | Lower the limits or move the funds, by email code | No: Veyra holds the wallet | Yes, onchain | Stop funding it. With a Gateway delegate, also `removeDelegate` |
| Runs from Veyra's server | Only from a separate persistent host | Yes, by API | Yes, with a session key | Yes |
| Pays the live market, on Arc and Base | Yes, if the seller accepts a smart-account signature | Yes | Only through extra plumbing | Yes |
| Arc | Mainnet and testnet | Testnet listed | Third-party providers | Yes |
| Built already | No | No | No | Partly: the canary x402 adapter, on Arc Testnet and off by default |
| Unproven | Permit and approve; seller acceptance | — | Everything: custom module, then an audit | — |
| Guarantee if all goes right | A wallet-level cap the runtime cannot raise | Risk bounded by the funded balance | Onchain cap, revocable by the owner | Risk bounded by the funded balance |

*(2026-09-24, corrected for Arc mainnet by
[options C and D, checked without money](2026-09-24-arc-autonomous-wallets-c-d.md).*
- *C needs no custom module there: MetaMask's delegation framework, with a
  cap per period, is already deployed, and a simulation on mainnet state
  enforced it.*
- *The Agent Wallet CLI does not use a Gateway delegate. It deposits for its
  backing EOA with `depositFor`, and that EOA signs the payments.)*

## Recommendation

**Circle Agent Wallet on mainnet, used as a signer and not as a payer.**

- **Veyra keeps quoting, pinning and dispatch.** The signer receives a request
  for one exact EIP-3009 authorization that matches a Veyra clearance, and
  signs it with `circle wallet sign typed-data`. It takes the browser wallet's
  place between Veyra's quote and settle steps, so this is a new signer, not a
  new payment path. *(Corrected: this said the legacy x402 adapter, which pays
  from a server key on Arc Testnet and is not the flow to extend. See
  [the signer note](2026-09-23-d1-operational-signer.md).)*
- **Not `circle services pay`.** It fetches a fresh 402 and pays whatever payee
  that names. That undoes the payee pinning Veyra exists for, and Parallel
  already issues a new payee on every request.
- **Where it runs.** On a small persistent host the owner controls, holding
  the only CLI session. That host must have no access to the owner's email.
- **How much.** A small balance, with limits set by the owner's email code
  before any money goes in. An unset tier reads as none.

**Accepted only after three mainnet tests, with one or two dollars.** *(Later
the same day: tests 1 and 2 need no money. Circle's limit acts when it is asked
to sign, so they run while the wallet is empty. Only test 3 spends.)*
1. A permit and an approve are refused, or counted against the cap.
2. An EIP-3009 authorization above the per-transaction limit is refused.
3. Exa search on Arc accepts the smart-account signature and settles. It is
   sold there from a wallet. The same test on Base follows.

If test 1 fails, the cap does not bind a compromised runtime, and the
guarantee falls to "risk bounded by the funded balance". Option D gives the
same guarantee with far less machinery, and the product must say so rather
than cite Circle's limits.

The full matrix, of which these three are the core, is in
[the signer note](2026-09-23-d1-operational-signer.md).

## Decisions for the owner

1. **When.** The funded pilot (D2) still waits for gate V. The three tests
   need the owner's email code, and the seller test needs one or two dollars
   of real USDC.
2. **Where the signer runs.** A small always-on host, or the owner's own
   machine for a single-owner pilot.
3. **The limits and the balance.**
4. **The chain.** *(Decided after this note: Arc first, Base additional.)*
   On Arc, Exa and CRA take a payment from the wallet. Most other Arc sellers
   need a Gateway deposit. The cap is shared across both chains.

## Not done

- No agent wallet was created, no CLI session was opened, and Circle's terms
  were not accepted.
- No signature was requested and no money moved.
- The Circle CLI was downloaded as a package to read its source. It was not
  installed and not run.
- The acceptance matrix of 2026-09-20 remains not run.
