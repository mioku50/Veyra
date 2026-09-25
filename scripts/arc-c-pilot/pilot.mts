/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Option C pilot on Arc mainnet: Nova's side, and the local page the owner
 * grants and revokes from. The plan, with the steps T0-T13 named below, is
 * docs/audits/2026-09-24-option-c-pilot-plan.md.
 *
 *   npm run --silent arc:c-pilot -- <command> [options]
 *
 *   init                make Nova's redeemer (N) and hot wallet (H) keys, once
 *   preflight           T0: the contracts, the pause, gas, MetaMask's flags
 *   serve               T2-T4, T10: the page, on http://127.0.0.1:8799
 *   status              balances, the account's code, the permission's state
 *   simulate            T6: the refusals, free, on the latest block
 *   redeem <usdc>       T7, T9: N moves <usdc> from the test account to H
 *     --send-refused    T8: send it even though the simulation refuses it
 *   check-revoked       T11: a 0.10 top-up after revocation must be refused
 *     --send            ...and send it as a real transaction as well
 *   sweep               T12: send what H holds back to the test account
 *   log                 everything this pilot has recorded
 *
 *   --home <dir>   keys and state; default ~/.veyra-arc-c-pilot, never
 *                  inside the repository
 *   --rpc <url>    default ARC_MAINNET_RPC_URL, else https://rpc.mainnet.arc.io
 *   --port <n>     the page's port, default 8799
 *   --yes          send without typing the confirmation
 *
 * The keys stay in <home>/keys.json (mode 0600) and are never printed. The
 * server behind the page holds no key: it signs nothing and sends nothing.
 * Every transaction comes from a command typed here, or from a MetaMask
 * prompt the owner approves.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  formatUnits,
  getAddress,
  http,
  isAddress,
  isAddressEqual,
  isHex,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { ADDABLE_CHAINS, ARC_MAINNET_CHAIN_ID, ARC_MAINNET_EXPLORER_URL, ARC_MAINNET_RPC_URL } from "../../lib/wallet/arc.ts";
import {
  ARC_CHAIN_ID_HEX,
  CONTRACTS,
  ELSEWHERE,
  MODES,
  OWNER_MAIN_WALLET,
  PILOT,
  REVOKE_ALL,
  UPGRADED_CODE,
  USDC,
  batchExecution,
  blockers,
  buildPermissionRequest,
  checkGrantShape,
  decodePermissionContext,
  delegationManagerAbi,
  describeCaveat,
  disableData,
  encodePermissionContext,
  erc20Abi,
  formatUsdc,
  isoTime,
  nonceEnforcerAbi,
  readPermission,
  redeemData,
  simulate,
  singleExecution,
  sweepAmount,
  toUsdcUnits,
  topUpData,
  usdcTransferData,
  type Check,
  type Delegation,
  type PermissionOnChain,
} from "./delegation.mts";

/* ---- arguments ---- */

const argv = process.argv.slice(2);
const command = argv[0] ?? "help";
const VALUE_OPTIONS = new Set(["home", "rpc", "port"]);
const options: Record<string, string> = {};
const flags = new Set<string>();
const positional: string[] = [];
for (let index = 1; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg.startsWith("--")) {
    const name = arg.slice(2);
    if (VALUE_OPTIONS.has(name)) options[name] = argv[++index] ?? "";
    else flags.add(name);
  } else {
    positional.push(arg);
  }
}

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

/* ---- where keys and state live: outside the repository ---- */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const home = resolve(options.home ?? process.env.ARC_C_PILOT_HOME ?? join(homedir(), ".veyra-arc-c-pilot"));
const fromRepo = relative(repoRoot, home);
if (fromRepo === "" || (!fromRepo.startsWith("..") && !isAbsolute(fromRepo))) {
  fail(`--home must be outside the repository (${repoRoot}), so the keys can never be committed.`);
}
const files = {
  keys: join(home, "keys.json"),
  request: join(home, "request.json"),
  grant: join(home, "grant.json"),
  log: join(home, "log.jsonl"),
};

const withBigInts = (_key: string, value: unknown) => (typeof value === "bigint" ? value.toString() : value);
const readJson = <T,>(path: string): T | null => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null);
const writeJson = (path: string, value: unknown) =>
  writeFileSync(path, `${JSON.stringify(value, withBigInts, 2)}\n`, { mode: 0o600 });

type KeyFile = {
  version: 1;
  createdAt: string;
  redeemer: { address: Address; privateKey: Hex };
  hot: { address: Address; privateKey: Hex };
};

function readKeys(): KeyFile {
  if (!existsSync(files.keys)) fail(`No keys in ${home}. Run "init" first.`);
  const mode = statSync(files.keys).mode & 0o777;
  if (mode & 0o077) fail(`${files.keys} can be read by others (mode ${mode.toString(8)}). Run: chmod 600 ${files.keys}`);
  return JSON.parse(readFileSync(files.keys, "utf8")) as KeyFile;
}

