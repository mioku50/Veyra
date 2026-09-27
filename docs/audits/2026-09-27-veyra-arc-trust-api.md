# Veyra's Trust API on Arc mainnet

Item d of the owner's order is Veyra's own paid service on Arc. The Circle
Agent Marketplace intake and the Arc team's Portal follow it.

## What the owner chose

On 27 September the owner chose:
- **The payout.** Veyra's own Circle wallet, the same one that registers its
  ERC-8004 identity. In ERC-8004 the agent's payment address starts as its
  registrant, so the identity and the payout are one address.
- **The products.** `history` at 0.005 USDC and `select` at 0.02 USDC, as on
  testnets. `verdict` stays free, and `clearance` stays on testnets.
- **The network.** Arc alone. The testnet service is unchanged.

## Checked before building

- **Circle's mainnet Gateway facilitator settles on Arc.** Its list of what it
  settles has twelve mainnets. The Arc entry is `eip155:5042`, scheme `exact`,
  `GatewayWalletBatched`. It uses the Gateway Wallet at `0x7777…00ee` and
  USDC at `0x3600…`.
- **What `history` would sell.** Veyra has observed 143 endpoints on Base
  (5,596 observations) and 11 on Arc (16). The last observation was on
  24 September. A buyer on Arc may ask about any endpoint.
- **Why `clearance` stays on testnets.** It is signed for Veyra's TrustGate,
  which exists on Arc Testnet only. On mainnet nothing could verify it until
  audited contracts are deployed.

## Built

- **Two routes of their own:** `/api/x402/v1/arc/history` and
  `/api/x402/v1/arc/select`.
  - They are paid only through Circle's mainnet facilitator, only on Arc, and
    only to `VEYRA_ARC_PAY_TO`.
  - The payout address is a constant in the code, not the environment. Every
    402 challenge publishes it anyway, and changing where Veyra is paid should
    take a reviewed commit.
- **No credits.** The testnet routes take credits, and a credit is earned with
  a clearance paid in faucet USDC. On Arc a credit is refused with 402
  `credits_not_accepted`, so testnet money buys no mainnet work.
- **`select` on Arc:**
  - it searches sellers paid on Arc unless another network is asked for;
  - it signs no clearance;
  - its schema has no `requesterWallet`.
- **Nothing is sold before there is a wallet.** Until `VEYRA_ARC_PAY_TO` is
  set:
  - the routes answer 503 `payments_unavailable`;
  - the catalogue lists no Arc item;
  - the registration file still says Veyra sells nothing on Arc.
- **Once the wallet exists:**
  - the catalogue lists the two Arc items;
  - the registration file sets `x402Support` to true and names the catalogue
    and the OpenAPI document;
  - its description gives the two prices.
- **Once the identity is minted,** the catalogue names it back in an
  `erc8004` field, as CRA's does.
- **An OpenAPI document** at `/openapi/veyra-arc-trust-api.json`. It is built
  from the definitions the routes and their challenges use, so it cannot
  describe a request they refuse.
- **Veyra is never its own candidate.** Once it sells on Arc, it is listed in
  the places it searches: Circle's catalogue and the ERC-8004 registry.
  - Chosen for an owner, it would be the owner paying Veyra's wallet for
    Veyra's answer.
  - Discovery now drops any listing on Veyra's hosts, or paid to its wallet.

## Faults found on the way

These three affected the testnet routes as well, and are fixed in both.

1. **`select` refused its own published field.** The schema offers
   `requesterWallet`. The selection engine refuses any field it does not own,
   so a buyer who followed the schema was refused, after paying.
2. **That refusal read as an outage.** The Trust API's error mapping knew only
   its own errors. The engine's refusal came back as 503, "cannot answer right
   now", instead of 400 with its code.
3. **Requests were checked only after settlement.** x402 has no refund.
   - A paid request is now checked before it is verified or settled.
   - An unpaid request is not checked, so a probe with no body still gets the
     challenge, as marketplace health checks expect.

## Verified

- **`arc-trust-api:test`.** It is new and in the release gate. It stubs
  Circle's facilitators with the Arc entry as published, and covers:
  - the accepts: Arc only, with the facilitator's domain and asset;
  - the checks made before payment: nothing reaches the facilitator for a
    refused request;
  - credits refused on Arc;
  - 503 before the wallet exists;
  - the catalogue;
  - the self-exclusion;
  - the registration file once selling;
  - the OpenAPI document.
- **`marketplace:test`** now also checks that Veyra's own routes, on either
  host, are not candidates.
- **The existing `x402-trust-api:test`,** unchanged and passing.

## Production, in order

1. **Deploy.** Nothing changes for buyers yet: the Arc routes answer 503 until
   the wallet exists.
2. **The owner completes Circle's setup and runs the wallet step** of
   `npm run veyra-identity`.
3. **The wallet's address goes into `VEYRA_ARC_PAY_TO`,** and the service is
   deployed. The registration file then describes the sales, and `check`
   compares against it. Done on 27 September: the wallet is
   `0x8F8E0C9Fa2F67AED5b16e04f2716022aeB200eD6`.
4. **The identity is registered,** and its id goes into `VEYRA_ARC_AGENT_ID`.
   Done on 27 September: Veyra is agentId 298.
5. **The first paid call.** A buyer needs a Gateway deposit on Arc, and the
   owner's wallet holds none.
6. **The owner submits Circle's Agent Marketplace intake form,** with the
   answers below. Then comes Arc's contact form for Portal.

## For the Circle Agent Marketplace intake

The owner submits it once step 3 is live. Every answer can be checked at the
URLs given.

| Field | Answer |
| --- | --- |
| Service | Veyra Trust API on Arc |
| What it does | Checks x402 sellers before an agent pays them. `history`: what Veyra has observed of an endpoint (latency and price distributions, payee changes, uptime). `select`: discovers, probes and ranks sellers for a task. What Veyra says about a seller is its own claim. |
| Endpoints | `POST https://agent-commerce-six.vercel.app/api/x402/v1/arc/history` (0.005 USDC), `POST https://agent-commerce-six.vercel.app/api/x402/v1/arc/select` (0.02 USDC) |
| Payment | x402 v2, `exact`, Circle Gateway (`GatewayWalletBatched`) on Arc mainnet, `eip155:5042` |
| OpenAPI | `https://agent-commerce-six.vercel.app/openapi/veyra-arc-trust-api.json` |
| Payout wallet | Veyra's Circle wallet on Arc, `0x8F8E0C9Fa2F67AED5b16e04f2716022aeB200eD6` |
| Identity | ERC-8004 on Arc mainnet, agentId 298 in `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, file at `https://agent-commerce-six.vercel.app/.well-known/agent-registration.json` |

## Not done

- **Withdrawing sales from Gateway.** It needs a signature from the Circle
  wallet, and is a later step.
- **A paid call on Arc,** for want of a buyer with a Gateway deposit there.
- **The listing requests.** They are the owner's to send.
