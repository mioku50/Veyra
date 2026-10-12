# Readiness agent: separately reviewed manual Testnet trial

Agent #2083 exists on Monad Testnet, but identity alone remains
`REVIEW_REQUIRED`. The ordinary Veyra/passkey payment path still requires actual
payment and delivered-result history. This local operator flow prepares that
first trial with a separately chosen EOA buyer. It does not change trust policy,
issue a clearance, execute the user's passkey account or enable autonomous spend.

The provider is the Veyra-created readiness demonstration described in
[METROPOLIS_READINESS.md](METROPOLIS_READINESS.md). Its report is also available
as a free preview. A paid Testnet trial tests the service and evidence flow; it
does not demonstrate commercial demand, external customers or independent
organizational ownership.

## Roles and prerequisites

- Choose a public EOA buyer address distinct from the provider's owner and
  canonical `agentWallet`. For #2083, both provider addresses are
  `0x861FBe92678Bd6421aCee2dC37b50FDe1Dc01A1E`.
- The buyer needs finalized Testnet USDC for the exact trial amount and MON for
  gas. The current immutable passkey account cannot execute this EOA trial.
- The buyer must sign the exact EIP-712 `ManualReadinessTrial` order and send the
  reviewed ERC-20 transfer. Signing material stays outside public files.
- A human buyer chooses the usefulness score after seeing the actual result.
  The provider cannot assess its own delivery. No score is selected automatically.

Different addresses do not prove independent control. Disclose shared Veyra
control if it applies. No buyer wallet, key or funding transaction is created by
these commands.

## Prepare the concrete order

Save actual public setup/task/order artifacts under ignored `.local-tools/`:

```bash
node --experimental-transform-types --no-warnings scripts/metropolis/readiness-report.mts \
  --setup .local-tools/user-account-setup.json --budget 0.02 --format task \
  > .local-tools/readiness-task.json

node --experimental-transform-types --no-warnings scripts/metropolis/readiness-trial.mts \
  --mode plan --buyer PUBLIC_EOA_BUYER_ADDRESS --agent-id 2083 \
  --task .local-tools/readiness-task.json --amount 0.012 \
  > .local-tools/readiness-trial-plan.json

node --experimental-transform-types --no-warnings scripts/metropolis/readiness-trial.mts \
  --mode order --plan .local-tools/readiness-trial-plan.json \
  > .local-tools/readiness-trial-order.json
```

The `0.012` test-USDC amount is a proposed demonstration trial amount, not a
market price or an approved payment. Prepare a funded buyer's actual plan before
asking for the specific spend approval. Planning verifies Testnet 10143,
canonical registries/USDC, exact readiness metadata, public P256 key, finalized
balances, EOA/non-provider role, pending nonce, transfer simulation and explicit
fee/gas ceilings. It applies a 5% gas buffer with a 300,000-gas ceiling.

The order binds the canonical plan hash, buyer, agent, payee, token, exact amount,
task hash, transaction nonce, observed block time and 30-minute window. Its domain
namespaces the offchain signature to the canonical Testnet Identity Registry;
the registry does not verify or store this signature. A token transfer does not
put the request hash onchain. This buyer-signed association is stated explicitly.

Planning emits no signature and makes no RPC write. The CLI loads no environment
file or key, provides no signer/broadcast mode and exposes no HTTP endpoint.

## After the separately approved transfer

Store the public buyer order signature as JSON containing exactly
`{"signature":"0x..."}`. Use the signature over `readiness-trial-order.json`,
rather than a signed plaintext message or an unrelated assessment.

Before sending, recheck the signed order without a write:

```bash
node --experimental-transform-types --no-warnings scripts/metropolis/readiness-trial.mts \
  --mode check --plan .local-tools/readiness-trial-plan.json \
  --signature .local-tools/readiness-trial-signature.json
```

This rejects changed nonce, pending transactions, expired window, insufficient
funds, changed provider identity and a transfer that no longer fits the reviewed
gas/fee ceilings. An EOA token transfer does not enforce the offchain trial
signature or deadline itself. A transaction sent outside the reviewed terms
may still spend tokens, but will not become valid trial evidence.