function addresses() {
  const keys = readKeys();
  return { redeemer: getAddress(keys.redeemer.address), hot: getAddress(keys.hot.address) };
}

function signer(which: "redeemer" | "hot"): PrivateKeyAccount {
  const keys = readKeys();
  const account = privateKeyToAccount(keys[which].privateKey);
  if (!isAddressEqual(account.address, keys[which].address)) fail(`${files.keys} does not match itself; do not edit it by hand.`);
  return account;
}

type PendingRequest = { id: string; startTime: number; expiry: number; createdAt: string };
type GrantFile = {
  version: 1;
  account: Address;
  context: Hex;
  delegation: Omit<Delegation, "salt"> & { salt: string };
  hash: Hex;
  startTime: number;
  expiry: number;
  requestId: string;
  grantedAt: string;
  response: unknown;
};

function readGrant(): (GrantFile & { parsed: Delegation }) | null {
  const grant = readJson<GrantFile>(files.grant);
  return grant ? { ...grant, parsed: { ...grant.delegation, salt: BigInt(grant.delegation.salt) } } : null;
}

function requireGrant() {
  const grant = readGrant();
  if (!grant) fail("No verified permission yet. Grant it from the page first (serve).");
  if (isAddressEqual(grant.account, OWNER_MAIN_WALLET)) fail("The saved permission comes from the owner's main wallet. The pilot does not use it.");
  return grant;
}

/* ---- the chain ---- */

const rpcUrl = options.rpc ?? process.env.ARC_MAINNET_RPC_URL ?? ARC_MAINNET_RPC_URL;
const onMainnet = rpcUrl === ARC_MAINNET_RPC_URL;
const chain = defineChain({
  id: ARC_MAINNET_CHAIN_ID,
  name: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const client = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 30_000, retryCount: 2 }) });
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function assertArc() {
  const id = await client.getChainId();
  if (id !== ARC_MAINNET_CHAIN_ID) fail(`${rpcUrl} is chain ${id}, not Arc mainnet (${ARC_MAINNET_CHAIN_ID}).`);
}

const usdcOf = (owner: Address) => client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [owner] });

function record(entry: Record<string, unknown>) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const line = JSON.stringify({ at: new Date().toISOString(), rpc: onMainnet ? "arc-mainnet" : rpcUrl, ...entry }, withBigInts);
  appendFileSync(files.log, `${line}\n`, { mode: 0o600 });
}

/* Arc drops a transaction priced under its 20 gwei floor without an error.
   The tip can be zero: the base fee alone pays for inclusion. */
async function fees() {
  const block = await client.getBlock();
  const floor = BigInt(20_000_000_000);
  const base = block.baseFeePerGas ?? floor;
  const withHeadroom = (base * BigInt(5)) / BigInt(4);
  return { maxFeePerGas: withHeadroom > floor ? withHeadroom : floor, maxPriorityFeePerGas: BigInt(0) };
}

async function confirm(lines: string[]) {
  for (const line of lines) console.log(`  ${line}`);
  if (flags.has("yes")) return;
  if (!process.stdin.isTTY) fail("Not a terminal. Pass --yes to send.");
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await prompt.question('\n  Type "send" to broadcast, anything else to stop: ')).trim();
  prompt.close();
  if (answer !== "send") fail("Stopped. Nothing was sent.");
}

async function send(input: {
  step: string;
  account: PrivateKeyAccount;
  to: Address;
  data: Hex;
  gas: bigint;
  fee?: Awaited<ReturnType<typeof fees>>;
  what: string[];
}): Promise<TransactionReceipt> {
  const fee = input.fee ?? (await fees());
  await confirm([
    ...input.what,
    `from ${input.account.address}, gas limit ${input.gas}, at most ${formatUnits(input.gas * fee.maxFeePerGas, 18)} USDC of gas`,
    onMainnet ? "on Arc mainnet" : `on ${rpcUrl} (not Arc mainnet)`,
  ]);
  const wallet = createWalletClient({ account: input.account, chain, transport: http(rpcUrl, { timeout: 30_000 }) });
  const hash = await wallet.sendTransaction({ to: input.to, data: input.data, value: BigInt(0), gas: input.gas, ...fee });
  console.log(`  sent ${hash}`);
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
  const cost = receipt.gasUsed * receipt.effectiveGasPrice;
  record({ step: input.step, hash, status: receipt.status, block: receipt.blockNumber, gasUsed: receipt.gasUsed, costUsdc: formatUnits(cost, 18) });
  console.log(`  ${receipt.status} in block ${receipt.blockNumber}: gas ${receipt.gasUsed}, ${formatUnits(cost, 18)} USDC`);
  if (onMainnet) console.log(`  ${ARC_MAINNET_EXPLORER_URL}/tx/${hash}`);
  return receipt;
}

