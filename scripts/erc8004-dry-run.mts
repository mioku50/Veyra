/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { ARC_ERC8004_IDENTITY_REGISTRY, getArcPublicClient } from "../lib/erc8004/client.ts";

async function main() {
  console.log("⚡ Running ERC-8004 Dry-Run Verification (Read-Only)...\n");
  const publicClient = getArcPublicClient();
  const chainId = await publicClient.getChainId();
  console.log("✅ Arc Testnet RPC Reachable, Chain ID:", chainId);
  console.log("✅ Identity Registry Address:", ARC_ERC8004_IDENTITY_REGISTRY);
  console.log("\n🎉 Dry-run verification complete.");
}

main().catch((err) => {
  console.error("❌ Dry-run failed:", err);
  process.exit(1);
});
