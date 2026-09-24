# D1 — where an operational signer plugs in, and what it must pass

[The D1 comparison](2026-09-23-d1-wallet-comparison.md) recommended a Circle
Agent Wallet used only as a signer. The owner then asked five things:

- how it connects to Veyra's existing protected payment flow, without the
  legacy Arc Testnet executor;
- one signer interface for exactly the payment Veyra already approved;
- whether it is compatible with EIP-3009, ERC-1271 and real x402
  facilitators;
- tests of independent limits, of getting round them with a permit or an
  approve, of revocation and of repeated execution;
- how the owner's wallets and powers stay separate from the operational
  wallet and from Veyra's own service roles.

**Sources and limits:**
- Veyra's code, Circle CLI 1.1.4's source, Circle's documentation and
  read-only calls to Arc mainnet and Base.
- The Arc half of the same request is in
  [Arc first](2026-09-23-arc-first-market-and-discovery.md).
- No wallet was created, no session was opened, nothing was signed and no
  money moved.

## The flow that already exists

One purchase goes through three steps, and two surfaces use them: `/run`,
and Nova's research in `lib/nova/research.ts` and
`lib/nova/investigation.ts`.

1. **Quote**, `quoteX402Call` (`lib/x402/execution.ts:341`):
   - reads the live 402 for the exact request body;
   - binds the payee, asset, network, amount and a fresh nonce to a Veyra
     decision;
   - stores the quote for 180 seconds at most, and never beyond the
     decision.
2. **Sign.** Today the owner's browser wallet does this through
   `signPaymentAuthorization` (`lib/x402/sign-payment.ts:66`). It builds the
   typed data with `buildPaymentTypedData` (`lib/x402/browser-payment.ts:269`)
   from the quote's own terms. The wallet interface, `PaymentWallet`
   (`lib/x402/sign-payment.ts:23`), was kept narrow "so a second wallet
   adapter can satisfy it".
3. **Settle**, `settleX402Call` (`lib/x402/execution.ts:620`):
   - claims the quote once (compare-and-swap);
   - checks the body hash, payer, payee, amount, nonce and expiry;
   - opens the ledger record before relaying;
   - relays through the SSRF-safe transport;
   - checks the seller's receipt against the chain.

**What is not the flow:**
- **The legacy executor.** `X402ExecutionAdapter`
  (`lib/execution/adapters/x402.ts`):
  - pays from a key the server holds (`CANARY_DEPLOYER_PRIVATE_KEY`, `:79`);
  - hard-codes Arc Testnet (`:140`, `:206`, `:229`) and its USDC (`:259`);
  - fetches and relays by itself.

  It stays a canary. It is off unless `EXECUTION_ALLOW_SERVER_PAYER` is set.
- **`circle services pay`.** It quotes again by itself and pays whichever
  payee the seller names.

## The connection point

The operational signer takes the browser wallet's place in step 2, and does
nothing else:

```text
Nova (Vercel), under an AUTOPILOT mandate naming the agent wallet
  → Veyra decision
  → quoteX402Call                    stored quote: payee, amount, nonce, expiry
  → signature request                waits, at most the quote's 180 s
       ↑ pulled by the signer host (outbound only)
       → host checks the request against its own limits
       → circle wallet sign typed-data
       → signature posted back
  → settleX402Call                   claim, checks, ledger, relay, receipt
  → reconciliation on the settlement chain
```

**Veyra must change before this can run.** None of it is done.

| # | Change | Why |
| --- | --- | --- |
| 1 | The decision carries the payer named by the mandate, and settle compares against it | Settle refuses any payer but `selection.ownerWallet` (`execution.ts:691`). The operational wallet is not the owner. |
| 2 | Settle accepts a bounded smart-account signature for a registered smart-account payer, checked first with `isValidSignature` on the settlement chain | Settle accepts only 65-byte signatures (`execution.ts:624`). A smart account's signature may be longer. |
| 3 | The claim reserves the mandate's budget in the same transaction, and settles or releases it at the end | `claim_x402_quote` enforces only a per-wallet cap per UTC day, 25 USDC by default. The mandate budget machinery is `reserveBudgetAtomic` (`lib/execution/db.ts:716`). |
| 4 | The attempt records its mandate | The ledger writes `mandateId: null` (`lib/execution/browser-x402-ledger.ts:26`). |
| 5 | Arc mainnet in the payment tables | See the Arc note. Without it, nothing on Arc can be quoted. |
| 6 | A queue of signature requests | One entry per quote waiting for the signer. The host reads it with a credential that can do nothing else. |

