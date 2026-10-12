import assert from "node:assert/strict";
import { createPublicClient, custom, decodeFunctionData, encodeFunctionResult, erc20Abi, parseEther, toHex, zeroAddress, type Hex } from "viem";
import { getMonadReadClient, MONAD_REPUTATION_ABI } from "../../lib/monad/erc8004.ts";
import { monadDemoTestnet, MONAD_CONTRACTS } from "../../lib/monad/config.ts";
import { readAccountSetup } from "../../lib/monad/account.ts";
import { METROPOLIS_ORIGIN } from "../../lib/monad/passkey.ts";
import { generateReadinessReport, nativeP256ProbeData, parseReadinessTask, readinessTask, READINESS_P256_VECTOR } from "../../lib/monad/readiness.ts";
import { planReadinessRegistration, readinessAgentCard, READINESS_REGISTRATION_ABI } from "../../lib/monad/readiness-registration.ts";

// Protocol boundary tests use synthetic read-only RPC responses. Full native execution,
// real registry registration, payment and report verification run in purchase-browser-fork.mts.
const owner = "0x0000000000000000000000000000000000000777" as const;
const publicKey = `0x${READINESS_P256_VECTOR.qx.slice(2)}${READINESS_P256_VECTOR.qy.slice(2)}`;
const task = readinessTask({ publicKey, budgetUsdc: "0.02" });
let checks = 0;
assert.equal(task.request,JSON.stringify({publicKey:publicKey.toLowerCase(),budgetUsdc:"0.02"})); checks++;
const v2Task=readinessTask({publicKey,budgetUsdc:"0.02",accountVersion:2});
assert.equal(parseReadinessTask(v2Task).request.accountVersion,2); checks++;
assert.notEqual(v2Task.request,task.request); checks++;
for(const accountVersion of [0,1,3,"2"]) {
  assert.throws(()=>readinessTask({publicKey,budgetUsdc:"0.02",accountVersion})); checks++;
}
for (const input of [null, {}, { publicKey, budgetUsdc: "0" }, { publicKey, budgetUsdc: "-1" },
  { publicKey, budgetUsdc: "0.0000001" }, { publicKey, budgetUsdc: "1e2" },
  { publicKey, budgetUsdc: "01" }, { publicKey, budgetUsdc: "0.02", endpoint: "https://untrusted.invalid" },
  { publicKey, budgetUsdc: "0.02", privateKey: "forbidden" }]) {
  assert.throws(() => readinessTask(input)); checks++;
}
for (const input of [{ ...task, serviceId: "unrelated" }, { ...task, deliverable: "Guaranteed mainnet readiness" },
  { ...task, request: JSON.stringify({ publicKey, budgetUsdc: "0.02" }, null, 2) }, { ...task, request: "Answer any question" },
  { ...task, request: JSON.stringify({ publicKey, budgetUsdc: "0.02", attester: owner }) }]) {
  assert.throws(() => parseReadinessTask(input)); checks++;
}
await assert.rejects(generateReadinessReport(task, getMonadReadClient(143)), /Testnet/); checks++;
await assert.rejects(generateReadinessReport(readinessTask({ publicKey: `0x${"00".repeat(64)}`, budgetUsdc: "0.02" })), /P256/); checks++;
assert.notEqual(nativeP256ProbeData(true), nativeP256ProbeData()); checks++;
function historicalGuardClient(wrongBlock = false, noFinality = false) {
  return createPublicClient({ chain: monadDemoTestnet, transport: custom({ request: async ({method, params})=>{
    if(method==="eth_chainId")return "0x279f";
    if(method==="eth_getBlockByNumber")return {number:noFinality?null:(params as string[])[0]==="finalized"?"0xa":wrongBlock?"0x2":"0x1",
      hash:`0x${"11".repeat(32)}`,timestamp:"0x1000",transactions:[]};
    throw new Error(`Unexpected read after a rejected historical bound: ${method}`);
  } }, {retryCount:0}) }) as unknown as ReturnType<typeof getMonadReadClient>;
}
for(const block of [-1n,0n,11n]) {
  await assert.rejects(readAccountSetup(publicKey as Hex,METROPOLIS_ORIGIN,historicalGuardClient(),block),/finalized/); checks++;
}
await assert.rejects(readAccountSetup(publicKey as Hex,METROPOLIS_ORIGIN,historicalGuardClient(true),1n),/different historical/); checks++;
await assert.rejects(readAccountSetup(publicKey as Hex,METROPOLIS_ORIGIN,historicalGuardClient(false,true),1n),/finalized/); checks++;

