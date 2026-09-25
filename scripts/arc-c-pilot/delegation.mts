/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Option C pilot: the permission, and what Nova's side needs to check it,
 * redeem it and revoke it. Pure helpers over viem; the only I/O goes through
 * the client passed in.
 *
 * The permission is the one MetaMask's gator-permissions-snap 2.5.0 builds for
 * `erc20-token-periodic` with expiry, redeemer and payee rules, read from the
 * snap's code: ERC20PeriodTransfer, ValueLte(0), Timestamp(0, expiry),
 * Redeemer, AllowedCalldata(4, payee), Nonce. The plan is
 * docs/audits/2026-09-24-option-c-pilot-plan.md.
 */

import {
  decodeAbiParameters,
  decodeErrorResult,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  formatUnits,
  getAddress,
  isAddress,
  isAddressEqual,
  pad,
  parseAbi,
  size,
  sliceHex,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

export const ARC_CHAIN_ID = 5_042;
export const ARC_CHAIN_ID_HEX = "0x13b2";
export const USDC: Address = "0x3600000000000000000000000000000000000000";
export const USDC_DECIMALS = 6;
/** The owner's main wallet: never the test account, never a sweep target. */
export const OWNER_MAIN_WALLET: Address = "0x8e525BfCe1eF40Aa8075ef64E45421b5855C8909";
/** Somewhere that is not the hot wallet, for refusals. */
export const ELSEWHERE: Address = "0x000000000000000000000000000000000000dEaD";

/** MetaMask's delegation framework v1.3, as deployed on Arc mainnet. */
export const CONTRACTS = {
  delegationManager: "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3",
  statelessDeleGator: "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B",
  erc20PeriodTransferEnforcer: "0x474e3Ae7E169e940607cC624Da8A15Eb120139aB",
  valueLteEnforcer: "0x92Bf12322527cAA612fd31a0e810472BBB106A8F",
  timestampEnforcer: "0x1046bb45C8d673d4ea75321280DB34899413c069",
  redeemerEnforcer: "0xE144b0b2618071B4E56f746313528a669c7E65c5",
  allowedCalldataEnforcer: "0xc2b0d624c1c4319760C96503BA27C347F3260f55",
  nonceEnforcer: "0xDE4f2FAC4B3D87A1d9953Ca5FC09FCa7F366254f",
} as const satisfies Record<string, Address>;

const ENFORCER_NAMES: Record<string, string> = {
  [CONTRACTS.erc20PeriodTransferEnforcer.toLowerCase()]: "ERC20PeriodTransfer",
  [CONTRACTS.valueLteEnforcer.toLowerCase()]: "ValueLte",
  [CONTRACTS.timestampEnforcer.toLowerCase()]: "Timestamp",
  [CONTRACTS.redeemerEnforcer.toLowerCase()]: "Redeemer",
  [CONTRACTS.allowedCalldataEnforcer.toLowerCase()]: "AllowedCalldata",
  [CONTRACTS.nonceEnforcer.toLowerCase()]: "Nonce",
};
export const enforcerName = (address: string) => ENFORCER_NAMES[address.toLowerCase()] ?? address;

/** The code an account carries once EIP-7702 points it at MetaMask's DeleGator. */
export const UPGRADED_CODE = `0xef0100${CONTRACTS.statelessDeleGator.slice(2).toLowerCase()}`;
export const ROOT_AUTHORITY: Hex = `0x${"f".repeat(64)}`;

/** ERC-7579 execution modes: the call type, then the execution type. */
export const MODES = {
  singleDefault: `0x${"00".repeat(32)}`,
  singleTry: `0x0001${"00".repeat(30)}`,
  batchDefault: `0x01${"00".repeat(31)}`,
} as const satisfies Record<string, Hex>;

/** The pilot's terms: 0.50 USDC a day into the hot wallet, for three days. */
export const PILOT = {
  periodAmount: BigInt(500_000),
  periodDuration: 86_400,
  lifetimeSeconds: 3 * 86_400,
  /* The start sits a little in the past, so a wallet or chain clock slightly
     behind this machine's cannot refuse the first top-up as not started. */
  startLeadSeconds: 30,
  justification:
    "Veyra C pilot. Nova may move up to 0.50 USDC a day from this account to its payment wallet, for three days",
} as const;

export type Caveat = { enforcer: Address; terms: Hex; args: Hex };
export type Delegation = {
  delegate: Address;
  delegator: Address;
  authority: Hex;
  caveats: Caveat[];
  salt: bigint;
  signature: Hex;
};

const caveatComponents = [
  { name: "enforcer", type: "address" },
  { name: "terms", type: "bytes" },
  { name: "args", type: "bytes" },
] as const;
const delegationComponents = [
  { name: "delegate", type: "address" },
  { name: "delegator", type: "address" },
  { name: "authority", type: "bytes32" },
  { name: "caveats", type: "tuple[]", components: caveatComponents },
  { name: "salt", type: "uint256" },
  { name: "signature", type: "bytes" },
] as const;
const delegationList = [{ name: "delegations", type: "tuple[]", components: delegationComponents }] as const;

export const delegationManagerAbi = [
  {
    type: "function",
    name: "redeemDelegations",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_permissionContexts", type: "bytes[]" },
      { name: "_modes", type: "bytes32[]" },
      { name: "_executionCallDatas", type: "bytes[]" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "disableDelegation",
    stateMutability: "nonpayable",
    inputs: [{ name: "_delegation", type: "tuple", components: delegationComponents }],
    outputs: [],
  },
  {
    type: "function",
    name: "disabledDelegations",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "getDelegationHash",
    stateMutability: "pure",
    inputs: [{ name: "_input", type: "tuple", components: delegationComponents }],
    outputs: [{ name: "", type: "bytes32" }],
  },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
  {
    type: "function",
    name: "eip712Domain",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "fields", type: "bytes1" },
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
      { name: "salt", type: "bytes32" },
      { name: "extensions", type: "uint256[]" },
    ],
  },
] as const;

