/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from "node:crypto";

export const CANONICALIZATION_VERSION = "veyra-canonical-v1" as const;

export const SECRET_INTERNAL_KEYS = new Set([
  "credentials",
  "_private",
  "webhookSecret",
  "bearerToken",
  "internalConfig",
]);

export interface CanonicalReportHashResult {
  canonicalHash: `0x${string}`;
  canonicalString: string;
  canonicalizationVersion: typeof CANONICALIZATION_VERSION;
}

/**
 * Recursively canonicalizes JSON values:
 * - Sorts object keys lexicographically
 * - Preserves array element order
 * - Rejects undefined, NaN, Infinity, -Infinity, and functions
 */
export function canonicalizeJson(payload: unknown): string {
  if (payload === undefined) {
    throw new Error("Canonical JSON formatting error: undefined value is not supported.");
  }
  if (typeof payload === "function" || typeof payload === "symbol") {
    throw new Error(`Canonical JSON formatting error: unsupported type ${typeof payload}`);
  }
  if (typeof payload === "number") {
    if (!Number.isFinite(payload)) {
      throw new Error(`Canonical JSON formatting error: non-finite number ${payload}`);
    }
    return JSON.stringify(payload);
  }
  if (payload === null || typeof payload === "boolean" || typeof payload === "string") {
    return JSON.stringify(payload);
  }
  if (Array.isArray(payload)) {
    const items = payload.map((item) => canonicalizeJson(item));
    return `[${items.join(",")}]`;
  }
  if (typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const entries: string[] = [];
    for (const key of keys) {
      const val = obj[key];
      if (val === undefined) {
        throw new Error(`Canonical JSON formatting error: undefined property value for key "${key}"`);
      }
      entries.push(`${JSON.stringify(key)}:${canonicalizeJson(val)}`);
    }
    return `{${entries.join(",")}}`;
  }
  throw new Error(`Canonical JSON formatting error: unsupported value ${String(payload)}`);
}

/**
 * Recursively strips internal and secret keys from a payload object/array.
 */
export function stripInternalKeys(val: unknown): unknown {
  if (val === null || typeof val !== "object") {
    return val;
  }
  if (Array.isArray(val)) {
    return val.map((item) => stripInternalKeys(item));
  }
  const obj = val as Record<string, unknown>;
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!SECRET_INTERNAL_KEYS.has(key)) {
      cleaned[key] = stripInternalKeys(value);
    }
  }
  return cleaned;
}

/**
 * Computes canonical report hash after stripping internal/secret keys.
 */
export function computeCanonicalReportHash(payload: unknown): CanonicalReportHashResult {
  const stripped = stripInternalKeys(payload);
  const canonicalString = canonicalizeJson(stripped);
  const hashHex = createHash("sha256").update(canonicalString).digest("hex");
  return {
    canonicalHash: `0x${hashHex}`,
    canonicalString,
    canonicalizationVersion: CANONICALIZATION_VERSION,
  };
}

/**
 * Strict report schema structure validator for API Quality reports.
 * Must contain workflowType === "paid_api_quality" (or workflow === "paid_api_quality"),
 * valid reportId, servicesCompared, availability, qualityScoreAndConfidence, etc.
 */
export function validateApiQualityReportPayload(
  payload: unknown,
): payload is Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }

  const report = payload as Record<string, unknown>;

  const workflowType = report.workflowType ?? report.workflow;
  if (workflowType !== "paid_api_quality") {
    return false;
  }

  if (typeof report.reportId !== "string" || !report.reportId.trim()) {
    return false;
  }

  if (!Array.isArray(report.servicesCompared)) {
    return false;
  }

  if (
    !report.availability ||
    typeof report.availability !== "object" ||
    Array.isArray(report.availability)
  ) {
    return false;
  }

  if (
    !report.qualityScoreAndConfidence ||
    typeof report.qualityScoreAndConfidence !== "object" ||
    Array.isArray(report.qualityScoreAndConfidence)
  ) {
    return false;
  }

  return true;
}

/**
 * Strict report schema structure validator for Treasury Health reports.
 * Must contain workflowType === "treasury_health", reportId string,
 * targetWallet string matching hex, usdcFlowOverview object,
 * treasuryHealthScore object.
 */
export function validateTreasuryHealthReportPayload(
  payload: unknown,
): payload is Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }

  const report = payload as Record<string, unknown>;

  const workflowType = report.workflowType ?? report.workflow;
  if (workflowType !== "treasury_health") {
    return false;
  }

  if (typeof report.reportId !== "string" || !report.reportId.trim()) {
    return false;
  }

  if (typeof report.targetWallet !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(report.targetWallet)) {
    return false;
  }

  if (
    !report.usdcFlowOverview ||
    typeof report.usdcFlowOverview !== "object" ||
    Array.isArray(report.usdcFlowOverview)
  ) {
    return false;
  }

  if (
    !report.treasuryHealthScore ||
    typeof report.treasuryHealthScore !== "object" ||
    Array.isArray(report.treasuryHealthScore)
  ) {
    return false;
  }

  return true;
}
