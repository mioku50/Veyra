/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The ERC-8004 registry on Arc mainnet, read now, the way the daily job
 * (/api/internal/discovery/arc-registry) reads it.
 *
 *   npm run --silent arc:registry             read and print; writes nothing
 *   npm run --silent arc:registry -- --save   read and keep the snapshot in the
 *                                             database .env.local names
 *
 * It reads the chain, registration files, declared x402 endpoints and each
 * offer's unpaid 402 challenge. It sends no payment and needs no credential
 * except, with --save, the database's. ARC_MAINNET_RPC_URL overrides the
 * public RPC. Prints counts, and the sellers by identity.
 */

import {
  arcRegistryReader,
  refreshArcRegistrySnapshot,
  summarizeArcRegistry,
  takeArcRegistrySnapshot,
} from "../lib/discovery/arc-registry.ts";

if (process.argv.includes("--save")) {
  const result = await refreshArcRegistrySnapshot();
  console.log(JSON.stringify(result, null, 2));
  if (!result.saved) process.exitCode = 1;
} else {
  const snapshot = await takeArcRegistrySnapshot({ reader: arcRegistryReader() });
  console.log(JSON.stringify(summarizeArcRegistry(snapshot), null, 2));
}