export const erc20Abi = parseAbi([
  "function transfer(address to, uint256 value) returns (bool)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function transferFrom(address from, address to, uint256 value) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
]);
export const nonceEnforcerAbi = parseAbi([
  "function currentNonce(address delegationManager, address delegator) view returns (uint256)",
  "function incrementNonce(address delegationManager)",
]);
export const periodEnforcerAbi = parseAbi([
  "function getAvailableAmount(bytes32 delegationHash, address delegationManager, bytes terms) view returns (uint256 availableAmount, bool isNewPeriod, uint256 currentPeriod)",
]);
/* Refusals the manager and the account raise; enforcers revert with a string. */
const revertAbi = parseAbi([
  "error Error(string message)",
  "error AlreadyDisabled()",
  "error BatchDataLengthMismatch()",
  "error CannotUseADisabledDelegation()",
  "error EmptySignature()",
  "error EnforcedPause()",
  "error InvalidAuthority()",
  "error InvalidDelegate()",
  "error InvalidDelegator()",
  "error InvalidEOASignature()",
  "error InvalidERC1271Signature()",
  "error NotDelegationManager()",
  "error NotEntryPoint()",
  "error NotEntryPointOrSelf()",
]);

/* ---- amounts and times ---- */

export function toUsdcUnits(text: string): bigint {
  if (!/^\d+(\.\d{1,6})?$/.test(text)) throw new Error(`not a USDC amount with at most 6 decimals: ${text}`);
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole) * BigInt(1_000_000) + BigInt(fraction.padEnd(6, "0"));
}
export const formatUsdc = (units: bigint) => formatUnits(units, USDC_DECIMALS);
export const isoTime = (seconds: bigint | number) => new Date(Number(seconds) * 1000).toISOString().replace(".000Z", "Z");

/* ---- the request MetaMask receives ---- */

export type PermissionRule =
  | { type: "expiry"; data: { timestamp: number } }
  | { type: "redeemer" | "payee"; data: { addresses: Address[] } };