function printPermission(state: PermissionOnChain) {
  const stopped = blockers(state);
  console.log(`  permission ${state.hash}`);
  console.log(`    ${stopped.length ? `cannot be used: ${stopped.join("; ")}` : "active"}`);
  if (state.available) console.log(`    left this period: ${formatUsdc(state.available.amount)} USDC (period ${state.available.period})`);
  if (state.expiry !== null) console.log(`    expires ${isoTime(state.expiry)}`);
}

/* ---- init ---- */

function init() {
  if (existsSync(files.keys)) {
    const { redeemer, hot } = addresses();
    console.log(`\n  Already made, in ${files.keys}:\n    N (redeemer)   ${redeemer}\n    H (hot wallet) ${hot}\n`);
    return;
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const redeemerKey = generatePrivateKey();
  const hotKey = generatePrivateKey();
  const keys: KeyFile = {
    version: 1,
    createdAt: new Date().toISOString(),
    redeemer: { address: privateKeyToAccount(redeemerKey).address, privateKey: redeemerKey },
    hot: { address: privateKeyToAccount(hotKey).address, privateKey: hotKey },
  };
  writeFileSync(files.keys, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  console.log(`
  Made two keys for this pilot only, in ${files.keys} (mode 0600):
    N (redeemer)   ${keys.redeemer.address}
    H (hot wallet) ${keys.hot.address}

  Before stage 2, send N about 0.05 USDC on Arc for gas. H needs nothing:
  it receives only through the permission. Keep ${home} out of backups you
  share, and delete it when the pilot is over.
`);
}

/* ---- preflight (T0) ---- */

async function preflight() {
  await assertArc();
  const rows: { name: string; ok: boolean; detail: string }[] = [];
  const targets: [string, Address][] = [["USDC", USDC], ...(Object.entries(CONTRACTS) as [string, Address][])];
  for (const [name, address] of targets) {
    const code = await client.getCode({ address });
    rows.push({ name: `${name} has code`, ok: Boolean(code && code !== "0x"), detail: address });
  }
  const paused = await client.readContract({ address: CONTRACTS.delegationManager, abi: delegationManagerAbi, functionName: "paused" });
  rows.push({ name: "DelegationManager not paused", ok: !paused, detail: String(paused) });
  const gasPrice = await client.getGasPrice();
  rows.push({ name: "Gas price read", ok: true, detail: `${formatUnits(gasPrice, 9)} gwei (Arc's floor is 20)` });
  try {
    const response = await fetch("https://client-config.api.cx.metamask.io/v1/flags?client=extension&distribution=main&environment=prod", { signal: AbortSignal.timeout(20_000) });
    const flagList = (await response.json()) as Record<string, unknown>[];
    const find = (key: string) => flagList.find((entry) => key in entry)?.[key] as Record<string, unknown> | undefined;
    const eip7702 = find("confirmations_eip_7702") as { supportedChains?: string[]; contracts?: Record<string, { address?: string }[]> } | undefined;
    const arcEntry = eip7702?.contracts?.[ARC_CHAIN_ID_HEX]?.[0]?.address;
    rows.push({
      name: "MetaMask upgrades accounts on Arc to this DeleGator",
      ok: Boolean(eip7702?.supportedChains?.includes(ARC_CHAIN_ID_HEX) && arcEntry && isAddressEqual(arcEntry as Address, CONTRACTS.statelessDeleGator)),
      detail: arcEntry ?? "no Arc entry",
    });
    const advanced = find("enabledAdvancedPermissions") as { permissions?: string[] } | undefined;
    rows.push({
      name: "MetaMask offers erc20-token-periodic",
      ok: Boolean(advanced?.permissions?.includes("erc20-token-periodic")),
      detail: advanced?.permissions?.join(", ") ?? "flag missing",
    });
  } catch (error) {
    rows.push({ name: "MetaMask's flags read", ok: false, detail: (error as Error).message });
  }
  if (existsSync(files.keys)) {
    const { redeemer, hot } = addresses();
    rows.push({ name: "N (redeemer)", ok: true, detail: `${redeemer}, ${formatUsdc(await usdcOf(redeemer))} USDC` });
    rows.push({ name: "H (hot wallet)", ok: true, detail: `${hot}, ${formatUsdc(await usdcOf(hot))} USDC` });
  }
  console.log("");
  for (const row of rows) console.log(`  ${row.ok ? "ok  " : "FAIL"}  ${row.name.padEnd(52)} ${row.detail}`);
  const failed = rows.filter((row) => !row.ok).length;
  record({ step: "preflight", failed, rows });
  console.log(failed ? `\n  ${failed} check(s) failed.\n` : "\n  All checks passed.\n");
  if (failed) process.exit(1);
}

/* ---- status ---- */

async function statusData(accountHint?: string | null) {
  const { redeemer, hot } = addresses();
  const grant = readGrant();
  const accountAddress = grant?.account ?? (accountHint && isAddress(accountHint) ? getAddress(accountHint) : null);
  const [redeemerUsdc, hotUsdc, paused] = await Promise.all([
    usdcOf(redeemer),
    usdcOf(hot),
    client.readContract({ address: CONTRACTS.delegationManager, abi: delegationManagerAbi, functionName: "paused" }),
  ]);
  let account = null;
  if (accountAddress) {
    const [usdc, code] = await Promise.all([usdcOf(accountAddress), client.getCode({ address: accountAddress })]);
    account = { address: accountAddress, usdc: formatUsdc(usdc), upgraded: (code ?? "0x").toLowerCase() === UPGRADED_CODE, code: code ?? "0x" };
  }
  let permission = null;
  if (grant) {
    const state = await readPermission(client, grant.parsed);
    permission = {
      hash: state.hash,
      blockers: blockers(state),
      available: state.available ? `${formatUsdc(state.available.amount)} USDC` : null,
      expiry: state.expiry === null ? null : Number(state.expiry),
      nonceNow: state.nonceNow.toString(),
      nonceInPermission: state.nonceInPermission?.toString() ?? null,
    };
  }
  return {
    mainnet: onMainnet,
    rpc: rpcUrl,
    redeemer: { address: redeemer, usdc: formatUsdc(redeemerUsdc) },
    hot: { address: hot, usdc: formatUsdc(hotUsdc) },
    account,
    permission,
    paused,
  };
}

async function status() {
  await assertArc();
  const data = await statusData();
  console.log(`\n  ${onMainnet ? "Arc mainnet" : rpcUrl}`);
  console.log(`  N (redeemer)   ${data.redeemer.address}  ${data.redeemer.usdc} USDC`);
  console.log(`  H (hot wallet) ${data.hot.address}  ${data.hot.usdc} USDC`);
  if (data.account) {
    console.log(`  test account   ${data.account.address}  ${data.account.usdc} USDC, ${data.account.upgraded ? "upgraded to MetaMask's DeleGator" : `not upgraded (code ${data.account.code})`}`);
  }
  const grant = readGrant();
  if (grant) printPermission(await readPermission(client, grant.parsed));
  else console.log("  no permission granted yet");
  console.log(`  DelegationManager ${data.paused ? "PAUSED" : "not paused"}\n`);
}

/* ---- simulate (T6) ---- */

async function simulateAll() {
  await assertArc();
  const grant = requireGrant();
  const { hot } = addresses();
  const redeemer = signer("redeemer");
  const state = await readPermission(client, grant.parsed);
  const usable = blockers(state).length === 0;
  const manager = CONTRACTS.delegationManager;
  const left = state.available?.amount ?? BigInt(0);
  /* Attempts that test some other rule move an amount the period can still
     cover, down to zero once it is used up: the period check runs first and
     would otherwise answer for every rule behind it. */
  const probe = left < BigInt(100_000) ? left : BigInt(100_000);
  const transfer = (amount: bigint) => usdcTransferData(hot, amount);

  /* A sub-delegation from N to a key made here and dropped at exit: the
     redeemer rule must refuse it. It is signed only to be simulated. */
  const stranger = privateKeyToAccount(generatePrivateKey());
  const [, name, version, domainChainId, verifyingContract] = await client.readContract({ address: manager, abi: delegationManagerAbi, functionName: "eip712Domain" });
  const leaf: Delegation = { delegate: stranger.address, delegator: redeemer.address, authority: state.hash, caveats: [], salt: BigInt(1), signature: "0x" };
  leaf.signature = await redeemer.signTypedData({
    domain: { name, version, chainId: domainChainId, verifyingContract },
    types: {
      Delegation: [
        { name: "delegate", type: "address" },
        { name: "delegator", type: "address" },
        { name: "authority", type: "bytes32" },
        { name: "caveats", type: "Caveat[]" },
        { name: "salt", type: "uint256" },
      ],
      Caveat: [
        { name: "enforcer", type: "address" },
        { name: "terms", type: "bytes" },
      ],
    },
    primaryType: "Delegation",
    message: { delegate: leaf.delegate, delegator: leaf.delegator, authority: leaf.authority, caveats: [], salt: leaf.salt },
  });

  /* The one attempt that should pass: what is left of this period, up to 0.30.
     Once the period is used up, it must be refused like the rest. */
  const positive = left < BigInt(300_000) ? left : BigInt(300_000);
  const cases: { name: string; from: Address; data: Hex; expect: string }[] = [
    positive > BigInt(0)
      ? { name: `${formatUsdc(positive)} to the hot wallet`, from: redeemer.address, data: topUpData(grant.context, hot, positive), expect: "ok" }
      : { name: "0.01 to the hot wallet, period used up", from: redeemer.address, data: topUpData(grant.context, hot, BigInt(10_000)), expect: "ERC20PeriodTransferEnforcer:transfer-amount-exceeded" },
    { name: `${formatUsdc(probe)} to another address`, from: redeemer.address, data: topUpData(grant.context, ELSEWHERE, probe), expect: "AllowedCalldataEnforcer:invalid-calldata" },
    { name: "0.60 at once", from: redeemer.address, data: topUpData(grant.context, hot, BigInt(600_000)), expect: "ERC20PeriodTransferEnforcer:transfer-amount-exceeded" },
    { name: "the same call aimed at another token contract", from: redeemer.address, data: redeemData(grant.context, singleExecution(ELSEWHERE, BigInt(0), transfer(probe))), expect: "ERC20PeriodTransferEnforcer:invalid-contract" },
    {
      name: "approve(H, 1000 USDC)",
      from: redeemer.address,
      data: redeemData(grant.context, singleExecution(USDC, BigInt(0), encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [hot, BigInt(1_000_000_000)] }))),
      expect: "ERC20PeriodTransferEnforcer:invalid-method",
    },
    {
      name: `transferFrom(test account, H, ${formatUsdc(probe)})`,
      from: redeemer.address,
      data: redeemData(grant.context, singleExecution(USDC, BigInt(0), encodeFunctionData({ abi: erc20Abi, functionName: "transferFrom", args: [grant.account, hot, probe] }))),
      expect: "ERC20PeriodTransferEnforcer:invalid-execution-length",
    },
    { name: "a transfer with native value attached", from: redeemer.address, data: redeemData(grant.context, singleExecution(USDC, BigInt(1), transfer(probe))), expect: "ValueLteEnforcer:value-too-high" },
    {
      name: "batch mode",
      from: redeemer.address,
      data: redeemData(grant.context, batchExecution([{ target: USDC, value: BigInt(0), callData: transfer(probe) }, { target: USDC, value: BigInt(0), callData: transfer(probe) }]), MODES.batchDefault),
      expect: "CaveatEnforcer:invalid-call-type",
    },
    { name: "try mode", from: redeemer.address, data: redeemData(grant.context, singleExecution(USDC, BigInt(0), transfer(probe)), MODES.singleTry), expect: "CaveatEnforcer:invalid-execution-type" },
    { name: "redeemed by an address other than N", from: stranger.address, data: topUpData(grant.context, hot, probe), expect: "InvalidDelegate()" },
    {
      name: "through a sub-delegation N signs to another key",
      from: stranger.address,
      data: redeemData(encodePermissionContext([leaf, grant.parsed]), singleExecution(USDC, BigInt(0), transfer(probe))),
      expect: "RedeemerEnforcer:unauthorized-redeemer",
    },
  ];

  console.log(`\n  ${onMainnet ? "Arc mainnet" : rpcUrl}, latest block. Nothing is sent.`);
  if (!usable) console.log(`  The permission cannot be used (${blockers(state).join("; ")}), so every attempt must be refused.`);
  let unexpected = 0;
  const results = [];
  for (const attempt of cases) {
    const result = await simulate(client, attempt.from, manager, attempt.data);
    const expected = usable ? attempt.expect : "refused";
    const ok = expected === "ok" ? result.ok : !result.ok && (expected === "refused" || result.reason.includes(expected));
    if (!ok) unexpected += 1;
    const got = result.ok ? "passes" : `refused: ${result.reason}`;
    results.push({ name: attempt.name, expected, got, ok });
    console.log(`  ${ok ? "as expected" : "UNEXPECTED "}  ${attempt.name.padEnd(48)} ${got}`);
  }
  record({ step: "simulate", usable, unexpected, results });
  console.log(unexpected ? `\n  ${unexpected} unexpected result(s).\n` : "\n  Every result as expected.\n");
  if (unexpected) process.exit(1);
}

