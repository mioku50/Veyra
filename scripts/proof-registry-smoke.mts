/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createPublicClient,
  getAddress,
  http,
  isAddress,
  type Hex,
} from "viem";
import { arcTestnet } from "viem/chains";
import {
  ARC_TESTNET_CHAIN_ID,
  proofRegistryAbi,
} from "../lib/commerce/onchain-proof.ts";

function requiredAddress(name: string) {
  const value = process.env[name];
  if (!value || !isAddress(value)) throw new Error(`${name} is missing or invalid`);
  return getAddress(value);
}

function proofIdArg() {
  const prefix = "--proof-id=";
  const value = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  if (!value) return null;
  if (!/^0x[0-9a-f]{64}$/i.test(value)) {
    throw new Error("--proof-id must be a 32-byte hex value");
  }
  return value as Hex;
}

async function main() {
  const registry = requiredAddress("AGENT_COMMERCE_PROOF_REGISTRY_ADDRESS");
  const operator = requiredAddress("AGENT_COMMERCE_PROOF_OPERATOR_ADDRESS");
  const attester = requiredAddress("AGENT_COMMERCE_PROOF_ATTESTER_ADDRESS");
  const rpc = process.env.ARC_TESTNET_RPC_URL ?? arcTestnet.rpcUrls.default.http[0];
  const client = createPublicClient({ chain: arcTestnet, transport: http(rpc) });

  const [chainId, bytecode, observedOperator, attesterAuthorized] = await Promise.all([
    client.getChainId(),
    client.getCode({ address: registry }),
    client.readContract({
      address: registry,
      abi: proofRegistryAbi,
      functionName: "operator",
    }),
    client.readContract({
      address: registry,
      abi: proofRegistryAbi,
      functionName: "isAttester",
      args: [attester],
    }),
  ]);

  if (chainId !== ARC_TESTNET_CHAIN_ID) throw new Error("Unexpected Arc chain ID");
  if (!bytecode || bytecode === "0x") throw new Error("Registry bytecode is unavailable");
  if (observedOperator.toLowerCase() !== operator.toLowerCase()) {
    throw new Error("Registry operator does not match configured operator");
  }
  if (!attesterAuthorized) throw new Error("Configured attester is not authorized");

  const proofId = proofIdArg();
  let proofRegistered: boolean | null = null;
  if (proofId) {
    proofRegistered = await client.readContract({
      address: registry,
      abi: proofRegistryAbi,
      functionName: "isRegistered",
      args: [proofId],
    });
    if (!proofRegistered) throw new Error("Requested proof ID is not registered");
  }

  console.log(
    JSON.stringify({
      chainId,
      registry,
      operator: observedOperator,
      attester,
      attesterAuthorized,
      bytecodePresent: true,
      proofId,
      proofRegistered,
    }),
  );
}

main().catch((error) => {
  console.error(
    `[proof-registry-smoke] failed: ${error instanceof Error ? error.message : "Unknown error"}`,
  );
  process.exitCode = 1;
});