export type PermissionRequest = {
  chainId: string;
  from?: Address;
  to: Address;
  permission: {
    type: "erc20-token-periodic";
    isAdjustmentAllowed: boolean;
    data: {
      tokenAddress: Address;
      periodAmount: Hex;
      periodDuration: number;
      startTime: number;
      justification: string;
    };
  };
  rules: PermissionRule[];
};

/** The params of `wallet_requestExecutionPermissions`: one permission. */
export function buildPermissionRequest(input: {
  redeemer: Address;
  hot: Address;
  startTime: number;
  expiry: number;
  account?: Address;
}): PermissionRequest[] {
  return [{
    chainId: ARC_CHAIN_ID_HEX,
    ...(input.account ? { from: input.account } : {}),
    to: input.redeemer,
    permission: {
      type: "erc20-token-periodic",
      // The terms are the pilot's; to change them, ask again.
      isAdjustmentAllowed: false,
      data: {
        tokenAddress: USDC,
        periodAmount: toHex(PILOT.periodAmount),
        periodDuration: PILOT.periodDuration,
        startTime: input.startTime,
        justification: PILOT.justification,
      },
    },
    rules: [
      { type: "expiry", data: { timestamp: input.expiry } },
      { type: "redeemer", data: { addresses: [input.redeemer] } },
      { type: "payee", data: { addresses: [input.hot] } },
    ],
  }];
}

/** The six caveats the snap builds for that request, in its order. */
export function expectedCaveats(input: {
  redeemer: Address;
  hot: Address;
  startTime: number;
  expiry: number;
  nonce: bigint;
}): Caveat[] {
  return [
    {
      enforcer: CONTRACTS.erc20PeriodTransferEnforcer,
      terms: encodePacked(
        ["address", "uint256", "uint256", "uint256"],
        [USDC, PILOT.periodAmount, BigInt(PILOT.periodDuration), BigInt(input.startTime)],
      ),
      args: "0x",
    },
    { enforcer: CONTRACTS.valueLteEnforcer, terms: encodePacked(["uint256"], [BigInt(0)]), args: "0x" },
    {
      enforcer: CONTRACTS.timestampEnforcer,
      terms: encodePacked(["uint128", "uint128"], [BigInt(0), BigInt(input.expiry)]),
      args: "0x",
    },
    { enforcer: CONTRACTS.redeemerEnforcer, terms: encodePacked(["address"], [input.redeemer]), args: "0x" },
    {
      enforcer: CONTRACTS.allowedCalldataEnforcer,
      // transfer(address to, uint256): bytes 4..36 are the recipient.
      terms: encodePacked(["uint256", "bytes"], [BigInt(4), pad(input.hot)]),
      args: "0x",
    },
    { enforcer: CONTRACTS.nonceEnforcer, terms: encodePacked(["uint256"], [input.nonce]), args: "0x" },
  ];
}

/* ---- the permission context MetaMask answers with ---- */

export function decodePermissionContext(context: Hex): Delegation[] {
  const [list] = decodeAbiParameters(delegationList, context);
  return list.map((delegation) => ({
    delegate: getAddress(delegation.delegate),
    delegator: getAddress(delegation.delegator),
    authority: delegation.authority,
    caveats: delegation.caveats.map((caveat) => ({
      enforcer: getAddress(caveat.enforcer),
      terms: caveat.terms,
      args: caveat.args,
    })),
    salt: delegation.salt,
    signature: delegation.signature,
  }));
}

export function encodePermissionContext(delegations: Delegation[]): Hex {
  return encodeAbiParameters(delegationList, [delegations]);
}

export function findCaveat(delegation: Delegation, enforcer: Address): Caveat | undefined {
  return delegation.caveats.find((caveat) => isAddressEqual(caveat.enforcer, enforcer));
}

/** The expiry in a Timestamp caveat: its second, "before", threshold. */
export function expiryOf(delegation: Delegation): bigint | null {
  const caveat = findCaveat(delegation, CONTRACTS.timestampEnforcer);
  return caveat && size(caveat.terms) === 32 ? BigInt(sliceHex(caveat.terms, 16, 32)) : null;
}

