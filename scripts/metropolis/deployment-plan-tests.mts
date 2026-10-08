import assert from "node:assert/strict";
import { parseEther, type Hex } from "viem";
import { getMonadReadClient } from "../../lib/monad/erc8004.ts";
import { parseDeploymentRoles, planTrustGateDeployment } from "./deployment-plan.mts";

// Mocked read-only RPC values. These checks establish planning guards, not a live deployment.
const sender = "0x0000000000000000000000000000000000000111";
const admin = "0x0000000000000000000000000000000000000222";
const attester = "0x0000000000000000000000000000000000000333";
const args = ["--sender",sender,"--admin",admin,"--attester",attester];
const roles = parseDeploymentRoles(args);
let checks = 0;
let estimationRequest: Record<string, unknown> | undefined;
type Scenario = { chain?: number; rpcChain?: number; pending?: number; code?: Hex; attesterCode?: Hex; gas?: bigint; balance?: bigint; estimateFails?: boolean; fee?: bigint; tip?: bigint; collision?: boolean };
function client(s: Scenario = {}) {
  return {
    chain: { id: s.chain ?? 10143 }, getChainId: async () => s.rpcChain ?? 10143,
    getTransactionCount: async ({blockTag}: {blockTag:string}) => blockTag === "pending" ? (s.pending ?? 0) : 0,
    getBalance: async () => s.balance ?? parseEther("5"),
    getCode: async ({address}: {address:string}) => address === sender ? (s.code ?? "0x")
      : address === attester ? (s.attesterCode ?? "0x") : (s.collision ? "0x6000" : "0x"),
    getBlock: async () => ({number: 1n, hash: `0x${"11".repeat(32)}`}),
    estimateFeesPerGas: async () => ({maxFeePerGas: s.fee ?? 200_000_000_000n, maxPriorityFeePerGas: s.tip ?? 0n}),
    estimateGas: async (request: Record<string, unknown>) => {
      estimationRequest = request;
      if (s.estimateFails) throw new Error("RPC estimation failed");
      return s.gas ?? 1_000_000n;
    },
  } as unknown as ReturnType<typeof getMonadReadClient>;
}
for (const invalid of [args.slice(0,-2), [...args,"--private-key","never-accepted"], [...args,"--sender",sender],
  ["--sender","0x0000000000000000000000000000000000000000",...args.slice(2)]]) {
  assert.throws(() => parseDeploymentRoles(invalid)); checks++;
}
const plan = await planTrustGateDeployment(roles,"0x6000",client());
assert.equal(plan.transaction.chainId,10143); assert.equal(plan.transaction.from,sender);
assert.equal(plan.transaction.value,"0"); assert.equal(plan.transaction.gas,"1050000");
assert.equal(plan.summary.maximumFeeMon,"0.21"); assert.equal(plan.summary.requiresFunding,false);
assert.equal(plan.summary.admin,admin); assert.equal(plan.summary.attester,attester);
assert.ok(plan.transaction.data.endsWith(admin.slice(2).padStart(64,"0")+attester.slice(2).padStart(64,"0")));
assert.equal(estimationRequest?.value,0n); assert.equal("to" in (estimationRequest ?? {}),false);
checks += 11;
const unfunded = await planTrustGateDeployment(roles,"0x6000",client({balance:0n}));
assert.equal(unfunded.summary.requiresFunding,true); assert.equal(unfunded.summary.senderBalanceMon,"0");
assert.equal(unfunded.summary.estimationUsedBalanceOverride,true); checks += 3;
for (const s of [{chain:143},{rpcChain:143},{pending:1},{code:"0x6000" as Hex},
  {attesterCode:"0x6000" as Hex},{gas:30_000_000n},{gas:0n},{fee:0n},
  {tip:300_000_000_000n},{estimateFails:true},{collision:true}]) {
  await assert.rejects(() => planTrustGateDeployment(roles,"0x6000",client(s))); checks++;
}
await assert.rejects(() => planTrustGateDeployment(roles,"0x",client())); checks++;
console.log(`TrustGate deployment planning PASS: ${checks} checks; mainnet, pending nonce, key arguments, contract signers and failed estimation rejected. No signing or transaction submission.`);