```bash
node --experimental-transform-types --no-warnings scripts/metropolis/readiness-trial.mts \
  --mode receipt --plan .local-tools/readiness-trial-plan.json \
  --signature .local-tools/readiness-trial-signature.json --tx ACTUAL_TRIAL_TX_HASH

node --experimental-transform-types --no-warnings scripts/metropolis/readiness-trial.mts \
  --mode deliver --plan .local-tools/readiness-trial-plan.json \
  --signature .local-tools/readiness-trial-signature.json --tx ACTUAL_TRIAL_TX_HASH \
  > .local-tools/readiness-trial-delivery.json
```

Receipt verification checks the real buyer signature, chain sender/nonce,
zero native value, exact transfer calldata, fee caps, canonical finalized block,
time window, historical/current provider identity and one unambiguous USDC
Transfer event. Wrong nonce, altered calldata/amount, removed/duplicate logs,
changed identity or another transaction cannot create admissible trial evidence.
It returns `manual_eoa_trial`, `clearanceIssued:false`, `passkeyApproval:false`
and `delivery:not_assessed`.

Delivery runs a fresh report after payment. Rechecking a persisted result
reproduces its original finalized snapshot, including after account nonce or
balance changes. A free prepayment preview, edited/rehashed result or mismatched
receipt is rejected. Payment and useful delivery remain separate facts.

## Human assessment and ordinary policy

```bash
node --experimental-transform-types --no-warnings scripts/metropolis/readiness-trial.mts \
  --mode assessment --plan .local-tools/readiness-trial-plan.json \
  --signature .local-tools/readiness-trial-signature.json --tx ACTUAL_TRIAL_TX_HASH \
  --delivery .local-tools/readiness-trial-delivery.json --score HUMAN_SCORE_0_TO_100 \
  > .local-tools/readiness-trial-assessment-plan.json
```

The assessment plan remains unsigned. Only a reverified delivery can produce it.
The signer is the actual non-provider buyer; the message binds the actual agent,
buyer, seller, amount, payment transaction and request/response hashes. A human
must inspect the result and choose the score. A low or failed assessment must be
retained honestly; an allowance is not guaranteed.

After a real buyer signature, the existing collector can verify the selected
payment log and signed report under explicit operator configuration. Reevaluate
the ordinary Veyra policy with current evidence. This does not create a favorable
ERC-8004 review, transfer trust across providers or promise future authorization.
Only an independently eligible decision can enter the existing passkey flow.

## Verification scope

Verified locally on 2026-10-08: **75** manual trial boundary checks, **41** readiness
checks, **44** purchase checks and **53** existing trust checks passed. TypeScript
checked the application and the new `.mts` operator/test entrypoints; scoped
ESLint and the production build passed. The full browser/trial/native passkey
flow passed on a disposable Monad fork at block **69357158**, using official
Foundry **1.8.5**. Evidence is recorded in
[metropolis-manual-trial-local-verification.json](metropolis-manual-trial-local-verification.json).

The local test covers genuine EIP-712 cryptography and hostile synthetic receipt
cases. The complete browser test uses official Foundry 1.8+ Anvil with Monad
execution and a readonly upstream RPC proxy. It performs an actual EOA trial,
delivers a report and signs an explicitly declared **test** usefulness score on
the disposable localhost fork before evaluating the normal policy and executing
the native WebAuthn/passkey payment. No fabricated initial payment receipts are
used. None of these fork identities, transfers or scores are live customer
evidence; no external transaction is sent by this test.

```bash
node --experimental-transform-types --no-warnings scripts/metropolis/readiness-trial-tests.mts
```

## Confirmed live manual trial

