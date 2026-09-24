# Arc first — the market on Arc, how Veyra would find it, and Veyra in Arc Portal

The owner asked for three things:
- make Arc Veyra's primary ecosystem, and keep Base as an additional network
  for buying services;
- design one discovery for both;
- find out what it takes to appear in Arc Portal.

This note answers all three. The D1 wallet half of the same request is in
[D1 — where an operational signer plugs in](2026-09-23-d1-operational-signer.md).

**How it was measured:**
- Measured on 23 September 2026, 21:35–22:00 UTC, read-only.
- Four sources were read: Circle's x402 catalogue, Coinbase's x402 Bazaar,
  the ERC-8004 registries on Arc mainnet and Arc Portal. Arc mainnet was
  also queried directly over RPC.
- Endpoints were probed with unpaid requests through Veyra's own SSRF-safe
  transport. No payment header was sent.
- Nothing was paid, signed, registered or written to production.

The figures are in
[the evidence file](2026-09-23-arc-market-evidence.json).

## This corrects the D1 comparison

[The D1 comparison](2026-09-23-d1-wallet-comparison.md), written earlier the
same day, said Nova's market had no endpoints on Arc. It concluded that a
wallet which could only pay on Arc would have nothing to buy.

**That was wrong.** It described Veyra's configuration, not the market:
- Discovery asks Circle's catalogue for Base by default.
- It does not know Arc mainnet as a network at all.

Asked for Arc mainnet, Circle's catalogue lists **482 offers**.

## What is on Arc

Arc mainnet is chain `5042` (RPC `https://rpc.mainnet.arc.io`). USDC is
`0x3600000000000000000000000000000000000000`, the same address as on testnet.
Circle Gateway on Arc is domain 26, with its GatewayWallet at
`0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE`.

Circle's Gateway facilitator lists `eip155:5042` among the networks it settles.

### Where the offers are

| Source | Offers on Arc mainnet | Who sells | How they are paid on Arc |
| --- | --- | --- | --- |
| Circle's x402 catalogue (the Agent Marketplace's Discovery API) | 482 listings, 463 distinct URLs | 5 providers: Orthogonal 293, AIsa 135, BlockRun.AI 41, Goldsky 11, Exa 2 | All 482 through a Circle Gateway deposit. Only Exa's 2 also accept a plain wallet payment. |
| Coinbase x402 Bazaar | 12 of 16,604 listings | 8 hosts: Exa, Insumer, SpendTheBits, clawg (2 hosts), retcg, ip402, watchevelive | 7 from a wallet, 8 through Gateway; some accept both |
| ERC-8004 registries on Arc mainnet | 192 agent identities, 39 owners | 7 declare x402 support; 2 of them sell standard x402 on Arc | See below |
| Arc Portal | Not a catalogue of paid APIs | — | — |

For comparison, the same Circle catalogue lists 1,009 offers on Base from 31
providers, and none on Arc Testnet.

No offer in either catalogue is Arc-only. Each is also sold on other chains,
usually Base. The exception came through ERC-8004: CRA's direct routes accept
Arc and nothing else. Nova's own search terms find Arc offers too:
- "search" finds 193 Arc listings, and "web" finds 143.
- Exa search is sold on Arc for **$0.007 from a wallet**, the same price as on
  Base.

### Payments are happening on Arc

In 2,000 blocks, about 17 minutes ending near 21:52 UTC, Arc's USDC recorded:
- 169 EIP-3009 authorizations redeemed;
- 50 payers and 40 payees;
- a median payment of $0.0016.

None of the busiest payees appears in any catalogue or in the ERC-8004
registry. This shows that gasless USDC payments are in real use on Arc. It
does not show who is selling.

### ERC-8004 on Arc mainnet

The three registries are deployed on Arc mainnet at their canonical mainnet
addresses, each reporting version 2.0.0:
- identity: `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`;
- reputation: `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`;
- validation: `0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58`.

Arc's documentation lists only the testnet addresses.

**What the identities say:**
- 192 identities are registered.
- 145 registration files could be read.
- 47 could not: every public IPFS gateway answered 429. 43 of those 47 point
  at one shared file.

**Agents that declare x402:**

| Agent | What it offers | Unpaid request |
| --- | --- | --- |
| #186 CRA AGENT | Arc network data; its manifest lists 22 routes. Its `/.well-known/x402` names its own ERC-8004 id, so the registry and the endpoint point at each other. | 402 on Arc: $0.0005 through Gateway, or $0.003 from a wallet |
| #1 APEX Faucet | A catalogue of 43 resources at $1.00 each, with its own facilitator | 402 on Arc, $1.00 from a wallet |
| #2–#5 Kleos | A 402 that says "send 0.1 USDC on Arc, then retry with the hash", or open an escrow job | Not x402. Nothing binds the transfer to the request. |
| #134 StatPad | A quote API | 405 to GET. Not standard x402. |