/* ---- redeem (T7, T8, T9) ---- */

async function redeem() {
  await assertArc();
  const text = positional[0];
  if (!text) fail("Usage: redeem <usdc>, for example redeem 0.30");
  const amount = toUsdcUnits(text);
  if (amount <= BigInt(0)) fail("The amount must be above zero.");
  if (amount > BigInt(1_000_000)) fail("Above 1.00 USDC. The pilot's cap is 0.50 a day.");
  const grant = requireGrant();
  const { hot } = addresses();
  const redeemer = signer("redeemer");
  const before = await readPermission(client, grant.parsed);
  printPermission(before);
  const data = topUpData(grant.context, hot, amount);
  const simulation = await simulate(client, redeemer.address, CONTRACTS.delegationManager, data);
  const sendRefused = flags.has("send-refused");
  if (!simulation.ok && !sendRefused) {
    record({ step: "top-up-refused-in-simulation", amount: formatUsdc(amount), reason: simulation.reason });
    fail(`Refused in simulation: ${simulation.reason}. Nothing was sent. To send it anyway, as the plan's T8, add --send-refused.`);
  }
  const gas = simulation.ok
    ? ((await client.estimateGas({ account: redeemer.address, to: CONTRACTS.delegationManager, data })) * BigInt(6)) / BigInt(5)
    : BigInt(250_000);
  await send({
    step: simulation.ok ? "top-up" : "top-up-expected-refusal",
    account: redeemer,
    to: CONTRACTS.delegationManager,
    data,
    gas,
    what: [
      `N moves ${formatUsdc(amount)} USDC from the test account ${grant.account} to H ${hot}.`,
      simulation.ok ? "The simulation passes." : `The simulation refuses it (${simulation.reason}); it is sent anyway, as T8.`,
    ],
  });
  const [after, accountUsdc, hotUsdc] = await Promise.all([readPermission(client, grant.parsed), usdcOf(grant.account), usdcOf(hot)]);
  printPermission(after);
  console.log(`  test account ${formatUsdc(accountUsdc)} USDC, H ${formatUsdc(hotUsdc)} USDC\n`);
}

