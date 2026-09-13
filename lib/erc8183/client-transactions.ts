/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  http,
  parseEventLogs,
  type Hex,
} from "viem";
import { arcTestnet } from "viem/chains";
import { ERC8183_AGENTIC_COMMERCE_ABI } from "./abi.ts";
import {
  ARC_CHAIN_ID,
  ARC_USDC_ADDRESS,
  DEFAULT_AGENTIC_COMMERCE,
  DEFAULT_EVALUATOR_CONTRACT,
} from "../execution/adapters/erc8183-lifecycle.ts";

/**
 * The ERC-8183 steps a buyer signs for themselves.
 *
 * The lifecycle adapter drives the same contract calls with keys Veyra holds.
 * That is the right shape for the operator's own demo and the wrong shape for a
 * stranger's money: escrow funded from a Veyra wallet is Veyra's money at risk,
 * and a product that spends its own balance on behalf of visitors is not a
 * trust layer, it is a treasury.
 *
 * So this module holds no key and signs nothing. It encodes calldata and reads
 * public state; the buyer's wallet sends every transaction, and the escrow is
 * funded from the buyer's own USDC. Veyra's role stays what it claims to be —
 * it decides, and it attests.
 */

export type WalletTransaction = {
  /** A stable id so the browser can report which step it sent. */
  step: "create_job" | "approve_usdc" | "fund_escrow";
  to: `0x${string}`;
  data: Hex;
  value: "0x0";
  chainId: number;
  /** What the user is actually approving, in their words not the ABI's. */
  title: string;
  detail: string;
};

export function agenticCommerceAddress(): `0x${string}` {
  const configured = process.env.NEXT_PUBLIC_ERC8183_AGENTIC_COMMERCE
    || process.env.ERC8183_AGENTIC_COMMERCE;
  return /^0x[0-9a-fA-F]{40}$/.test(configured ?? "")
    ? configured as `0x${string}`
    : DEFAULT_AGENTIC_COMMERCE;
}

export function evaluatorAddress(): `0x${string}` {
  const configured = process.env.NEXT_PUBLIC_ERC8183_EVALUATOR_CONTRACT
    || process.env.ERC8183_EVALUATOR_CONTRACT;
  return /^0x[0-9a-fA-F]{40}$/.test(configured ?? "")
    ? configured as `0x${string}`
    : DEFAULT_EVALUATOR_CONTRACT;
}

function publicClient() {
  return createPublicClient({
    chain: arcTestnet,
    transport: http(process.env.ARC_TESTNET_RPC_URL || "https://rpc.testnet.arc.network"),
  });
}

export function encodeCreateJob(input: {
  provider: `0x${string}`;
  description: string;
  expiresInSeconds?: number;
}): WalletTransaction {
  const commerce = agenticCommerceAddress();
  const expiredAt = BigInt(
    Math.floor(Date.now() / 1000) + (input.expiresInSeconds ?? 3_600),
  );
  return {
    step: "create_job",
    to: commerce,
    data: encodeFunctionData({
      abi: ERC8183_AGENTIC_COMMERCE_ABI,
      functionName: "createJob",
      args: [
        input.provider,
        evaluatorAddress(),
        expiredAt,
        input.description,
        "0x0000000000000000000000000000000000000000",
      ],
    }),
    value: "0x0",
    chainId: ARC_CHAIN_ID,
    title: "Create the job on Arc",
    detail: `Registers the job against ${input.provider} with an independent evaluator. No funds move in this step.`,
  };
}

export function encodeApproveUsdc(amountAtomic: bigint): WalletTransaction {
  const commerce = agenticCommerceAddress();
  return {
    step: "approve_usdc",
    to: ARC_USDC_ADDRESS,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      // Exactly the budget, never unlimited: an allowance larger than the job
      // is an authorization the buyer did not ask to give.
      args: [commerce, amountAtomic],
    }),
    value: "0x0",
    chainId: ARC_CHAIN_ID,
    title: "Allow the escrow to draw the budget",
    detail: `Approves exactly ${(Number(amountAtomic) / 1e6).toFixed(6)} USDC to the escrow contract — not an unlimited allowance.`,
  };
}

export function encodeFundEscrow(jobId: bigint | string): WalletTransaction {
  const commerce = agenticCommerceAddress();
  return {
    step: "fund_escrow",
    to: commerce,
    data: encodeFunctionData({
      abi: ERC8183_AGENTIC_COMMERCE_ABI,
      functionName: "fund",
      args: [BigInt(jobId), "0x"],
    }),
    value: "0x0",
    chainId: ARC_CHAIN_ID,
    title: "Fund the escrow",
    detail: "Moves the budget from your wallet into the job's escrow. It is released to the provider only if the evaluator passes the work, and returns to you if it does not.",
  };
}

export type OnchainJob = {
  id: string;
  client: `0x${string}`;
  provider: `0x${string}`;
  evaluator: `0x${string}`;
  description: string;
  budgetAtomic: string;
  budgetUsdc: number;
  expiredAt: string;
  status: number;
};

export async function readJob(jobId: bigint | string): Promise<OnchainJob | null> {
  try {
    const job = await publicClient().readContract({
      address: agenticCommerceAddress(),
      abi: ERC8183_AGENTIC_COMMERCE_ABI,
      functionName: "getJob",
      args: [BigInt(jobId)],
    }) as {
      id: bigint; client: `0x${string}`; provider: `0x${string}`;
      evaluator: `0x${string}`; description: string; budget: bigint;
      expiredAt: bigint; status: number;
    };
    return {
      id: job.id.toString(),
      client: job.client,
      provider: job.provider,
      evaluator: job.evaluator,
      description: job.description,
      budgetAtomic: job.budget.toString(),
      budgetUsdc: Number(job.budget) / 1e6,
      expiredAt: job.expiredAt.toString(),
      status: Number(job.status),
    };
  } catch {
    return null;
  }
}

export async function readUsdcAllowance(owner: `0x${string}`): Promise<bigint> {
  try {
    return await publicClient().readContract({
      address: ARC_USDC_ADDRESS,
      abi: erc20Abi,
      functionName: "allowance",
      args: [owner, agenticCommerceAddress()],
    });
  } catch {
    return BigInt(0);
  }
}

/**
 * Confirms a transaction the buyer's wallet sent, and reports what it did.
 *
 * Veyra never takes the browser's word for a transaction hash. The receipt is
 * read from Arc, and for a job creation the id comes out of the emitted event
 * rather than from anything the client claimed.
 */
export async function confirmClientTransaction(txHash: Hex): Promise<{
  ok: boolean;
  reverted: boolean;
  from: `0x${string}` | null;
  jobId: string | null;
}> {
  try {
    const receipt = await publicClient().waitForTransactionReceipt({
      hash: txHash,
      timeout: 60_000,
    });
    if (receipt.status !== "success") {
      return { ok: false, reverted: true, from: receipt.from, jobId: null };
    }
    const [created] = parseEventLogs({
      abi: ERC8183_AGENTIC_COMMERCE_ABI,
      eventName: "JobCreated",
      logs: receipt.logs,
    });
    const jobId = created && "args" in created && created.args
      && typeof (created.args as { jobId?: bigint }).jobId === "bigint"
      ? String((created.args as { jobId: bigint }).jobId)
      : null;
    return { ok: true, reverted: false, from: receipt.from, jobId };
  } catch {
    return { ok: false, reverted: false, from: null, jobId: null };
  }
}
