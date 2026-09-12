/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { hashTypedData, parseSignature, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Verdict } from "./types.ts";

export const EIP712_VERDICT_TYPES = {
  Verdict: [
    { name: "agenticCommerce", type: "address" },
    { name: "jobId", type: "uint256" },
    { name: "deliverableHash", type: "bytes32" },
    { name: "reportHash", type: "bytes32" },
    { name: "policyHash", type: "bytes32" },
    { name: "decision", type: "uint8" },
    { name: "evaluatedAt", type: "uint64" },
    { name: "validUntil", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export function getEip712Domain(chainId: number, verifyingContract: `0x${string}`) {
  return {
    name: "Veyra ERC8183 Evaluator",
    version: "1",
    chainId: BigInt(chainId),
    verifyingContract,
  } as const;
}

export function computeVerdictDigest(
  chainId: number,
  verifyingContract: `0x${string}`,
  verdict: Verdict,
): `0x${string}` {
  return hashTypedData({
    domain: getEip712Domain(chainId, verifyingContract),
    types: EIP712_VERDICT_TYPES,
    primaryType: "Verdict",
    message: {
      agenticCommerce: verdict.agenticCommerce,
      jobId: verdict.jobId,
      deliverableHash: verdict.deliverableHash,
      reportHash: verdict.reportHash,
      policyHash: verdict.policyHash,
      decision: verdict.decision,
      evaluatedAt: verdict.evaluatedAt,
      validUntil: verdict.validUntil,
      nonce: verdict.nonce,
    },
  });
}

export async function signVerdict(
  chainId: number,
  verifyingContract: `0x${string}`,
  verdict: Verdict,
  privateKey: Hex,
): Promise<{ signature: `0x${string}`; digest: `0x${string}`; attester: `0x${string}` }> {
  const account = privateKeyToAccount(privateKey);
  const signature = await account.signTypedData({
    domain: getEip712Domain(chainId, verifyingContract),
    types: EIP712_VERDICT_TYPES,
    primaryType: "Verdict",
    message: {
      agenticCommerce: verdict.agenticCommerce,
      jobId: verdict.jobId,
      deliverableHash: verdict.deliverableHash,
      reportHash: verdict.reportHash,
      policyHash: verdict.policyHash,
      decision: verdict.decision,
      evaluatedAt: verdict.evaluatedAt,
      validUntil: verdict.validUntil,
      nonce: verdict.nonce,
    },
  });

  const digest = computeVerdictDigest(chainId, verifyingContract, verdict);

  return {
    signature,
    digest,
    attester: account.address,
  };
}