/* ---- check-revoked (T11) ---- */

async function checkRevoked() {
  await assertArc();
  const grant = requireGrant();
  const { redeemer, hot } = addresses();
  const state = await readPermission(client, grant.parsed);
  printPermission(state);
  /* 0.10, or less if the period cannot cover it: the period check runs before
     the nonce and expiry checks and would answer for them. */
  const left = state.available?.amount ?? BigInt(0);
  const amount = left < BigInt(100_000) ? left : BigInt(100_000);
  const data = topUpData(grant.context, hot, amount);
  const simulation = await simulate(client, redeemer, CONTRACTS.delegationManager, data);
  /* Refused is not enough: a used-up period refuses too. Only these reasons
     mean the permission itself is gone. */
  const revokedBy = ["CannotUseADisabledDelegation()", "NonceEnforcer:invalid-nonce", "TimestampEnforcer:expired-delegation"];
  const revoked = !simulation.ok && revokedBy.some((reason) => simulation.reason.includes(reason));
  record({ step: "check-revoked", revoked, reason: simulation.ok ? null : simulation.reason });
  if (!revoked) {
    fail(simulation.ok
      ? "NOT refused: the permission still works. Revoke it first (T10)."
      : `Refused, but only by ${simulation.reason}. The permission itself is NOT revoked. Revoke it first (T10).`);
  }
  const attempt = amount > BigInt(0) ? `A ${formatUsdc(amount)} USDC top-up` : "A zero top-up (the period is used up)";
  console.log(`  ${attempt} is refused: ${simulation.reason}`);
  if (!flags.has("send")) {
    console.log("  Nothing was sent. Add --send to prove it with a real transaction.\n");
    return;
  }
  await send({
    step: "top-up-after-revocation",
    account: signer("redeemer"),
    to: CONTRACTS.delegationManager,
    data,
    gas: BigInt(250_000),
    what: [`N tries a ${formatUsdc(amount)} USDC top-up after revocation. It must be refused on the chain.`],
  });
  console.log("");
}

