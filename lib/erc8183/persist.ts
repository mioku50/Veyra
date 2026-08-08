/**
 * Durable persistence for a terminal, onchain-verified ERC-8183 evaluation.
 */

import assert from "node:assert/strict";
import type { Hex, TransactionReceipt } from "viem";
import { getByoaClient } from "../byoa/service.ts";
import { computePolicyHash } from "./deliverable.ts";
import type { EvaluationExecutionResult } from "./evaluator.ts";
import type { Erc8183Job, Erc8183EvaluationRecord, VeyraDeliverableV1 } from "./types.ts";

export async function persistTerminalErc8183Evaluation(args: {
  chainId: 5042002;
  agenticCommerce: `0x${string}`;
  evaluatorContract: `0x${string}`;
  job: Erc8183Job;
  deliverable: VeyraDeliverableV1;
  deliverableHash: Hex;
  result: EvaluationExecutionResult;
  settlementReceipt: TransactionReceipt;
}): Promise<Erc8183EvaluationRecord> {
  const { result } = args;
  assert.ok(result.status === "completed" || result.status === "rejected", "Only terminal evaluations may be persisted");
  assert.ok(result.decision === "complete" || result.decision === "reject", "Terminal evaluation decision is missing");
  assert.ok(result.reportHash && /^0x[0-9a-f]{64}$/i.test(result.reportHash), "Evaluation report hash is invalid");
  assert.ok(result.verdictDigest && /^0x[0-9a-f]{64}$/i.test(result.verdictDigest), "Evaluation verdict digest is invalid");
  assert.ok(result.settlementTxHash && /^0x[0-9a-f]{64}$/i.test(result.settlementTxHash), "Evaluation settlement transaction is invalid");
  assert.equal(args.settlementReceipt.status, "success", "Evaluation settlement receipt reverted");
  assert.equal(args.settlementReceipt.transactionHash.toLowerCase(), result.settlementTxHash.toLowerCase());

  const timestamp = new Date().toISOString();
  const publicId = `vev_${result.settlementTxHash.slice(2, 34).toLowerCase()}`;
  const row = {
    public_id: publicId,
    chain_id: args.chainId,
    agentic_commerce: args.agenticCommerce.toLowerCase(),
    job_id: args.job.jobId.toString(),
    client_wallet: args.job.client.toLowerCase(),
    provider_wallet: args.job.provider.toLowerCase(),
    evaluator_contract: args.evaluatorContract.toLowerCase(),
    deliverable_hash: args.deliverableHash.toLowerCase(),
    content_hash: args.deliverable.contentHash.toLowerCase(),
    content_uri: args.deliverable.contentUri,
    policy_id: args.deliverable.policyId,
    policy_hash: computePolicyHash(args.deliverable.policyId),
    decision: result.decision,
    status: result.status,
    failure_category: null,
    canonical_report: result.canonicalReport || null,
    report_hash: result.reportHash,
    verdict_digest: result.verdictDigest,
    settlement_tx_hash: result.settlementTxHash,
    settlement_block_number: Number(args.settlementReceipt.blockNumber),
    created_at: timestamp,
    evaluated_at: timestamp,
    settled_at: timestamp,
  };

  const supabase = getByoaClient();
  const { error } = await supabase
    .from("erc8183_evaluations")
    .upsert(row, { onConflict: "chain_id,agentic_commerce,job_id" });
  if (error) {
    throw new Error(`erc8183_evaluation_storage_unavailable:${error.code || "upsert_failed"}`);
  }
  const { data: reloaded, error: reloadError } = await supabase
    .from("erc8183_evaluations")
    .select("*")
    .eq("chain_id", args.chainId)
    .eq("agentic_commerce", args.agenticCommerce.toLowerCase())
    .eq("job_id", args.job.jobId.toString())
    .single();
  if (reloadError || !reloaded) {
    throw new Error(`erc8183_evaluation_storage_unavailable:${reloadError?.code || "reload_failed"}`);
  }
  for (const field of [
    "public_id",
    "chain_id",
    "agentic_commerce",
    "job_id",
    "client_wallet",
    "provider_wallet",
    "evaluator_contract",
    "deliverable_hash",
    "content_hash",
    "content_uri",
    "policy_id",
    "policy_hash",
    "decision",
    "status",
    "report_hash",
    "verdict_digest",
    "settlement_tx_hash",
    "settlement_block_number",
  ] as const) {
    assert.equal(
      String(reloaded[field]).toLowerCase(),
      String(row[field]).toLowerCase(),
      `Persisted evaluation field ${field} differs`,
    );
  }
  return reloaded as Erc8183EvaluationRecord;
}
