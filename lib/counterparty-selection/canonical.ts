import { keccak256, toBytes, type Hex } from "viem";
import type {
  CandidateInput,
  CounterpartySelectionRequest,
  SelectionCanonicalPayload,
} from "./types.ts";
import { COUNTERPARTY_NETWORK } from "./types.ts";

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortValue(item)]),
  );
}

export function canonicalJson(value: unknown) {
  return JSON.stringify(sortValue(value));
}

export function hashCanonical(value: unknown): Hex {
  return keccak256(toBytes(canonicalJson(value)));
}

export function normalizeCapability(value: unknown) {
  if (typeof value !== "string") throw new Error("capability_invalid");
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!/^[a-z0-9][a-z0-9_:-]{1,79}$/.test(normalized)) throw new Error("capability_invalid");
  return normalized;
}

export function normalizeNetwork(value: unknown) {
  const normalized = String(value || COUNTERPARTY_NETWORK).trim().toLowerCase();
  if (!["arc-testnet", "arc_testnet", "eip155:5042002"].includes(normalized)) {
    throw new Error("network_unsupported");
  }
  return COUNTERPARTY_NETWORK;
}

export function canonicalCandidateInput(input: CandidateInput) {
  return {
    agentId: input.agentId?.trim() || null,
    wallet: input.wallet?.trim().toLowerCase() || null,
    serviceId: input.serviceId?.trim() || null,
  };
}

export function canonicalSelectionRequest(input: CounterpartySelectionRequest) {
  const candidates = input.candidates
    .map(canonicalCandidateInput)
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  return {
    capability: normalizeCapability(input.capability),
    taskHash: hashCanonical({ task: input.task?.trim() || "" }),
    budgetUsdc: Number(input.budgetUsdc).toFixed(6),
    network: normalizeNetwork(input.network),
    requireExactCapability: Boolean(input.requireExactCapability),
    visibility: input.visibility === "public" ? "public" : "private",
    candidates,
  };
}

export function selectionRequestHash(input: CounterpartySelectionRequest) {
  return hashCanonical(canonicalSelectionRequest(input));
}

export function selectionCanonicalHash(payload: SelectionCanonicalPayload) {
  return hashCanonical(payload);
}

export function idempotencyKeyHash(tenantKey: string, key: string) {
  return hashCanonical({ tenantKey, key });
}
