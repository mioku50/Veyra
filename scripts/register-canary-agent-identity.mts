/**
 * Copyright 2026 Circle Internet Group, Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import {
  ARC_ERC8004_IDENTITY_REGISTRY,
  getArcPublicClient,
  recoverAgentIdFromLogs,
} from "../lib/erc8004/client.ts";

async function main() {
  console.log("🔥 Registering / Recovering Dedicated Veyra Canary Agent Identity...\n");
  const privateKey = process.env.VEYRA_EVALUATOR_ATTESTER_PRIVATE_KEY || process.env.VEYRA_EVALUATOR_RELAYER_PRIVATE_KEY;
  if (!privateKey || !privateKey.startsWith("0x")) {
    console.warn("⚠️ No private key provided. Running dry-run check for Canary Agent registration.");
    return;
  }

  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const ownerAddress = account.address;
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://agent-commerce-six.vercel.app";
  const metadataUri = `${baseUrl}/.well-known/veyra-canary-agent.json`;
  const registryAddress = ARC_ERC8004_IDENTITY_REGISTRY;

  const publicClient = getArcPublicClient();
  const walletClient = createWalletClient({
    account,
    chain: arcTestnet,
    transport: http(process.env.ARC_TESTNET_RPC_URL || "https://rpc.testnet.arc.network"),
  });

  let mintRecord = await recoverAgentIdFromLogs(ownerAddress, registryAddress, publicClient);

  if (mintRecord) {
    console.log(`ℹ️ Canary Agent ID already exists for owner ${ownerAddress}: #${mintRecord.agentId}`);
  } else {
    console.log("⚡ Minting new Canary Agent ID on Arc Testnet...");
    const abi = parseAbi(["function register(string metadataURI) returns (uint256 tokenId)"]);
    const txHash = await walletClient.writeContract({
      address: registryAddress,
      abi,
      functionName: "register",
      args: [metadataUri],
    });
    console.log("TX submitted:", txHash);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 30_000 });
    assert.equal(receipt.status, "success", "Canary registration failed");

    mintRecord = await recoverAgentIdFromLogs(ownerAddress, registryAddress, publicClient, {
      fromBlock: receipt.blockNumber,
      toBlock: receipt.blockNumber,
    });
    assert.ok(mintRecord, "Failed to recover Canary Agent ID");
    assert.equal(mintRecord.transactionHash, txHash, "Recovered Canary mint transaction does not match");
    console.log(`🎉 Minted Canary Agent ID #${mintRecord.agentId}`);
  }

  console.log("=======================================================");
  console.log(`Canary Agent ID: ${mintRecord.agentId}`);
  console.log(`Owner Address: ${ownerAddress}`);
  console.log("=======================================================\n");
}

main().catch((err) => {
  console.error("❌ Canary registration failed:", err);
  process.exit(1);
});
