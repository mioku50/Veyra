/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import {
  GATEWAY_WALLET_MAINNET,
  GATEWAY_WALLET_TESTNET,
  gatewayContextForChain,
  gatewayDepositSteps,
  readGatewayBalance,
} from "../lib/x402/gateway-deposit.ts";

/* ---- which chains Gateway actually runs on ---- */

const base = gatewayContextForChain(8453);
assert(base, "Base is a Gateway chain");
assert.equal(base.domain, 6);
assert.equal(base.gatewayWallet, GATEWAY_WALLET_MAINNET);
assert.equal(base.testnet, false);
assert.equal(base.usdc, "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
assert.equal(base.balancesUrl, "https://gateway-api.circle.com/v1/balances");

const arc = gatewayContextForChain(5042002);
assert(arc, "Arc Testnet is a Gateway chain");
assert.equal(arc.domain, 26);
assert.equal(arc.gatewayWallet, GATEWAY_WALLET_TESTNET);
assert.equal(arc.testnet, true);
// Arc's USDC is the 6-decimal ERC-20 view; the native gas view is the same
// pool at 18 decimals and is never what a deposit moves.
assert.equal(arc.usdc, "0x3600000000000000000000000000000000000000");
assert.equal(arc.balancesUrl, "https://gateway-api-testnet.circle.com/v1/balances");

// A testnet must never be handed the mainnet contract, or a deposit goes to an
// address that does not exist on that chain.
assert.notEqual(arc.gatewayWallet, base.gatewayWallet);

// An unknown chain is unsupported, not quietly defaulted to Base.
assert.equal(gatewayContextForChain(1_234_567), null);
assert.equal(gatewayContextForChain(0), null);

/* ---- the two transactions, and only those ---- */

const ONE_USDC = BigInt(1_000_000);
const steps = gatewayDepositSteps({
  context: base,
  depositAtomic: ONE_USDC,
  allowanceAtomic: BigInt(0),
});
assert.deepEqual(steps.map((step) => step.kind), ["approve", "deposit"]);

const [approve, deposit] = steps;

// approve(address,uint256) on the token, to the Gateway wallet.
assert.equal(approve.to, base.usdc);
assert.equal(approve.data.slice(0, 10), "0x095ea7b3");
assert(approve.data.toLowerCase().includes(base.gatewayWallet.slice(2).toLowerCase()));

/* Exactly the deposit, never unlimited. An allowance larger than the deposit is
   an authorization the buyer did not ask to give, and it outlives the purchase
   that justified it. */
const approvedAmount = BigInt(`0x${approve.data.slice(-64)}`);
assert.equal(approvedAmount, ONE_USDC);
assert.notEqual(approve.data.slice(-64), "f".repeat(64), "never an unlimited approval");
assert.match(approve.detail, /not an unlimited allowance/);

// deposit(address,uint256) on the Gateway wallet, naming the token.
assert.equal(deposit.to, base.gatewayWallet);
assert.equal(deposit.data.slice(0, 10), "0x47e7ef24");
assert(deposit.data.toLowerCase().includes(base.usdc.slice(2).toLowerCase()));
assert.equal(BigInt(`0x${deposit.data.slice(-64)}`), ONE_USDC);

// A sufficient allowance skips the approval rather than spending a transaction
// to re-approve what is already approved.
assert.deepEqual(
  gatewayDepositSteps({ context: base, depositAtomic: ONE_USDC, allowanceAtomic: ONE_USDC })
    .map((step) => step.kind),
  ["deposit"],
);
assert.deepEqual(
  gatewayDepositSteps({ context: base, depositAtomic: ONE_USDC, allowanceAtomic: BigInt(999_999) })
    .map((step) => step.kind),
  ["approve", "deposit"],
  "an allowance one unit short still needs approving",
);

// Every step is a contract call with no value attached: a plain transfer to the
// Gateway wallet is NOT credited to the unified balance.
for (const step of steps) {
  assert.equal(step.value, "0x0");
  assert.equal(step.chainId, 8453);
}

/* ---- an unknown balance is never reported as an empty one ---- */

const ok = await readGatewayBalance(base, "0x0000000000000000000000000000000000000001", (async () => ({
  ok: true,
  json: async () => ({
    balances: [{ domain: 6, balance: "1.234560", pendingBatch: "0.500000" }],
  }),
})) as unknown as typeof fetch);
assert.deepEqual(ok, { availableAtomic: BigInt(1_234_560), pendingAtomic: BigInt(500_000) });

// Decimal parsing has to survive the shapes Circle actually returns.
const shapes: Array<[string, bigint]> = [
  ["0", BigInt(0)],
  ["10", BigInt(10_000_000)],
  ["0.000001", BigInt(1)],
  ["0.4", BigInt(400_000)],
  ["4.892670", BigInt(4_892_670)],
];
for (const [raw, expected] of shapes) {
  const parsed = await readGatewayBalance(base, "0x1", (async () => ({
    ok: true,
    json: async () => ({ balances: [{ domain: 6, balance: raw }] }),
  })) as unknown as typeof fetch);
  assert.equal(parsed?.availableAtomic, expected, `balance "${raw}"`);
}

/* Null, not zero. Reporting "you have nothing deposited" because Circle timed
   out would send someone to fund an account that is already funded, and a
   deposit is not undone by pressing back. */
for (const failure of [
  (async () => ({ ok: false, json: async () => ({}) })),
  (async () => { throw new Error("network down"); }),
  (async () => ({ ok: true, json: async () => ({ balances: [] }) })),
  (async () => ({ ok: true, json: async () => ({ balances: [{ domain: 99, balance: "5" }] }) })),
]) {
  assert.equal(
    await readGatewayBalance(base, "0x1", failure as unknown as typeof fetch),
    null,
    "an unanswerable balance question is unknown, never zero",
  );
}

console.log("[x402-gateway-test] passed: Gateway chains and their domains, mainnet and testnet wallets kept apart, exact-amount approval never unlimited, approval skipped when allowance covers it, deposit calldata, and an unknown balance reported as unknown rather than empty");
