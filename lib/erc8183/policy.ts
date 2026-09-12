/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { fetchWithSsrfProtection, ResponseSizeLimitExceededError, SSRFProtectionError } from "../seller/ssrf.ts";
import { computeContentHash, computeDeliverableHash, computePolicyHash } from "./deliverable.ts";
import type { EvaluationCheck, StructuredDeliverableV1, VeyraDeliverableV1 } from "./types.ts";
import { STRUCTURED_DELIVERABLE_V1_POLICY, STRUCTURED_DELIVERABLE_V1_SCHEMA } from "./types.ts";

export type EvaluationPolicyResult = {
  outcome: "PASS" | "DETERMINISTIC_FAIL" | "TRANSIENT_ERROR";
  checks: EvaluationCheck[];
  failureCategory?: string;
  failureMessage?: string;
  rawContent?: string;
  parsedDeliverable?: StructuredDeliverableV1;
};

export function validateStructuredDeliverableSchema(data: unknown): data is StructuredDeliverableV1 {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const obj = data as Record<string, unknown>;

  if (obj.schemaVersion !== "veyra.structured-deliverable.v1") return false;
  if (typeof obj.title !== "string" || !obj.title.trim()) return false;
  if (typeof obj.summary !== "string" || !obj.summary.trim()) return false;
  if (!obj.result || typeof obj.result !== "object" || Array.isArray(obj.result)) return false;
  if (!Array.isArray(obj.evidence)) return false;

  for (const item of obj.evidence) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const ev = item as Record<string, unknown>;
    if (typeof ev.type !== "string" || !ev.type.trim()) return false;
    if (typeof ev.description !== "string" || !ev.description.trim()) return false;
    if (ev.uri !== undefined && typeof ev.uri !== "string") return false;
    if (ev.hash !== undefined && typeof ev.hash !== "string") return false;
  }

  if (typeof obj.generatedAt !== "string" || isNaN(Date.parse(obj.generatedAt))) return false;

  return true;
}