This is one payment path with a second signer, not a second payment path.

## One signer interface

Both signers answer the same question: sign exactly this authorization, or
refuse. The browser wallet already implements it as `PaymentWallet`. The
operational signer does it on its own host:

```ts
/** Signs exactly one authorization Veyra already approved, or refuses. */
interface OperationalSigner {
  /** Who pays: the agent wallet (a smart account) for a wallet payment, its
   *  backing EOA for a Gateway payment. */
  payerFor(rail: "wallet" | "gateway_deposit", chainId: number): Promise<`0x${string}`>;
  signExactAuthorization(request: {
    quoteId: string;        // the handle; the terms are read from the quote
    executionId: string;    // opened before signing, so a crash leaves a record
    mandateHash: `0x${string}`;
    typedData: TransferWithAuthorizationTypedData; // buildPaymentTypedData(quote)
  }): Promise<{ signature: `0x${string}` } | { refused: string }>;
}
```

The host checks the request itself, whatever Veyra's server says:

- **Only this type.** `TransferWithAuthorization`, under a domain from its own
  table:

  | Network | Domain | Contract |
  | --- | --- | --- |
  | Arc | `USDC` version `2` | `0x3600…` |
  | Base | `USD Coin` version `2` | Base USDC |
  | Arc and Base | `GatewayWalletBatched` version `1` | `0x7777…` |

- **Only this authorization.** `from` is its own payer. `to`, `value` and
  `nonce` equal the quote.
- **Only this long.** `validBefore` is no more than 1 hour away for a wallet
  payment, and no more than 7 days for Gateway.
- **Only within its own limits.** `value` is within the host's own
  per-payment limit. The day's total, kept in its own ledger, is within its
  daily limit.
- **Only once.** One signature per quote. A repeated request gets the same
  signature back, never a second authorization.
- **Only signing.** The host never calls `execute`, `transfer`,
  `services pay` or `gateway withdraw`, and signs nothing else.

That makes three independent limits, each held by a different party:

| Limit | Held by |
| --- | --- |
| Veyra's decision and mandate | Veyra's server |
| The host's own limits | The signer host |
| Circle's wallet policy | Changeable only with the owner's email code |

## Compatibility, from read-only evidence

| Question | Evidence | Answer |
| --- | --- | --- |
| Does Arc's USDC take EIP-3009? | Its implementation (`0xc6ad664a…`, version `2`) dispatches `transferWithAuthorization` in both forms: `v,r,s` and `bytes`. It also dispatches `receiveWithAuthorization`, `cancelAuthorization`, `permit` in both forms, and `approve`. Base USDC does the same. | **Yes**, read from bytecode. The `bytes` form is how FiatToken 2.2 takes ERC-1271 signatures from smart accounts. |
| Do Circle smart accounts answer ERC-1271? | Circle's documented `circle_6900_singleowner_v3` implementation, `0xD206aC7f…`, is deployed on Arc mainnet and Base. So are its factory and EntryPoint v0.6. Its bytecode dispatches `isValidSignature`. | **Probably**, if agent wallets use that version. The CLI does not say which. |
| Can an agent wallet sign before it has sent a transaction? | The CLI answers "This wallet isn't deployed on-chain yet. Send any transaction first (e.g. a zero-value transfer)". Circle deploys smart accounts on first use. | **No.** Deploy it on Arc (and on Base, if used) first. Gas is sponsored. |
| Who signs a Gateway payment? | The CLI signs as the wallet's backing EOA, `eoaOwnerAddress`. It deposits with `depositFor(USDC, EOA, amount)`, so the Gateway balance belongs to the EOA. | **The EOA.** Whether Circle's limits count EOA-signed payments is unknown. A burn intent signed by the same key can move the whole deposit. |
| Which key signs, and in what form? | The CLI sends the same request for both rails, with the same wallet id. Only the declared signer differs. | **Decided inside Circle.** It is not visible from outside, and must be observed (test B1). |
| Do facilitators accept a smart-account signature? | The reference `@x402/evm` 2.6.0 checks with viem's `verifyTypedData`, which understands ERC-1271 and ERC-6492. It settles through the `bytes` form when a signature is not 65 bytes. It refuses an undeployed smart wallet unless the signature carries ERC-6492 deployment data. | **The reference does.** Circle's facilitator for Exa's Arc wallet payment, CRA's and APEX's own facilitators are not known. Test per seller. |
| Will Veyra's relay pass it? | Settle requires exactly 65 bytes. | **Only if the signature is 65 bytes.** Otherwise change 2 above is needed. |