None of these four appears in Circle's catalogue or in the Bazaar. Discovery
through ERC-8004 finds sellers the catalogues miss. It also finds identities
with no services: many carry template names such as "User Personas".

## Probed without paying

| Offers probed | Asked to be paid on Arc | Matched the listing |
| --- | --- | --- |
| Circle catalogue, 49 sampled across all 5 providers | 43 | 42 |
| Bazaar, all 10 not also in Circle's | 10 | 9 |
| ERC-8004, 3 routes of the 2 standard sellers | 3 | — |

The misses were these:
- **BlockRun.AI** rejected an empty body before quoting 5 times (HTTP 400).
  One path held an unfilled `{symbol}` template (HTTP 404).
- **Exa contents** asked $0 for an empty body. The price depends on the body,
  which is why Veyra prices the exact request.
- **watchevelive `/stamp`** asked **$50.00** against a listed $0.05. A decision
  ceiling refuses that; a listing price would not.

So there are two working ways to pay a seller on Arc, and one way Veyra does
not pay:

1. **x402 `exact` from a wallet.** An EIP-3009 authorization signed under
   Arc USDC's own domain (`USDC`, version `2`, contract `0x3600…`). Offered
   by:

   | Seller | Price |
   | --- | --- |
   | Exa search | $0.007 |
   | Exa contents | priced by body |
   | CRA direct | $0.003 |
   | Insumer | $0.05–0.15 |
   | SpendTheBits | $0.01 |
   | watchevelive print | $0.05 |
   | APEX | $1.00 |

   Arc's USDC redeems the authorization, so the payment is settled on Arc.
2. **x402 `exact` through Circle Gateway.** The same authorization, signed
   under the GatewayWallet's domain (`GatewayWalletBatched`) and paid from a
   deposit. The minimum deposit is 0.5 USDC. It is offered by:
   - the 480 Gateway-only listings in Circle's catalogue;
   - CRA's paid routes;
   - clawg, retcg, ip402 and watchevelive.
3. **Not x402, and not payable through Veyra:** Kleos's "send first, then
   retry" and StatPad's quote API. A plain transfer is not bound to the
   request it pays for.

## What Veyra can pay on Arc today: nothing

The probes ran Veyra's own accept selector and USDC check on every Arc offer
they reached.

| Step | What stops it | Where |
| --- | --- | --- |
| Discovery | `eip155:5042` is not a known network. Asking for it throws `marketplace_network_unsupported`. The default is Base. | `lib/counterparty-selection/marketplace-source.ts:30`, `:173` |
| Quote, wallet payments | Arc mainnet USDC is missing from the asset table. All 7 wallet offers probed were accepted by the selector and then refused as `asset_not_usdc`: Exa (2), Insumer (3), SpendTheBits and watchevelive print. | `lib/x402/usdc-assets.ts:23` |
| Quote, Gateway payments | Arc mainnet is missing from the Gateway domain table, so all 45 Gateway-only offers probed were refused as `no_payable_accept`. | `lib/x402/gateway-deposit.ts:36`, `:67` |
| Reconciliation | `chainForNetwork` has no `eip155:5042`. `arc` and an empty network still mean Arc Testnet, as they must for old records. | `lib/execution/settlement-resolver.ts:116` |
| Chain definition | The installed viem, 2.47.1, has no Arc mainnet chain. Arc's documentation says current viem ships one. | `package.json` |
| Autonomy | The only mandate is Base (the D0 calibration epoch). ERC-8004 counterparty selection is Arc Testnet only. | `lib/nova/autonomy-mandate.ts:45`, `lib/counterparty-selection/types.ts:6` |
| Veyra's own paid API | `/api/x402/v1/select` offers 12 networks, all testnets, Arc Testnet among them. No mainnet. | Probed on production |

Each fix is small, and most are in payment code. None was made here.

*2026-09-24, with the owner's approval:* the first four rows and the
chain-definition row are fixed. Autonomy and Veyra's own paid API are not.

- Arc mainnet USDC (`0x3600…`) is now in the asset table under chain 5042.
- Gateway domain 26 is in the domain table. It was checked against Circle's
  `/v1/info` and `/v1/x402/supported`, which lists `eip155:5042` with the
  mainnet GatewayWallet.
