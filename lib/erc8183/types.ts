/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

export const STRUCTURED_DELIVERABLE_V1_SCHEMA = "veyra://schemas/structured-deliverable-v1" as const;
export const STRUCTURED_DELIVERABLE_V1_POLICY = "structured-deliverable-v1" as const;

export type VeyraDeliverableV1 = {
  version: 1;
  contentUri: string;
  contentHash: `0x${string}`;
  contentType: "application/json";
  schemaId: typeof STRUCTURED_DELIVERABLE_V1_SCHEMA;
  policyId: typeof STRUCTURED_DELIVERABLE_V1_POLICY;
};

export type StructuredDeliverableEvidence = {
  type: string;
  uri?: string;
  hash?: `0x${string}`;
  description: string;
};

export type StructuredDeliverableV1 = {
  schemaVersion: "veyra.structured-deliverable.v1";
  title: string;
  summary: string;
  result: Record<string, unknown>;
  evidence: StructuredDeliverableEvidence[];
  generatedAt: string;
};

export enum Decision {
  None = 0,
  Complete = 1,
  Reject = 2,
}

export type Verdict = {
  agenticCommerce: `0x${string}`;
  jobId: bigint;
  deliverableHash: `0x${string}`;
  reportHash: `0x${string}`;
  policyHash: `0x${string}`;
  decision: Decision;
  evaluatedAt: bigint;
  validUntil: bigint;
  nonce: bigint;
};

export type EvaluationCheck = {
  id: string;
  name: string;
  passed: boolean;
  severity: "critical" | "warning" | "info";
  message: string;
  details?: Record<string, unknown>;
};

export type Erc8183JobStatus = "Open" | "Funded" | "Submitted" | "Completed" | "Rejected" | "Expired";

export type Erc8183Job = {
  jobId: bigint;
  client: `0x${string}`;
  provider: `0x${string}`;
  evaluator: `0x${string}`;
  budget: bigint;
  expiredAt: bigint;
  status: Erc8183JobStatus;
  description: string;
  hook: `0x${string}`;
  deliverableHash?: `0x${string}`;
};

export type EvaluationStatus =
  | "queued"
  | "evaluating"
  | "retryable"
  | "completed"
  | "rejected";

export type Erc8183EvaluationRecord = {
  id: string;
  public_id: string;
  chain_id: number;
  agentic_commerce: string;
  job_id: string;
  client_wallet: string;
  provider_wallet: string;
  evaluator_contract: string;
  deliverable_hash: string;
  content_hash: string;
  content_uri: string;
  policy_id: string;
  policy_hash: string;
  decision: "complete" | "reject" | null;
  status: EvaluationStatus;
  failure_category: string | null;
  canonical_report: Record<string, unknown> | null;
  report_hash: string | null;
  verdict_digest: string | null;
  settlement_tx_hash: string | null;
  settlement_block_number: number | null;
  created_at: string;
  evaluated_at: string | null;
  settled_at: string | null;
};

export interface EvaluatorMetadata {
  standard: "ERC-8183";
  network: "arc-testnet";
  chainId: 5042002;
  status: "active" | "paused";
  evaluatorAddress: `0x${string}`;
  commerceAddress: `0x${string}`;
  policy: "structured-deliverable-v1";
}