## The check matrix

Every row is **NOT RUN**. The whole matrix runs on mainnet, because Circle
applies spending policies only there.

**Most of it needs no money.** Circle's limits act when it is asked to sign,
not when a payment settles. So groups B to F run while the wallet is still
empty. Nothing a test signs can then move money, because there is none. Only
group G needs one or two dollars. Circle may refuse to sign for an empty
wallet at all; if it does, record it, and group C moves after funding.

**Protocol for every row that signs:**
- Each test signature names the owner's own address as recipient or spender,
  and expires within 10 minutes.
- Funding starts only after every earlier test signature has expired.
- Any allowance a test creates onchain is set back to zero afterwards.

### A. Set up, by the owner

Free, apart from sponsored gas.

| # | Check | Passes when |
| --- | --- | --- |
| A1 | Log in with the owner's email; record the wallet, its smart-account version and its backing EOA | Addresses recorded; one wallet per EVM chain |
| A2 | Deploy on Arc with a zero-value transfer | Code at the wallet address on Arc |
| A3 | Set limits before any money arrives: per payment, daily, weekly and monthly | `circle wallet limit` shows them. A level left unset reads as no limit. |
| A4 | Open Arc Portal with the same email | Portal shows this wallet and its limits. Otherwise Portal is not the owner's control panel. |

### B. Signature compatibility

Free; the wallet is unfunded.

| # | Check | Passes when |
| --- | --- | --- |
| B1 | Sign an Arc USDC `TransferWithAuthorization` from the smart account | A signature comes back; its length and form are recorded |
| B2 | `isValidSignature(digest, signature)` on the account, read-only | Returns `0x1626ba7e` |
| B3 | Simulate USDC `transferWithAuthorization` with that signature, read-only | Reverts on the balance, not on the signature |
| B4 | Settle's signature check with that signature | Passes, or change 2 is confirmed necessary |
| B5 | Sign a `GatewayWalletBatched` authorization from the backing EOA | The signature recovers to the EOA |

### C. The wallet's own limits

Free, with the limits from A3 in place.

| # | Check | Passes when |
| --- | --- | --- |
| C1 | An authorization above the per-payment limit | No signature is returned |
| C2 | Authorizations that together pass the daily limit | Refused at the limit |
| C3 | A signature that is never relayed | Recorded whether it used up budget |
| C4 | Sign on Arc, then on Base | One shared budget. Otherwise the cap is per chain, and must be said so. |
| C5 | Two requests at once, together over what is left | At most one signature |

### D. Getting round the limits

The decisive group. Each row passes when the request is **refused, or counted
against the limit**.

| # | Attempt |
| --- | --- |
| D1 | An EIP-2612 `permit` on Arc USDC for more than the limit |
| D2 | `circle wallet execute "approve(...)"` for more than the limit |
| D3 | `increaseAllowance` |
| D4 | Approve Permit2 (deployed on Arc), then sign a Permit2 transfer |
| D5 | `ReceiveWithAuthorization` above the limit |
| D6 | A Gateway burn intent to an address the owner has not allowed |
| D7 | A `GatewayWalletBatched` authorization above the per-payment limit |
| D8 | Typed data of a type Circle does not know, and a plain message |
| D9 | `circle wallet transfer` above the limit, as the baseline |

For D8, "refused or counted" means either refused, or shown to authorize
nothing. A smart account's ERC-1271 answers for every protocol that accepts
one, and any such protocol can move value.

### E. Revocation and outstanding authorizations

| # | Check | Passes when |
| --- | --- | --- |
| E1 | The owner lowers the limits, by code or in Portal | The host's next request is refused. The delay is measured, from a second process. |
| E2 | The runtime tries to change its own limits, with no code or another email | Refused |
| E3 | An authorization signed before the stop is still outstanding | Veyra keeps it reserved until it settles, expires or is cancelled. `cancelAuthorization` on Arc USDC is tried, and the cancellation is read back from `authorizationState`. |
| E4 | The session reaches 28 days, or the CLI falls below Circle's minimum version | Signing fails closed and nothing is paid. The owner is told. |

### F. Repeated execution