export function nonceOf(delegation: Delegation): bigint | null {
  const caveat = findCaveat(delegation, CONTRACTS.nonceEnforcer);
  return caveat && size(caveat.terms) === 32 ? BigInt(caveat.terms) : null;
}

/** One caveat in words, for the page and the terminal. */
export function describeCaveat(caveat: Caveat): string {
  const terms = caveat.terms;
  const name = enforcerName(caveat.enforcer);
  try {
    switch (name) {
      case "ERC20PeriodTransfer": {
        if (size(terms) !== 116) break;
        const token = getAddress(sliceHex(terms, 0, 20));
        const amount = BigInt(sliceHex(terms, 20, 52));
        const period = BigInt(sliceHex(terms, 52, 84));
        const start = BigInt(sliceHex(terms, 84, 116));
        const tokenName = isAddressEqual(token, USDC) ? "USDC" : token;
        return `${name}: ${formatUsdc(amount)} ${tokenName} per ${period} s, from ${isoTime(start)}`;
      }
      case "ValueLte":
        if (size(terms) !== 32) break;
        return `${name}: native value at most ${BigInt(terms)}`;
      case "Timestamp": {
        if (size(terms) !== 32) break;
        const after = BigInt(sliceHex(terms, 0, 16));
        const before = BigInt(sliceHex(terms, 16, 32));
        return `${name}: ${after > BigInt(0) ? `after ${isoTime(after)}, ` : ""}until ${isoTime(before)}`;
      }
      case "Redeemer": {
        if (size(terms) === 0 || size(terms) % 20 !== 0) break;
        const redeemers: Address[] = [];
        for (let offset = 0; offset < size(terms); offset += 20) redeemers.push(getAddress(sliceHex(terms, offset, offset + 20)));
        return `${name}: only ${redeemers.join(", ")}`;
      }
      case "AllowedCalldata": {
        if (size(terms) < 32) break;
        const start = BigInt(sliceHex(terms, 0, 32));
        const value = size(terms) > 32 ? sliceHex(terms, 32) : "0x";
        const asAddress = size(value) === 32 && BigInt(sliceHex(value, 0, 12)) === BigInt(0)
          ? getAddress(sliceHex(value, 12, 32))
          : value;
        return `${name}: calldata bytes ${start}..${start + BigInt(size(value))} are ${asAddress}`;
      }
      case "Nonce":
        if (size(terms) !== 32) break;
        return `${name}: ${BigInt(terms)}`;
    }
  } catch {
    // fall through to the raw form
  }
  return `${name}: ${terms}`;
}

/* ---- checking a grant ---- */

export type Check = { name: string; ok: boolean; detail: string };

/** Everything that can be checked without the chain: exactly the pilot's terms. */
export function checkGrantShape(input: {
  delegations: Delegation[];
  delegationManager: unknown;
  account: Address;
  redeemer: Address;
  hot: Address;
  startTime: number;
  expiry: number;
  nonce: bigint;
}): Check[] {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const manager = typeof input.delegationManager === "string" ? input.delegationManager : "";

  add("One delegation, no chain", input.delegations.length === 1, `${input.delegations.length} delegation(s)`);
  add(
    "The DelegationManager on Arc",
    isAddress(manager) && isAddressEqual(manager, CONTRACTS.delegationManager),
    manager || "missing",
  );
  const delegation = input.delegations[0];
  if (!delegation) return checks;

  add("Delegator is the connected test account", isAddressEqual(delegation.delegator, input.account), delegation.delegator);
  add("Delegator is not the owner's main wallet", !isAddressEqual(delegation.delegator, OWNER_MAIN_WALLET), delegation.delegator);
  add("Delegate is Nova's redeemer", isAddressEqual(delegation.delegate, input.redeemer), delegation.delegate);
  add("Root authority", delegation.authority.toLowerCase() === ROOT_AUTHORITY, delegation.authority);
  add("Signed", size(delegation.signature) > 0, `${size(delegation.signature)} bytes`);

  const expected = expectedCaveats(input);
  add("Exactly six caveats", delegation.caveats.length === expected.length, `${delegation.caveats.length} caveat(s)`);
  expected.forEach((want, index) => {
    const got = delegation.caveats[index];
    const ok = got !== undefined
      && isAddressEqual(got.enforcer, want.enforcer)
      && got.terms.toLowerCase() === want.terms.toLowerCase()
      && got.args === "0x";
    const detail = !got
      ? `missing; expected ${describeCaveat(want)}`
      : ok
        ? describeCaveat(got)
        : `got ${describeCaveat(got)}${got.args === "0x" ? "" : ` with args ${got.args}`}; expected ${describeCaveat(want)}`;
    add(`Caveat ${index + 1}, ${enforcerName(want.enforcer)}`, ok, detail);
  });
  return checks;
}

