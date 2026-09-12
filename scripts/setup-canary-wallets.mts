/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, formatEther, parseEther } from "viem";
import { arcTestnet } from "viem/chains";
import fs from "node:fs";
import path from "node:path";

const RPC_URL = process.env.ARC_TESTNET_RPC_URL || "https://rpc.testnet.arc.network";
const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(RPC_URL),
});

async function main() {
  console.log("🔍 Setting up dedicated Canary Wallets for Arc Testnet...");

  const envPath = path.join(process.cwd(), ".env.local");
  let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "";

  function getOrGenerateKey(varName: string): { key: `0x${string}`; address: `0x${string}` } {
    const match = envContent.match(new RegExp(`${varName}=(0x[a-fA-F0-9]{64})`));
    let key: `0x${string}`;
    if (match && match[1]) {
      key = match[1] as `0x${string}`;
    } else {
      key = generatePrivateKey();
      envContent += `\n${varName}=${key}`;
    }
    const account = privateKeyToAccount(key);
    return { key, address: account.address };
  }

  const deployer = getOrGenerateKey("CANARY_DEPLOYER_PRIVATE_KEY");
  const attester = getOrGenerateKey("ERC8183_EVALUATOR_ATTESTER_PRIVATE_KEY");
  const relayer = getOrGenerateKey("ERC8183_EVALUATOR_RELAYER_PRIVATE_KEY");

  // Save updated .env.local
  fs.writeFileSync(envPath, envContent.trim() + "\n", "utf-8");

  console.log("\n📌 Canary Public Addresses:");
  console.log("Deployer Address:", deployer.address);
  console.log("Attester Address:", attester.address);
  console.log("Relayer Address: ", relayer.address);

  // Check native gas balances (native gas on Arc uses 18 decimals)
  const deployerBal = await publicClient.getBalance({ address: deployer.address });
  const attesterBal = await publicClient.getBalance({ address: attester.address });
  const relayerBal = await publicClient.getBalance({ address: relayer.address });

  console.log("\n💰 Native Gas Balances (Arc Testnet USDC gas):");
  console.log(`Deployer: ${formatEther(deployerBal)} native USDC`);
  console.log(`Attester: ${formatEther(attesterBal)} native USDC`);
  console.log(`Relayer:  ${formatEther(relayerBal)} native USDC`);

  const minRequired = parseEther("0.1"); // 0.1 USDC native gas minimum
  const needsFunding = [];

  if (deployerBal < minRequired) {
    needsFunding.push({ role: "Deployer", address: deployer.address, needed: "1.0 USDC" });
  }
  if (attesterBal < minRequired) {
    needsFunding.push({ role: "Attester", address: attester.address, needed: "0.1 USDC" });
  }
  if (relayerBal < minRequired) {
    needsFunding.push({ role: "Relayer", address: relayer.address, needed: "1.0 USDC" });
  }

  if (needsFunding.length > 0) {
    console.log("\n⚠️ FUNDING REQUIRED BEFORE DEPLOYMENT!");
    console.log("Please fund the following addresses with testnet USDC from https://faucet.circle.com (Select Arc Testnet):");
    for (const item of needsFunding) {
      console.log(`- ${item.role} Address: ${item.address} (Required: ~${item.needed})`);
    }
  } else {
    console.log("\n✅ All wallets have sufficient gas for deployment and execution!");
  }
}

main().catch(console.error);
