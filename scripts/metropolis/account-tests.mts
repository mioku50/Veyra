import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPublicClient, custom, getAddress, sha256, toHex, zeroAddress, type Hex } from "viem";
import { METROPOLIS_ACCOUNT_SALT, METROPOLIS_DEPLOYMENT, parseAccountSetup,
  readAccountSetup, validateAccountKey, type MetropolisAccountSetup } from "../../lib/monad/account.ts";
import { MONAD_CONTRACTS, monadDemoTestnet } from "../../lib/monad/config.ts";
import { getMonadReadClient } from "../../lib/monad/erc8004.ts";
import { METROPOLIS_ORIGIN } from "../../lib/monad/passkey.ts";
import { parseAccountPlanArguments, planAccountCreation } from "./account-plan.mts";

// Generated software fixture, not the user's iPhone key. No transaction is sent.
const fixture = JSON.parse(readFileSync(new URL("../../contracts/monad/test/fixtures/webauthn.json", import.meta.url), "utf8")) as { qx: Hex; qy: Hex };
const publicKey = `0x${fixture.qx.slice(2)}${fixture.qy.slice(2)}` as Hex;
const sender = getAddress("0x861FBe92678Bd6421aCee2dC37b50FDe1Dc01A1E");
const synthetic: MetropolisAccountSetup = {
  kind: "veyra.metropolis.account-setup", version: 1, chainId: 10143,
  factory: METROPOLIS_DEPLOYMENT.factory, trustGate: METROPOLIS_DEPLOYMENT.trustGate,
  usdc: MONAD_CONTRACTS[10143].usdc, origin: METROPOLIS_ORIGIN,
  rpIdHash: sha256(toHex(new URL(METROPOLIS_ORIGIN).hostname)),
  qx: fixture.qx, qy: fixture.qy, userSalt: METROPOLIS_ACCOUNT_SALT,
  accountAddress: sender, observedBlock: "1", observedBlockHash: `0x${"11".repeat(32)}`,
  accountDeployed: false, usdcBalanceUnits: "0",
};
let checks = 0;
assert.deepEqual(await validateAccountKey(publicKey), {qx:fixture.qx,qy:fixture.qy}); checks++;
assert.deepEqual(await parseAccountSetup(synthetic), synthetic); checks++;
for (const [field, value] of [
  ["kind", "other"], ["version", 2], ["chainId", 143], ["factory", sender], ["trustGate", sender],
  ["usdc", MONAD_CONTRACTS[143].usdc], ["origin", "https://preview.vercel.app"],
  ["rpIdHash", `0x${"00".repeat(32)}`], ["userSalt", `0x${"00".repeat(32)}`],
  ["qx", "0x12"], ["qy", `0x${"00".repeat(32)}`], ["accountAddress", zeroAddress],
  ["observedBlock", "0"], ["observedBlock", "-1"], ["observedBlockHash", "0x"],
  ["accountDeployed", "false"], ["usdcBalanceUnits", "-1"], ["usdcBalanceUnits", 1],
] as const) { await assert.rejects(parseAccountSetup({ ...synthetic, [field]: value })); checks++; }
for (const value of [null, [], "invalid", { ...synthetic, privateKey: "must not be accepted" },
  { ...synthetic, credentialId: "credential identifiers are not needed onchain" }]) {
  await assert.rejects(parseAccountSetup(value)); checks++;
}
for (const value of ["0x", `0x${"00".repeat(64)}`, `0x${"ff".repeat(64)}`]) {
  await assert.rejects(validateAccountKey(value)); checks++;
}
assert.deepEqual(parseAccountPlanArguments(["--setup", "/tmp/public.json", "--sender", sender]), { setupPath: "/tmp/public.json", sender }); checks++;
for (const args of [[], ["--setup", "a"], ["--sender", zeroAddress, "--setup", "a"],
  ["--setup", "a", "--sender", sender, "--private-key", "forbidden"],
  ["--setup", "a", "--setup", "b", "--sender", sender], ["--setup", "a", "--sender"]]) {
  assert.throws(() => parseAccountPlanArguments(args)); checks++;
}
await assert.rejects(readAccountSetup(publicKey, "http://localhost:3123")); checks++;
await assert.rejects(readAccountSetup(publicKey, METROPOLIS_ORIGIN, getMonadReadClient(143)), /Testnet/); checks++;
const wrongChain = createPublicClient({ chain: monadDemoTestnet,
  transport: custom({ request: async () => "0x8f" }) });
await assert.rejects(readAccountSetup(publicKey, METROPOLIS_ORIGIN, wrongChain), /Testnet/); checks++;
await assert.rejects(planAccountCreation(synthetic, zeroAddress, "0x01")); checks++;
await assert.rejects(planAccountCreation(synthetic, sender, "0x"), /Compile/); checks++;

const factoryReceipt = JSON.parse(readFileSync(new URL("../../docs/metropolis-testnet-factory-deployment.json", import.meta.url), "utf8"));
const gateReceipt = JSON.parse(readFileSync(new URL("../../docs/metropolis-testnet-deployment.json", import.meta.url), "utf8"));
assert.equal(METROPOLIS_DEPLOYMENT.factory, factoryReceipt.address); checks++;
assert.equal(METROPOLIS_DEPLOYMENT.factoryCodeHash, factoryReceipt.runtimeCodeHash); checks++;
assert.equal(METROPOLIS_DEPLOYMENT.trustGate, gateReceipt.address); checks++;
assert.equal(METROPOLIS_DEPLOYMENT.gateCodeHash, gateReceipt.runtimeCodeHash); checks++;
console.log(`Account setup guards PASS: ${checks} checks.`);

if (process.argv.includes("--live")) {
  const allowed = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_call", "eth_getTransactionCount",
    "eth_getBalance", "eth_maxPriorityFeePerGas", "eth_gasPrice", "eth_estimateGas"]);
  const methods = new Set<string>();
  let id = 0;
  const client = createPublicClient({ chain: monadDemoTestnet, transport: custom({ request: async ({ method, params }) => {
    assert.ok(allowed.has(method), `Forbidden RPC method: ${method}`);
    methods.add(method);
    const response = await fetch("https://testnet-rpc.monad.xyz", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    const payload = await response.json();
    if (payload.error) throw new Error(payload.error.message);
    return payload.result;
  } }) });
  const setup = await readAccountSetup(publicKey, METROPOLIS_ORIGIN, client);
  const artifact = JSON.parse(readFileSync(new URL("../../contracts/monad/out/VeyraPasskeyAccount.sol/VeyraPasskeyAccount.json", import.meta.url), "utf8"));
  const plan = await planAccountCreation(setup, sender, artifact.bytecode.object, client);
  assert.equal(plan.summary.accountAddress, setup.accountAddress);
  assert.equal(plan.summary.usdcSpent, "0");
  if (plan.transaction) {
    assert.equal(plan.transaction.to, METROPOLIS_DEPLOYMENT.factory);
    assert.equal(plan.transaction.value, "0");
  }
  await assert.rejects(planAccountCreation({ ...setup, accountAddress: sender }, sender, artifact.bytecode.object, client), /disagree/);
  console.log(`Live synthetic account plan PASS: verified factory, independent CREATE2, zero value, ${methods.size} read/simulation RPC methods. No account created.`);
}
