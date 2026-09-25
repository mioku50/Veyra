# Option C pilot tools

These tools run the minimal real test of option C on Arc mainnet:

1. MetaMask grants Nova a permission from a test account: 0.50 USDC a day,
   for three days.
2. Nova's redeemer moves money within it to a hot wallet.
3. The owner revokes the permission.
4. The hot wallet sends the rest back.

- The plan: [the pilot plan](../../docs/audits/2026-09-24-option-c-pilot-plan.md),
  with steps T0–T13.
- Why it is built this way: [the architecture note](../../docs/audits/2026-09-24-option-c-architecture.md).
- Scope: nothing here touches Veyra's app, its database or Vercel.

| File | What it is |
| --- | --- |
| `pilot.mts` | The commands, and the server behind the page |
| `page.html` | The page: connect, switch to Arc, ask for the permission, see the checks, revoke |
| `delegation.mts` | The permission, its checks and the calls, over viem |
| `pilot-tests.mts` | Offline tests: `npm run --silent arc:c-pilot:test` |

## Stage by stage

Each command runs as `npm run --silent arc:c-pilot -- <command>`.

| Step | Who | Command or action |
| --- | --- | --- |
| T0 | Anyone | `preflight` |
| — | Owner | `init`. Prints N (the redeemer) and H (the hot wallet). The keys stay in `~/.veyra-arc-c-pilot/keys.json` |
| T1 | Owner | Make a new MetaMask account and send it 0.02 USDC on Arc |
| T2–T4 | Owner | Run `serve` and open `http://127.0.0.1:8799`. Connect the test account, then *Add or switch to Arc*, then *Ask MetaMask for this permission*. In MetaMask, *Grant*, then confirm the upgrade. The page shows every check and saves the permission only if all pass |
| T5 | Owner | Send 1.00 USDC to the test account and 0.05 USDC to N |
| T6 | Script | `simulate` |
| T7 | Script | `redeem 0.30` |
| T8 | Script | `redeem 0.30 --send-refused`, a real transaction that must be refused |
| T9 | Script | `redeem 0.20` |
| T10 | Owner | Revoke in MetaMask, or with the page's *Revoke this permission* |
| T11 | Script | `check-revoked`. Add `--send` for a real attempt |
| T12 | Script | `sweep` |
| — | Anyone | `status`, and `log` for the follow-up note |

Every command that sends a transaction first says what it will send and what
the gas may cost. It then waits for `send` to be typed. `--yes` skips the
wait. It is meant for a dry run on a fork.

## Safety

- **The keys.**
  - They are made on this machine, in a directory outside the repository with
    mode 0700. `keys.json` is mode 0600.
  - A `--home` inside the repository is refused.
  - Keys are never printed.
- **Fixed destinations.**
  - A top-up goes only to H: the chain enforces that too.
  - A sweep goes only to the account that granted the permission.
- **The owner's main wallet** is refused as the test account, both by the page
  and by the script.
- **The server behind the page:**
  - it holds no key, and signs and sends nothing;
  - it listens on 127.0.0.1 only;
  - it answers only to its own page's token, and only under its own host name.
- **Checks before use.** A grant is saved only when all of these hold:
  - it decodes to exactly the pilot's six caveats;
  - the account carries MetaMask's DeleGator;
  - a simulated top-up to anyone but H is refused by the payee rule.

  The period starts by the chain's clock, so a fast computer clock cannot
  make the first top-up "not started".
- **Revocation checks.** `check-revoked` accepts only a refusal that comes
  from the revocation:
  - a disabled permission;
  - a bumped nonce;
  - an expiry.

  A period that is used up refuses too. It does not count as a revocation.

## A dry run on a fork

Every command takes `--rpc <url>`. The page and the log then say that the run
is not on mainnet. Arc's USDC cannot run on a local fork, because it needs
Arc's native-balance precompile, so a fork needs a plain ERC-20 in its place.

## How it was tested

The tools were run end to end on a local fork of Arc mainnet at block
22,729,692:
- the page ran in headless Chromium;
- a stand-in for MetaMask built and signed the permission with MetaMask's own
  kit, as the permission snap does;
- all 50 checks passed, among them:
  - a grant that pays someone else is refused;
  - a revoke-all is seen behind a used-up period.

MetaMask itself was not used.

On Windows, a browser reaches the page in WSL at `http://127.0.0.1:8799`
through WSL's localhost forwarding.
