import { hashTypedData, isAddress, toBytes, keccak256, type Hex, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { TrustDecision } from "./types.ts";

export const EIP712_CLEARANCE_TYPES = {
  TrustClearance: [
    { name: "decisionId", type: "bytes32" },
    { name: "subject", type: "address" },
    { name: "executor", type: "address" },
    { name: "counterparty", type: "address" },
    { name: "actionHash", type: "bytes32" },
    { name: "requestedAmount", type: "uint256" },
    { name: "maxAmount", type: "uint256" },
    { name: "snapshotHash", type: "bytes32" },
    { name: "policyVersion", type: "bytes32" },
    { name: "evaluator", type: "address" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

export function getTrustGateEip712Domain(chainId: number, verifyingContract: `0x${string}`) {
  return {
    name: "Veyra Trust Gate",
    version: "1",
    chainId: BigInt(chainId),
    verifyingContract,
  } as const;
}

export function buildClearanceMessage(decision: TrustDecision) {
  if (!decision.subject.wallet || !isAddress(decision.subject.wallet)) {
    throw new Error("Canonical subject wallet is required for an executable clearance");
  }
  if (!decision.request.executor || !isAddress(decision.request.executor)) {
    throw new Error("A valid executor wallet is required for an executable clearance");
  }
  const actionBinding = decision.request.workflowType?.startsWith("counterparty_selection:")
    ? `${decision.request.action}|${decision.request.workflowType}`
    : decision.request.action;
  return {
    decisionId: keccak256(toBytes(decision.decisionId)),
    subject: decision.subject.wallet as `0x${string}`,
    executor: decision.request.executor as `0x${string}`,
    counterparty:
      decision.request.counterparty && isAddress(decision.request.counterparty)
        ? (decision.request.counterparty as `0x${string}`)
        : zeroAddress,
    actionHash: keccak256(toBytes(actionBinding)),
    requestedAmount: BigInt(Math.round(decision.request.requestedValueUsdc * 1_000_000)),
    maxAmount: BigInt(Math.round(decision.policy.maxValueUsdc * 1_000_000)),
    snapshotHash: (decision.trust.snapshotHash as Hex) || keccak256(toBytes("")),
    policyVersion: keccak256(toBytes(decision.policy.version)),
    evaluator: (decision.policy.evaluatorAddress as `0x${string}`) || zeroAddress,
    issuedAt: BigInt(Math.floor(new Date(decision.issuedAt).getTime() / 1000)),
    expiresAt: BigInt(Math.floor(new Date(decision.expiresAt).getTime() / 1000)),
  };
}

export async function signTrustClearance(
  decision: TrustDecision,
  chainId: number,
  verifyingContract: `0x${string}`,
  privateKey: Hex
) {
  const account = privateKeyToAccount(privateKey);
  const clearanceMessage = buildClearanceMessage(decision);
  const domain = getTrustGateEip712Domain(chainId, verifyingContract);

  const signature = await account.signTypedData({
    domain,
    types: EIP712_CLEARANCE_TYPES,
    primaryType: "TrustClearance",
    message: clearanceMessage,
  });

  const digest = hashTypedData({
    domain,
    types: EIP712_CLEARANCE_TYPES,
    primaryType: "TrustClearance",
    message: clearanceMessage,
  });

  return { signature, digest, attester: account.address, clearanceMessage };
}
