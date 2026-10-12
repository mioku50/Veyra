# Select an existing Metropolis passkey

## Problem and scope

A browser can save a different resident passkey from the one that owns an
already deployed and funded V2 account. Its derived account address then differs.
The owner requested returning to the existing account, rather than deploying
and funding another account.

The `/metropolis` interface now provides **Use an existing passkey**. First click
**Check existing account**, then **Select existing passkey**. An optional
`?account=<full address>` URL prefills this form. Opening the URL never starts
a WebAuthn prompt or signs automatically.

This selects public credential metadata in the browser. It does not replace an
account's immutable public key, provide key recovery/rotation, deploy an account,
issue a clearance or transfer funds. The original passkey must still be available
in the owner's authenticator/password manager on the canonical Veyra domain.

## Verification before saving metadata

1. Require the canonical origin, a valid full account address and Monad Testnet
   chain ID 10143.
2. Read the deployed account's public key at a finalized block. Verify pinned
   V2 factory and TrustGate code, factory configuration, account version,
   CREATE2 derivation, RP/origin and account configuration through the existing
   `readAccountSetup` path. Reject an address outside this factory/key binding.
3. Keep the verified setup immutable in memory; it cannot be supplied from a URL
   or restored directly from JSON. The next explicit click invokes WebAuthn
   before awaiting any further RPC. This preserves the user gesture when network
   reads are slow; [WebKit documents the gesture requirement and expiry](https://webkit.org/blog/11312/meet-face-id-and-touch-id-for-the-web/).
   Generate a random, domain-separated diagnostic challenge bound to this
   account, factory, chain, origin, finalized block hash and a two-minute expiry.
   It is distinct from the contract's payment approval challenge.
4. Request a discoverable credential with user verification required and no
   `allowCredentials` restriction. Use the installed viem WebAuthn integration
   to parse the authenticator's original response and DER signature.
5. Validate the returned credential identifier, signed client-data type,
   challenge, origin, RP hash, UP/UV and signature scalar bounds. Preserve the
   signed bytes and verify their P256 signature against the account key through
   Monad's native `0x0100` using **eth_call**, not a transaction.
6. Reject a wrong key or expired request. Refresh finalized account/balance
   reads before saving the selected public metadata. Retain the previous public
   metadata pointer locally when changing it. Never persist selection assertions.

The previous credential is unchanged if selection fails. Beginning selection
clears the displayed setup/payment component so a stale account cannot stay
active. Reloading the page retains only the selected public metadata and again
requires a fresh passkey verification before preparing a payment.

## Acceptance

`scripts/metropolis/purchase-browser-fork.mts` exercises the production frontend
with two real resident credentials from a virtual browser authenticator and
official Foundry 1.8.5 using `--network monad` on a disposable local fork.

Required checks:

- A prefilled URL does not prompt automatically.
- An undeployed address is rejected before a browser prompt.
- A real signature from the wrong resident key is rejected by native P256;
  saved metadata remains unchanged and no account is displayed.
- Selecting the original key restores its deployed account; public metadata
  persists after reload and the previous pointer remains available locally.
- The application's selection request has no allowed-credential restriction
  and requires user verification on the canonical RP ID.
- An intentionally delayed 11-second RPC preflight does not start a prompt.
  Both subsequent credential-selection prompts start with fresh user activation.
- Selection does not change the USDC balance or consume a payment nonce.
- The subsequent exact-payment, receipt, delivery and replay-protection flow
  continues to work with the selected original credential.

All test transactions and funding stay on localhost. The upstream proxy admits
only read methods. A passing virtual-authenticator test does not establish that
the owner's original device still has its passkey. That requires the owner to
complete selection on the published page.

Source: [WebAuthn discoverable credentials](https://www.w3.org/TR/webauthn-3/#sctn-discoverable-credentials).

## Local verification — 2026-10-12

- Production build, project TypeScript, scoped Metropolis TypeScript and scoped
  ESLint passed.
- Account setup/selection guards: 59 checks. Signed purchase guards: 65 checks.
  Existing authorization/provenance guards: 73 checks.
- The full browser/fork script passed at upstream block `70357792`, including
  the selection checks above and the subsequent 0.012-USDC local payment,
  replay rejection, delivery and receipt restoration. External transactions: 0.
- Separately, finalized live reads at block `70380162`, hash
  `0x2bcd6e97594840a7050407c0904cf9fd5dc6ff980bdf3b040b30add4bb3bdc75`,
  confirmed existing account `0x88f7aAe6050C842A5D2FB9e39B625102f5D54bB6`
  is deployed with `20000000` USDC units (20 test USDC) and payment nonce `0`.

Owner-device selection remains pending. The live balance check is a read-only
snapshot; it does not establish a new owner assertion or payment receipt.

## Requested-account interface correction — 2026-10-12

The owner reported selecting the original key, while the next exported setup
still described another, undeployed account. The screenshot's green status was
the generic saved-key diagnostic message, rather than the existing-account
selection result. The screenshots do not establish which step failed.

The requested-account flow now keeps those results separate:

- Entering an address or opening a prefilled URL hides saved-key verification,
  new-key creation and account preparation/export until selection of the
  requested account succeeds. Action handlers also enforce the target binding.
- A finalized balance read displays **Requested V2 account** and explicitly
  says that passkey selection is still required. It does not establish access.
- Selection failures remain visible as alerts alongside the full target address;
  a generic green verification cannot replace them. Browser storage failures
  after a matching assertion have their own explanation.
- Successful selection displays **Selected V2 account**, the matching setup and
  its refreshed finalized balance. Editing the target clears verification,
  displayed setup and purchase controls. Reloading again requires verification.
- Returning to ordinary saved-key verification requires clearing the target or
  explicitly cancelling account selection; cancellation also removes the URL
  target and retains the saved public credential.

The browser/fork test covers pending selection, wrong-key rejection, blocked
exports, a matching assertion followed by a simulated browser storage failure,
target edits, reload and explicit cancellation before the existing
payment/receipt/replay checks. Native signature verification and all deployed
contracts are unchanged. The owner's actual key selection remains unconfirmed.

A separate finalized live snapshot at block `70480943`, hash
`0xb0b2687dfb7a0ad1c4a0e8c377d39581f309d18b13c6a60379486dcfd1a5079b`,
confirmed the requested account still has 20 test USDC and payment nonce `0`.

The production build, project/scoped TypeScript, scoped ESLint and the complete
browser/fork test passed locally with the correction. All test writes were on
localhost; no external transaction was sent.

## Publication — 2026-10-12

The canonical `/metropolis` page now serves source commit
`a019fc5e4900f685ad0c36ef19a0ad30032fe77c`. Its production deployment was
staged, checked against that Git commit, then promoted without rebuilding.
The full selection/payment browser test passed against the published frontend,
with all blockchain writes still restricted to the disposable local fork.
The delayed-preflight test targets the first actual RPC so a cached chain-ID
lookup cannot bypass its timing check.

The root page, `/arc`, `/console` and `/metropolis` returned HTTP 200 before and
after promotion. Existing Arc source and `main` were unchanged.
See [publication evidence](metropolis-existing-passkey-publication.json).

To return to the existing funded account, open
[the prefilled account page](https://agent-commerce-six.vercel.app/metropolis?account=0x88f7aAe6050C842A5D2FB9e39B625102f5D54bB6),
click **Check existing account**, then **Select existing passkey** and select
its original passkey in the device's password manager. Owner-device selection
and any actual payment remain separate, pending actions.
