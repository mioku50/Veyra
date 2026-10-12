# Monad readiness demonstration service

This increment supplies a concrete result for the Metropolis demonstration:
`veyra.monad.readiness.v1`. It is an operator-run diagnostic of Veyra's **Monad
Testnet** infrastructure and the buyer's personal passkey account. A free preview
is useful before discussing a purchase. It does not establish commercial demand,
an independent security audit, production readiness or a paid interaction.

## Result and boundaries

The request contains only a public P256 key and a decimal USDC budget. The task
uses a fixed service ID and deliverable. All observations use one `finalized`
block, including runtime/configuration checks, account state, USDC balance,
registry linkage and native P256 probes. The positive/negative P256 vector is
public software test data; it is not the owner's device approval.

The report returns findings, sources, blockers and next actions. Passing all
diagnostic checks still returns `purchaseAuthorized:false` and
`productionReady:false`. Provider history, current clearance, attester/relayer
readiness and human approval remain separate requirements. RPC failures fail
closed. Source links identify expected parameters; the service does not crawl
their current text.

Request hash uses the existing `purchaseRequestHash`. Response hash is Keccak-256
of the exact canonical JSON report, rather than its Markdown or pretty-printed
file. The report includes its finalized height and block hash so it can be
reproduced after balances and nonces change.

## Free preview

Keep actual setup and report files in an ignored directory:

```bash
node --experimental-transform-types --no-warnings scripts/metropolis/readiness-report.mts \
  --setup .local-tools/user-account-setup.json --budget 0.02 --format json \
  > .local-tools/readiness-preview.json

node --experimental-transform-types --no-warnings scripts/metropolis/readiness-report.mts \
  --setup .local-tools/user-account-setup.json --budget 0.02 --format markdown

node --experimental-transform-types --no-warnings scripts/metropolis/readiness-report.mts \
  --setup .local-tools/user-account-setup.json --budget 0.02 --format task \
  > .local-tools/readiness-task.json
```

These commands load no secret or signer and cannot broadcast. Old balance and
deployment fields in the setup are not trusted; the account is derived and reread
through the verified factory.

## Demonstration identity

The planner prepares `register(string)` on the canonical Testnet Identity Registry.
Its self-contained `data:application/json;base64,...` card identifies the Veyra
controller and operator-run demonstration. It advertises no hosted delivery API,
x402 support, independent validation or favorable history. `active:false` prevents
claiming an available public service.

```bash
node --experimental-transform-types --no-warnings scripts/metropolis/readiness-registration-plan.mts \
  --owner PUBLIC_PROVIDER_OWNER_ADDRESS > .local-tools/readiness-registration-plan.json
```

The planner checks chain, infrastructure, nonce, EOA, available MON, simulation,
explicit gas/fee ceiling and zero native value. It signs nothing and spends no
USDC. Monad charges on the gas limit; the plan uses a 5% estimation buffer.
Present the concrete plan for separate registration approval.

The registry initializes both NFT owner and canonical `agentWallet` to the caller
of `register(string)`. The ID returned by `eth_call` is tentative: another
registration may precede the transaction. `verifyReadinessRegistrationReceipt`
requires the actual `Registered` event, mint, canonical finalized block and current
owner/wallet/URI. A simulation is not a mint.

