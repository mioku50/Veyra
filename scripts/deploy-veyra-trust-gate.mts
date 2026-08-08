/**
 * Deploys the final caller-bound VeyraTrustGate bytecode to Arc Testnet.
 * The signing key is read from the server environment and never passed on a CLI.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWalletClient, http, keccak256, toBytes, zeroHash, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { getArcPublicClient } from "../lib/erc8004/client.ts";

function requireKey(value: string | undefined, label: string): Hex {
  assert.ok(value && /^0x[0-9a-f]{64}$/i.test(value), `${label} is missing or invalid`);
  return value as Hex;
}

async function main() {
  const deployerKey = requireKey(process.env.CANARY_DEPLOYER_PRIVATE_KEY, "CANARY_DEPLOYER_PRIVATE_KEY");
  const attesterKey = requireKey(
    process.env.VEYRA_TRUST_ATTESTER_PRIVATE_KEY || process.env.ERC8183_EVALUATOR_ATTESTER_PRIVATE_KEY,
    "Trust attester key",
  );
  const deployer = privateKeyToAccount(deployerKey);
  const attester = privateKeyToAccount(attesterKey);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const artifact = JSON.parse(
    readFileSync(path.join(root, "contracts", "out", "VeyraTrustGate.sol", "VeyraTrustGate.json"), "utf8"),
  );
  const bytecode = artifact.bytecode?.object as Hex | undefined;
  assert.ok(bytecode && bytecode !== "0x", "Compiled VeyraTrustGate bytecode is missing; run forge build first");
  assert.ok(Array.isArray(artifact.abi), "Compiled VeyraTrustGate ABI is missing");

  const rpcUrl = process.env.ARC_TESTNET_RPC_URL || "https://rpc.testnet.arc.network";
  const publicClient = getArcPublicClient(rpcUrl);
  assert.equal(await publicClient.getChainId(), arcTestnet.id, "Deployment RPC is not Arc Testnet");
  assert.ok((await publicClient.getBalance({ address: deployer.address })) > 0n, "Trust Gate deployer has no Arc Testnet gas balance");
  const wallet = createWalletClient({ account: deployer, chain: arcTestnet, transport: http(rpcUrl) });
  const txHash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode,
    args: [deployer.address, attester.address],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
  assert.equal(receipt.status, "success", "VeyraTrustGate deployment reverted");
  assert.ok(receipt.contractAddress, "Deployment receipt has no contract address");
  const address = receipt.contractAddress;
  assert.ok((await publicClient.getCode({ address })) !== "0x", "Deployed Trust Gate has no bytecode");

  const adminRole = zeroHash;
  const attesterRole = keccak256(toBytes("TRUST_ATTESTER_ROLE"));
  const expectedTypeHash = keccak256(toBytes(
    "TrustClearance(bytes32 decisionId,address subject,address executor,address counterparty,bytes32 actionHash,uint256 requestedAmount,uint256 maxAmount,bytes32 snapshotHash,bytes32 policyVersion,address evaluator,uint64 issuedAt,uint64 expiresAt)",
  ));
  const [adminReady, attesterReady, typeHash] = await Promise.all([
    publicClient.readContract({ address, abi: artifact.abi, functionName: "hasRole", args: [adminRole, deployer.address] }),
    publicClient.readContract({ address, abi: artifact.abi, functionName: "hasRole", args: [attesterRole, attester.address] }),
    publicClient.readContract({ address, abi: artifact.abi, functionName: "CLEARANCE_TYPEHASH" }),
  ]);
  assert.equal(adminReady, true, "Deployer lacks DEFAULT_ADMIN_ROLE");
  assert.equal(attesterReady, true, "Configured attester lacks TRUST_ATTESTER_ROLE");
  assert.equal(String(typeHash).toLowerCase(), expectedTypeHash.toLowerCase(), "Deployed clearance typehash omits caller binding");

  console.log("TRUST_GATE_DEPLOYMENT", JSON.stringify({
    address,
    transactionHash: txHash,
    blockNumber: receipt.blockNumber.toString(),
    admin: deployer.address,
    attester: attester.address,
    clearanceTypeHash: typeHash,
  }));
}

main().catch((error) => {
  console.error("Trust Gate deployment failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