- `chainForNetwork("eip155:5042")` resolves to Arc mainnet, read over Arc
  mainnet's own RPC and never the testnet URL. A bare `arc` still means the
  testnet.
- `eip155:5042` is a marketplace network. The alias `arc` in discovery now
  means mainnet.
- `lib/wallet/arc.ts` holds Veyra's own chain definition for Arc mainnet. It
  replaces viem's missing one.
- A wallet that has never seen Arc is asked to add it from Veyra's parameters
  before switching.
- The EIP-712 domain was read from the chain: `name()` is `USDC`, `version()`
  is `2`. The tests sign an Arc wallet payment under that domain and recover
  the signer. They accept a Gateway payment only against the mainnet
  GatewayWallet.
- Nova's brief reads Circle's catalogue for Arc first and Base second. An
  endpoint sold on both networks becomes one card, on Arc.
- Which network is paid is still decided by the live challenge. For an
  endpoint that offers both networks at the same price, that is the order the
  seller lists them in, not a preference for Arc.
- Nova's own mandate still names Base, so Nova refuses Arc offers on its own
  (`network_matches_mandate`). Only the owner's own signed purchase pays on
  Arc.

*2026-09-24, later: what stood between the owner and a purchase on Arc.* The
tables were not enough. The owner found Exa on Arc in My Agent and could not
buy it, and three causes were found. They are fixed in this order:

1. **No way to ask a listing.** Listings are background observations, and Nova
   proposes nothing from them (`paidResearchReadiness`). That was right when
   Nova wrote the question: it paid Exa's search API $0.0070 to search for
   Exa. Now the owner can ask a listed tool their own question from My Agent.
   Veyra's decision, the live quote, the owner's signature and the check on
   the answer all still run. Only the "a reading must find a gap" rule is
   skipped, because the question is the owner's. Secrets are refused before
   anything is sent. Only an `x402_resource` listing can be asked.
2. **The quote took the seller's first offer.** Exa's live 402 offers one price
   seven ways:
   - a wallet payment on Base to a legacy payee (`0x6d6E…`);
   - Solana;
   - Gateway on Base, World Chain and Arc;
   - a wallet payment on Arc (`0xB98e…`);
   - a wallet payment on Base (`0xB98e…`).

   The quote took the cheapest, and a tie went to whichever came first. A
   decision made on Arc was therefore quoted on Base, to a payee nobody decided
   on, and the quote store refused it. The quote now considers only accepts on
   the decision's network, payee and asset (`decided_terms_not_offered`
   otherwise). At one price it takes a wallet payment before a Gateway one. Nova
   prices a listing on its own terms the same way, and the discovery for an
   interaction uses the listing's network.
3. **Nova's approval could not be quoted at all.** Since the relay began
   reading decisions back (`2c913e3`, 2026-09-16), a decision is stored only
   with a clearance. Nova's approval deliberately clears after quoting, for the
   exact amount, so its decision was never stored. The quote then answered "No
   Veyra decision with that id". The approval now asks for the decision to be
   recorded without a clearance (`recordDecision`). A proposal that only prices
   still leaves nothing quotable.

Checked live without paying (2026-09-24):
- The owner's question to Exa search on Arc priced at $0.007, "Direct USDC on
  Arc", payee `0xB98e…`, `REQUIRE_EVALUATOR`, with the question sent as
  `query`.
- The approval re-selected, recorded the decision and quoted the same terms.
  It stopped at the clearance signature, which needs production keys.

**The first payment through Veyra on Arc mainnet, 2026-09-24.** The owner asked
Exa search a question from My Agent ("jumper tokensale info"), approved
$0.007, and signed in their own browser wallet. On chain:

| Fact | Value |
| --- | --- |
| Transaction | `0x08b3ff1ceb76d9d47ca6ae8d914eec0e9061f16a58d355940a786d63ef9d0dac`, block 22517476, status success |
| Call | `transferWithAuthorization` on USDC `0x3600…` (the `bytes` signature form, selector `0xcf092995`) |
| Sent by | `0xa483…ad30`, the seller's side; it paid the gas, the buyer only signed |
| Authorizer | `0x8e52…8909`, the owner's wallet (`AuthorizationUsed`, nonce `0x3077…88bc`) |
| Transfer | 7000 in the 6-decimal ERC-20 view to Exa's payee `0xB98e…2dbC`; the same move appears as 7×10¹⁵ in Arc's 18-decimal native view |
| Veyra | execution `vexec_8e412d01ae4a47a3`, delivery check PASS |

This is group G1 of the D1 matrix with a browser wallet (an EOA) in place of
the agent wallet. It shows the seller side works on Arc: Exa accepts the
authorization and its facilitator settles it. What it cannot show is how
Circle's agent wallet signs, which G1 exists for.

