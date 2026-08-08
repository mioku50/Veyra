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
  fetchAgentIdentityOnchain,
  getArcPublicClient,
  recoverAgentIdFromLogs,
} from "../lib/erc8004/client.ts";
import { getByoaClient } from "../lib/byoa/service.ts";

async function main() {
  console.log("🔥 Running Veyra ERC-8004 Identity Registration & Recovery...\n");

  const privateKey =
    process.env.VEYRA_IDENTITY_OWNER_PRIVATE_KEY || process.env.CANARY_DEPLOYER_PRIVATE_KEY;
  if (!privateKey || !privateKey.startsWith("0x")) {
    console.error(
      "❌ FAIL-CLOSED PRODUCTION GATE: Missing valid VEYRA_IDENTITY_OWNER_PRIVATE_KEY or project deployer key."
    );
    process.exit(1);
  }

  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const ownerAddress = account.address;
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://agent-commerce-six.vercel.app";
  const metadataUri = `${baseUrl}/.well-known/veyra-agent.json`;
  const registryAddress = (process.env.ERC8004_IDENTITY_REGISTRY || ARC_ERC8004_IDENTITY_REGISTRY) as `0x${string}`;

  console.log("Registry Address:", registryAddress);
  console.log("Owner Address:", ownerAddress);
  console.log("Metadata URI:", metadataUri);

  const publicClient = getArcPublicClient();
  const walletClient = createWalletClient({
    account,
    chain: arcTestnet,
    transport: http(process.env.ARC_TESTNET_RPC_URL || "https://rpc.testnet.arc.network"),
  });

  // Check if identity already registered for this owner
  let mintRecord = await recoverAgentIdFromLogs(ownerAddress, registryAddress, publicClient);

  if (mintRecord) {
    console.log(`ℹ️ Agent ID already registered for owner ${ownerAddress}: #${mintRecord.agentId}`);
  } else {
    console.log("⚡ Submitting IdentityRegistry.register(metadataURI)...");
    const abi = parseAbi(["function register(string metadataURI) returns (uint256 tokenId)"]);
    const txHash = await walletClient.writeContract({
      address: registryAddress,
      abi,
      functionName: "register",
      args: [metadataUri],
    });

    console.log(`Transaction submitted: ${txHash}`);
    console.log("Waiting for block confirmation on Arc Testnet...");
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 30_000 });
    assert.equal(receipt.status, "success", "Identity registration transaction reverted");

    // Recover minted agentId from Transfer event
    mintRecord = await recoverAgentIdFromLogs(ownerAddress, registryAddress, publicClient, {
      fromBlock: receipt.blockNumber,
      toBlock: receipt.blockNumber,
    });
    assert.ok(mintRecord, "Failed to recover minted agentId from the confirmed mint receipt block");
    assert.equal(mintRecord.transactionHash, txHash, "Recovered mint transaction does not match submission");
    console.log(`🎉 Successfully minted ERC-8004 Agent ID #${mintRecord.agentId}`);
  }

  assert.ok(mintRecord, "A canonical ERC-8004 mint record is required");
  const { agentId, transactionHash: txHash, blockNumber } = mintRecord;

  // Verify ownerOf and tokenURI onchain
  console.log(`🔍 Verifying ownerOf(#${agentId}) and tokenURI(#${agentId})...`);
  const onchainData = await fetchAgentIdentityOnchain(BigInt(agentId), registryAddress, publicClient);
  assert.equal(
    onchainData.owner.toLowerCase(),
    ownerAddress.toLowerCase(),
    "Onchain ownerOf does not match registration account"
  );
  console.log("✅ Onchain ownerOf verified:", onchainData.owner);
  console.log("✅ Onchain tokenURI verified:", onchainData.tokenURI);
  assert.equal(onchainData.tokenURI, metadataUri, "Onchain tokenURI does not match canonical metadata URI");

  const registrationReceipt = await publicClient.getTransactionReceipt({ hash: txHash });
  assert.equal(registrationReceipt.status, "success", "Registration transaction is not successful");
  assert.equal(registrationReceipt.blockNumber, blockNumber, "Mint block does not match transaction receipt");
  assert.equal(
    registrationReceipt.to?.toLowerCase(),
    registryAddress.toLowerCase(),
    "Registration transaction target is not the official identity registry"
  );
  const registrationBlock = await publicClient.getBlock({ blockNumber });
  const createdAt = new Date(Number(registrationBlock.timestamp) * 1_000).toISOString();

  // Save to Supabase database
  const storedIdentity = {
    agent_id: agentId,
    registry_address: registryAddress,
    chain_id: arcTestnet.id,
    owner_address: ownerAddress,
    metadata_uri: metadataUri,
    registration_tx: txHash,
    created_at: createdAt,
  };
  const supabase = getByoaClient();
  const { error } = await supabase
    .from("erc8004_agent_identity")
    .upsert(storedIdentity, { onConflict: "agent_id" });
  assert.equal(error, null, `Failed to persist ERC-8004 identity: ${error?.code || "unknown"}`);

  const { data: reloaded, error: reloadError } = await supabase
    .from("erc8004_agent_identity")
    .select("agent_id,registry_address,chain_id,owner_address,metadata_uri,registration_tx,created_at")
    .eq("agent_id", agentId)
    .single();
  assert.equal(reloadError, null, `Failed to reload ERC-8004 identity: ${reloadError?.code || "unknown"}`);
  assert.ok(reloaded, "Persisted ERC-8004 identity could not be reloaded");
  for (const [field, expected] of Object.entries(storedIdentity)) {
    const actual = reloaded[field as keyof typeof reloaded];
    if (field === "created_at") {
      assert.equal(Date.parse(String(actual)), Date.parse(String(expected)), "Reloaded identity field created_at does not match");
      continue;
    }
    const normalizedActual = field.endsWith("address") || field.endsWith("tx")
      ? String(actual).toLowerCase()
      : actual;
    const normalizedExpected = field.endsWith("address") || field.endsWith("tx")
      ? String(expected).toLowerCase()
      : expected;
    assert.equal(normalizedActual, normalizedExpected, `Reloaded identity field ${field} does not match`);
  }
  console.log("✅ Database identity record persisted and reloaded exactly");

  console.log("\n=======================================================");
  console.log(`ERC-8004 Agent ID: ${agentId}`);
  console.log(`Identity Registry: ${registryAddress}`);
  console.log(`Owner Address: ${ownerAddress}`);
  console.log(`Metadata URI: ${metadataUri}`);
  console.log(`Registration TX: ${txHash}`);
  console.log(`Arcscan Link: https://testnet.arcscan.app/tx/${txHash}`);
  console.log("=======================================================\n");
}

main().catch((err) => {
  console.error("❌ Identity Registration & Recovery failed:", err);
  process.exit(1);
});
