/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The option C pilot's helpers, offline: the request MetaMask receives, the
 * caveats it must answer with, the checks that refuse anything else, and the
 * reading of refusals. The chain side was run on a fork of Arc mainnet; see
 * docs/audits/2026-09-24-option-c-architecture.md.
 *
 *   npm run --silent arc:c-pilot:test
 */

import assert from "node:assert/strict";
import { encodeErrorResult, encodeFunctionData, parseAbi, size, toFunctionSelector, type Address, type Hex } from "viem";
import {
  CONTRACTS,
  OWNER_MAIN_WALLET,
  PILOT,
  REVOKE_ALL,
  ROOT_AUTHORITY,
  UPGRADED_CODE,
  USDC,
  buildPermissionRequest,
  checkGrantShape,
  decodePermissionContext,
  describeCaveat,
  encodePermissionContext,
  expectedCaveats,
  expiryOf,
  nonceOf,
  revertReason,
  singleExecution,
  sweepAmount,
  toUsdcUnits,
  topUpData,
  usdcTransferData,
  type Delegation,
} from "./delegation.mts";

const redeemer: Address = "0x1111111111111111111111111111111111111111";
const hot: Address = "0x2222222222222222222222222222222222222222";
const account: Address = "0x3333333333333333333333333333333333333333";
const startTime = 1_790_000_000;
const expiry = startTime + PILOT.lifetimeSeconds;
const nonce = BigInt(0);

/* ---- the request ---- */

const [request] = buildPermissionRequest({ redeemer, hot, startTime, expiry, account });
assert.equal(request.chainId, "0x13b2");
assert.equal(request.from, account);
assert.equal(request.to, redeemer, "the session account MetaMask delegates to is Nova's redeemer");
assert.equal(request.permission.type, "erc20-token-periodic");
assert.equal(request.permission.isAdjustmentAllowed, false);
assert.equal(request.permission.data.tokenAddress, USDC);
assert.equal(request.permission.data.periodAmount, "0x7a120", "0.50 USDC in base units, as hex");
assert.equal(request.permission.data.periodDuration, 86_400);
assert.equal(request.permission.data.startTime, startTime);
assert.deepEqual(request.rules.map((rule) => rule.type), ["expiry", "redeemer", "payee"]);
assert.deepEqual(request.rules[0].data, { timestamp: expiry });
assert.deepEqual(request.rules[1].data, { addresses: [redeemer] });
assert.deepEqual(request.rules[2].data, { addresses: [hot] }, "the snap takes one payee for ERC-20 permissions");
assert.equal(buildPermissionRequest({ redeemer, hot, startTime, expiry })[0].from, undefined);