/* ---- sweep (T12) ---- */

async function sweep() {
  await assertArc();
  const grant = requireGrant();
  const account = signer("hot");
  const [usdc, native] = await Promise.all([usdcOf(account.address), client.getBalance({ address: account.address })]);
  if (usdc === BigInt(0)) {
    console.log("\n  H holds no USDC. Nothing to sweep.\n");
    return;
  }
  const fee = await fees();
  const gas = ((await client.estimateGas({ account: account.address, to: USDC, data: usdcTransferData(grant.account, BigInt(1)) })) * BigInt(11)) / BigInt(10);
  const amount = sweepAmount({ usdcBalance: usdc, nativeBalance: native, gasReserveWei: gas * fee.maxFeePerGas });
  if (amount === BigInt(0)) fail(`H holds ${formatUsdc(usdc)} USDC, not enough to pay for its own sweep.`);
  await send({
    step: "sweep",
    account,
    to: USDC,
    data: usdcTransferData(grant.account, amount),
    gas,
    fee,
    what: [
      `H returns ${formatUsdc(amount)} USDC to the test account ${grant.account}, the only address a sweep goes to.`,
      `H keeps at most ${formatUsdc(usdc - amount)} USDC, to pay for this transaction.`,
    ],
  });
  const [accountUsdc, hotUsdc] = await Promise.all([usdcOf(grant.account), usdcOf(account.address)]);
  console.log(`  test account ${formatUsdc(accountUsdc)} USDC, H ${formatUsdc(hotUsdc)} USDC\n`);
}

/* ---- log ---- */

function showLog() {
  if (!existsSync(files.log)) {
    console.log("\n  Nothing recorded yet.\n");
    return;
  }
  console.log("");
  for (const line of readFileSync(files.log, "utf8").trim().split("\n")) {
    const entry = JSON.parse(line) as Record<string, unknown>;
    const parts = [entry.at, entry.rpc === "arc-mainnet" ? "" : `[${String(entry.rpc)}]`, entry.step, entry.status ?? "", entry.hash ?? "", entry.costUsdc ? `${String(entry.costUsdc)} USDC` : "", entry.reason ?? ""];
    console.log(`  ${parts.filter(Boolean).join("  ")}`);
  }
  console.log("");
}