Exa contents is still refused on both networks, and that is Veyra's policy
working. Its free probe raises a different price from its listing
(`catalog_drift:price_changed`), and Veyra does not pay a seller whose terms
disagree with themselves.

## One discovery for Arc and Base

**The principle.** Discovery says who might sell something and what they
last asked. It never says what will be paid. Every source below feeds the
same candidate engine that `marketplace-source.ts` already feeds. The same
probe, ranking, policy and clearance follow.

### Sources

| Source | How it is read | Arc coverage it adds |
| --- | --- | --- |
| Circle catalogue | Once per network: Arc first, then Base, only on networks the decision allows | 482 Arc offers |
| Coinbase Bazaar | The API cannot filter by network, so a bounded daily snapshot indexed by network, never a download per request | Insumer, SpendTheBits, ip402, clawg, retcg, watchevelive |
| ERC-8004 on Arc mainnet | Identities → registration files → declared x402 endpoints and manifests, refreshed on a schedule | CRA, APEX |
| Veyra's seller registry | As now | Veyra's own sellers |
| An address the owner pastes | Probed only, never trusted as a listing | — |

### One record per offer

- **Source and provenance:** every source that lists the offer, each with
  when it was read and when it says it was updated.
- **The call:** URL and method, keyed by URL and method, with the offers from
  all sources merged.
- **Network and rail, per network:**
  - the chain in CAIP-2 form;
  - the rail: from a wallet, or through a Gateway deposit;
  - the asset and the verifying contract, both checked against Veyra's own
    table and never taken from the seller.
- **Price and payee, as last listed.** A payee that changes on every request
  is flagged, as Parallel's does on Base.
- **What it does:** capabilities, description, and the request and response
  shapes from the listing, the Bazaar extension or the challenge.