/* The snap refuses a justification over 300 characters or with any of these. */
const snapRefuses = [/[<>]/, /[{}]/, /[\[\]]/, /url\s*\(/, /on\w+\s*=/, /javascript:|data:|vbscript:/, /["`]/, /&[a-zA-Z]+;/, /\\u[0-9a-fA-F]{4}/];
assert.ok(PILOT.justification.length <= 300);
for (const pattern of snapRefuses) assert.ok(!pattern.test(PILOT.justification), `justification matches ${pattern}`);

/* ---- the caveats MetaMask builds, byte for byte ---- */

const caveats = expectedCaveats({ redeemer, hot, startTime, expiry, nonce });
assert.deepEqual(caveats.map((caveat) => caveat.enforcer), [
  CONTRACTS.erc20PeriodTransferEnforcer,
  CONTRACTS.valueLteEnforcer,
  CONTRACTS.timestampEnforcer,
  CONTRACTS.redeemerEnforcer,
  CONTRACTS.allowedCalldataEnforcer,
  CONTRACTS.nonceEnforcer,
]);
assert.deepEqual(caveats.map((caveat) => size(caveat.terms)), [116, 32, 32, 20, 64, 32]);
assert.ok(caveats.every((caveat) => caveat.args === "0x"));
assert.equal(
  caveats[0].terms,
  `0x${USDC.slice(2).toLowerCase()}${"7a120".padStart(64, "0")}${(86_400).toString(16).padStart(64, "0")}${startTime.toString(16).padStart(64, "0")}`,
);
assert.equal(caveats[2].terms, `0x${"0".repeat(32)}${expiry.toString(16).padStart(32, "0")}`, "uint128 after = 0, uint128 before = expiry");
assert.equal(caveats[4].terms, `0x${"4".padStart(64, "0")}${hot.slice(2).padStart(64, "0")}`, "calldata bytes 4..36, the transfer's recipient");
assert.match(describeCaveat(caveats[0]), /0\.5 USDC per 86400 s, from 2026-/);
assert.match(describeCaveat(caveats[2]), /until 2026-/);
assert.equal(describeCaveat(caveats[3]), `Redeemer: only ${redeemer}`);
assert.equal(describeCaveat(caveats[4]), `AllowedCalldata: calldata bytes 4..36 are ${hot}`);

/* ---- a grant as MetaMask would answer it ---- */

const granted: Delegation = {
  delegate: redeemer,
  delegator: account,
  authority: ROOT_AUTHORITY,
  caveats,
  salt: BigInt(7),
  signature: `0x${"ab".repeat(65)}`,
};
const context = encodePermissionContext([granted]);
assert.deepEqual(decodePermissionContext(context), [granted], "the permission context round-trips");
assert.equal(expiryOf(granted), BigInt(expiry));
assert.equal(nonceOf(granted), nonce);

const shape = (delegations: Delegation[], overrides: Partial<Parameters<typeof checkGrantShape>[0]> = {}) =>
  checkGrantShape({ delegations, delegationManager: CONTRACTS.delegationManager, account, redeemer, hot, startTime, expiry, nonce, ...overrides });
const failed = (delegations: Delegation[], overrides = {}) => shape(delegations, overrides).filter((check) => !check.ok).map((check) => check.name);

assert.deepEqual(failed([granted]), [], "the pilot's own permission passes every check");

const withCaveat = (index: number, terms: Hex) => ({ ...granted, caveats: granted.caveats.map((caveat, i) => (i === index ? { ...caveat, terms } : caveat)) });
const other = expectedCaveats({ redeemer, hot: "0x4444444444444444444444444444444444444444", startTime, expiry, nonce });
assert.deepEqual(failed([withCaveat(4, other[4].terms)]), ["Caveat 5, AllowedCalldata"], "another payee");
const bigger = expectedCaveats({ redeemer, hot, startTime, expiry, nonce });
bigger[0] = { ...bigger[0], terms: bigger[0].terms.replace("7a120", "f4240") as Hex };
assert.deepEqual(failed([withCaveat(0, bigger[0].terms)]), ["Caveat 1, ERC20PeriodTransfer"], "1.00 a day instead of 0.50");
const later = expectedCaveats({ redeemer, hot, startTime, expiry: expiry + 86_400, nonce });
assert.deepEqual(failed([withCaveat(2, later[2].terms)]), ["Caveat 3, Timestamp"], "a longer expiry");
assert.deepEqual(failed([withCaveat(5, expectedCaveats({ redeemer, hot, startTime, expiry, nonce: BigInt(1) })[5].terms)]), ["Caveat 6, Nonce"]);
assert.deepEqual(failed([{ ...granted, caveats: granted.caveats.slice(0, 5) }]), ["Exactly six caveats", "Caveat 6, Nonce"], "no nonce caveat");
assert.deepEqual(failed([{ ...granted, caveats: [...granted.caveats, granted.caveats[1]] }]), ["Exactly six caveats"], "an extra caveat");
assert.deepEqual(
  failed([{ ...granted, caveats: granted.caveats.map((caveat, i) => (i === 3 ? { ...caveat, args: "0x01" as Hex } : caveat)) }]),
  ["Caveat 4, Redeemer"],
  "stored args",
);
assert.deepEqual(failed([{ ...granted, authority: `0x${"12".repeat(32)}` }]), ["Root authority"]);
assert.deepEqual(failed([{ ...granted, delegate: hot }]), ["Delegate is Nova's redeemer"]);
assert.deepEqual(failed([{ ...granted, signature: "0x" }]), ["Signed"]);
assert.deepEqual(failed([granted, granted]), ["One delegation, no chain"]);
assert.deepEqual(failed([granted], { delegationManager: hot }), ["The DelegationManager on Arc"]);
assert.deepEqual(failed([granted], { delegationManager: undefined }), ["The DelegationManager on Arc"]);
assert.deepEqual(
  failed([{ ...granted, delegator: OWNER_MAIN_WALLET }], { account: OWNER_MAIN_WALLET }),
  ["Delegator is not the owner's main wallet"],
  "the main wallet is refused even when it is the connected account",
);
assert.deepEqual(failed([granted], { account: hot }), ["Delegator is the connected test account"]);
assert.deepEqual(failed([]), ["One delegation, no chain"]);

/* ---- what Nova sends ---- */

const transfer = usdcTransferData(hot, BigInt(300_000));
assert.equal(size(singleExecution(USDC, BigInt(0), transfer)), 20 + 32 + size(transfer));
assert.equal(topUpData(context, hot, BigInt(300_000)).slice(0, 10), toFunctionSelector("redeemDelegations(bytes[],bytes32[],bytes[])"));
assert.equal(
  REVOKE_ALL.data,
  "0xf5743c4c000000000000000000000000db9b1e94b5b69df7e401ddbede43491141047db3",
  "the revoke-all data printed in the plan",
);
assert.equal(REVOKE_ALL.to, CONTRACTS.nonceEnforcer);
assert.equal(UPGRADED_CODE, "0xef010063c0c19a282a1b52b07dd5a65b58948a07dae32b");

/* ---- reading refusals ---- */

const errorString = (message: string) =>
  encodeErrorResult({ abi: parseAbi(["error Error(string)"]), errorName: "Error", args: [message] });
assert.equal(revertReason({ data: errorString("ERC20PeriodTransferEnforcer:transfer-amount-exceeded") }), "ERC20PeriodTransferEnforcer:transfer-amount-exceeded");
assert.equal(revertReason({ cause: { cause: { data: errorString("AllowedCalldataEnforcer:invalid-calldata") } } }), "AllowedCalldataEnforcer:invalid-calldata");
assert.equal(revertReason({ cause: { data: { data: toFunctionSelector("InvalidDelegate()") } } }), "InvalidDelegate()");
assert.equal(revertReason({ data: toFunctionSelector("CannotUseADisabledDelegation()") }), "CannotUseADisabledDelegation()");
assert.equal(revertReason({ data: "0x12345678" }), "reverted with 0x12345678");
assert.equal(revertReason({ details: "execution reverted: NonceEnforcer:invalid-nonce" }), "NonceEnforcer:invalid-nonce");
assert.equal(revertReason({ data: "0x" }), "reverted without a reason");
assert.equal(revertReason(new Error("fetch failed")), "fetch failed");

/* ---- amounts ---- */

assert.equal(toUsdcUnits("0.30"), BigInt(300_000));
assert.equal(toUsdcUnits("1"), BigInt(1_000_000));
assert.equal(toUsdcUnits("0.000001"), BigInt(1));
assert.throws(() => toUsdcUnits("0.0000001"));
assert.throws(() => toUsdcUnits("-1"));
assert.throws(() => toUsdcUnits("1e3"));

/* On Arc the ERC-20 balance is the native balance in 6 decimals, and gas
   comes out of it: the sweep leaves exactly the gas reserve behind. */
const scale = BigInt(1_000_000_000_000);
const reserve = BigInt(54_000) * BigInt(25_000_000_000);
assert.equal(sweepAmount({ usdcBalance: BigInt(500_000), nativeBalance: BigInt(500_000) * scale, gasReserveWei: reserve }), BigInt(500_000) - BigInt(1_350));
// A fork keeps the two apart, and native gas money is plentiful there.
assert.equal(sweepAmount({ usdcBalance: BigInt(500_000), nativeBalance: BigInt(10) ** BigInt(19), gasReserveWei: reserve }), BigInt(500_000));
assert.equal(sweepAmount({ usdcBalance: BigInt(1_000), nativeBalance: BigInt(1_000) * scale, gasReserveWei: reserve }), BigInt(0), "too little to pay for itself");

/* ---- the transfer the permission allows is exactly `transfer(H, x)` ---- */

assert.equal(transfer, encodeFunctionData({ abi: parseAbi(["function transfer(address,uint256) returns (bool)"]), functionName: "transfer", args: [hot, BigInt(300_000)] }));

console.log("arc-c-pilot helpers: all assertions passed");