/* ---- serve: the page (T2-T4, T10) ---- */

async function checkGrantOnChain(delegation: Delegation, context: Hex, account: Address, redeemer: Address, hot: Address) {
  const checks: Check[] = [];
  /* MetaMask answers once the upgrade is sent; it may land a moment later. */
  let code = (await client.getCode({ address: account })) ?? "0x";
  for (let attempt = 0; attempt < 10 && code.toLowerCase() !== UPGRADED_CODE; attempt += 1) {
    await pause(1_500);
    code = (await client.getCode({ address: account })) ?? "0x";
  }
  checks.push({ name: "Account upgraded to MetaMask's DeleGator", ok: code.toLowerCase() === UPGRADED_CODE, detail: code });
  const state = await readPermission(client, delegation);
  checks.push({ name: "Not disabled", ok: !state.disabled, detail: state.disabled ? "disabled" : "enabled" });
  checks.push({ name: "Nonce is current", ok: state.nonceInPermission === state.nonceNow, detail: `${state.nonceInPermission} in the permission, ${state.nonceNow} now` });
  checks.push({ name: "DelegationManager not paused", ok: !state.paused, detail: String(state.paused) });
  /* Refused by the payee rule means the signature and the delegate passed, and
     the enforcers ran: this proves the grant without moving anything. */
  const elsewhere = await simulate(client, redeemer, CONTRACTS.delegationManager, topUpData(context, ELSEWHERE, BigInt(10_000)));
  checks.push({
    name: "A top-up to another address is refused by the payee rule",
    ok: !elsewhere.ok && elsewhere.reason.includes("AllowedCalldataEnforcer:invalid-calldata"),
    detail: elsewhere.ok ? "it passed" : elsewhere.reason,
  });
  const balance = await usdcOf(account);
  if (balance >= BigInt(10_000)) {
    const toHot = await simulate(client, redeemer, CONTRACTS.delegationManager, topUpData(context, hot, BigInt(10_000)));
    checks.push({ name: "A 0.01 top-up to the hot wallet passes", ok: toHot.ok, detail: toHot.ok ? "passes (simulated, nothing moved)" : toHot.reason });
  } else {
    checks.push({ name: "A 0.01 top-up to the hot wallet passes", ok: true, detail: `not tried: the account holds ${formatUsdc(balance)} USDC` });
  }
  return { checks, hash: state.hash };
}

async function verifyGrant(body: unknown, pending: PendingRequest | null, redeemer: Address, hot: Address) {
  const input = (body ?? {}) as { requestId?: unknown; account?: unknown; response?: unknown };
  if (!pending || input.requestId !== pending.id) return { ok: false, error: "the page's request is not the latest one; ask again" };
  if (typeof input.account !== "string" || !isAddress(input.account)) return { ok: false, error: "no connected account" };
  const account = getAddress(input.account);
  const first = Array.isArray(input.response) ? (input.response[0] as Record<string, unknown> | undefined) : undefined;
  const context = first?.context;
  if (typeof context !== "string" || !isHex(context)) return { ok: false, error: "MetaMask's answer carries no permission context" };
  let delegations: Delegation[];
  try {
    delegations = decodePermissionContext(context);
  } catch (error) {
    return { ok: false, error: `the permission context does not decode: ${(error as Error).message}` };
  }
  const nonce = await client.readContract({ address: CONTRACTS.nonceEnforcer, abi: nonceEnforcerAbi, functionName: "currentNonce", args: [CONTRACTS.delegationManager, account] });
  const checks = checkGrantShape({ delegations, delegationManager: first?.delegationManager, account, redeemer, hot, startTime: pending.startTime, expiry: pending.expiry, nonce });
  checks.push({ name: "Answer names Arc mainnet", ok: String(first?.chainId).toLowerCase() === ARC_CHAIN_ID_HEX, detail: String(first?.chainId) });
  let hash: Hex | null = null;
  if (delegations.length === 1 && checks.every((check) => check.ok)) {
    const onChain = await checkGrantOnChain(delegations[0], context, account, redeemer, hot);
    checks.push(...onChain.checks);
    hash = onChain.hash;
  }
  const ok = checks.every((check) => check.ok) && hash !== null;
  record({ step: "grant-checked", ok, account, failed: checks.filter((check) => !check.ok) });
  if (ok && hash) {
    const grant: GrantFile = {
      version: 1,
      account,
      context,
      delegation: { ...delegations[0], salt: delegations[0].salt.toString() },
      hash,
      startTime: pending.startTime,
      expiry: pending.expiry,
      requestId: pending.id,
      grantedAt: new Date().toISOString(),
      response: input.response,
    };
    writeJson(files.grant, grant);
  }
  return {
    ok,
    hash,
    checks,
    decoded: delegations.map((delegation) => ({ delegator: delegation.delegator, delegate: delegation.delegate, caveats: delegation.caveats.map(describeCaveat) })),
    dependencies: first?.dependencies ?? [],
  };
}