- **Identity:** the ERC-8004 id, and whether the binding holds both ways (the
  registration names the endpoint, and the endpoint's manifest names the id).

### Which network

- **The owner's mandate names the networks.** Arc comes first among them and
  Base is additional. A decision is made for one network and is bound to it,
  as `settlementNetwork` already is.
- **A refusal stands.** Veyra may refuse an offer on Arc because of its
  price, its payee, its trust score or anything else. Nova then does not try
  the same seller on Base. The card may say the seller also sells on Base.
  Buying there is a new decision, under a mandate that allows Base.
- **Base support stays.** Nothing here removes it.

### Safety carried over

- **SSRF.** Every fetch goes through `fetchWithSsrfProtection`: registration
  files, manifests, catalogues and probes alike. That means HTTPS only, DNS
  pinning, private addresses refused, and bounded time and size. IPFS is read
  only through a fixed list of gateways. `data:` URIs are parsed locally, with
  a size cap.
- **Counterparty checks.** Payees are pinned. An ERC-8004 binding counts only
  if it holds both ways. Arc USDC and the GatewayWallet must match Veyra's
  table.
- **Only standard x402.** A 402 that is not `exact` x402 is not an offer.
- **A fresh quote before every payment.** `quoteX402Call` reads the live
  challenge for the exact body, under a decision ceiling, before anything can
  be signed. watchevelive's $50 is what this is for.

### Order of work (no money)

1. **Read-only Arc discovery:**
   - Circle catalogue per network, the Bazaar snapshot and the ERC-8004 read.
   - The network shown on every card.
   - No change to how anything is paid.
2. **Arc mainnet in the payment tables, with tests:**
   - USDC on 5042, Gateway domain 26 and the Arc chain definition;
   - reconciliation on Arc.
3. **A new mandate that names its networks.** The D0 epoch stays Base. Its
   terms cannot change without a new signature.

## Veyra in Arc Portal

### What Portal is

[Arc Portal](https://portal.arc.io/) was announced on 18 September 2026. It
is Circle's interface for people:
- create or connect a wallet, and fund it;
- earn, swap and send;
- discover apps;
- "create or provision an agent wallet, fund it with a defined amount, set
  limits and permissions, connect it to an agent running in their own
  environment, and monitor activity from Arc Portal".

That last part matters to D1. See the
[signer note](2026-09-23-d1-operational-signer.md).

### How an app gets in

- **No self-serve submission is documented.** The announcement, Portal's
  terms and Arc's documentation describe none, and Arc's documentation does
  not mention Portal at all.
- **Circle chooses.** Portal's terms say Circle "may, in its sole discretion
  … decline to support any … Offering". They also say any "listing, display,
  order … or featured placement" is "for discovery and informational purposes
  only" and not an endorsement.
- **The route in is the Arc team:**
  - the contact form at [arc.io/contact-us](https://www.arc.io/contact-us),
    whose page opens "Building something real on Arc?";
  - the Arc Discord.
- **ERC-8004 registration is not a listing.** 192 identities are registered
  on Arc mainnet. The apps Portal shows are a curated set, and none is there
  because of a registry entry.
- **Portal could not be read directly.** It answers automated requests with
  a Cloudflare challenge. What it lists, and whether it has any agent
  category, was not seen.

### The neighbouring places to be listed

| Where | For whom | How to get in |
| --- | --- | --- |
| Circle Agent Marketplace and its Discovery API | Agents buying x402 services; this is where the 482 Arc offers live | Needs a payable x402 endpoint, an OpenAPI spec and a payout wallet, which is sanctions-screened. [Intake form](https://forms.gle/7YFzvdmMcn1JH5tF6), then review. Listed services are health-checked continuously. |
| ERC-8004 identity registry on Arc mainnet | Agents and verifiers | Permissionless: `register(agentURI)`, paying gas in USDC |
| arc.io/ecosystem | People reading about Arc | Curated by the Arc team; same contact route |
| Arc Portal | People with a wallet | Curated by Circle; same contact route |

### What Veyra lacks for Arc mainnet

| Component | Today | Needed |
| --- | --- | --- |
| Something a Portal user can use on mainnet | Nova's identities and proofs are on Arc Testnet. Its paid research pays on Base. | Arc-first discovery and payment, as above |
| ERC-8004 identity for Veyra itself | None on mainnet | A registration with its own registrant wallet (not the attester key). Its file at a stable HTTPS address, listing Veyra's services, OpenAPI and `x402Support`, with a registrations entry naming `eip155:5042:0x8004A169…`. The endpoint's own manifest names the id back, as CRA's does. |
| A paid mainnet API | Trust API sells only on 12 testnets | Arc mainnet through Circle's mainnet Gateway (eip155:5042 is supported), an owner-controlled payout wallet, and a current OpenAPI |
| Veyra's contracts on mainnet (TrustGate, proof registry, ERC-8183 evaluator) | Arc Testnet only | Deployed with separate roles and a multisig admin, verified on the explorer, and **externally audited first** |
| A public description of what Veyra does | README and docs | One page, and the registration file, stating what a `WOULD_ALLOW` means and what it does not |
| Listing requests | None made | The Circle Marketplace form once a mainnet endpoint exists; the Arc contact form for Portal and the ecosystem page |

Order: mainnet API and identity first, since both are cheap and
reversible. Contracts only after an audit. Listing requests last, so a
reviewer finds a working mainnet service.

## Verified

- Circle's catalogue returned 482 Arc mainnet listings, 1,009 on Base and none
  on Arc Testnet, each counted from every page.
- 56 of 62 unpaid requests to offers were asked to be paid on Arc:
  - 43 of 49 sampled from Circle's catalogue;
  - all 10 Bazaar listings not also in Circle's;
  - all 3 routes probed from the two standard sellers found through ERC-8004
    (CRA's paid and direct routes, and one of APEX's).

  Veyra's own selector and USDC check refused every Arc offer, for the reasons
  in the table above.
- ERC-8004 v2.0.0 registries on Arc mainnet: 192 identities, found by
  bisecting agent ids with `ownerOf` (ids are sequential).
- Arc USDC at `0x3600…`, the Gateway contracts, EntryPoint v0.6, v0.7 and
  v0.8, and Permit2 are all deployed on Arc mainnet (`eth_getCode`).
- Circle's Gateway facilitator lists `eip155:5042`.

## Not verified

- **Arc Portal's contents and any listing criteria.** Portal refused
  automated requests, and nothing public states the criteria.
- **The 47 registration files on IPFS**, 43 of them one shared file.
- **Who is paid on Arc.** The 169 redeemed authorizations do not say which of
  them were x402.
- **Offers not in the 49-offer sample.** The rest of Circle's 482 were not
  probed.
- **Settlement.** No purchase was made, so nothing shows that any of these
  sellers settles and delivers.

## Not done

- No code changed in this note. The discovery design, the Arc payment tables
  and a new mandate are the next steps, in that order. *(2026-09-24: the
  discovery readers now exist in `lib/discovery/`; `npm run --silent
  arc:market` reproduces this census without probing. They are not wired
  into Nova yet.)* *(Later on 2026-09-24: Arc mainnet is in the payment
  tables and Nova's brief reads Arc first; see "What Veyra can pay on Arc
  today" above.)*
- No listing request, registration or contact was made.