On 2026-10-09, the buyer separately approved and signed one trial using desktop
MetaMask. The canonical Monad Testnet transaction
[`0x4418a0ee…cda59008`](https://testnet.monadscan.com/tx/0x4418a0eed4b3d4bd81a5d3a2088b05438d2c7f76ba2a465813cfd040cda59008)
transferred **0.012 test USDC** from
`0x9b57b2aCf3242db458B5EadD5e2026eaccB33dAD` to readiness agent #2083's
canonical wallet. The receipt is successful at block **69650766**. Charged gas
was **0.01076406 MON**, below the approved cap of **0.01287466 MON**.

The actual buyer order signature, exact transfer calldata/nonce/fees, finalized
receipt and canonical USDC log were verified. The delivered report at block
**69650789** passed all five diagnostics. Its original snapshot and response hash
were reproduced from RPC; a subsequent receipt check preserves this result rather
than replacing it with a new snapshot. Public receipt/result evidence is recorded
in [metropolis-testnet-manual-trial.json](metropolis-testnet-manual-trial.json).

The human buyer chose usefulness **80/100** after viewing the result. On
2026-10-10, independent local verification recovered the actual buyer from its
EIP-712 assessment signature and matched the exact score, provider, amount,
payment and original request/response hashes. The assessment digest is
`0xdf16d565557d8ea719290009b1951f1c1ef9b0195cc636a90352269f8239bef4`.
The original block **69650789** report was reproduced again without replacing
its snapshot. The signature is retained in ignored local operator artifacts.

The existing collector now accepts one real payment and one buyer assessment,
which supplies the `service_delivery` and `api_quality` categories. These are
**two dimensions of one assessment**, not two independent validators. The engine
computes trust **90**, confidence **0.9** and coverage **0.67**. These values differ
from the human usefulness score and are not a calibrated probability of success.

The historical v1 decision at **2026-10-10T08:27:49.115Z** was **REVIEW_REQUIRED**,
with `STALE_REPUTATION` and `TRUST_TIER_REQUIRES_REVIEW`: the oldest history is
**38,269 seconds** old. Existing policy windows are one hour for ALLOW, two hours
for ALLOW_WITH_LIMITS and four hours for REQUIRE_EVALUATOR. A new identity read
does not change the original payment or assessment time. The executable amount
is **zero**; no clearance, ERC-8004 review, passkey payment or additional transfer
was produced. This is a Veyra-created demonstration with distinct wallet addresses;
it does not establish independent organizational ownership or commercial demand.

The personal passkey account still holds **20 test USDC**, nonce **0**. A manual
EOA trial does not demonstrate the deployed account's live WebAuthn execution.


## Freshness correction from the actual trial

The overnight human review exposed a product constraint: the Monad adapter uses
the age of the oldest economic/delivery fact as policy freshness. Even a payment
reverified on a new finalized block remains old. Signing or reproducing the same
report again must not manufacture a new purchase or delivery event.

The authorized local v2 implementation now separates:

1. Short-lived, freshly reverified security state: canonical payee/owner, contract
   code, finality, account nonce/balance, attester authority and quote expiry.
2. Historical payment and delivery evidence with its original timestamps,
   provenance, explicit lookback and decay. A fresh RPC read never rewrites an
   interaction's event time or substitutes a newer report for the assessed one.
3. Negative history, provider ownership changes, missing sources and expired
   quotes still failing closed; one operator-run demonstration still labelled as
   such. New useful delivery must be assessed separately.

At **2026-10-10T08:53:35.744Z**, read-only reevaluation of the same receipt, original
report and buyer-signed 80-point assessment returned **ALLOW**, trust **90**,
confidence **0.9**, coverage **0.67**. Security age was **3 seconds**; original
history remained **39,815 seconds** old. The proposed exact amount was 0.012 USDC
within a 0.02-USDC owner budget. This was an unsigned, now-expired review plan;
no new clearance signature, passkey approval or transaction was produced.
The personal account still had 20 test USDC and nonce 0.

See [METROPOLIS_FRESHNESS.md](METROPOLIS_FRESHNESS.md) for policy boundaries and
verification. The reviewed policy/frontend change was published on 2026-10-12;
see [V2 publication evidence](metropolis-v2-publication.json). Shared scoring
thresholds and Arc behavior are unchanged. Do not make another payment solely to
refresh the clock, relabel a free report as paid delivery, or replay the expired
manual order. Live passkey execution remains a separately approved next action.