export async function runDeterministicEvaluationPolicy(input: {
  deliverable: VeyraDeliverableV1;
  onchainJob: {
    jobId: bigint;
    client: string;
    provider: string;
    evaluator: string;
    budget: bigint;
    expiredAt: bigint;
    status: number;
    description: string;
  };
  onchainDeliverableHash?: `0x${string}`;
  onchainSubmittedEventCount?: number;
  expectedEvaluatorContract: string;
  allowlistedCommerceAddress: string;
  targetChainId: number;
  currentChainId: number;
  fetchTimeoutMs?: number;
  maxArtifactBytes?: number;
  fetcher?: typeof fetchWithSsrfProtection;
}): Promise<EvaluationPolicyResult> {
  const checks: EvaluationCheck[] = [];
  const fetcher = input.fetcher ?? fetchWithSsrfProtection;
  const timeoutMs = input.fetchTimeoutMs ?? 15_000;
  const maxBytes = input.maxArtifactBytes ?? 1_048_576;

  // 1. Check Chain & Contract Allowlist
  const isChainAllowlisted = input.currentChainId === input.targetChainId;
  checks.push({
    id: "chain_allowlisted",
    name: "Chain ID Allowlist Check",
    passed: isChainAllowlisted,
    severity: "critical",
    message: isChainAllowlisted
      ? `Chain ID ${input.currentChainId} is allowlisted.`
      : `Chain ID ${input.currentChainId} does not match target ${input.targetChainId}.`,
  });
  if (!isChainAllowlisted) {
    return { outcome: "DETERMINISTIC_FAIL", checks, failureCategory: "chain_mismatch" };
  }

  // 2. Evaluator Contract Match
  const isEvaluatorMatch =
    input.onchainJob.evaluator.toLowerCase() === input.expectedEvaluatorContract.toLowerCase();
  checks.push({
    id: "evaluator_match",
    name: "Evaluator Contract Address Check",
    passed: isEvaluatorMatch,
    severity: "critical",
    message: isEvaluatorMatch
      ? `Job evaluator matches Veyra contract ${input.expectedEvaluatorContract}.`
      : `Job evaluator ${input.onchainJob.evaluator} does not match Veyra ${input.expectedEvaluatorContract}.`,
  });
  if (!isEvaluatorMatch) {
    return { outcome: "DETERMINISTIC_FAIL", checks, failureCategory: "evaluator_mismatch" };
  }

  // 3. The current Arc reference implementation uses Submitted = 2.
  const isSubmitted = input.onchainJob.status === 2;
  checks.push({
    id: "job_status_submitted",
    name: "Job Status Submitted Check",
    passed: isSubmitted,
    severity: "critical",
    message: isSubmitted
      ? "ERC-8183 Job status is Submitted (2)."
      : `Job status is ${input.onchainJob.status}, expected Submitted (2).`,
  });
  if (!isSubmitted) {
    return { outcome: "DETERMINISTIC_FAIL", checks, failureCategory: "job_not_submitted" };
  }

  // 4. Job Expiry Check
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const isNotExpired = input.onchainJob.expiredAt > nowSec;
  checks.push({
    id: "job_not_expired",
    name: "Job Expiry Check",
    passed: isNotExpired,
    severity: "critical",
    message: isNotExpired
      ? `Job active until timestamp ${input.onchainJob.expiredAt}.`
      : `Job expired at ${input.onchainJob.expiredAt} (current: ${nowSec}).`,
  });
  if (!isNotExpired) {
    return { outcome: "DETERMINISTIC_FAIL", checks, failureCategory: "job_expired" };
  }

  // 5. JobSubmitted Event Count Check
  if (input.onchainSubmittedEventCount !== undefined) {
    const isSingleEvent = input.onchainSubmittedEventCount === 1;
    checks.push({
      id: "submitted_event_count",
      name: "JobSubmitted Log Integrity",
      passed: isSingleEvent,
      severity: "critical",
      message: isSingleEvent
        ? "Exactly one JobSubmitted log found onchain."
        : `Found ${input.onchainSubmittedEventCount} JobSubmitted logs, expected 1.`,
    });
    if (!isSingleEvent) {
      return { outcome: "DETERMINISTIC_FAIL", checks, failureCategory: "invalid_log_history" };
    }
  }

  // 6. Deliverable Commitment & Hash Match
  const computedHash = computeDeliverableHash(input.deliverable);
  if (input.onchainDeliverableHash) {
    const isDeliverableHashMatch =
      input.onchainDeliverableHash.toLowerCase() === computedHash.toLowerCase();
    checks.push({
      id: "deliverable_hash_match",
      name: "Deliverable Commitment Hash Match",
      passed: isDeliverableHashMatch,
      severity: "critical",
      message: isDeliverableHashMatch
        ? `Onchain deliverableHash matches calculated ${computedHash}.`
        : `Onchain deliverableHash ${input.onchainDeliverableHash} mismatch with calculated ${computedHash}.`,
    });
    if (!isDeliverableHashMatch) {
      return { outcome: "DETERMINISTIC_FAIL", checks, failureCategory: "deliverable_hash_mismatch" };
    }
  }

  // 7. Policy and Schema Identifiers
  const isPolicyValid =
    input.deliverable.policyId === STRUCTURED_DELIVERABLE_V1_POLICY &&
    input.deliverable.schemaId === STRUCTURED_DELIVERABLE_V1_SCHEMA;
  checks.push({
    id: "policy_schema_identifiers",
    name: "Policy and Schema Identifier Check",
    passed: isPolicyValid,
    severity: "critical",
    message: isPolicyValid
      ? "Policy and Schema identifiers match supported V1 standards."
      : "Invalid policy or schema identifiers.",
  });
  if (!isPolicyValid) {
    return { outcome: "DETERMINISTIC_FAIL", checks, failureCategory: "invalid_policy_identifiers" };
  }

  // 8. HTTPS URL Validation
  const isHttps = input.deliverable.contentUri.startsWith("https://");
  checks.push({
    id: "content_uri_https",
    name: "HTTPS Protocol Requirement",
    passed: isHttps,
    severity: "critical",
    message: isHttps ? "Content URI uses HTTPS protocol." : "Content URI must use HTTPS protocol.",
  });
  if (!isHttps) {
    return { outcome: "DETERMINISTIC_FAIL", checks, failureCategory: "non_https_uri" };
  }

  // 9. Fetch Content via SSRF Protection
  let response: Response;
  let rawBodyText: string;
  try {
    response = await fetcher(
      input.deliverable.contentUri,
      { method: "GET", headers: { Accept: "application/json" } },
      { maxTimeoutMs: timeoutMs, maxResponseSizeBytes: maxBytes, label: "erc8183 deliverable fetch" },
    );
    rawBodyText = await response.text();
  } catch (error) {
    if (error instanceof SSRFProtectionError || error instanceof ResponseSizeLimitExceededError) {
      checks.push({
        id: "ssrf_security_check",
        name: "SSRF and Egress Security Validation",
        passed: false,
        severity: "critical",
        message: error.message,
      });
      return {
        outcome: "DETERMINISTIC_FAIL",
        checks,
        failureCategory: "ssrf_security_violation",
        failureMessage: error.message,
      };
    }
    // Network timeouts / RPC errors / transient connection issues must NOT reject the job!
    checks.push({
      id: "fetch_network_status",
      name: "Deliverable Egress Network Fetch",
      passed: false,
      severity: "critical",
      message: `Transient network or HTTP failure: ${error instanceof Error ? error.message : String(error)}`,
    });
    return {
      outcome: "TRANSIENT_ERROR",
      checks,
      failureCategory: "network_transient_error",
      failureMessage: error instanceof Error ? error.message : String(error),
    };
  }

  // 10. HTTP Response Code Check
  const isHttpResponseOk = response.ok;
  checks.push({
    id: "http_status_ok",
    name: "HTTP Response Status 2xx Check",
    passed: isHttpResponseOk,
    severity: "critical",
    message: isHttpResponseOk
      ? `HTTP status ${response.status} OK.`
      : `HTTP status ${response.status} failed.`,
  });
  if (!isHttpResponseOk) {
    return {
      outcome: "DETERMINISTIC_FAIL",
      checks,
      failureCategory: "http_fetch_failed",
      failureMessage: `HTTP status ${response.status}`,
    };
  }

  // 11. Content Raw Hash Check
  const computedContentHash = computeContentHash(rawBodyText);
  const isContentHashMatch =
    computedContentHash.toLowerCase() === input.deliverable.contentHash.toLowerCase();
  checks.push({
    id: "content_raw_hash_match",
    name: "Raw Content Hash Match",
    passed: isContentHashMatch,
    severity: "critical",
    message: isContentHashMatch
      ? `Raw content keccak256 hash matches commitment ${computedContentHash}.`
      : `Raw content hash ${computedContentHash} mismatch with committed ${input.deliverable.contentHash}.`,
  });
  if (!isContentHashMatch) {
    return {
      outcome: "DETERMINISTIC_FAIL",
      checks,
      failureCategory: "content_hash_mismatch",
      rawContent: rawBodyText,
    };
  }

  // 12. JSON Parsing & Schema Validation
  let jsonBody: unknown;
  try {
    jsonBody = JSON.parse(rawBodyText);
  } catch (err) {
    checks.push({
      id: "json_syntax_validity",
      name: "JSON Syntax Parser Check",
      passed: false,
      severity: "critical",
      message: "Response content is not valid JSON syntax.",
    });
    return {
      outcome: "DETERMINISTIC_FAIL",
      checks,
      failureCategory: "invalid_json_syntax",
      rawContent: rawBodyText,
    };
  }

  const isSchemaValid = validateStructuredDeliverableSchema(jsonBody);
  checks.push({
    id: "structured_schema_compliance",
    name: "Structured Deliverable V1 Schema Compliance",
    passed: isSchemaValid,
    severity: "critical",
    message: isSchemaValid
      ? "JSON payload fully conforms to veyra.structured-deliverable.v1 schema."
      : "JSON payload fails veyra.structured-deliverable.v1 schema rules.",
  });
  if (!isSchemaValid) {
    return {
      outcome: "DETERMINISTIC_FAIL",
      checks,
      failureCategory: "schema_validation_failed",
      rawContent: rawBodyText,
    };
  }

  return {
    outcome: "PASS",
    checks,
    rawContent: rawBodyText,
    parsedDeliverable: jsonBody as StructuredDeliverableV1,
  };
}
