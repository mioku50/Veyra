# Metropolis passkey account V2

## Implementation scope

Use a separate Testnet-only account and CREATE2 factory. Keep the deployed V1
contracts and deployment pins; verify archived V1 approvals against their
original account. The published browser selects V2 for new purchases. Arc behavior stays intact.
Autonomous spending remains frozen. Deployment, funding and publishing each
require their specific approval; this document authorizes none of them.

## Compatibility and authorization

V1 compares the entire signed `clientDataJSON` with a four-field template.
Chrome can legitimately append additional members, so a valid P256 assertion can
fail V1. V2 uses the [WebAuthn limited verification algorithm](https://www.w3.org/TR/webauthn-3/#sctn-client-data-json-verification):

- Match the ordered `type`, exact challenge, exact configured origin and
  `crossOrigin:false` prefix; require a closing brace or comma immediately after it.
- Bound the signed JSON to 4096 bytes and require a final closing brace. Extra
  fields are opaque onchain. This is deliberately not a full JSON parser: only
  the required prefix determines authorization, and appended fields cannot
  replace its values. The browser additionally parses and validates compact JSON.
- Pin OpenZeppelin's type/challenge indices to their positions in that prefix.
- Hash the complete original JSON and authenticator data. Never rewrite signed
  browser data. Require the RP hash, UP/UV, valid backup flags, low-s and Monad's
  native P256 verifier. OpenZeppelin supplies the WebAuthn and P256 checks.
- Preserve the exact USDC transfer, TrustGate signature, account/chain binding,
  nonce, one-use clearance and atomic rollback. Reject the deadline at equality,
  consistent with the server's freshness boundary.

V2 is identified by `ACCOUNT_VERSION() == 2`. It remains an immutable prototype
without key rotation/recovery, arbitrary calls, escrow or automatic spending.

## Verification required before deployment

Reuse all V1 authorization and replay tests against V2. Add signed client-data
variants for extra fields, cross-origin, ordering, delimiter and size failures.
Verify an actual Chromium assertion with appended fields in an actual payment
transaction on a disposable Monad fork, using the native precompile without
signature mocks or rewritten JSON. Check the exact transfer, nonce, clearance,
rollback and replay independently. Fork receipts are not Testnet deployments.

## Transition

1. Review a fresh unsigned factory deployment: Testnet 10143, existing TrustGate
   and USDC, canonical Veyra domain, public sender, nonce, bytecode and fee cap.
2. After a separately approved deployment, verify its finalized receipt and source,
   pin the new runtime hash, and prepare a separately approved personal V2 account.
   Reuse the public passkey and RP on the same domain; its private key never leaves
   the authenticator. A new factory and versioned salt produce a different address.
3. Fund the V2 address only after checking the deployed configuration. The V1
   account's existing 20 test USDC do not automatically move. Transferring them
   would require a separate supported, owner-approved action; no withdrawal or
   policy bypass is added here.
4. Activate the V2 browser/payment path only after the new deployments are verified.
   Obtain a fresh Veyra clearance and exact owner passkey approval for a payment.
   Keep historical V1 orders, receipts and assessments bound to their original
   account and transaction; do not relabel them as V2 evidence.

This fixes a known Chromium format incompatibility. A fork test cannot establish
universal browser compatibility, an iPhone payment or Mainnet readiness.

## Verified locally on 2026-10-11

- Official Foundry 1.8.5 with Monad execution: 38 V1 and 52 V2 contract tests
  passed, plus the separate pinned native-P256/registry fork test.
- Chromium 149 at 390×844: a genuine virtual-authenticator assertion containing
  `other_keys_can_be_added_here` completed a 12,000-unit USDC transfer on the
  disposable fork of block 69650789. The required prefix, full original signature,
  exact transfer, consumed clearance, nonce and replay checks passed. V1 refused
  its separately signed extra-field assertion without moving funds.
- The existing trust engine supplied the local clearance from explicitly
  synthetic evidence. This focused compatibility test establishes no new live
  provider history or actual-device payment.
- Unsigned transition planning matched simulated constructor runtime hashes
  against actual local deployments and rejected nine unsafe inputs. TypeScript,
  scoped ESLint and whitespace checks passed. The existing V1 payment package
  tests also passed (57 checks).

Evidence: [verification record](metropolis-passkey-v2-verification.json).

Reproduce from the worktree root with the locally installed official binaries:

```bash
.local-tools/foundry-1.8.5/forge test --root contracts/monad --network monad --match-contract 'VeyraPasskeyAccount(V2)?Test' -vv
.local-tools/foundry-1.8.5/forge test --root contracts/monad --network monad --match-contract MonadPrecompileForkTest --fork-url https://testnet-rpc.monad.xyz --fork-block-number 69650789 -vv
METROPOLIS_TEST_FUNDING_SOURCE=0x90B958DeA1CD0189632845484F5Ec87a10247061 METROPOLIS_TEST_FORK_BLOCK=69650789 node --experimental-transform-types --no-warnings scripts/metropolis/passkey-v2-browser-fork.mts
```

The funding address is impersonated exclusively on localhost. The upstream
proxy refuses every write method. Public fork proof is reproducible without the
human owner's credential, private key or signature. The extra-field test can
request multiple virtual assertions to observe Chrome's optional field; the
product does not retry owner approvals silently or rewrite assertions.

## Historical factory deployment proposal

Observed on 2026-10-11 before the approved deployment below. This proposal is
retained for comparison with the finalized receipt; do not broadcast it again:

| Field | Proposed value |
| --- | --- |
| Network | Monad Testnet, chain ID 10143 |
| Sender | `0x861FBe92678Bd6421aCee2dC37b50FDe1Dc01A1E` |
| Sender nonce | 4 |
| Factory CREATE prediction | `0x0624d4C7fcB61d178BFA2b675ec25B111C0E4c7a` |
| Personal account CREATE2 prediction | `0x88f7aAe6050C842A5D2FB9e39B625102f5D54bB6` |
| Estimated gas / limit with 5% buffer | 2,794,416 / 2,934,137 |
| Max fee / priority fee | 122 / 2 gwei |
| Maximum factory fee | 0.357964714 MON |
| Native value / USDC spent | 0 / 0 |

Only the factory transaction is estimated. The personal account is a conditional
prediction, not a deployed account or approved account-creation transaction.
The old account `0xc4867c6ae80563D9216a1b16D289b26Fa266bDc3` still had 20 test
USDC and nonce 0 at finalized block 70204447. Its funds are not migration funding.
The existing sender's attester role was active; this deployment adds no role.

The original unsigned transaction is saved locally in
`.local-tools/passkey-v2-transition-plan.json`, outside Git. The read-only command
used to generate it was:

```bash
node --experimental-transform-types --no-warnings scripts/metropolis/passkey-v2-plan.mts --setup .local-tools/user-account-setup.json --sender 0x861FBe92678Bd6421aCee2dC37b50FDe1Dc01A1E
```

After the deployment, the sender nonce is different. Running that transition
planner again proposes a different factory; it does not reproduce this receipt
or prepare an account on the deployed V2 factory.

## Verified Testnet factory deployment — 2026-10-11

The separately approved factory transaction finalized at block **70207992**:

- Factory: `0x0624d4C7fcB61d178BFA2b675ec25B111C0E4c7a`.
- Transaction: `0xfec4f59f529250e3bbdf34121d63c8e46653d9ed4539bf8d1095bd71f9c69a11`.
- Sender nonce 4; native value and USDC spent both 0.
- Charged fee **0.299281974 MON**, below the approved **0.357964714 MON** cap.
- Runtime hash: `0x2b55104da9e31a77ef1cd4ec74d3ab1fcdb99b5ef4a46792502f6100d4e5fe3d`.
- Version 2, TrustGate, USDC, RP hash and canonical origin matched the approved
  configuration. Independent CREATE2 predictions matched the factory for both
  a synthetic fixture and the existing public passkey.
- Monad Sourcify confirmed `exact_match` for creation and runtime bytecode.
  Its input included only the 32 contract/dependency sources. Local compilation
  reproduced both factory and embedded-account creation bytecode exactly.
- At finalized block 70208252, the V1 account still held 20 test USDC with nonce
  0; the existing TrustGate and V1 factory runtime hashes matched their pins.

Evidence: [finalized deployment record](metropolis-testnet-factory-v2-deployment.json).
This factory receipt establishes neither an owner passkey payment nor delivery.
The browser payment path still uses V1. Autonomous spending remains frozen.

## Historical personal V2 account proposal

Read-only checks on 2026-10-11 at finalized block 70209050 confirmed the deployed
factory configuration and simulated `createAccount` successfully. The existing
public passkey and versioned V2 salt produced the following separate proposal,
subsequently approved and finalized below. Do not broadcast it again:

| Field | Proposed value |
| --- | --- |
| Network | Monad Testnet, chain ID 10143 |
| Sender | `0x861FBe92678Bd6421aCee2dC37b50FDe1Dc01A1E` |
| Sender nonce | 5 |
| Target factory | `0x0624d4C7fcB61d178BFA2b675ec25B111C0E4c7a` |
| Personal account CREATE2 prediction | `0x88f7aAe6050C842A5D2FB9e39B625102f5D54bB6` |
| Estimated gas / limit with 5% buffer | 2,129,419 / 2,235,890 |
| Max fee / priority fee | 122 / 2 gwei |
| Maximum creation fee | 0.27277858 MON |
| Native value / USDC spent | 0 / 0 |

The original unsigned account-creation transaction is saved locally in
`.local-tools/personal-v2-account-plan.json`, outside Git. Before deployment,
the V2 address had no code and held 0 USDC at this snapshot.

## Verified personal V2 account deployment — 2026-10-11

The separately approved `createAccount` transaction finalized at block **70210612**:

- Account: `0x88f7aAe6050C842A5D2FB9e39B625102f5D54bB6`.
- Transaction: `0xb825cb51ba11c7f0500d59454d38ca7f091027616568f290275472157ef12f2e`.
- Sender nonce 5; native value and USDC spent both 0.
- Charged fee **0.22806078 MON**, below the approved **0.27277858 MON** cap.
- Runtime hash: `0x1ac8e3344da21ca1fbb98769e53232ebb0ab1fff4e84c28cf41705da860ac6c1`.
- The factory emitted the expected `AccountCreated` event. Its key coordinates,
  derived salt and account address matched the reviewed public passkey and local
  CREATE2 calculation. No USDC event was emitted by the creation transaction.
- Version 2, Testnet chain restriction, TrustGate, USDC, RP hash, canonical origin
  and both public-key coordinates matched. All runtime-template bytes matched,
  excluding only compiler-declared immutable slots; the complete runtime hash
  also matched the constructor simulation.
- Monad Sourcify confirmed `exact_match` for creation and runtime bytecode. Its
  input contained only 29 contract/dependency sources; local compilation
  reproduced the approved account creation bytecode exactly.
- At finalized block **70210948**, account nonce, USDC balance and MON balance
  were all 0. The existing V1 account still held **20 test USDC** with nonce 0.
  Factory, TrustGate and V1-account runtime hashes remained unchanged.

Evidence: [finalized personal-account record](metropolis-testnet-account-v2-deployment.json).
The account reuses the existing passkey public key and canonical domain; no new
credential was registered. Creation does not prove an actual-device payment or
service delivery. At this creation snapshot, the published browser still used V1;
the later V2 publication is recorded below.

The snapshot above records the balance immediately after creation. Subsequent
funding and local activation are recorded below; it is not a current balance.

## Funding and local browser transition — 2026-10-12

Finalized block **70357792** confirmed **20 test USDC** in personal V2 account
`0x88f7aAe6050C842A5D2FB9e39B625102f5D54bB6`, with nonce 0 and the deployment's
runtime hash. At the same block, the original V1 account still held 20 test USDC.
The user supplied V2 funding; this verification did not transfer funds.

The local adapter pins both factory versions, selects each account's own salt
and checks V2 `ACCOUNT_VERSION()` on the factory and personal account. The
browser derives V2 using the existing saved credential and accepts new proposals
only for that active factory. A saved V1 approval continues to select its original
factory and strict assertion parser for receipt verification. Payment context
signatures bind the factory, so changing it invalidates the original package.

Readiness tasks explicitly sign `accountVersion:2` for V2 reports. Historical
requests without that field remain V1 and retain their original request hashes.
Delivery verification rejects a task/account-version mismatch and requires the
report to describe the account that actually paid.

Read-only evidence: [V2 activation verification](metropolis-v2-activation-verification.json).
Reproduce the live configuration and negative adapter checks without a signer:

```bash
node --experimental-transform-types --no-warnings scripts/metropolis/v2-activation-tests.mts
```

At this local verification stage, publication and the actual owner passkey
payment were pending. Publication is recorded below; no V1 funds move
automatically and autonomous spending remains frozen.

The complete V2 frontend/issuer/relay/receipt/readiness-delivery flow passed on
the disposable fork of block **70357792**, using a Chromium virtual authenticator
and one owner-approval prompt. It verified a 0.012-USDC transfer, exact receipt,
nonce/clearance replay refusal, refusal of identity-only evidence, tampered-task
and report rejection, result restoration and receipt verification after reload.
The browser sent only read RPC methods; every write remained on localhost.
Production build, root/scoped TypeScript, scoped ESLint and adapter/package tests
passed. This local run establishes no actual iPhone payment or publication;
the separate published-frontend verification is recorded below.

Evidence: [V2 browser verification](metropolis-v2-browser-verification.json).

## Verified frontend publication — 2026-10-12

Commit `7efa187c03c42df840e214704ddd2a22c2e75c38` was pushed to
`metropolis-monad`, built with production configuration and published at the
existing `https://agent-commerce-six.vercel.app/metropolis`. The RP and saved
credential storage key did not change. New account preparation selects V2.

The canonical domain maps to the verified READY deployment. Staged and public
HTTP checks passed for `/metropolis`, `/`, `/arc` and `/console`. The full browser
test also passed against the published frontend using a virtual authenticator
and disposable Monad fork of block **70357792**, including the exact transfer,
receipt, replay refusal and separate readiness result checks. Every blockchain
write stayed on localhost. A fresh finalized Testnet read at block **70363301**
confirmed the actual V2 account still held 20 test USDC with nonce 0.

The actual owner's passkey payment remains pending. Publication created no
clearance, payment authorization or live blockchain transaction. No private
plan, credential file or operator secret was uploaded; main and Arc source
behavior remain unchanged. Autonomous spending remains frozen.

Evidence: [V2 publication record](metropolis-v2-publication.json).

## Current available passkey account — 2026-10-12

Following the resident-key registration correction, the owner supplied the
public setup for their currently available passkey and separately approved one
account-creation transaction. This creates another personal V2 account; it does
not recover or migrate the earlier account.

- Account: `0x8A683d781368a765F252E53F8d1683f24623535e`.
- Transaction: `0x73d2f1cfcad108008637825f67338be11bcad1ca68b16548b2508ad51e9d0ec7`.
- Successful creation at block **70504915**, verified against finalized block
  **70505343**. Sender nonce 6; native value and USDC spent both 0.
- Charged fee **0.228062106 MON**, below the approved **0.272780166 MON** cap.
- Runtime hash: `0xc45b71a0dcdfba76b33cd0dde01fcf3d238af4fb0c78d1d45f4150d2f27f1877`.
  The complete runtime matched the constructor simulation; the runtime template,
  immutable getters, version, RP/origin, both public-key coordinates, CREATE2
  derivation and factory event matched the reviewed setup.
- Monad Sourcify confirmed `exact_match` for creation and runtime bytecode.
  Its input contained only 29 contract/dependency sources, and local compilation
  reproduced the account creation bytecode exactly.
- The application account-setup adapter also confirmed **Deployed** at finalized
  block **70505988**, with **0 test USDC**. The published page reads deployment
  and balance dynamically; this account creation requires no frontend rebuild.
- The earlier V2 account `0x88f7aAe6050C842A5D2FB9e39B625102f5D54bB6`
  still held **20 test USDC** with payment nonce 0 at block 70505343. Its runtime,
  the factory and TrustGate were unchanged. No USDC event was emitted by the new
  creation transaction.

Evidence: [current-passkey account deployment](metropolis-testnet-current-passkey-v2-deployment.json).
Funding the new address and an actual owner-approved payment remain pending.
Creation verifies the account's binding to the supplied public key, not an owner
payment assertion or service delivery. Existing receipts remain bound to their
original accounts. Autonomous spending remains frozen.