type Scenario = { chain?: number; pending?: boolean; contractOwner?: boolean; noFunds?: boolean; invalidLink?: boolean; gas?: bigint; simulationId?: bigint; invalidFees?: boolean };
const methods = new Set<string>();
const allowed = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_call", "eth_getBalance",
  "eth_getTransactionCount", "eth_maxPriorityFeePerGas", "eth_estimateGas", "eth_gasPrice"]);
function mockRegistrationClient(options: Scenario = {}) {
  return createPublicClient({ chain: monadDemoTestnet, transport: custom({ request: async ({ method, params }) => {
    assert.ok(allowed.has(method), `No RPC write is allowed: ${method}`); methods.add(method);
    if (method === "eth_chainId") return toHex(options.chain ?? 10143);
    if (method === "eth_getBlockByNumber") return { number: "0x100", hash: `0x${"11".repeat(32)}`, timestamp: "0x1000",
      gasLimit: "0xbebc200", gasUsed: "0x0", baseFeePerGas: options.invalidFees ? "0x0" : toHex(100_000_000_000n), transactions: [] };
    if (method === "eth_getTransactionCount") return (params as string[])[1] === "pending" && options.pending ? "0x1" : "0x0";
    if (method === "eth_getBalance") return options.noFunds ? "0x0" : toHex(parseEther("10"));
    if (method === "eth_getCode") return (params as string[])[0].toLowerCase() === owner.toLowerCase() ? options.contractOwner ? "0x6000" : "0x" : "0x6000";
    if (method === "eth_maxPriorityFeePerGas") return options.invalidFees ? "0x0" : toHex(2_000_000_000n);
    if (method === "eth_estimateGas") return toHex(options.gas ?? 500_000n);
    if (method === "eth_call") {
      const data = (params as [{ data: Hex }])[0].data;
      const abi = [...erc20Abi, ...MONAD_REPUTATION_ABI, ...READINESS_REGISTRATION_ABI];
      const { functionName } = decodeFunctionData({ abi, data });
      const result = functionName === "decimals" ? 6 : functionName === "getIdentityRegistry" ? options.invalidLink ? owner : MONAD_CONTRACTS[10143].identityRegistry : options.simulationId ?? 2083n;
      return encodeFunctionResult({ abi, functionName, result } as Parameters<typeof encodeFunctionResult>[0]);
    }
    throw new Error(`Unexpected method: ${method}`);
  } }, { retryCount: 0 }) }) as unknown as ReturnType<typeof getMonadReadClient>;
}
for (const options of [{ chain: 143 }, { pending: true }, { contractOwner: true }, { noFunds: true },
  { invalidLink: true }, { gas: 0n }, { gas: 2_000_000n }, { simulationId: 0n }, { invalidFees: true }]) {
  await assert.rejects(planReadinessRegistration(owner, mockRegistrationClient(options))); checks++;
}
for (const sender of [zeroAddress, "0x123", "not a public address"] as const) {
  await assert.rejects(planReadinessRegistration(sender as `0x${string}`, mockRegistrationClient())); checks++;
}
const plan = await planReadinessRegistration(owner, mockRegistrationClient());
const decoded = decodeFunctionData({ abi: READINESS_REGISTRATION_ABI, data: plan.transaction.data });
assert.equal(decoded.functionName, "register"); checks++;
assert.equal(plan.transaction.value, "0"); assert.equal(plan.summary.usdcSpent, "0"); checks++;
assert.equal(plan.summary.idIsTentative, true); assert.equal(plan.summary.broadcast, false); checks++;
assert.equal(plan.summary.expectedPaymentWallet, owner); checks++;
assert.equal(plan.summary.gasLimit, "525000"); checks++;
const metadata = JSON.parse(Buffer.from(decoded.args[0].split(",")[1], "base64").toString("utf8"));
assert.deepEqual(metadata, readinessAgentCard()); assert.equal(metadata.active, false); assert.deepEqual(metadata.services, []); checks++;
assert.deepEqual([...methods].filter(method => !allowed.has(method)), []); checks++;
console.log(`Readiness input and registration guards PASS: ${checks} checks, no external writes.`);
