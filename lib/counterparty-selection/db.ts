import { getByoaClient } from "../byoa/service.ts";
import { trustDecisionToRow } from "../trust-gate/db.ts";
import type { TrustDecision } from "../trust-gate/types.ts";
import type {
  CounterpartySelection,
  SelectionCandidate,
  SelectionClearance,
  SelectionProof,
  SelectionTenant,
} from "./types.ts";

type SelectionRow = {
  selection_id: string;
  public_id: string;
  tenant_key: string;
  request_hash: string;
  selection_payload: CounterpartySelection;
  is_public: boolean;
};

type ProofRow = {
  proof_tx: `0x${string}`;
  block_number: string | number;
  proof_status: "verified";
  evidence_source: "erc8183_job";
  evidence_source_id: string;
  evidence_amount_usdc: string | number;
  evidence_tx: `0x${string}`;
};

type ClearanceRow = {
  clearance_id: string;
  decision_id: string;
  clearance_digest: `0x${string}`;
  selection_hash: `0x${string}`;
  clearance_message: Record<string, string>;
  signature: `0x${string}`;
  issued_at: string;
  expires_at: string;
};

export class CounterpartyStorageError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "CounterpartyStorageError";
  }
}

function candidateRow(selectionId: string, candidate: SelectionCandidate, createdAt: string) {
  return {
    selection_id: selectionId,
    candidate_agent_id: candidate.identity?.agentId ?? "",
    candidate_wallet: candidate.identity?.ownerAddress ?? "",
    candidate_service_id: candidate.serviceId ?? "",
    eligibility_status: candidate.eligibility,
    trust_decision: candidate.trustDecision,
    trust_decision_id: candidate.trustDecisionId ?? "",
    trust_score: candidate.trustScore,
    ranking_score: candidate.rankingScore,
    confidence: candidate.confidence,
    recommended_max_exposure_usdc: candidate.recommendedMaxExposureUsdc,
    rank: candidate.rank,
    capability_match: candidate.capabilityMatch,
    price_kind: candidate.priceKind,
    evidence_hash: candidate.evidenceHash,
    rejection_reason: candidate.rejectionReason ?? "",
    candidate_payload: candidate,
    created_at: createdAt,
  };
}

async function attachProof(selection: CounterpartySelection) {
  const { data, error } = await getByoaClient()
    .from("counterparty_selection_proofs")
    .select("proof_tx,block_number,proof_status,evidence_source,evidence_source_id,evidence_amount_usdc,evidence_tx")
    .eq("selection_id", selection.selectionId)
    .maybeSingle();
  if (error) throw new CounterpartyStorageError("selection_storage_unavailable");
  if (!data) return selection;
  const proof = data as ProofRow;
  return {
    ...selection,
    proof: {
      proofTx: proof.proof_tx,
      blockNumber: Number(proof.block_number),
      proofStatus: proof.proof_status,
      evidenceSource: proof.evidence_source,
      evidenceSourceId: proof.evidence_source_id,
      evidenceAmountUsdc: Number(proof.evidence_amount_usdc),
      evidenceTx: proof.evidence_tx,
    } satisfies SelectionProof,
  };
}

export async function findIdempotentSelection(
  tenantKey: string,
  idempotencyKeyHash: string,
) {
  const { data, error } = await getByoaClient()
    .from("counterparty_selections")
    .select("selection_id,public_id,tenant_key,request_hash,selection_payload,is_public")
    .eq("tenant_key", tenantKey)
    .eq("idempotency_key_hash", idempotencyKeyHash)
    .maybeSingle();
  if (error) throw new CounterpartyStorageError("selection_storage_unavailable");
  if (!data) return null;
  const row = data as SelectionRow;
  return { requestHash: row.request_hash, selection: await attachProof(row.selection_payload) };
}

export async function saveCounterpartySelection(input: {
  selection: CounterpartySelection;
  tenant: SelectionTenant;
  requestHash: string;
  idempotencyKeyHash: string;
  decisions: TrustDecision[];
}) {
  const winner = input.selection.candidates.find(
    (candidate) => candidate.identity?.agentId === input.selection.recommendedAgentId,
  );
  const row = {
    selection_id: input.selection.selectionId,
    public_id: input.selection.publicId,
    tenant_key: input.tenant.tenantKey,
    requester_agent_id: input.tenant.requesterAgentId ?? "",
    requester_wallet: input.tenant.requesterWallet,
    machine_credential_id: input.tenant.machineCredentialId ?? "",
    capability: input.selection.capability,
    task_hash: input.selection.taskHash,
    requested_budget_usdc: input.selection.requestedBudgetUsdc,
    network: input.selection.network,
    require_exact_capability: input.selection.requireExactCapability,
    policy_version: input.selection.policyVersion,
    ranking_version: input.selection.rankingVersion,
    recommended_agent_id: input.selection.recommendedAgentId,
    recommended_wallet: input.selection.recommendedWallet,
    recommended_service_id: input.selection.recommendedServiceId ?? "",
    decision: input.selection.decision,
    recommended_max_exposure_usdc: input.selection.recommendedMaxExposureUsdc,
    ranking_score: input.selection.rankingScore,
    trust_score: input.selection.trustScore,
    confidence: input.selection.confidence,
    candidate_count: input.selection.candidates.length,
    canonical_hash: input.selection.canonicalHash,
    request_hash: input.requestHash,
    idempotency_key_hash: input.idempotencyKeyHash,
    selection_payload: input.selection,
    is_public: input.selection.visibility === "public",
    created_at: input.selection.createdAt,
    expires_at: input.selection.expiresAt,
  };
  if (!winner?.identity) throw new CounterpartyStorageError("selection_winner_mismatch");
  const { error } = await getByoaClient().rpc("create_counterparty_selection", {
    p_selection: row,
    p_candidates: input.selection.candidates.map((candidate) =>
      candidateRow(input.selection.selectionId, candidate, input.selection.createdAt)),
    p_decisions: input.decisions.map(trustDecisionToRow),
  });
  if (error) throw new CounterpartyStorageError(
    error.code === "23505" ? "selection_idempotency_race" : "selection_storage_unavailable",
  );
  const reloaded = await fetchCounterpartySelection(input.selection.selectionId, input.tenant);
  if (!reloaded || reloaded.canonicalHash.toLowerCase() !== input.selection.canonicalHash.toLowerCase()) {
    throw new CounterpartyStorageError("selection_storage_mismatch");
  }
  return reloaded;
}

