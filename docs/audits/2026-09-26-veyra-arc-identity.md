# Veyra's identity on Arc mainnet (ERC-8004)

Item c of the owner's order: an ERC-8004 identity for Veyra on Arc mainnet,
from Veyra's own registrant wallet. Contracts wait for an external audit.

## What the owner chose

On 26 September the owner chose a developer-controlled Circle wallet as the
registrant. It is:
- an EOA on Arc mainnet (`ARC`), in a wallet set of its own;
- neither the owner's wallet nor an attester key;
- held under the owner's own Circle credentials. The owner creates them and
  keeps them; they are never read or shown here.

The same kind of wallet can later sign Veyra's attestations from the server.

## Checked before building

- **Circle Wallets on Arc mainnet.** Circle's supported blockchains page lists
  Arc as `ARC` / `ARC-TESTNET`, with EOA and SCA for developer-controlled
  wallets. It names no Arc-specific limitation, so contract execution works.
  The index behind Circle's MCP search still listed Arc Testnet only.
- **The SDK.** `@circle-fin/developer-controlled-wallets` 10.8.1 knows `ARC`.
  It adds no npm advisory the lockfile did not already carry: its one,
  through `@solana/web3.js`, already came with Circle's other packages.
- **Keys.** A mainnet Circle key starts `LIVE_API_KEY:`. A testnet key is
  refused before the first call.
- **The registry.** `0x8004A169…a432` answers as `AgentIdentity` (`AGENT`).
  A dry call of `register(agentURI)` (`eth_call`, nothing sent) would mint
  agentId 295. It takes about 203,500 gas at 20 gwei, about 0.004 USDC.

## The registration file

Served at `https://agent-commerce-six.vercel.app/.well-known/agent-registration.json`.
That URL is the agentURI written on chain. Being at the well-known path on
Veyra's own domain, it also proves the domain, as ERC-8004 allows.

In the standard's `registration-v1` shape:
- **The description** says what Veyra does and what it does not do:
  - the owner approves and signs every payment;
  - what Veyra records about a seller is Veyra's claim;
  - Veyra sells nothing on Arc mainnet yet.
- **`x402Support` is false**, for the same reason.
- **Services: only the website.** The Agent API's OpenAPI describes the API on
  Arc Testnet, so it waits for item d and a mainnet service.
- **`supportedTrust` is `reputation`.**
- **`registrations` is empty until the mint.** The id then goes into the code
  (`VEYRA_ARC_AGENT_ID`), and the file names the identity back.
- **Veyra's Arc Testnet identity is not listed.** It stays separate, as the
  roadmap asks.

## The script

`npm run veyra-identity -- <step>` has three steps, and the owner runs them.

| Step | Reads or writes | Does |
| --- | --- | --- |
| `wallet` | Creates a wallet at Circle; no funds | Finds the registrant, or creates it. Prints the address to fund with 0.10 USDC. |
| `check` | Reads only | Reads the balance and Circle's fee estimate. Checks that the served file is exactly this code's file, and counts what the registrant already holds and its transactions still in flight. Ends with a dry call of `register()`. |
| `register --confirm <agentURI>` | The one mainnet transaction | Refused unless every check passes and the agentURI typed matches the code's. Polls Circle to a final state, reads the minted id from the receipt, then checks `ownerOf` and `tokenURI`. |

What it refuses, each as its own reason:
- no wallet;
- a file that is not the code's;
- an identity already held, because Veyra registers once;
- a transaction still in flight;
- a dry call that fails;
- no fee estimate;
- a balance below the fee.

It never prints a credential. An error from Circle is cut to its status and
message, because the request behind it carries the key.

## In production, in order

1. **Deploy.** The file must be live before the mint, and `check` refuses
   until it is.
2. **The owner, not through this chat:**
   - a mainnet API key, from the Circle Console, written into `.env.local` by
     hand as `CIRCLE_API_KEY`;
   - the entity secret, created one of two ways:
     - on the Console's entity secret page, and written into `.env.local` by
       hand as `CIRCLE_ENTITY_SECRET`;
     - or with `npm run veyra-identity -- entity-secret`, which does what
       Circle's own example does. It makes the secret itself, because the
       SDK's `generateEntitySecret` prints it. It registers it and appends it
       to `.env.local`. Circle's recovery file goes to `~/.circle/veyra`,
       outside the repository. Neither is printed, and the step refuses when
       `.env.local` already names a secret.

   On 27 September a client key (`LIVE_CLIENT_KEY:…`) went into
   `CIRCLE_ENTITY_SECRET`. The check found it only by shape, and printed
   neither value. It now names a client key or an API key in that place.
3. **The owner:**
   - runs `npm run veyra-identity -- wallet`;
   - sends 0.10 USDC on Arc to the address it prints;
   - runs `check`, then `register --confirm <agentURI>`.

   On 27 September the owner created the entity secret and ran the wallet
   step. The registrant is `0x8F8E0C9Fa2F67AED5b16e04f2716022aeB200eD6`, an
   EOA on `ARC`, and it is also Veyra's payout wallet on Arc. Read from the
   chain before `check`:
   - it holds 0.11 USDC and has sent nothing;
   - it holds no identity;
   - a dry call of `register()` from it would mint agentId 298, for about
     203,500 gas, or 0.004 USDC.

   The owner's first `register` was refused before anything was sent: "Could
   not read the registrant's Circle transactions." Circle refuses a listing by
   `walletIds` together with `blockchain` (400, code 2, "API parameter
   invalid"). A Circle wallet is on one chain already, so the listing now goes
   by wallet id alone. A Circle read that fails now prints its reason, still
   without the key. `check` then passed: nothing in flight, and Circle's high
   fee estimate was 0.012 USDC.
4. **Then the id goes into the file.** Set `VEYRA_ARC_AGENT_ID`, deploy, and
   check the binding both ways:
   - the token's owner and URI;
   - the file's `registrations` entry.

## Not done

- **Attestations.** Feedback in the ReputationRegistry needs a separate
  attester wallet, and it follows verified purchases on Arc mainnet.
- **The `erc8004` field in Veyra's own x402 manifest.** This is how CRA names
  its identity back. It comes with item d: today the manifest sells on
  testnets.
- **The mint itself.** It waits for the owner's steps above.
