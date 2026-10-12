# Monad security freshness and historical evidence

Local implementation scope authorized by the user's instruction on 2026-10-10
to separate fresh security checks from the age of already verified purchases.
Applies to `metropolis-monad` only. No deployment or new payment is authorized
by this implementation spec.

## Problem

The real manual trial at block 69650766 delivered a reproducible report and a
buyer-signed usefulness score of 80/100. The first reevaluation on the next
morning computed trust 90, but returned REVIEW_REQUIRED because it treated the
oldest payment timestamp as the freshness of the current security snapshot.
An overnight human review should not require another payment merely to reset
that clock.

## Two clocks

| Input | Clock and boundary |
| --- | --- |
| Current canonical identity, owner, payee, token and registries | Finalized block timestamp and completed RPC collection, maximum 300 seconds |
| Positive payment and delivery history | Original payment timestamp, inclusive 30-day lookback |
| Buyer assessment | Preserve its signed timestamp; its eligibility remains anchored to the original payment |
| Negative delivery assessment | Remains blocking even when the corresponding positive payment ages out |
| Aggregate ERC-8004 feedback | Its event time is unknown; positive aggregates do not enter history scoring, negative aggregates remain visible |
| Clearance/quote | Expires no later than the source security snapshot, plus the existing exact nonce, task, amount and owner approval checks |

Thirty days is an explicit conservative prototype lookback, not a calibrated
provider-performance guarantee. It is a server constant; HTTP callers cannot
extend it. The existing scoring engine retains original timestamps and temporal
weights. Shared Arc scoring and tier thresholds are unchanged.

The collector verifies both current owner/payee and their values at the original
payment block. A mismatch fails closed rather than carrying history across a
change of provider. This comparison covers the two observation points; it is
not an exhaustive scan for intermediate NFT transfers.

## Issuance and audit trail

The Monad policy identifier is `veyra-trust-policy-v1:metropolis-evidence-v2`.
Old v1 policy purchase packages are rejected by the new parser. The reviewed
frontend was published on 2026-10-12; see
[V2 publication evidence](metropolis-v2-publication.json). Policy version and
passkey account version are separate. This policy change preserves the USDC
transfer and TrustGate clearance format; the separate account V2 compatibility
change is described in [its runbook](METROPOLIS_PASSKEY_V2.md).

Each server-verified evidence bundle binds the finalized block hash/time,
original payment anchor, assessment digest and actual source timestamps in its
hash. Recollection can update the security snapshot; it cannot rewrite an event
or invent a new paid delivery. Serialized/copied bundles or decisions cannot
cross the existing issuance boundary.

The decision records security age separately from history age and excluded
positive facts. It cannot extend an old snapshot's deadline, authorize a failed
delivery, replace a missing source, relax an amount cap or dispense with a human
passkey approval. Account balance/nonce, attester role, clearance consumption,
current owner/payee and full transaction simulation are checked again by the
existing purchase and relay path.

## Required verification

- Reverified overnight payment and delivery remain eligible, with unchanged
  source hashes/timestamps and zero additional payments.
- The 30-day boundary is explicit. Re-signing an old delivery cannot bring a
  payment outside the window back into positive scoring.
- Old negative delivery still denies; undated positive feedback does not
  fabricate recent history.
- Stale, future-dated, mismatched or missing finalized block data fails closed.
- Ownership/payee changes, missing/reverted/reorganized receipts, ambiguous or
  conflicting assessments, wrong signer and altered bindings are rejected.
- Reissued decisions retain their source expiry; expired/copied decisions,
  budget overflow, stale policy versions and contract replay remain blocked.
- Existing Monad payment/WebAuthn paths and Arc regressions pass.
- Reevaluate the actual receipt/report/80-point signature through read-only RPC.
  A positive policy result is not a new payment receipt or publication approval.

Autonomous spending remains frozen. Live passkey execution still needs its
separately reviewed exact transaction and a real receipt before claiming success.

## Verified result (2026-10-10, local v2)

The actual original receipt, block-69650789 report and buyer-signed usefulness
score of 80/100 were reverified through read-only RPC. At
`2026-10-10T08:53:35.744Z`, payment-only evidence still required review; adding the
actual signed delivery assessment returned ALLOW with trust 90, coverage 0.67
and confidence 0.9. Security age was 3 seconds and original history age was
39,815 seconds. No history timestamp, request/response hash or signed score was
changed. No new live transaction or clearance signature was produced. The
personal account remained at 20 test USDC and nonce 0. The unsigned review plan
has expired and must not be reused.

Public evidence retains the earlier v1 REVIEW_REQUIRED result as a dated
historical record and adds the separate v2 reevaluation in
[metropolis-testnet-manual-trial.json](metropolis-testnet-manual-trial.json).
Verification details and source hashes are in
[metropolis-freshness-verification.json](metropolis-freshness-verification.json).

## Browser compatibility found during verification

Chromium's real virtual authenticator intermittently appended
`other_keys_can_be_added_here` to `clientDataJSON`. This is valid WebAuthn data;
see the [WebAuthn client-data serialization and verification requirements](https://www.w3.org/TR/webauthn-2/#sctn-client-data-json).
Comparing the entire response to a fixed JSON template made both the diagnostic
and deployed payment account reject this encoding.

The local read-only diagnostic now validates the compact required prefix, RP,
challenge, origin, cross-origin restriction, UP/UV and signature while preserving
the complete signed JSON. Duplicate, altered and nested required fields fail
closed. It supports appended compact JSON fields, not arbitrary serialization.
The payment parser retains the deployed account's stricter encoding and the UI
explains incompatibility without producing an approval. Removing an additional
field would invalidate the signature and is never used as a workaround.

The complete browser/fork test verified one such payment refusal, then used a
separate genuine virtual-authenticator signature in the account's supported
format to complete payment, result verification, reload and replay rejection.
These extra test prompts are confined to the virtual authenticator; the product
does not silently retry the user's passkey. A contract regression additionally
proves that an extended JSON signature passes native P256 and OpenZeppelin WebAuthn
but the unchanged account rejects it without consuming nonce/clearance or moving
USDC. Universal browser payment compatibility remains incomplete.

Reliable payment support for that encoding requires a new compatible immutable
account/factory version, a separate reviewed migration plan and explicit approval
before deployment or movement of the existing funds. This increment changes no
deployed contract or account address.