| # | Check | Passes when |
| --- | --- | --- |
| F1 | Settle the same quote twice | The second is refused as already claimed |
| F2 | Present the same authorization to the seller twice | The chain redeems it once |
| F3 | The host crashes after signing, before posting the signature | No second nonce until the first has expired or been cancelled |
| F4 | The response is lost after the relay | The payment is marked settlement unverified. Reconciliation reads Arc (change 5), and the budget stays held. |
| F5 | The host receives the same request twice | Returns the same signature, or refuses |

### G. Real sellers

About $0.01 each, from the one or two dollars funded after groups B to F.

| # | Payment | Passes when |
| --- | --- | --- |
| G1 | Exa search on Arc, from the wallet, $0.007 | A result, and `authorizationState(wallet, nonce)` true on Arc. *(The seller side passed on 2026-09-24 with the owner's browser wallet: block 22517476, PASS. The agent wallet's own run is still open.)* |
| G2 | CRA direct on Arc, $0.003 (its own facilitator) | The same |
| G3 | Exa on Base, from the same wallet | The same, on Base, from the same shared budget |
| G4 | A Gateway payment on Arc, after a 0.5 USDC deposit | Accepted, and counted against the limit. Only after D6 and D7 pass. |

### H. Separation

| # | Check | Passes when |
| --- | --- | --- |
| H1 | What the signer host holds | The Circle agent session and its narrow Veyra credential only: no owner email, no Veyra keys, no database service key |
| H2 | What Vercel holds | No Circle session, no operational key |
| H3 | One agent wallet per Nova agent | A second agent cannot use the first one's wallet |

**If D1–D8 fail,** Circle's limit does not bind a compromised runtime. The
guarantee then falls to "risk bounded by the funded balance". Option D of the
comparison gives that guarantee with less machinery, and the product must say
so.

## Wallets and powers, kept apart

| Role | Holds | Never |
| --- | --- | --- |
| **The owner** | Their own wallet, which signs mandates and manual purchases; Nova's recovery credential; the Circle account's email or passkey, which administers the agent wallet's limits (by code in the CLI, or in Arc Portal) | Hands their email or wallet to the signer host |
| **The operational wallet** | The agent wallet: a smart account on Arc (and on Base, if the owner allows it), and a backing EOA for Gateway only. A small balance, limits set before funding. | Is the owner's wallet; administers its own limits |
| **The signer host** | A small always-on machine the owner controls, holding the Circle agent session and a narrow Veyra credential. Outbound connections only. | Holds the owner's email, Veyra's keys or the database service key |
| **Veyra's server** | Decisions, quotes, relay, reconciliation, the ledger | Holds a Circle session, an operational key or any policy power |
| **Veyra's service roles** | The trust attester, the evaluator, the Trust API payout address and the Arc Testnet canary deployer | Pays for the owner. The attester already never pays. |

## What is still limited

- **Nothing shows that the cap binds anything but a plain payment.** Permit,
  approve, Permit2, burn intents and arbitrary ERC-1271 are all unproven.
  Group D decides it.
- **Circle's limits apply on mainnet only.** No free test of a cap exists.
- **Circle's windows are not Veyra's.** Circle's limits are rolling windows.
  Veyra's mandate uses the owner's calendar day. Both apply, and neither
  stands for the other.
- **The session has to be kept alive.** It lasts 28 days and is renewed only
  with the owner's code, and Circle can stop old CLI versions remotely. An
  unattended signer needs both kept current.
- **Gateway is the riskier path.** It signs with a different key (the backing
  EOA), and one burn intent can move the whole deposit. The first pilot pays
  from the wallet only, on Arc:
  - Exa search;
  - CRA's direct routes.
- **Arc Portal as the owner's control panel is announced, not seen.** A4
  checks it.
- **Each facilitator accepts smart accounts or not.** Checked seller by
  seller (G).

## Verified

- Arc mainnet and Base USDC implementations dispatch the EIP-3009, ERC-1271
  `bytes`, `permit` and `cancelAuthorization` entry points, read from bytecode.
- Circle's `circle_6900_singleowner_v3` factory and implementation, and
  EntryPoint v0.6, are deployed on Arc mainnet. The implementation dispatches
  `isValidSignature`.
- The CLI refuses to sign for an undeployed wallet, signs Gateway payments as
  the backing EOA and deposits to it, from its source.
- The reference x402 facilitator's smart-account handling, from its source in
  `node_modules`.
- The line references to Veyra's code above.

## Not verified

- Everything in the matrix.
- Which smart-account version agent wallets use.

## Not done

No code changed. The six changes are for after the matrix, and D2 still
waits for gate V.