/* ---- redeeming and revoking ---- */

/** An ERC-7579 single execution: target, value, calldata, packed. */
export const singleExecution = (target: Address, value: bigint, callData: Hex): Hex =>
  encodePacked(["address", "uint256", "bytes"], [target, value, callData]);

export const batchExecution = (calls: { target: Address; value: bigint; callData: Hex }[]): Hex =>
  encodeAbiParameters(
    [{
      type: "tuple[]",
      components: [
        { name: "target", type: "address" },
        { name: "value", type: "uint256" },
        { name: "callData", type: "bytes" },
      ],
    }],
    [calls],
  );

export const usdcTransferData = (to: Address, amount: bigint): Hex =>
  encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] });

export const redeemData = (context: Hex, execution: Hex, mode: Hex = MODES.singleDefault): Hex =>
  encodeFunctionData({ abi: delegationManagerAbi, functionName: "redeemDelegations", args: [[context], [mode], [execution]] });

/** A top-up: the test account transfers `amount` of USDC to the hot wallet. */
export const topUpData = (context: Hex, hot: Address, amount: bigint): Hex =>
  redeemData(context, singleExecution(USDC, BigInt(0), usdcTransferData(hot, amount)));

export const disableData = (delegation: Delegation): Hex =>
  encodeFunctionData({ abi: delegationManagerAbi, functionName: "disableDelegation", args: [delegation] });

/** Ends every permission the account granted through MetaMask, at once. */
export const REVOKE_ALL = {
  to: CONTRACTS.nonceEnforcer,
  data: encodeFunctionData({ abi: nonceEnforcerAbi, functionName: "incrementNonce", args: [CONTRACTS.delegationManager] }),
} as const;

/* ---- reading refusals ---- */

function findRevertData(error: unknown, depth = 0): Hex | null {
  if (!error || typeof error !== "object" || depth > 8) return null;
  const record = error as Record<string, unknown>;
  for (const key of ["data", "raw"]) {
    const value = record[key];
    if (typeof value === "string" && /^0x(?:[0-9a-fA-F]{2})*$/.test(value)) return value as Hex;
    if (value && typeof value === "object") {
      const nested = (value as Record<string, unknown>).data;
      if (typeof nested === "string" && /^0x(?:[0-9a-fA-F]{2})*$/.test(nested)) return nested as Hex;
    }
  }
  return findRevertData(record.cause, depth + 1) ?? findRevertData(record.error, depth + 1);
}

function messagesOf(error: unknown, depth = 0): string[] {
  if (!error || typeof error !== "object" || depth > 8) return [];
  const record = error as Record<string, unknown>;
  const own = ["details", "shortMessage", "message"]
    .map((key) => record[key])
    .filter((value): value is string => typeof value === "string");
  return [...own, ...messagesOf(record.cause, depth + 1)];
}

/** The reason a call was refused, as the contract said it. */
export function revertReason(error: unknown): string {
  const data = findRevertData(error);
  if (data && data !== "0x") {
    try {
      const decoded = decodeErrorResult({ abi: revertAbi, data });
      if (decoded.errorName === "Error") return String(decoded.args?.[0] ?? "");
      return `${decoded.errorName}()`;
    } catch {
      return `reverted with ${sliceHex(data, 0, Math.min(4, size(data)))}`;
    }
  }
  for (const message of messagesOf(error)) {
    const match = message.match(/reverted with reason string '([^']+)'/) ?? message.match(/execution reverted: ([^\n]+)/);
    if (match) return match[1].trim();
  }
  if (data === "0x") return "reverted without a reason";
  return (messagesOf(error)[0] ?? String(error)).split("\n")[0].slice(0, 160);
}

