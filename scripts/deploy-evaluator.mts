/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, createWalletClient, http, keccak256, stringToBytes } from "viem";
import { arcTestnet } from "viem/chains";
import fs from "node:fs";
import path from "node:path";

const RPC_URL = process.env.ARC_TESTNET_RPC_URL || "https://rpc.testnet.arc.network";
const COMMERCE_ADDRESS = "0x0747EEf0706327138c69792bF28Cd525089e4583" as `0x${string}`;
const POLICY_HASH = keccak256(stringToBytes("structured-deliverable-v1"));

const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(RPC_URL),
});

async function main() {
  console.log("🚀 Deploying VeyraERC8183Evaluator.sol to Arc Testnet...");

  const deployerKey = process.env.CANARY_DEPLOYER_PRIVATE_KEY as `0x${string}`;
  const attesterKey = process.env.ERC8183_EVALUATOR_ATTESTER_PRIVATE_KEY as `0x${string}`;

  if (!deployerKey || !attesterKey) {
    throw new Error("Missing CANARY_DEPLOYER_PRIVATE_KEY or ERC8183_EVALUATOR_ATTESTER_PRIVATE_KEY");
  }

  const deployerAccount = privateKeyToAccount(deployerKey);
  const attesterAccount = privateKeyToAccount(attesterKey);

  console.log("Deployer Address:", deployerAccount.address);
  console.log("Attester Address:", attesterAccount.address);
  console.log("Commerce Address:", COMMERCE_ADDRESS);
  console.log("Policy Hash:     ", POLICY_HASH);

  const artifactPath = path.join(process.cwd(), "contracts/out/VeyraERC8183Evaluator.sol/VeyraERC8183Evaluator.json");
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf-8"));

  const abi = artifact.abi;
  const bytecode = artifact.bytecode.object as `0x${string}`;

  const walletClient = createWalletClient({
    account: deployerAccount,
    chain: arcTestnet,
    transport: http(RPC_URL),
  });

  const txHash = await walletClient.deployContract({
    abi,
    bytecode,
    args: [
      deployerAccount.address,
      attesterAccount.address,
      COMMERCE_ADDRESS,
      POLICY_HASH,
    ],
  });

  console.log("\n📡 Deployment Transaction Sent!");
  console.log("Tx Hash:", txHash);
  console.log("Waiting for confirmation on Arc Testnet...");

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  if (!receipt.contractAddress) {
    throw new Error("Deployment receipt did not contain contractAddress");
  }

  console.log("\n✅ VeyraERC8183Evaluator DEPLOYED SUCCESSFULLY!");
  console.log("Contract Address:", receipt.contractAddress);
  console.log("Block Number:    ", receipt.blockNumber);
  console.log("Gas Used:        ", receipt.gasUsed.toString());
  console.log(`Arcscan Link:     https://testnet.arcscan.app/address/${receipt.contractAddress}`);

  // Runtime Bytecode verification
  const code = await publicClient.getBytecode({ address: receipt.contractAddress });
  if (!code || code === "0x") {
    throw new Error("Runtime bytecode verification failed: empty bytecode at address!");
  }
  console.log("✅ Onchain runtime bytecode verified! Length:", code.length, "bytes");

  // Save deployment outputs into .env.local
  const envPath = path.join(process.cwd(), ".env.local");
  let envContent = fs.readFileSync(envPath, "utf-8");
  if (envContent.includes("NEXT_PUBLIC_VEYRA_ERC8183_EVALUATOR_ADDRESS=")) {
    envContent = envContent.replace(
      /NEXT_PUBLIC_VEYRA_ERC8183_EVALUATOR_ADDRESS=.*/g,
      `NEXT_PUBLIC_VEYRA_ERC8183_EVALUATOR_ADDRESS=${receipt.contractAddress}`
    );
  } else {
    envContent += `\nNEXT_PUBLIC_VEYRA_ERC8183_EVALUATOR_ADDRESS=${receipt.contractAddress}`;
  }

  fs.writeFileSync(envPath, envContent.trim() + "\n", "utf-8");
  console.log("Saved NEXT_PUBLIC_VEYRA_ERC8183_EVALUATOR_ADDRESS to .env.local");
}

main().catch((err) => {
  console.error("❌ Deployment failed:", err);
  process.exit(1);
});
