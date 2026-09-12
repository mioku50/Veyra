/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { createPublicClient, http, type Hex } from "viem";
import { arcTestnet } from "viem/chains";
import { ERC8183_AGENTIC_COMMERCE_ABI } from "./abi.ts";
import type { Erc8183Job } from "./types.ts";

export const ARC_TESTNET_RPC_URL =
  process.env.ARC_TESTNET_RPC_URL || "https://rpc.testnet.arc.network";

export function getArcPublicClient(rpcUrl = ARC_TESTNET_RPC_URL) {
  return createPublicClient({
    chain: arcTestnet,
    transport: http(rpcUrl, { retryCount: 3, timeout: 15_000 }),
  });
}

export async function fetchOnchainJob(
  commerceAddress: `0x${string}`,
  jobId: bigint,
  client = getArcPublicClient(),
): Promise<Erc8183Job> {
  const rawJob = await client.readContract({
    address: commerceAddress,
    abi: ERC8183_AGENTIC_COMMERCE_ABI,
    functionName: "getJob",
    args: [jobId],
  });

  if (rawJob.id !== jobId) {
    throw new Error(`Job ${jobId} not found onchain`);
  }

  const statusMap: Record<number, Erc8183Job["status"]> = {
    0: "Open",
    1: "Funded",
    2: "Submitted",
    3: "Completed",
    4: "Rejected",
    5: "Expired",
  };

  return {
    jobId,
    client: rawJob.client,
    provider: rawJob.provider,
    evaluator: rawJob.evaluator,
    budget: rawJob.budget,
    expiredAt: rawJob.expiredAt,
    status: statusMap[rawJob.status] ?? "Open",
    description: rawJob.description,
    hook: rawJob.hook,
  };
}

export async function fetchJobSubmittedLogs(
  commerceAddress: `0x${string}`,
  jobId: bigint,
  client = getArcPublicClient(),
): Promise<Array<{ jobId: bigint; deliverableHash: `0x${string}`; blockNumber: bigint; transactionHash: Hex }>> {
  const currentBlock = await client.getBlockNumber();
  const blockWindow = BigInt(5_000);
  const fromBlock = currentBlock > blockWindow ? currentBlock - blockWindow : BigInt(0);

  const logs = await client.getLogs({
    address: commerceAddress,
    event: ERC8183_AGENTIC_COMMERCE_ABI[8],
    args: { jobId },
    fromBlock,
    toBlock: "latest",
  });

  const uniqueLogs = Array.from(new Map(logs.map((log) => [log.transactionHash, log])).values());
  const latestLogs = uniqueLogs.length > 0 ? [uniqueLogs[uniqueLogs.length - 1]] : [];

  return latestLogs.map((log) => ({
    jobId,
    deliverableHash: log.args.deliverableHash!,
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash,
  }));
}
