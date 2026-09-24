import type { PublicExecutionView } from "./public-view.ts";
import type { ExecutionState } from "./types.ts";

export function formatUsdc(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value !== 0 && Math.abs(value) < 0.000001)
    return value < 0 ? ">−0.000001" : "<0.000001";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
    useGrouping: false,
  });
}

const CHAINS: Record<number, { label: string; explorer: string }> = {
  5042: { label: "Arc", explorer: "https://explorer.arc.io" },
  5042002: { label: "Arc Testnet", explorer: "https://testnet.arcscan.app" },
  8453: { label: "Base", explorer: "https://basescan.org" },
  84532: { label: "Base Sepolia", explorer: "https://sepolia.basescan.org" },
  1: { label: "Ethereum", explorer: "https://etherscan.io" },
  11155111: {
    label: "Ethereum Sepolia",
    explorer: "https://sepolia.etherscan.io",
  },
  42161: { label: "Arbitrum", explorer: "https://arbiscan.io" },
  137: { label: "Polygon", explorer: "https://polygonscan.com" },
  10: { label: "Optimism", explorer: "https://optimistic.etherscan.io" },
};
export function chainIdOf(
  network: string | number | null | undefined,
): number | null {
  if (typeof network === "number")
    return Number.isSafeInteger(network) && network > 0 ? network : null;
  if (!network || !/^eip155:\d+$/.test(network)) return null;
  const id = Number(network.slice(7));
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
export function chainLabel(
  network: string | number | null | undefined,
): string {
  const id = chainIdOf(network);
  return id ? (CHAINS[id]?.label ?? `Chain ${id}`) : "Network not recorded";
}
export function transactionUrl(
  network: string | number | null | undefined,
  hash: string | null | undefined,
): string | null {
  const id = chainIdOf(network);
  return id && CHAINS[id] && hash && /^0x[0-9a-f]{64}$/i.test(hash)
    ? `${CHAINS[id].explorer}/tx/${hash}`
    : null;
}
export function executionNetwork(
  exec: Pick<PublicExecutionView, "rail" | "x402">,
) {
  // The deployed ERC-8183 rail is Arc Testnet. x402 always carries its own network.
  return exec.rail === "erc8183"
    ? "eip155:5042002"
    : (exec.x402?.network ?? null);
}
export const executionLabels: Record<ExecutionState, string> = {
  DRAFT: "Draft",
  PREPARED: "Ready for approval",
  AUTHORIZED: "Authorized",
  EXECUTING: "Calling service",
  WAITING_FOR_PROVIDER: "Waiting for delivery",
  SUBMITTED: "Delivered · awaiting evaluation",
  EVALUATING: "Checking delivery",
  SETTLING: "Payment in progress",
  SETTLEMENT_UNVERIFIED: "Payment confirmation pending",
  EVIDENCE_PENDING: "Evidence pending",
  COMPLETED_UNPROVEN: "Finished · proof pending",
  SETTLED_SERVICE_FAILED: "Payment recorded · delivery failed",
  COMPLETED: "Completed",
  REJECTED: "Not authorized",
  EXPIRED: "Expired",
  CANCELLED: "Cancelled",
  FAILED: "Execution failed",
  SETTLEMENT_FAILED: "Payment failed",
  EVALUATION_REJECTED: "Delivery rejected",
};
export const filters = [
  "All",
  "Settled",
  "Waiting",
  "In flight",
  "Failed / refused",
] as const;
export type ExecutionFilter = (typeof filters)[number];
export function matchesExecutionFilter(
  exec: Pick<
    PublicExecutionView,
    "state" | "actualSettledAmountUsdc" | "settlementProof"
  >,
  filter: ExecutionFilter,
) {
  if (filter === "All") return true;
  if (filter === "Settled")
    return (
      exec.actualSettledAmountUsdc > 0 &&
      exec.settlementProof !== "presumed_spent"
    );
  if (filter === "Waiting")
    return [
      "DRAFT",
      "PREPARED",
      "WAITING_FOR_PROVIDER",
      "EVIDENCE_PENDING",
      "SETTLEMENT_UNVERIFIED",
      "COMPLETED_UNPROVEN",
    ].includes(exec.state);
  if (filter === "In flight")
    return [
      "AUTHORIZED",
      "EXECUTING",
      "SUBMITTED",
      "EVALUATING",
      "SETTLING",
    ].includes(exec.state);
  return [
    "REJECTED",
    "EXPIRED",
    "CANCELLED",
    "FAILED",
    "SETTLEMENT_FAILED",
    "EVALUATION_REJECTED",
    "SETTLED_SERVICE_FAILED",
  ].includes(exec.state);
}
export function proofLabel(proof: string | null | undefined): string {
  switch (proof) {
    case "presumed_spent":
      return "Reserved as spent · confirmation unavailable";
    case "seller_reported":
      return "Reported by seller · not confirmed onchain";
    case "facilitator_accepted":
      return "Accepted by facilitator · batch pending";
    case "onchain_final":
      return "Confirmed onchain";
    default:
      return "Confirmation level not recorded";
  }
}

export function paymentSummary(
  exec: Pick<
    PublicExecutionView,
    "state" | "actualSettledAmountUsdc" | "settlementProof"
  >,
) {
  if (exec.settlementProof === "presumed_spent")
    return "Spend uncertain · budget reserved";
  if (exec.actualSettledAmountUsdc > 0) return proofLabel(exec.settlementProof);
  if (
    ["SETTLEMENT_UNVERIFIED", "EVIDENCE_PENDING", "SETTLING"].includes(
      exec.state,
    )
  )
    return "Payment confirmation pending";
  return "No spend recorded";
}
