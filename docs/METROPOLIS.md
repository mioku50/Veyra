# Veyra on Monad — Metropolis implementation spec

Status: local implementation and publication of the read-only `/metropolis`
diagnostic on the existing Veyra domain authorized on 2026-10-08. Separately
approved TrustGate and account factory deployments on Monad Testnet are complete.
Per-user account creation, funding and payments still require separate approval.
Starting commit: `3b0a29e780b83246509d54638567c3c2dc6c6cbb`.
Branch: `metropolis-monad`. Network for the demo: Monad Testnet, chain ID 10143.

## Product

Veyra evaluates an agent's proposed purchase using identity, evidence, risk and
spending policy. The owner separately approves the exact payment with a passkey.
Monad verifies the policy clearance and the WebAuthn assertion before USDC moves.

The existing trust engine and TrustGate predate this integration. The new work is
the isolated Monad adapter, per-credential account/factory, WebAuthn authorization,
relayed payment path and focused demonstration. Existing Arc execution remains
unchanged. Autonomous spending stays frozen.

## Boundaries

```mermaid
flowchart TD
  Intent[Agent intent and budget] --> Evidence[Monad ERC-8004 identity and evidence]
  Evidence --> Policy[Existing Veyra deterministic trust policy]
  Policy --> Clearance[Exact EIP-712 clearance from Veyra]
  Clearance --> Human[Owner approves exact challenge with passkey]
  Human --> Account[Per-user account on Monad]
  Account --> Checks[TrustGate + WebAuthn + native P256 verification]
  Checks --> Transfer[Exact USDC transfer]
  Transfer --> Receipt[Confirmed receipt]
  Receipt --> Delivery[Provider result and separate delivery assessment]
```

- Reuse `VeyraTrustGate.sol` unchanged and its EIP-712 domain/schema.
- Each user has a CREATE2 account with an immutable P256 public key, RP ID hash,
  origin, USDC address and TrustGate. No generic calls, approvals or delegatecall.
- The initial execution action is only `USDC.transfer(counterparty, requestedAmount)`.
  The account constructs this call itself and checks its hash against the clearance.
- `executor` is the account. `subject` retains its meaning as the trust subject;
  it must not silently be reinterpreted as the relayer or account owner.
- Bind the human challenge to chain ID, account, TrustGate, clearance digest,
  transfer action hash, nonce and deadline. Enforce clearance issuance/expiry,
  maximum amount, user presence and user verification. Use the account nonce for
  replay protection; synchronized passkeys may have a zero signature counter.
- OpenZeppelin 5.6.1 `WebAuthn.verify` handles assertion checks. The account adds
  RP ID and origin restrictions and requires `P256.verifyNative`; a Solidity
  fallback alone does not satisfy the Monad demo acceptance criterion.
- The first prototype accepts the compact browser client-data JSON format with
  `crossOrigin:false`. Other encodings fail closed and need explicit compatibility
  tests before being supported. Do not write a permissive custom JSON parser.
- The relayer submits EVM transactions and pays MON. USDC resides in the user's
  account. Estimate MON gas with Monad semantics; fees are charged on the gas limit.
- No recovery, key rotation or general-purpose wallet claims in this prototype.

## Passkey domain

The owner selected `/metropolis` on the existing Veyra domain. The canonical
origin is `https://agent-commerce-six.vercel.app`, with RP ID
`agent-commerce-six.vercel.app`. An RP ID is a hostname, not a URL path.
Changing the hostname requires registering a new credential. Preview hosts and
the alternative Vercel alias are rejected. `localhost` is allowed for development;
its credentials cannot authorize a production-origin account.

The local `/metropolis` page registers a credential using viem and performs a
domain-separated diagnostic signature check via the native precompile. This is
not the payment challenge and cannot authorize a payment. Only public credential
metadata is stored in the browser. The page does not mount the Arc wallet provider.

## Verified sources (2026-10-08)