function reply(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body, withBigInts));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += (chunk as Buffer).length;
    if (length > 1_000_000) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

async function serve() {
  await assertArc();
  const { redeemer, hot } = addresses();
  const port = Number(options.port ?? 8799);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) fail("--port must be between 1024 and 65535.");
  const token = randomBytes(24).toString("hex");
  const page = readFileSync(new URL("./page.html", import.meta.url), "utf8").replaceAll("__PILOT_TOKEN__", token);
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  let pending = readJson<PendingRequest>(files.request);
  const tokenMatches = (value: unknown) =>
    typeof value === "string" && value.length === token.length && timingSafeEqual(Buffer.from(value), Buffer.from(token));

  const server = createServer(async (request, response) => {
    try {
      // Only this machine, by name: no other site, and no DNS rebinding.
      if (!hosts.has(request.headers.host ?? "")) return reply(response, 403, { error: "unexpected Host" });
      const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "content-security-policy": "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
        });
        return response.end(page);
      }
      if (!url.pathname.startsWith("/api/")) return reply(response, 404, { error: "not found" });
      if (!tokenMatches(request.headers["x-pilot-token"])) return reply(response, 403, { error: "missing or stale page token: reload the page" });
      const route = `${request.method} ${url.pathname}`;
      if (route === "GET /api/config") {
        return reply(response, 200, {
          chain: ADDABLE_CHAINS[ARC_MAINNET_CHAIN_ID],
          redeemer,
          hot,
          contracts: CONTRACTS,
          revokeAll: REVOKE_ALL,
          mainWallet: OWNER_MAIN_WALLET,
          mainnet: onMainnet,
          rpc: rpcUrl,
        });
      }
      if (route === "POST /api/request") {
        /* The period starts by the chain's clock, not this machine's: a start
           ahead of the latest block is refused as not started. */
        const chainNow = Number((await client.getBlock()).timestamp);
        const now = Math.min(Math.floor(Date.now() / 1000), chainNow);
        const startTime = now - PILOT.startLeadSeconds;
        pending = { id: randomBytes(8).toString("hex"), startTime, expiry: startTime + PILOT.lifetimeSeconds, createdAt: new Date().toISOString() };
        writeJson(files.request, pending);
        return reply(response, 200, { ...pending, params: buildPermissionRequest({ redeemer, hot, startTime, expiry: pending.expiry }) });
      }
      if (route === "POST /api/grant") return reply(response, 200, await verifyGrant(await readBody(request), pending, redeemer, hot));
      if (route === "GET /api/status") return reply(response, 200, await statusData(url.searchParams.get("account")));
      if (route === "GET /api/revoke-tx") {
        const grant = readGrant();
        if (!grant) return reply(response, 409, { error: "no verified permission yet" });
        return reply(response, 200, { from: grant.account, to: CONTRACTS.delegationManager, data: disableData(grant.parsed), hash: grant.hash });
      }
      return reply(response, 404, { error: "not found" });
    } catch (error) {
      return reply(response, 500, { error: (error as Error).message });
    }
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`
  The pilot page: http://127.0.0.1:${port}/
  ${onMainnet ? "Arc mainnet" : `RPC ${rpcUrl}, NOT Arc mainnet`}
  N (redeemer)   ${redeemer}
  H (hot wallet) ${hot}

  Open it in the browser that has MetaMask, and connect only the test
  account. This server holds no key and sends nothing. Ctrl+C to stop.
`);
  });
}

/* ---- main ---- */

const commands: Record<string, () => unknown> = {
  init,
  preflight,
  serve,
  status,
  simulate: simulateAll,
  redeem,
  "check-revoked": checkRevoked,
  sweep,
  log: showLog,
};

const USAGE = `
  npm run --silent arc:c-pilot -- <command> [--home <dir>] [--rpc <url>] [--port <n>] [--yes]

  init                make Nova's redeemer (N) and hot wallet (H) keys, once
  preflight           T0: the contracts, the pause, gas, MetaMask's flags
  serve               T2-T4, T10: the page, on http://127.0.0.1:8799
  status              balances, the account's code, the permission's state
  simulate            T6: the refusals, free, on the latest block
  redeem <usdc>       T7, T9: N moves <usdc> from the test account to H
    --send-refused    T8: send it even though the simulation refuses it
  check-revoked       T11: a 0.10 top-up after revocation must be refused
    --send            ...and send it as a real transaction as well
  sweep               T12: send what H holds back to the test account
  log                 everything this pilot has recorded
`;

const run = commands[command];
if (!run) {
  console.log(USAGE);
  process.exit(command === "help" ? 0 : 1);
}
await run();