export type Simulation = { ok: true } | { ok: false; reason: string };

/** An eth_call on the latest block: what the chain would do, for free. */
export async function simulate(client: PublicClient, from: Address, to: Address, data: Hex, value = BigInt(0)): Promise<Simulation> {
  try {
    await client.call({ account: from, to, data, value });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: revertReason(error) };
  }
}

/* ---- the permission on the chain ---- */

export type PermissionOnChain = {
  hash: Hex;
  disabled: boolean;
  nonceNow: bigint;
  nonceInPermission: bigint | null;
  upgraded: boolean;
  code: Hex;
  paused: boolean;
  expiry: bigint | null;
  available: { amount: bigint; isNewPeriod: boolean; period: bigint } | null;
  now: bigint;
};

export async function readPermission(client: PublicClient, delegation: Delegation): Promise<PermissionOnChain> {
  const manager = CONTRACTS.delegationManager;
  const hash = await client.readContract({ address: manager, abi: delegationManagerAbi, functionName: "getDelegationHash", args: [delegation] });
  const [disabled, nonceNow, code, paused, block] = await Promise.all([
    client.readContract({ address: manager, abi: delegationManagerAbi, functionName: "disabledDelegations", args: [hash] }),
    client.readContract({ address: CONTRACTS.nonceEnforcer, abi: nonceEnforcerAbi, functionName: "currentNonce", args: [manager, delegation.delegator] }),
    client.getCode({ address: delegation.delegator }),
    client.readContract({ address: manager, abi: delegationManagerAbi, functionName: "paused" }),
    client.getBlock(),
  ]);
  const period = findCaveat(delegation, CONTRACTS.erc20PeriodTransferEnforcer);
  let available: PermissionOnChain["available"] = null;
  if (period) {
    try {
      const [amount, isNewPeriod, current] = await client.readContract({
        address: CONTRACTS.erc20PeriodTransferEnforcer,
        abi: periodEnforcerAbi,
        functionName: "getAvailableAmount",
        args: [hash, manager, period.terms],
      });
      available = { amount, isNewPeriod, period: current };
    } catch {
      available = null; // before the start date the enforcer refuses to answer
    }
  }
  return {
    hash,
    disabled,
    nonceNow,
    nonceInPermission: nonceOf(delegation),
    upgraded: (code ?? "0x").toLowerCase() === UPGRADED_CODE,
    code: code ?? "0x",
    paused,
    expiry: expiryOf(delegation),
    available,
    now: block.timestamp,
  };
}

/** Why the permission cannot be used right now; empty when it can. */
export function blockers(state: PermissionOnChain): string[] {
  const reasons: string[] = [];
  if (state.disabled) reasons.push("disabled by the account (disableDelegation)");
  if (state.nonceInPermission !== null && state.nonceInPermission !== state.nonceNow) reasons.push("revoked with every other MetaMask permission (nonce bumped)");
  if (state.expiry !== null && state.now >= state.expiry) reasons.push(`expired at ${isoTime(state.expiry)}`);
  if (!state.upgraded) reasons.push("the account is not upgraded to MetaMask's DeleGator (paused, not revoked)");
  if (state.paused) reasons.push("the DelegationManager is paused");
  return reasons;
}

/** On a sweep, what H can send: its USDC, less the gas it must keep. On Arc the
 *  ERC-20 balance (6 decimals) is a view of the native balance (18 decimals),
 *  which also pays the gas; elsewhere, such as a local fork, the two differ. */
export function sweepAmount(input: { usdcBalance: bigint; nativeBalance: bigint; gasReserveWei: bigint }): bigint {
  const spendable = input.nativeBalance > input.gasReserveWei ? input.nativeBalance - input.gasReserveWei : BigInt(0);
  const fromNative = spendable / BigInt(1_000_000_000_000);
  return input.usdcBalance < fromNative ? input.usdcBalance : fromNative;
}
