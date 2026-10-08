# Metropolis purchase prototype

This increment connects the existing Monad trust adapter to owner approval and
payment receipt verification. It runs only on Monad Testnet (10143). Arc execution
and autonomous spending policy remain unchanged. The public interface uses manual
proposal/approval exchange; it is not a hosted signing or broadcast service.

## Operator and owner flow

1. Specify a service ID, concrete request, expected deliverable, ERC-8004 provider,
   exact USDC price and owner budget. Identify any Veyra-created demonstration agent.
2. Collect canonical identity, selected payment receipts and signed delivery reports
   through `preparePurchasePlan`. Evidence configuration is operator-owned. A funded
   buyer or a registered provider alone cannot produce an executable clearance.
3. Pass the process-local decision to `issuePurchaseQuote` with an authorized
   attester. Copied decisions, review/deny results, task/provider/budget mismatches
   and an undeployed account are rejected. This library accepts an injected signer;
   it never loads an environment file or broadcasts.
4. On the canonical `/metropolis` page, verify the saved passkey and prepare the
   deployed account. Paste the signed proposal and select **Check proposal**.
   The browser checks both signatures, account/key configuration, current provider
   identity, attester authority, nonce, expiry and balance before displaying a
   validated purchase. Finalized and latest identity changes fail closed.
5. Review the task, expected result, provider, exact amount, policy decision,
   limitations and expiry. **Approve … USDC with passkey** signs the deployed
   account's challenge, then simulates its complete `executePayment` call with
   actual state. It sends no transaction. Copy the approval for the operator.
6. `planApprovedPayment` repeats verification and simulation and prepares unsigned
   EIP-1559 calldata with sender nonce, a 5% gas buffer and maximum MON fee.
   Present this concrete transaction for the owner's separate relay approval.
   The relayer pays MON; the account transfers exactly the approved USDC amount.
7. After relay, enter its transaction hash. Verification requires success, canonical
   block/finality, exact calldata and matching TrustGate, account and USDC events.
   **Payment confirmed** and **Service delivery: not assessed** are separate states.
   A saved approval can verify its receipt after reload, expiry or nonce consumption.

A second attester signature covers the complete displayed task and policy context.
The unchanged TrustGate clearance binds the original trust decision and exact
transfer. The owner challenge binds chain, account, TrustGate, clearance, action,
nonce and deadline. Changing a task, amount, recipient or context invalidates the
proposal or its signatures. Approval authorizes one execution before expiry;
copying it does not itself broadcast or revoke that authorization.

## Public-input commands

Keep actual setup, proposal and approval files in an ignored directory. Never
commit a device credential record, approval, environment file or operator secret.
Task JSON has exactly `serviceId`, `request` and `deliverable` string fields.

```bash
node --experimental-transform-types --no-warnings scripts/metropolis/purchase-plan.mts \
  --setup .local-tools/user-account-setup.json --task .local-tools/task.json \
  --agent-id PROVIDER_ID --amount 0.012 --budget 0.02 \
  --evidence-policy .local-tools/operator-evidence-policy.json

node --experimental-transform-types --no-warnings scripts/metropolis/relay-plan.mts \
  --approval .local-tools/payment-approval.json --sender PUBLIC_RELAYER_ADDRESS
```

Both CLIs are read-only. The purchase planner prints `eligible:false` and reasons
when evidence is insufficient; it does not issue a signature. A new provider needs
honest corroborated payment and delivery history under the current policy. No
first-time override, fabricated reviews or synthetic live evidence is supported.

## Scope remaining for a useful purchase

A real provider/service must be selected and integrated. Useful output, persistence
of request/response hashes, an actual delivery assessment and client ERC-8004
feedback remain separate work. A manual operator flow or a successful local fork
does not prove a live end-to-end service. Direct transfer provides no escrow.

## Verification

Verified locally on 2026-10-08: 44 purchase packet/signature/budget/provenance
checks, 53 existing Monad trust checks, 37 Monad contract authorization tests,
31 unchanged Arc contract tests, the seven Arc reputation vectors and TrustGate
policy tests passed. TypeScript, scoped ESLint and the production build passed.

The full browser flow passed on a disposable Monad fork pinned at block
**69323524**, using official Foundry **1.8.5** and a Chromium virtual platform
authenticator at a 390×844 viewport. It verifies native P256 execution, a
0.012-USDC fork transfer, exact receipt matching, replay rejection, tampered task
rejection, identity-only refusal, approval copying and receipt restoration after
reload. Browser RPC methods were read-only, with no horizontal overflow or browser
runtime errors. **No external transaction was sent or service delivered.** This
does not establish a payment approved by the actual iPhone credential.

Run packet tests and the existing account authorization suite:

```bash
node --experimental-transform-types --no-warnings scripts/metropolis/payment-tests.mts
node --experimental-transform-types --no-warnings scripts/metropolis/trust-tests.mts --write-contract-fixture
forge test --root contracts/monad --network monad --no-match-contract MonadPrecompileForkTest
```

For the browser/relay/receipt test, build and start Next.js on port 3126, then run:

```bash
METROPOLIS_TEST_FUNDING_SOURCE=PUBLIC_TESTNET_ADDRESS_WITH_AT_LEAST_ONE_USDC \
METROPOLIS_TEST_FORK_BLOCK=FINALIZED_BLOCK_WITH_THAT_BALANCE \
  node --experimental-transform-types --no-warnings scripts/metropolis/purchase-browser-fork.mts
```

The test launches official Foundry 1.8+ Anvil with Monad execution at localhost.
It impersonates addresses and uses synthetic history **only on that disposable
fork**. Chromium's virtual authenticator performs real WebAuthn cryptography;
the deployed account executes native P256 verification on the fork. The upstream
proxy allows only read RPC methods. It never spends the live funding address's
USDC or grants a live attester role. It does not call or assess a real service.
