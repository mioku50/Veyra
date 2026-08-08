/**
 * Copyright 2026 Circle Internet Group, Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { isHex, keccak256, toHex, zeroAddress, type Hex } from "viem";
import type { Erc8183EvaluationRecord } from "../erc8183/types.ts";

const ZERO_HASH = `0x${"0".repeat(64)}` as Hex;

export type CanonicalValidationResponse = {
  requestHash: Hex;
  agentId: string;
  evaluationPublicId: string;
  canonicalReportHash: Hex;
  response: 0 | 100;
  responseHash: Hex;
  responseURI: string;
  tag: "veyra_erc8183_deliverable_passed" | "veyra_erc8183_deliverable_failed";
  canonicalPayload: {
    schema: "veyra-erc8004-validation-v1";
    agentId: string;
    erc8183JobId: string;
    evaluationPublicId: string;
    deliverableHash: Hex;
    reportHash: Hex;
    decision: "passed" | "failed";
  };
};

function requireBytes32(value: string | null, field: string): Hex {
  if (!value || !isHex(value) || value.length !== 66 || value.toLowerCase() === ZERO_HASH) {
    throw new Error(`invalid_${field}`);
  }
  return value as Hex;
}

export function deriveValidationRequestHash(evaluation: Erc8183EvaluationRecord): Hex {
  const deliverableHash = requireBytes32(evaluation.deliverable_hash, "deliverable_hash");
  const reportHash = requireBytes32(evaluation.report_hash, "report_hash");
  return keccak256(
    toHex(
      JSON.stringify({
        schema: "veyra-erc8004-validation-request-v1",
        evaluationPublicId: evaluation.public_id,
        erc8183JobId: evaluation.job_id,
        deliverableHash,
        reportHash,
      })
    )
  );
}

export function buildCanonicalValidationResponse(args: {
  evaluation: Erc8183EvaluationRecord;
  requestHash: Hex;
  agentId: string;
  baseUrl: string;
}): CanonicalValidationResponse {
  const { evaluation, requestHash, agentId } = args;
  if (!/^\d+$/.test(agentId) || BigInt(agentId) <= BigInt(0)) {
    throw new Error("invalid_agent_id");
  }
  if (!isHex(requestHash) || requestHash.length !== 66 || requestHash === ZERO_HASH) {
    throw new Error("invalid_request_hash");
  }

  const isPassed = evaluation.status === "completed" && evaluation.decision === "complete";
  const isFailed = evaluation.status === "rejected" && evaluation.decision === "reject";
  if (!isPassed && !isFailed) {
    throw new Error("evaluation_not_terminal_or_inconsistent");
  }

  const deliverableHash = requireBytes32(evaluation.deliverable_hash, "deliverable_hash");
  const reportHash = requireBytes32(evaluation.report_hash, "report_hash");
  const expectedRequestHash = deriveValidationRequestHash(evaluation);
  if (requestHash.toLowerCase() !== expectedRequestHash.toLowerCase()) {
    throw new Error("request_evaluation_hash_mismatch");
  }

  const decision: "passed" | "failed" = isPassed ? "passed" : "failed";
  const response = isPassed ? 100 : 0;
  const tag = isPassed
    ? "veyra_erc8183_deliverable_passed"
    : "veyra_erc8183_deliverable_failed";
  const canonicalPayload = {
    schema: "veyra-erc8004-validation-v1" as const,
    agentId,
    erc8183JobId: evaluation.job_id,
    evaluationPublicId: evaluation.public_id,
    deliverableHash,
    reportHash,
    decision,
  };
  const responseHash = keccak256(toHex(JSON.stringify(canonicalPayload)));
  const baseUrl = args.baseUrl.replace(/\/$/, "");

  return {
    requestHash,
    agentId,
    evaluationPublicId: evaluation.public_id,
    canonicalReportHash: reportHash,
    response,
    responseHash,
    responseURI: `${baseUrl}/api/erc8004/v1/validations/${requestHash}`,
    tag,
    canonicalPayload,
  };
}

export function isPendingValidationStatus(status: {
  validatorAddress: Hex;
  responseHash: Hex;
  tag: string;
  lastUpdate: bigint;
}) {
  return (
    status.validatorAddress.toLowerCase() !== zeroAddress &&
    status.responseHash.toLowerCase() === ZERO_HASH &&
    status.tag === "" &&
    status.lastUpdate > BigInt(0)
  );
}

export function isTerminalValidationStatus(status: {
  validatorAddress: Hex;
  responseHash: Hex;
  tag: string;
  lastUpdate: bigint;
}) {
  return (
    status.validatorAddress.toLowerCase() !== zeroAddress &&
    status.responseHash.toLowerCase() !== ZERO_HASH &&
    status.tag.length > 0 &&
    status.lastUpdate > BigInt(0)
  );
}