export async function fetchCounterpartySelection(
  selectionId: string,
  tenant: SelectionTenant,
) {
  const { data, error } = await getByoaClient()
    .from("counterparty_selections")
    .select("selection_id,public_id,tenant_key,request_hash,selection_payload,is_public")
    .eq("selection_id", selectionId)
    .eq("tenant_key", tenant.tenantKey)
    .maybeSingle();
  if (error) throw new CounterpartyStorageError("selection_storage_unavailable");
  return data ? attachProof((data as SelectionRow).selection_payload) : null;
}

export async function fetchPublicCounterpartySelection(publicId: string) {
  const { data, error } = await getByoaClient()
    .from("counterparty_selections")
    .select("selection_payload")
    .eq("public_id", publicId)
    .eq("is_public", true)
    .maybeSingle();
  if (error) throw new CounterpartyStorageError("selection_storage_unavailable");
  return data ? attachProof(data.selection_payload as CounterpartySelection) : null;
}

export async function fetchSelectionClearance(selectionId: string) {
  const { data, error } = await getByoaClient()
    .from("counterparty_selection_clearances")
    .select("clearance_id,decision_id,clearance_digest,selection_hash,clearance_message,signature,issued_at,expires_at")
    .eq("selection_id", selectionId)
    .maybeSingle();
  if (error) throw new CounterpartyStorageError("selection_storage_unavailable");
  if (!data) return null;
  const row = data as ClearanceRow;
  return {
    clearanceId: row.clearance_id,
    decisionId: row.decision_id,
    clearanceDigest: row.clearance_digest,
    selectionHash: row.selection_hash,
    clearance: row.clearance_message,
    signature: row.signature,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
  } satisfies SelectionClearance;
}

export async function saveSelectionClearance(input: {
  selectionId: string;
  decision: TrustDecision;
  clearance: SelectionClearance;
}) {
  const { error } = await getByoaClient().rpc("create_counterparty_selection_clearance", {
    p_decision: trustDecisionToRow(input.decision),
    p_clearance: {
      clearance_id: input.clearance.clearanceId,
      selection_id: input.selectionId,
      decision_id: input.clearance.decisionId,
      clearance_digest: input.clearance.clearanceDigest,
      selection_hash: input.clearance.selectionHash,
      subject_wallet: input.decision.subject.wallet,
      executor_wallet: input.decision.request.executor,
      counterparty_wallet: input.decision.request.counterparty,
      max_amount_usdc: input.decision.policy.maxValueUsdc,
      clearance_message: input.clearance.clearance,
      signature: input.clearance.signature,
      issued_at: input.clearance.issuedAt,
      expires_at: input.clearance.expiresAt,
    },
  });
  if (error) throw new CounterpartyStorageError("selection_clearance_storage_unavailable");
  const reloaded = await fetchSelectionClearance(input.selectionId);
  if (!reloaded || reloaded.clearanceDigest.toLowerCase() !== input.clearance.clearanceDigest.toLowerCase()) {
    throw new CounterpartyStorageError("selection_clearance_storage_mismatch");
  }
  return reloaded;
}

export async function saveSelectionProof(input: {
  selectionId: string;
  canonicalHash: string;
  proof: SelectionProof;
}) {
  const { error } = await getByoaClient().from("counterparty_selection_proofs").insert({
    selection_id: input.selectionId,
    canonical_hash: input.canonicalHash,
    proof_tx: input.proof.proofTx,
    block_number: input.proof.blockNumber,
    proof_status: input.proof.proofStatus,
    evidence_source: input.proof.evidenceSource,
    evidence_source_id: input.proof.evidenceSourceId,
    evidence_amount_usdc: input.proof.evidenceAmountUsdc,
    evidence_tx: input.proof.evidenceTx,
  });
  if (error && error.code !== "23505") {
    throw new CounterpartyStorageError("selection_proof_storage_unavailable");
  }
  const selection = await getByoaClient()
    .from("counterparty_selection_proofs")
    .select("proof_tx,block_number,proof_status,evidence_source,evidence_source_id,evidence_amount_usdc,evidence_tx")
    .eq("selection_id", input.selectionId)
    .single();
  if (selection.error || !selection.data) throw new CounterpartyStorageError("selection_proof_storage_mismatch");
  return {
    proofTx: selection.data.proof_tx as `0x${string}`,
    blockNumber: Number(selection.data.block_number),
    proofStatus: selection.data.proof_status as "verified",
    evidenceSource: selection.data.evidence_source as "erc8183_job",
    evidenceSourceId: selection.data.evidence_source_id as string,
    evidenceAmountUsdc: Number(selection.data.evidence_amount_usdc),
    evidenceTx: selection.data.evidence_tx as `0x${string}`,
  } satisfies SelectionProof;
}