| Parameter | Monad Testnet | Monad Mainnet (read-only configuration) |
| --- | --- | --- |
| Chain ID | 10143 | 143 |
| RPC | https://testnet-rpc.monad.xyz | https://rpc.monad.xyz |
| Native gas asset | MON | MON |
| USDC, 6 decimals | `0x534b2f3A21130d7a60830c2Df862319e593943A3` | `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` |
| Identity Registry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| Reputation Registry | `0x8004B663056A597Dffe9eCcC1965A193B7388713` | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |
| P256 | `0x0100`, EIP-7951 | `0x0100`, EIP-7951 |

Sources: [Monad current facts](https://docs.monad.xyz/ai/current-facts),
[precompiles](https://docs.monad.xyz/developer-essentials/precompiles),
[block states and RPC commitments](https://docs.monad.xyz/monad-arch/consensus/block-states),
[Foundry](https://docs.monad.xyz/tooling-and-infra/toolkits/foundry),
[ERC-8004 deployments](https://github.com/erc-8004/erc-8004-contracts),
[Circle USDC addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses).
Confirm RPC chain IDs, contract code, USDC decimals and the reputation registry's
identity-registry reference before using an adapter. Precompiles have no bytecode;
verify a real known signature instead of testing `eth_getCode(0x0100)`.

Use official Foundry >=1.8 with `--network monad` or `network = "monad"` in
the isolated config. Never install the deprecated Category Labs Foundry fork.
MONSKILLS are navigation aids, not a source of truth for addresses or live gas
parameters. Reviewed upstream: `3f8efd26057985d46e5b2b3b611c7e6957fadee0`.
Skills and Context7 setup remain local and excluded from Git.

## Monad trust backend

`lib/monad/evidence.ts` collects verified facts through read-only RPC. Trust
collections use one `finalized` block for identity, token and registry reads;
Monad's `latest` represents a proposed block. Payment evidence must reference
a successful, canonical USDC `Transfer` log at or before that finalized block,
with at least two confirmations measured against the finalized height. The
historical block hash, recipient, payer, exact amount and log index are checked.
Provider self-transfers and provider-controlled feedback addresses are excluded.

ERC-8004 feedback enters scoring only for explicit operator-selected clients and
the local convention `tag1=veyra.delivery`, `tag2=score100`, decimals zero, value
0..100. This is a Veyra convention, not an ERC-8004 requirement. Raw registry
values, review count and distinct addresses do not establish independent ownership
or verified delivery. Missing/unconfigured feedback stays missing.

Delivery assessments carry an EIP-712 signature from an operator-configured
non-provider reporter. They bind agent, buyer, seller, payment transaction and
amount, request/response hashes, score, verdict and timestamp to Monad Testnet.
The registry address namespaces the offchain report; the registry does not store
or validate the report. Assessments require an unambiguous previously verified
payment. Unsigned, conflicting, future-dated and mismatched reports are rejected.

`lib/monad/trust.ts` reuses the existing `computeAgentReputation` and `resolvePolicy`.
The pure scoring input now accepts Monad identity and the explicit evidence types
`usdc_payment_success` and `service_delivery`. It does not manufacture x402 events,
ERC-8183 jobs or Arc proofs. Existing Arc scoring inputs and thresholds retain
their behavior. Veyra confidence is a category-coverage heuristic, not a calibrated
probability. A single operator report can describe execution and service quality;
those dimensions are not two independent evaluators.

Additional Monad execution checks require corroborated payment and passed delivery
history, no failed delivery assessment, a fresh collection, a matching canonical
payee, an executable trust tier and an amount within both owner budget and tier cap.
Old source timestamps cannot be refreshed by rereading identity. Amounts are exact
decimal strings with at most six places and become atomic integer USDC units.
The first account cannot execute `REQUIRE_EVALUATOR`; these cases require review.

Evidence and decisions are deeply immutable and retain process-local verification
provenance. A browser-supplied score or serialized/copied decision cannot reach the
clearance issuer. Recompute through the server collector after a process restart;
do not deserialize a client packet into an authorized decision. Policy client,
reporter and payment lists are operator configuration, not trusted HTTP input.

The Monad clearance builder reuses the original EIP-712 schema and binds the exact
canonical USDC transfer. Task/service, owner budget and evidence are bound into
the decision identifier. Passkey challenges match the Solidity account's nonce,
deadline, domain and digest. Candidate selection shares one task/executor/budget,
filters by executable policy first, then orders by trust or price. Shared onchain
ownership is disclosed. Selection never promises independent providers.

These are backend primitives and verification scripts. A public signing endpoint,
production attester/relayer configuration, device account deployment, fresh
identity/account checks before submission and order/delivery persistence are not
enabled yet. The browser diagnostic remains read-only. No first-time purchase
override or autonomous wallet has been introduced.

## Milestones and acceptance

1. **Local safety prototype:** account + factory; generated cryptographic WebAuthn
   fixtures; valid transfer; wrong key/RP/origin/flags/amount/recipient/nonce,
   expiration, unauthorized attester/executor and clearance replay tests. Check
   rollback on failed token transfer. Run existing Arc contract tests unchanged.
2. **Live read/fork checks:** RPC smoke on both chain IDs; canonical testnet
   ERC-8004 relationship and token checks; real P256 `eth_call`; reproducible
   Monad fork test. These do not establish a deployed payment transaction.
3. **Actual device prototype:** fix a dedicated HTTPS origin and RP ID before
   registration. Create a real iPhone/browser credential, extract its P256 key,
   normalize DER/low-s, and verify its signature through native P256 `eth_call`.
   This read-only device check was reported successful by the user on 2026-10-08.
   Next verify the assertion through the deployed account and record a transaction
   receipt; that contract-execution acceptance remains pending. User verification
   does not identify whether the authenticator used Face ID or a device passcode.
4. **Trust integration:** reuse the existing policy resolver with honest Monad
   evidence. The current full decision service has Arc-specific proof/database
   assumptions; do not invent an Arc proof to make a Monad candidate pass it.
   Distinguish Veyra score from ERC-8004 feedback values and disclose evidence
   coverage and provenance. Missing evidence must remain missing.
5. **One useful purchase:** selected agent, exact clearance, human approval,
   confirmed USDC transfer, actual service result, request/response hashes and
   a separate delivery assessment. Payment success is not delivery success.
6. **Feedback and demo:** verify the deployed ABI before supporting a separate
   passkey-authorized reputation action. The published ABI is
   `giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)`.
   Feedback must come from the client account after a real interaction; never
   fabricate favorable reviews. Disclose self-created demonstration agents.

The main demo excludes x402, Gateway and the full ERC-8183 lifecycle. Add them only
after the principal flow passes. A bare USDC transfer does not provide escrow or
guarantee that the provider delivers; the demo must say so accurately.

## Approval gates

Before each external deployment/transaction present the concrete network,
contract/action, recipient, amount and estimated gas cost. No mainnet writes.
Before publishing review the explicit file list; private planning documents,
local skills, local MCP configuration, secrets and build artifacts must be absent.

### TrustGate deployment preparation

`scripts/metropolis/deployment-plan.mts` prepares unsigned CREATE data for the
unchanged TrustGate using the two owner-selected role addresses. It uses only a
public RPC client and rejects Mainnet, RPC chain mismatch, pending sender nonces,
contract deployers/attesters, occupied CREATE addresses and failed gas estimation.
It loads no signing material and has no broadcast path.

Compile and prepare a reviewable plan using public EVM addresses:

```bash
forge build --root contracts/monad
node --experimental-transform-types --no-warnings scripts/metropolis/deployment-plan.mts \
  --sender DEPLOYER_PUBLIC_ADDRESS --admin ADMIN_PUBLIC_ADDRESS --attester ATTESTER_PUBLIC_ADDRESS
```

The output includes constructor roles, creation/data hashes, predicted CREATE
address, sender nonce, current balance, a 5% gas-limit buffer and maximum MON
fee at the sampled EIP-1559 cap. Gas fees are based on the gas limit on Monad.
An unfunded sender can still receive an estimate using an explicitly disclosed
simulation-only balance override; the output continues to require real funding.
No simulated funding is described as an actual deposit.

The owner supplied one address for both roles on 2026-10-08 and approved one
TrustGate deployment from that same address through Foundry.
Approved transaction bounds are chain ID 10143, nonce 0, gas limit 1,236,257,
maximum fee per gas 122 gwei, and maximum total MON fee 0.150823354. A live
Testnet estimate succeeded with actual funding and no balance override. Owner-
provided local signing material was checked against the approved sender, encrypted
into a temporary Foundry keystore and used for this single deployment. The temporary
keystore and password file were removed after submission; no secret was copied
into the worktree or recorded in deployment evidence. The resulting transaction
and finalized role/domain checks are recorded below.
Deployment planning guards passed 30 checks with mocked read-only RPC values;
TypeScript and scoped ESLint also passed. Recheck nonce, gas and fees immediately
before submission; the estimate does not authorize sending a transaction.

The separately approved TrustGate and factory deployments are complete. Per-user
account creation, funding and payment follow as separate actions. Keep
Mainnet reads available, but do not enable Mainnet execution by removing the
account's Testnet restriction without a separate reviewed specification.

### Per-user account preparation

The updated diagnostic prepares a personal account from the public key already
saved in the user's canonical-origin browser. After native P256 verification,
**Prepare account** reads a finalized Testnet block, checks the deployed factory
and TrustGate runtime hashes, checks USDC and RP/origin configuration, and asks
the factory for the CREATE2 address. An existing account is checked against the
same key and immutable configuration. Deployment status and USDC balance are
observations at that block, not promises that state remains unchanged.

**Copy public account details** exports only the public P256 coordinates,
configuration, deterministic namespace salt, predicted account address and
observation metadata. It exports no credential ID, private key or signature and
does not upload the setup to a server. The fixed salt selects one account per
credential in this factory; reloading or preparing again does not create a new
address. A fresh browser verification is required after a reload. This setup
record does not authorize a transaction or establish ownership by itself.

`scripts/metropolis/account-plan.mts` accepts a public setup JSON file and a
public sender address. It checks the P256 point, rejects other networks/origins
and unknown fields, re-reads the deployed configuration, and independently
calculates CREATE2 using the compiled account creation code. It then prepares
unsigned `createAccount` calldata and estimates gas with a 5% buffer. Sender
nonce, pending transactions, balance and fee caps are included in the reviewable
plan. A simulation-only balance override is explicitly disclosed if needed.
An already deployed account returns no creation transaction. This script has no
environment-file loading, signer, private-key input or broadcast path.

Keep an actual user's setup file in an ignored local location, such as
`.local-tools/user-account-setup.json`, rather than adding it to public evidence.
Prepare the concrete transaction before requesting its separate approval:

```bash
node --experimental-transform-types --no-warnings scripts/metropolis/account-plan.mts \
  --setup .local-tools/user-account-setup.json --sender DEPLOYER_PUBLIC_ADDRESS
```

The owner separately authorized this browser update and the branch push on
2026-10-08. It is published on the canonical domain; see the account-setup
publication evidence below. A real-device run of the new setup/copy flow remains
pending. The existing browser credential storage key is unchanged.

### Published increment — 2026-10-08

The reviewed changes from diagnostic revision `efa0f21` are listed below.
The publication evidence file was added afterward without rebuilding the site:

```text
.vercelignore
app/metropolis/prototype.tsx
docs/METROPOLIS.md
docs/metropolis-account-publication.json
docs/metropolis-testnet-deployment.json
docs/metropolis-testnet-factory-deployment.json
lib/monad/account.ts
scripts/metropolis/account-plan.mts
scripts/metropolis/account-tests.mts
scripts/metropolis/browser-smoke.mts
scripts/metropolis/deployment-plan.mts
scripts/metropolis/deployment-plan-tests.mts
```

The publication updates the diagnostic on the canonical `/metropolis`
path. It enables public account preparation and reflects the two verified
Testnet deployments. It introduces no browser signer, transaction submission or
automatic account funding. Private setup files, environment files, local skills,
tool binaries and `MonadPlan.md` remain excluded from Git and deployment uploads.

### Public change manifest

The new public implementation files are:

```text
app/metropolis/page.tsx
app/metropolis/prototype.tsx
contracts/monad/foundry.toml
contracts/monad/test/MonadPrecompileFork.t.sol
contracts/monad/test/VeyraPasskeyAccount.t.sol
contracts/monad/test/fixtures/backend-clearance.json
contracts/monad/test/fixtures/webauthn.json
contracts/src/monad/VeyraPasskeyAccount.sol
contracts/src/monad/VeyraPasskeyAccountFactory.sol
docs/METROPOLIS.md
docs/metropolis-account-publication.json
docs/metropolis-testnet-deployment.json
docs/metropolis-testnet-factory-deployment.json
lib/monad/config.ts
lib/monad/account.ts
lib/monad/erc8004.ts
lib/monad/evidence.ts
lib/monad/passkey.ts
lib/monad/trust.ts
scripts/metropolis/browser-smoke.mts
scripts/metropolis/account-plan.mts
scripts/metropolis/account-tests.mts
scripts/metropolis/deployment-plan.mts
scripts/metropolis/deployment-plan-tests.mts
scripts/metropolis/generate-webauthn-fixtures.mts
scripts/metropolis/rpc-smoke.mts
scripts/metropolis/trust-smoke.mts
scripts/metropolis/trust-tests.mts
```

Modified existing public files: `.gitignore`, `.vercelignore`, `AGENTS.md`,
`components/layout/layout.tsx`, `lib/reputation/engine.ts`, `lib/reputation/types.ts`.
Fixture keys/receipts/identities are explicitly synthetic; no real wallet secret
is included. `MonadPlan.md` is excluded from Git and deployment uploads. Local
MCP setup, MONSKILLS and Foundry binaries are excluded from deployment uploads.

## Evidence

TrustGate and the account factory are deployed on Monad Testnet. Per-user account
creation and USDC payments have not been authorized or executed.

### TrustGate transaction — 2026-10-08

Contract: `0x4a8f26B1d376c9924aAE80877261E0c635eb54Bb`.
Receipt: `0x1c48705ab59edce5bae251beadb76ccbc11c1b9f025e53bb6c4374a9e8b86b11`,
status `success`, block **69271003**, checked against finalized block **69271314**.
The sender, nonce, constructor data hash, gas limit and fee caps matched the
approved transaction. Both admin and attester roles belong to the approved owner.
The EIP-712 domain reads `Veyra Trust Gate`, version `1`, chain ID `10143`, and
this contract's address. Runtime code hash and public receipt evidence are saved
in `docs/metropolis-testnet-deployment.json`.

Charged fee: **0.126098214 MON**, below the approved **0.150823354 MON** cap.
USDC spent: **0**. Monad Sourcify source verification completed with status
`match`, job `0afb9548-d6bc-4bb8-a6f9-b1b3499aecf9`.
This proves TrustGate deployment and configuration, not a passkey-authorized
payment or service delivery.

### Account factory transaction — 2026-10-08

Contract: `0x8fbaAcB3390ba67F80db02434c024fF2F04ca94B`.
Receipt: `0x82eb3aa96bcaa6c4054a69268e99d129a08b577a88935b5e739fcbbca1743e9d`,
status `success`, block **69276485**, checked against finalized block **69276781**.
The owner separately approved this transaction. Its sender, nonce `1`, deployment
data hash, gas limit **2,829,586**, maximum fee **122 gwei** and priority fee
**2 gwei** matched the approved bounds.

Finalized contract reads confirmed the deployed TrustGate, canonical Testnet USDC,
RP ID hash for `agent-commerce-six.vercel.app` and origin
`https://agent-commerce-six.vercel.app`. The factory's CREATE2 prediction matched
an independent calculation using the compiled account creation code and a
synthetic public WebAuthn fixture. This read-only check did not deploy a user's
account or establish that the fixture belongs to the user's iPhone passkey.

Charged fee: **0.288617772 MON**, below the approved **0.345209492 MON** cap.
USDC spent: **0**. Monad Sourcify source verification completed with status
`match`, job `14980993-ff87-4dd9-b667-370041d5726f`.
Runtime code hash, immutable configuration and public receipt evidence are saved
in `docs/metropolis-testnet-factory-deployment.json`.

The next account must use the public P256 key of the user's existing credential
on the canonical origin. The private passkey remains with the authenticator.
Account deployment, funding, passkey-authorized payment and delivery remain
pending. The factory transaction itself did not update the diagnostic; the
separately authorized account-setup publication below reflects these deployments.

### Account-setup publication — 2026-10-08

Deployment `dpl_2LFxbxzfeWQEGZwcPiERmmPL3aPm` was built from branch
`metropolis-monad`, source commit `a99398801ffe183a6976e31d7896c04163f98fdd`,
with Production environment variables and automatic domain assignment disabled.
The build reached `READY` in **66,347 ms**. Authenticated checks of staged
`/metropolis`, `/`, `/arc` and `/console` all returned HTTP 200 before promotion.
The prior canonical deployment is `dpl_CBnJUpJTx9ps747vTC1DjR26kPtx` for rollback.

After the owner-authorized promotion, both alias mappings completed and the
canonical deployment lookup resolved to the new deployment ID. Public checks of
the same four paths returned HTTP 200. `veyras.vercel.app/metropolis` still
redirects to `https://agent-commerce-six.vercel.app/metropolis`.

The browser smoke passed on the actual canonical site at a mobile viewport with
a Chromium virtual platform authenticator: native P256 `eth_call`, finalized
factory/configuration reads, predicted account address, public setup copy,
credential restoration and clearing stale setup on a simulated RPC failure.
This is not a real iPhone setup test or an account-creation transaction. The
deployment's runtime error-log scan returned **0 entries** for the first
10-minute query window; this is a bounded observation, not a future guarantee.

The CLI's dry upload manifest contained **965 reviewed tracked files**, with no
private or untracked files. Environment files, local skills and skill lock,
tool binaries, generated TypeScript cache and `MonadPlan.md` were excluded.
Publication sent no blockchain transactions and spent no USDC. Public evidence
is saved in `docs/metropolis-account-publication.json`. The branch push did not
change `main`.

### Diagnostic publication — 2026-10-08

The user authorized publication of the read-only diagnostic on the existing
Veyra hostname. Deployment `dpl_CBnJUpJTx9ps747vTC1DjR26kPtx`, built from branch
`metropolis-monad`, commit `e8a86caa6f5f209bfd17a14a860afed142ca853e`, reached
`READY` and was promoted after staging checks. The canonical URL is
https://agent-commerce-six.vercel.app/metropolis. `main` was not changed.

The production browser check passed using a virtual platform authenticator:
credential creation, live Monad Testnet P256 `eth_call`, public-metadata reload
and mobile layout. No write RPC methods were used. This is not a real iPhone
Face ID test or a deployed smart-account transaction.

Reproduce the read-only production check:

```bash
METROPOLIS_SMOKE_ORIGIN=https://agent-commerce-six.vercel.app \
  node --experimental-transform-types --no-warnings scripts/metropolis/browser-smoke.mts
```

The previous production deployment for rollback is
`dpl_J9idbKUn4cH7wM3PRMuLg6rZV5RA`. Private planning documents, local skills,
credentials and local tool binaries were absent from the uploaded file manifest.

### Actual iPhone diagnostic — 2026-10-08

The user reported creating a passkey and completing verification on an iPhone.
Provided Safari screenshots on the canonical Veyra hostname show both the
credential-created message and the successful RP/origin/user-verification plus
native Monad P256 `eth_call` result. This is user-provided device evidence,
separate from the automated virtual-authenticator check above. The screenshots
do not identify the exact biometric/passcode method and are not a transaction
receipt. Deployed-account authorization, payment and delivery remain pending.
The screenshots and private credential metadata are not copied into the repository.

Verified locally on 2026-10-08 with official Foundry 1.8.5:

- 37 Monad account/factory tests passed with generated cryptographic assertions.
  No mocked P256 verifier: the tests execute using the Monad network mode.
  Four tests additionally consume a clearance produced by the real TypeScript
  trust pipeline: digest/challenge equality, exact transfer, replay and tampering.
- 53 backend authorization/provenance checks passed using explicitly synthetic
  RPC evidence and real cryptographic report signatures. Tests cover ALLOW,
  ALLOW_WITH_LIMITS, review/deny, owner/tier limits, payee binding, finality,
  duplicate/conflicting evidence, failed delivery, server provenance and selection.
- The existing seven Arc reputation vectors and TrustGate policy tests passed.
- A live read-only trust probe of public Testnet agent #1 at finalized block
  **69224986** returned `REVIEW_REQUIRED`, coverage 17%, no executable clearance.
  Identity-only score 100 does not bypass evidence requirements. This is not a
  demo provider or a purchase/quality assessment.
- 31 existing Arc contract tests passed unchanged with Ethereum execution mode.
- One native-precompile and infrastructure fork test passed at Monad Testnet
  block **69196275**. It verifies both accepted and rejected signatures.
- Read-only RPC checks passed on chain IDs 10143 and 143: contract bytecode,
  USDC decimals, canonical registry relationship, and native P256 acceptance
  and rejection on Testnet. Agent #1 was read only as a public registry example;
  it is not a Veyra demonstration agent or an endorsed seller.
- Browser smoke passed at a mobile viewport using Chromium's virtual WebAuthn
  authenticator and the live Testnet RPC: credential creation, native signature
  verification, public metadata restoration and alternate-host rejection.
  This does not establish Face ID compatibility on an actual iPhone.
- Account preparation passed 44 input/network/key guards, plus a live read-only
  factory/CREATE2 and gas-estimation check using a synthetic public key. No
  account was created. The browser check of the local build also exercised a
  virtual credential under the canonical origin, finalized factory reads,
  public-only setup copying, metadata restoration and mobile layout. This is
  separate from publication and from testing the new setup flow on an iPhone.
  A simulated RPC failure cleared the old setup and showed a concise retry
  message without raw provider error details.
- TypeScript, scoped ESLint, `npm run build` and the existing deterministic
  trust-policy test passed.

Reproduce from the worktree root after `npm ci`, with official Foundry >=1.8:

```bash
node --experimental-transform-types --no-warnings scripts/metropolis/generate-webauthn-fixtures.mts
node --experimental-transform-types --no-warnings scripts/metropolis/trust-tests.mts --write-contract-fixture
node --experimental-transform-types --no-warnings scripts/metropolis/deployment-plan-tests.mts
node --experimental-transform-types --no-warnings scripts/metropolis/account-tests.mts
forge test --root contracts/monad --network monad --no-match-contract MonadPrecompileForkTest -vv
forge test --root contracts/monad --network monad --match-contract MonadPrecompileForkTest --fork-url https://testnet-rpc.monad.xyz --fork-block-number 69196275 -vv
forge test --root contracts --network ethereum -vv
node --experimental-transform-types --no-warnings scripts/metropolis/rpc-smoke.mts
node --experimental-transform-types --no-warnings scripts/metropolis/trust-smoke.mts 1
npm run reputation:test
npm run trust-gate:test
npx tsc --noEmit
npx eslint app/metropolis lib/monad components/layout/layout.tsx scripts/metropolis
```

For the browser smoke, start `npm run dev -- --hostname localhost --port 3123`,
then run `node --experimental-transform-types --no-warnings scripts/metropolis/browser-smoke.mts`
in another terminal. Install Chromium with `npx playwright install chromium` if needed.
Run `scripts/metropolis/account-tests.mts --live` with the same Node flags for
the read-only factory and account-creation simulation check. To test public
account preparation in the local browser build, set
`METROPOLIS_SMOKE_ACCOUNT_SETUP=1` when running the browser smoke. The test serves
the local build under the canonical browser origin using Playwright routing;
it does not publish anything or create a real user credential on the device.
All these smoke checks use read-only network calls. Test fixture generation keeps
its ephemeral private key in memory and writes only public signatures/metadata.

Milestones 1 and 2 are complete. Milestone 3 has a local browser diagnostic;
an actual-device assertion through a deployed account and its transaction receipt
are still required. Milestone 4 now has a verified backend foundation and local
contract integration; live service evidence, endpoint wiring, delivery persistence
and client feedback remain separate implementation steps. Existing scripts that send signed onchain
transactions are not acceptance checks for this local phase.
