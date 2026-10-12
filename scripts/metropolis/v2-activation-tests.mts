import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { keccak256, parseAbi, type Address, type Hex } from "viem";
import { METROPOLIS_V2_DEPLOYMENT, parseAccountSetup, readAccountSetup } from "../../lib/monad/account.ts";
import { getMonadReadClient } from "../../lib/monad/erc8004.ts";
import { METROPOLIS_ORIGIN } from "../../lib/monad/passkey.ts";

// Read-only live verification. Negative cases explicitly spoof individual RPC
// replies; they are adapter guards, not claims about contract execution.
const args = process.argv.slice(2);
assert.ok(args.length === 0 || args.length === 1 && args[0] === "--write");
const record = JSON.parse(readFileSync(new URL("../../docs/metropolis-testnet-account-v2-deployment.json", import.meta.url), "utf8"));
const client = getMonadReadClient();
const getters = parseAbi(["function qx() view returns(bytes32)", "function qy() view returns(bytes32)", "function nonce() view returns(uint256)"]);
const finalized = await client.getBlock({ blockTag: "finalized" });
const account = record.address as Address;
const [qx, qy] = await Promise.all([
  client.readContract({ address: account, abi: getters, functionName: "qx", blockNumber: finalized.number }),
  client.readContract({ address: account, abi: getters, functionName: "qy", blockNumber: finalized.number }),
]);
const publicKey = `0x${qx.slice(2)}${qy.slice(2)}` as Hex;
const setup = await readAccountSetup(publicKey, METROPOLIS_ORIGIN, client, finalized.number, METROPOLIS_V2_DEPLOYMENT.factory);
assert.equal(setup.accountAddress, account);
assert.equal(setup.accountDeployed, true);
assert.deepEqual(await parseAccountSetup(setup), setup);
const [code, nonce, old] = await Promise.all([
  client.getCode({ address: account, blockNumber: finalized.number }),
  client.readContract({ address: account, abi: getters, functionName: "nonce", blockNumber: finalized.number }),
  readAccountSetup(publicKey, METROPOLIS_ORIGIN, client, finalized.number),
]);
assert.equal(keccak256(code!), record.runtimeCodeHash);
assert.notEqual(old.accountAddress, setup.accountAddress);
let negativeChecks = 0;
for (const target of [METROPOLIS_V2_DEPLOYMENT.factory, account]) {
  const read = (parameters: Parameters<typeof client.readContract>[0]) => client.readContract(parameters);
  const spoofed = { ...client, readContract: async (parameters: Parameters<typeof client.readContract>[0]) =>
    parameters.address === target && parameters.functionName === "ACCOUNT_VERSION" ? BigInt(1) : read(parameters) } as typeof client;
  await assert.rejects(readAccountSetup(publicKey, METROPOLIS_ORIGIN, spoofed, finalized.number, METROPOLIS_V2_DEPLOYMENT.factory), /version 2/);
  negativeChecks++;
}
const changedCode = { ...client, getCode: async (parameters: Parameters<typeof client.getCode>[0]) =>
  parameters.address === METROPOLIS_V2_DEPLOYMENT.factory ? "0x6000" as Hex : client.getCode(parameters) };
await assert.rejects(readAccountSetup(publicKey, METROPOLIS_ORIGIN, changedCode, finalized.number, METROPOLIS_V2_DEPLOYMENT.factory), /verified contracts/);
negativeChecks++;
await assert.rejects(readAccountSetup(publicKey, METROPOLIS_ORIGIN, client, finalized.number, account), /Unsupported/);
negativeChecks++;
const verification = {
  kind: "veyra.metropolis.v2-activation-verification", version: 1, verifiedAt: new Date().toISOString(), chainId: 10143,
  accountVersion: 2, account: setup.accountAddress, factory: setup.factory, trustGate: setup.trustGate,
  observedBlock: setup.observedBlock, observedBlockHash: setup.observedBlockHash, commitment: "finalized",
  runtimeCodeHash: keccak256(code!), nonce: nonce.toString(), usdcBalanceUnits: setup.usdcBalanceUnits,
  origin: setup.origin, deploymentAndPublicKeyVerified: true,
  legacyAccount: { address: old.accountAddress, usdcBalanceUnits: old.usdcBalanceUnits },
  negativeAdapterChecks: negativeChecks, fundingTransferredByAgent: false, clearanceIssued: false,
  ownerPaymentApproved: false, transactionSent: false, frontendPublished: false, autonomousSpending: false,
  disclosure: "Finalized read-only Testnet configuration and balance check. No live owner passkey payment or service delivery is established.",
};
if (args[0] === "--write") writeFileSync(new URL("../../docs/metropolis-v2-activation-verification.json", import.meta.url), JSON.stringify(verification, null, 2) + "\n");
console.log(JSON.stringify(verification));
