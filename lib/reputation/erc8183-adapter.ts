import { formatUnits, keccak256, padHex, toBytes, type Hex, type TransactionReceipt } from "viem";
import type { EvaluationExecutionResult } from "../erc8183/evaluator.ts";
import type { Erc8183Job } from "../erc8183/types.ts";

export const ERC8183_JOB_COMPLETED_TOPIC = keccak256(
  toBytes("JobCompleted(uint256,address,bytes32)"),
);

/**
 * Canonical mapping from a terminal ERC-8183 evaluation to reputation score.
 * Callers must not invent a score when the evaluation is non-terminal or its
 * decision/status pair is inconsistent.
 */
export function deriveReputationScoreFromEvaluation(
  evaluation: Pick<EvaluationExecutionResult, "status" | "decision">,
): number {
  if (evaluation.status === "completed" && evaluation.decision === "complete") {
    return 100;
  }
  if (evaluation.status === "rejected" && evaluation.decision === "reject") {
    return 0;
  }
  throw new Error("ERC-8183 evaluation is not a consistent terminal result");
}

/**
 * Derive economic value from the completed onchain ERC-8183 job state and its
 * exact JobCompleted receipt. The amount is the escrow budget in 6-decimal
 * USDC, which is the reference contract's canonical job payment value.
 */
export function deriveSettledErc8183ValueUsdc(input: {
  job: Erc8183Job;
  receipt: TransactionReceipt;
  commerceAddress: `0x${string}`;
}): number {
  if (input.receipt.status !== "success") {
    throw new Error("ERC-8183 completion transaction was not successful");
  }
  if (input.job.status !== "Completed") {
    throw new Error(`ERC-8183 job is ${input.job.status}, not Completed`);
  }
  if (input.job.budget <= BigInt(0)) {
    throw new Error("ERC-8183 completed job has no positive settled budget");
  }

  const expectedJobTopic = padHex(`0x${input.job.jobId.toString(16)}` as Hex);
  const hasExactCompletionEvent = input.receipt.logs.some((log) =>
    log.address.toLowerCase() === input.commerceAddress.toLowerCase()
    && log.topics[0]?.toLowerCase() === ERC8183_JOB_COMPLETED_TOPIC.toLowerCase()
    && log.topics[1]?.toLowerCase() === expectedJobTopic.toLowerCase()
    && log.topics[2]?.slice(-40).toLowerCase() === input.job.evaluator.slice(2).toLowerCase()
  );

  if (!hasExactCompletionEvent) {
    throw new Error("Exact ERC-8183 JobCompleted event was not found in the settlement receipt");
  }

  const value = Number(formatUnits(input.job.budget, 6));
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("ERC-8183 settled economic value is invalid");
  }
  return value;
}
