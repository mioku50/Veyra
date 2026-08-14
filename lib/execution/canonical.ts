/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { keccak256, toBytes, type Hex } from "viem";
import type { ExecutionAttempt, ExecutionMandate } from "./types.ts";

export const VEYRA_EXECUTION_EIP712_DOMAIN = {
  name: "Veyra Execution Mandate",
  version: "1",
  chainId: 5042002, // Arc Testnet
} as const;

export const EIP712_MANDATE_TYPES = {
  ExecutionMandate: [
    { name: "mandateId", type: "string" },
    { name: "ownerWallet", type: "address" },
    { name: "subjectAgentId", type: "string" },
    { name: "subjectWallet", type: "address" },
    { name: "mode", type: "string" },
    { name: "network", type: "string" },
    { name: "capabilitiesHash", type: "bytes32" },
    { name: "railsHash", type: "bytes32" },
    { name: "maxPerTransactionUsdc", type: "uint256" },
    { name: "maxPerDayUsdc", type: "uint256" },
    { name: "maxTotalUsdc", type: "uint256" },
    { name: "minimumTrustScore", type: "uint256" },
    { name: "minimumConfidence", type: "uint256" },
    { name: "requireVerifiedIdentity", type: "bool" },
    { name: "evaluatorThresholdUsdc", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "version", type: "string" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

/**
 * Computes deterministic hash of allowed capabilities array.
 */
export function hashCapabilities(capabilities: string[]): Hex {
  const sorted = [...capabilities].sort();
  return keccak256(toBytes(JSON.stringify(sorted)));
}

/**
 * Computes deterministic hash of allowed rails array.
 */
export function hashRails(rails: string[]): Hex {
  const sorted = [...rails].sort();
  return keccak256(toBytes(JSON.stringify(sorted)));
}

/**
 * Builds the canonical EIP-712 message payload for signing an Execution Mandate.
 */
export function buildMandateEip712Message(mandate: {
  mandateId: string;
  ownerWallet: `0x${string}`;
  subjectAgentId: string;
  subjectWallet: `0x${string}`;
  mode: string;
  network: string;
  allowedCapabilities: string[];
  allowedRails: string[];
  maxPerTransactionUsdc: number;
  maxPerDayUsdc: number;
  maxTotalUsdc: number;
  minimumTrustScore: number;
  minimumConfidence: number;
  requireVerifiedIdentity?: boolean;
  evaluatorThresholdUsdc?: number;
  nonce?: number;
  version?: string;
  issuedAt: string | number;
  expiresAt: string | number;
}) {
  const issuedSec =
    typeof mandate.issuedAt === "number"
      ? BigInt(mandate.issuedAt)
      : BigInt(Math.floor(new Date(mandate.issuedAt).getTime() / 1000));
  const expiresSec =
    typeof mandate.expiresAt === "number"
      ? BigInt(mandate.expiresAt)
      : BigInt(Math.floor(new Date(mandate.expiresAt).getTime() / 1000));

  // Convert USDC decimals (6 decimals) to integer units for EIP-712
  const toUnits = (val: number) => BigInt(Math.round(val * 1_000_000));
  const toScoreUnits = (val: number) => BigInt(Math.round(val * 100));

  return {
    mandateId: mandate.mandateId,
    ownerWallet: mandate.ownerWallet,
    subjectAgentId: mandate.subjectAgentId,
    subjectWallet: mandate.subjectWallet,
    mode: mandate.mode,
    network: mandate.network,
    capabilitiesHash: hashCapabilities(mandate.allowedCapabilities),
    railsHash: hashRails(mandate.allowedRails),
    maxPerTransactionUsdc: toUnits(mandate.maxPerTransactionUsdc),
    maxPerDayUsdc: toUnits(mandate.maxPerDayUsdc),
    maxTotalUsdc: toUnits(mandate.maxTotalUsdc),
    minimumTrustScore: toScoreUnits(mandate.minimumTrustScore),
    minimumConfidence: toScoreUnits(mandate.minimumConfidence),
    requireVerifiedIdentity: mandate.requireVerifiedIdentity ?? true,
    evaluatorThresholdUsdc: toUnits(mandate.evaluatorThresholdUsdc ?? 0),
    nonce: BigInt(mandate.nonce ?? 0),
    version: mandate.version ?? "v1",
    issuedAt: issuedSec,
    expiresAt: expiresSec,
  };
}

/**
 * Computes deterministic canonical hash for an Execution Mandate.
 */
export function computeCanonicalMandateHash(mandate: ExecutionMandate | ReturnType<typeof buildMandateEip712Message>): string {
  const replacer = (_key: string, value: any) => (typeof value === "bigint" ? value.toString() : value);
  const serialized = JSON.stringify(mandate, (_key, value) => {
    if (typeof value === "bigint") return value.toString();
    return value;
  });
  return keccak256(toBytes(serialized));
}

/**
 * Computes deterministic canonical hash for an Execution Attempt.
 */
export function computeCanonicalExecutionHash(attempt: {
  executionId: string;
  mandateId?: string | null;
  selectionId: string;
  selectionHash: string;
  rail: string;
  counterpartyAgentId: string;
  counterpartyWallet: string;
  capability: string;
  requestedAmountUsdc: number;
  authorizedAmountUsdc: number;
  clearanceDigest?: string | null;
  createdAt: string;
}): string {
  const payload = {
    executionId: attempt.executionId,
    mandateId: attempt.mandateId || null,
    selectionId: attempt.selectionId,
    selectionHash: attempt.selectionHash,
    rail: attempt.rail,
    counterpartyAgentId: attempt.counterpartyAgentId,
    counterpartyWallet: attempt.counterpartyWallet.toLowerCase(),
    capability: attempt.capability,
    requestedAmountUsdc: attempt.requestedAmountUsdc,
    authorizedAmountUsdc: attempt.authorizedAmountUsdc,
    clearanceDigest: attempt.clearanceDigest || null,
    createdAt: attempt.createdAt,
  };
  const serialized = JSON.stringify(payload, Object.keys(payload).sort());
  return keccak256(toBytes(serialized));
}
