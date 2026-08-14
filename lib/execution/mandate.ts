/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { recoverTypedDataAddress, type Hex } from "viem";
import {
  buildMandateEip712Message,
  EIP712_MANDATE_TYPES,
  VEYRA_EXECUTION_EIP712_DOMAIN,
} from "./canonical.ts";
import type { ExecutionMandate, ExecutionMandateInput } from "./types.ts";

export interface MandateValidationResult {
  valid: boolean;
  signer?: `0x${string}`;
  reason?: string;
}

/**
 * Recovers the signer address of an EIP-712 signed Execution Mandate.
 */
export async function recoverMandateSigner(
  mandate: ExecutionMandate | ExecutionMandateInput,
  mandateId: string,
  signature: Hex,
  domain = VEYRA_EXECUTION_EIP712_DOMAIN
): Promise<`0x${string}`> {
  const message = buildMandateEip712Message({
    mandateId,
    ownerWallet: mandate.ownerWallet,
    subjectAgentId: mandate.subjectAgentId,
    subjectWallet: mandate.subjectWallet,
    mode: mandate.mode,
    network: mandate.network,
    allowedCapabilities: mandate.allowedCapabilities,
    allowedRails: mandate.allowedRails,
    maxPerTransactionUsdc: mandate.maxPerTransactionUsdc,
    maxPerDayUsdc: mandate.maxPerDayUsdc,
    maxTotalUsdc: mandate.maxTotalUsdc,
    minimumTrustScore: mandate.minimumTrustScore,
    minimumConfidence: mandate.minimumConfidence,
    requireVerifiedIdentity: mandate.requireVerifiedIdentity,
    evaluatorThresholdUsdc: mandate.evaluatorThresholdUsdc,
    nonce: mandate.nonce ?? 0,
    version: mandate.version ?? "v1",
    issuedAt: "issuedAt" in mandate ? mandate.issuedAt : new Date().toISOString(),
    expiresAt: mandate.expiresAt,
  });

  return recoverTypedDataAddress({
    domain,
    types: EIP712_MANDATE_TYPES,
    primaryType: "ExecutionMandate",
    message,
    signature,
  });
}

/**
 * Validates an Execution Mandate against its signature, expiration, and ownership.
 */
export async function validateMandateAuthorization(
  mandate: ExecutionMandate,
  signature: Hex
): Promise<MandateValidationResult> {
  try {
    const signer = await recoverMandateSigner(mandate, mandate.mandateId, signature);

    if (signer.toLowerCase() !== mandate.ownerWallet.toLowerCase()) {
      return {
        valid: false,
        signer,
        reason: `SIGNER_MISMATCH: recovered ${signer} but owner is ${mandate.ownerWallet}`,
      };
    }

    if (mandate.revokedAt) {
      return { valid: false, signer, reason: "MANDATE_REVOKED" };
    }

    const now = Date.now();
    const expiry = new Date(mandate.expiresAt).getTime();
    if (expiry < now) {
      return { valid: false, signer, reason: "MANDATE_EXPIRED" };
    }

    return { valid: true, signer };
  } catch (err: any) {
    return { valid: false, reason: `RECOVERY_ERROR: ${err.message}` };
  }
}

/**
 * Checks whether an execution candidate matches all policy constraints in a mandate.
 */
export function checkMandateEligibility(
  mandate: ExecutionMandate,
  params: {
    capability: string;
    rail: string;
    requestedAmountUsdc: number;
    trustScore: number;
    confidence: number;
    identityVerified?: boolean;
    network?: string;
  }
): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (mandate.revokedAt) {
    reasons.push("MANDATE_REVOKED");
  }

  if (new Date(mandate.expiresAt).getTime() < Date.now()) {
    reasons.push("MANDATE_EXPIRED");
  }

  if (params.network && params.network !== mandate.network) {
    reasons.push(`NETWORK_NOT_ALLOWED: ${params.network}`);
  }

  if (!mandate.allowedCapabilities.includes(params.capability)) {
    reasons.push(`CAPABILITY_NOT_ALLOWED: ${params.capability}`);
  }

  if (!mandate.allowedRails.includes(params.rail as any)) {
    reasons.push(`RAIL_NOT_ALLOWED: ${params.rail}`);
  }

  if (params.requestedAmountUsdc > mandate.maxPerTransactionUsdc) {
    reasons.push(
      `PER_TRANSACTION_CAP_EXCEEDED: requested ${params.requestedAmountUsdc} > max ${mandate.maxPerTransactionUsdc}`
    );
  }

  if (params.trustScore < mandate.minimumTrustScore) {
    reasons.push(
      `INSUFFICIENT_TRUST_SCORE: score ${params.trustScore} < min ${mandate.minimumTrustScore}`
    );
  }

  if (params.confidence < mandate.minimumConfidence) {
    reasons.push(
      `INSUFFICIENT_CONFIDENCE: confidence ${params.confidence} < min ${mandate.minimumConfidence}`
    );
  }

  if (mandate.requireVerifiedIdentity && !params.identityVerified) {
    reasons.push("ERC8004_IDENTITY_REQUIRED");
  }

  return {
    eligible: reasons.length === 0,
    reasons,
  };
}