Sources: [ERC-8004 source and ABI](https://github.com/erc-8004/erc-8004-contracts),
[Monad current facts](https://docs.monad.xyz/ai/current-facts),
[Monad transaction semantics](https://docs.monad.xyz/developer-essentials/transactions).

### Confirmed Testnet registration

The separately approved registration completed on 2026-10-08. The actual
`Registered` event and identity mint identify **agent #2083**, owned by
`0x861FBe92678Bd6421aCee2dC37b50FDe1Dc01A1E`; its canonical `agentWallet` is the
same address. The finalized receipt and current owner, wallet and exact metadata
were verified. [Transaction](https://testnet.monadscan.com/tx/0x97a119d22f0ef0d714316ad424a10d79b9140c0f477e267b8c7074dee5ffd309),
block `69357154`, charged fee **0.138080664 MON**, below the approved maximum
of `0.165155304 MON`. Registration transferred no USDC and left the personal
passkey account's balance and nonce unchanged.

Public registration evidence is recorded in
[metropolis-testnet-readiness-agent.json](metropolis-testnet-readiness-agent.json).
It proves this demonstration identity exists; it supplies no payment, delivery,
feedback or provider-quality evidence. Registration alone remains
`REVIEW_REQUIRED`. The local verification artifact below records the earlier
fork tests, before this separate live transaction.

## New-provider history

A new identity remains `REVIEW_REQUIRED`. A paid trial outside the ordinary
passkey-clearance path, if desired, must be a separately reviewed and authorized
action with a real buyer, requested task, result and assessment. A local unsigned
planner and receipt/result verifier now prepare this separate EOA trial; see
[the manual trial runbook](METROPOLIS_MANUAL_TRIAL.md). They cannot sign, send,
seed history or introduce a first-time spending override. An established external
provider is another option.

The provider owner/payment wallet cannot serve as the history payer or assessment
reporter. If it is also the Veyra attester, that signer cannot assess this provider.
Select an allowed non-provider reporter separately. Different addresses do not
establish independent organizational control; disclose Veyra-controlled roles.
Do not create favorable ERC-8004 reviews to satisfy policy.

## Delivery after an eligible, owner-approved purchase

The existing purchase/relay runbook still applies. The request's public key and
budget must match the signed purchase. The provider must be labelled as a
demonstration and identify this exact readiness card onchain.

```bash
node --experimental-transform-types --no-warnings scripts/metropolis/readiness-delivery.mts \
  --approval .local-tools/payment-approval.json --tx REAL_PAYMENT_TRANSACTION_HASH \
  > .local-tools/readiness-delivery.json

node --experimental-transform-types --no-warnings scripts/metropolis/readiness-delivery.mts \
  --approval .local-tools/payment-approval.json --tx REAL_PAYMENT_TRANSACTION_HASH \
  --delivery .local-tools/readiness-delivery.json --reporter NON_PROVIDER_PUBLIC_ADDRESS \
  --score HUMAN_USEFULNESS_SCORE > .local-tools/readiness-assessment-plan.json
```

Fulfillment verifies the signed purchase and finalized payment before running the
service. Its report must observe a block **after** payment; an earlier free preview
cannot be recycled into delivery history. A finding that blocks a purchase may
still be a correct, useful diagnostic result.

Verification of a saved artifact repeats payment checks and reproduces the report
at its original canonical finalized block. It rejects edited task, result, balance,
receipt or hashes, including a fabricated report with a recomputed hash.
Deserialized artifacts must be reverified to regain process-local provenance.

The assessment planner requires a non-provider reporter and a human usefulness
score. Its EIP-712 message binds the actual agent, buyer, seller, amount, transaction
and request/response hashes. It is **unsigned** and cannot enter trust scoring yet.
Signing and operator configuration remain separate; the existing collector checks
signature, reporter selection and payment binding. This is an operator assessment,
not independent validation or onchain feedback.

Output files are manual persistence. No hosted delivery/storage, public signing
endpoint, automatic relay or autonomous spending is added. Live registration has
its separate receipt above. A separately approved **manual EOA trial** has now
paid for and received an actual readiness snapshot; see
[live trial evidence](metropolis-testnet-manual-trial.json). The buyer chose 80/100
usefulness and its signature is verified. The existing collector accepts the
actual payment and assessment. The historical v1 evaluation returned REVIEW_REQUIRED
because it used history age as freshness. The local v2 adapter returned ALLOW
under a fresh finalized security snapshot while preserving the original history;
see [freshness design and verification](METROPOLIS_FRESHNESS.md). Implementation and
fork tests remain separate from that actual receipt; a live passkey payment is
still pending.

## Verification

Local checks passed on 2026-10-08: 41 readiness/registration/history-boundary
checks, 44 account guards, 44 purchase packet checks, 53 existing trust checks,
37 Monad and 31 unchanged Arc contract tests. TypeScript, scoped ESLint and the
production build passed. The complete browser/service fork test passed, including
expanded structured-request rendering at a 390×844 viewport. The native path ran
on official Foundry 1.8.5 with Monad execution enabled. Evidence and source hashes
are recorded in [metropolis-readiness-local-verification.json](metropolis-readiness-local-verification.json).
Those results record the earlier local build. The reviewed code was published
on 2026-10-12 and retested against the canonical frontend with a disposable
Monad fork; see [V2 publication evidence](metropolis-v2-publication.json).
Delivery remains an operator CLI workflow; publication adds no public signing,
broadcast or delivery endpoint and does not establish a live passkey purchase.

```bash
node --experimental-transform-types --no-warnings scripts/metropolis/readiness-tests.mts
node --experimental-transform-types --no-warnings scripts/metropolis/account-tests.mts
node --experimental-transform-types --no-warnings scripts/metropolis/payment-tests.mts

METROPOLIS_TEST_FUNDING_SOURCE=PUBLIC_TESTNET_ADDRESS_WITH_AT_LEAST_1_1_USDC \
METROPOLIS_TEST_FORK_BLOCK=FINALIZED_BLOCK_WITH_THAT_BALANCE \
  node --experimental-transform-types --no-warnings scripts/metropolis/purchase-browser-fork.mts
```

The browser test creates a labelled readiness identity on localhost, performs
native passkey payment, runs the service, reloads its result, rejects tampering and
prepayment artifacts, and collects a signed operator assessment of the fork result.
The earlier verification artifact used explicit synthetic initial history. The
current browser test obtains its initial history from an actual manual trial and
result on the localhost fork with a declared test buyer score. None of that
history, identity or signature is live evidence.
Writes are restricted to the disposable localhost Monad fork; upstream RPC and
browser RPC use read methods only.
