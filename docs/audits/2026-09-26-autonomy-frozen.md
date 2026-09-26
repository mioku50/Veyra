# Autonomy frozen, after MetaMask refused option C on Arc mainnet

On 26 September the owner ran the first stage of
[option C's minimal real test](2026-09-24-option-c-pilot-plan.md) in their own
MetaMask, with a new test account. MetaMask refused to grant the permission.
The owner then froze autonomous spending for every user and moved the work to
Arc first and to owner-approved agent hiring (D3).

## What MetaMask did

**Setup:**
- the test account `0x9b57…33dAD`, an imported MetaMask account holding
  0.05 USDC on Arc;
- the pilot page, on `http://127.0.0.1:8799`;
- `preflight` passed on Arc mainnet.

**What happened:**

1. **An introduction screen.** MetaMask opened with "Token subscription
   request": "Token subscriptions give sites permission to pull tokens from
   your wallet on the schedule you set."
2. **Its own permission dialog, with the pilot's terms exactly:**
   - 0.5 USDC, daily;
   - start 26.09.2026 06:31:01 UTC, expiry 29.09.2026 06:31 UTC;
   - redeemer `0x8829…5224c` (N), payee `0x676c…706b6` (H);
   - the justification, word for word.

   The dialog had two oddities:
   - it named the network "Unknown chain 0x13b2";
   - under "Recipient" it showed N, the redeemer. The only address that can
     receive is H, shown under "Payees".
3. **Grant, twice. Both times MetaMask answered:**

   ```text
   -32603  External signature requests cannot sign delegations for internal accounts.
   ```

**Nothing was sent.** On 26 September:
- the test account had nonce 0 and no code, so it was not upgraded;
- it still held its 0.05 USDC;
- N and H held nothing.

## Why

MetaMask signs a delegation for one of its own accounts only when it can decode
the delegation as one of its known permissions. Its decoder, in
`GatorPermissionsController.decodePermissionFromPermissionContextForOrigin`,
looks up the chain's contracts in a table built into the extension, the
`@metamask/delegation-deployments` table:

```text
let d = C[chainId];
if (!d) throw new Error(`Contracts not found for chainId: ${chainId}`);
```

**The table has no Arc.** In MetaMask 13.49.0, its v1.3.0 table lists 46
chains. Arc mainnet (5042) is not among them, and neither is Arc Testnet.
- The decoder throws, so the permission is not recognised.
- The signing guard then treats the request as an outside site asking to sign
  a delegation for the user's own account, and refuses.
- The contracts are deployed on Arc at the same addresses. What is missing is
  the entry in MetaMask's table.

**Why the dialog still appeared.** The permission snap falls back to
Ethereum's addresses when it has no entry for a chain, so it built the
dialog. The extension's decoder has no such fallback.

**Nothing on Veyra's side can get round this.** The page already asks through
`wallet_requestExecutionPermissions`, and a raw delegation from a site meets
the same guard. It works only once a MetaMask release adds chain 5042 to that
table.

**This corrects the note of 24 September.**
[Option C in sequence](2026-09-24-option-c-architecture.md) said that "by its
code and configuration, MetaMask already offers this on Arc mainnet". That was
read from MetaMask's feature flags and from its permission snap. The check
never reached the table the extension's decoder uses.
- The fork tests stand: the contracts do what that note says.
- The wallet route to those contracts does not exist yet.

The HybridDeleGator fallback in that note is not refused by this guard,
because its delegator is a separate smart account. It is frozen with the rest.

## The owner's decision

On 26 September the owner decided that autonomous spending is frozen for every
user. Every payment is proposed by Nova, checked by Veyra and approved by its
owner.

**Production before the freeze:**
- **No mandates.** Production held no unexpired, unrevoked execution mandate
  of any mode, AUTOPILOT or PREVIEW.
- **No shadow decisions since 20 September.** The last shadow-autonomy
  decision was on 2026-09-20.
- **Autopilot switched off.** `VEYRA_AUTOPILOT_ENABLED` is not set in
  production, and neither is any server payer.

So the freeze stopped nothing that was running. It closes every door that
could open again.

| Where | Frozen behaviour |
| --- | --- |
| `lib/execution/autonomy-freeze.ts` | `AUTONOMY_FROZEN`, a constant rather than a setting. `VEYRA_AUTOPILOT_ENABLED` alone cannot undo it |
| `POST /api/execution/v1/autopilot` | 503 `AUTONOMY_FROZEN`, before authentication |
| `POST /api/execution/v1/mandates` | A new AUTOPILOT mandate is refused with 403 `AUTONOMY_FROZEN`. PREVIEW and PREPARE are unchanged, because they cannot spend |
| Nova's autonomy route | No shadow-autonomy limits are offered or saved: 409 `autonomy_frozen` |
| The scheduled shadow pass | Stops before it reads a mandate: no discovery, no quote, no model call |
| Nova's page | The autonomy panel says "Autonomy · frozen" and offers nothing to sign. The brief's shadow state carries the new block reason `autonomy_frozen`, and it has words for the owner |

The library path behind the autopilot endpoint is unchanged and still tested,
so that lifting the freeze is one reviewed change: the constant, and the test
in `nova-autonomy:test` that pins it.

**Not changed:**
- **Owner-approved purchases** work exactly as before.
- **The option C pilot tools** (`scripts/arc-c-pilot/`) are kept and marked
  frozen.
- **The research notes** stand as records.

**Left over:**
- **The test account.** It still holds its 0.05 USDC and was never upgraded.
- **The pilot keys.** They are in `~/.veyra-arc-c-pilot` on the owner's
  machine and are empty. Deleting that directory is the owner's to do.

## What comes next

The owner's order:

1. **Arc first:**
   - full Arc discovery;
   - better selection of services;
   - Veyra's identity and attestations on Arc mainnet;
   - Veyra's own paid service;
   - the Circle Agent Marketplace, and the Arc team for Portal.
2. **D3.** Nova proposes hiring a specific ERC-8004 agent for a specific task
   and price. The owner confirms every hire.

The [roadmap](../ROADMAP.md) carries both.
