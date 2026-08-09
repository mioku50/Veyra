import { randomBytes } from "node:crypto";
import { getAddress, isAddress, isHex, type Hex } from "viem";
import { rejectHostedWorkflowSecrets } from "../agent/hosted-workflows.ts";
import { getByoaClient } from "../byoa/service.ts";
import { proofRegistryAbi } from "../commerce/onchain-proof.ts";
import {
  ARC_ERC8004_IDENTITY_REGISTRY,
  getArcPublicClient,
  getCanonicalAgentIdentity,
} from "../erc8004/client.ts";
import type { Erc8004AgentIdentityRecord } from "../erc8004/types.ts";
import {
  fetchLatestReputationSnapshot,
  fetchReputationEvidenceForAgent,
} from "../reputation/db.ts";
import type { ReputationEvidence, ReputationSnapshot } from "../reputation/types.ts";
import { sellerWorkflowType } from "../seller/marketplace.ts";
import { computeCanonicalDecisionHash } from "../trust-gate/canonical.ts";
import { evaluateTrustDecision } from "../trust-gate/decision.ts";
import { buildClearanceMessage, signTrustClearance } from "../trust-gate/sign.ts";
import type { TrustDecision } from "../trust-gate/types.ts";
import { TRUST_POLICY_VERSION } from "../trust-gate/types.ts";
import { verifyTrustClearanceOnchain } from "../trust-gate/verify.ts";
import { readArcUsdcBlocklistStatus } from "../wallet/arc-usdc.ts";
import {
  canonicalCandidateInput,
  canonicalSelectionRequest,
  hashCanonical,
  idempotencyKeyHash,
  normalizeCapability,
  normalizeNetwork,
  selectionCanonicalHash,
  selectionRequestHash,
} from "./canonical.ts";
import {
  fetchCounterpartySelection,
  fetchSelectionClearance,
  findIdempotentSelection,
  saveCounterpartySelection,
  saveSelectionClearance,
} from "./db.ts";
import { rankCounterparties } from "./engine.ts";
import {
  capabilityMatchFor,
  COUNTERPARTY_SELECTION_POLICY,
  freshnessFromAge,
} from "./policy.ts";
import {
  COUNTERPARTY_COMPLIANCE_POLICY,
  COUNTERPARTY_NETWORK,
  COUNTERPARTY_RANKING_VERSION,
  type CandidateEvidence,
  type CandidateInput,
  type CandidateRankingInput,
  type CandidateService,
  type CanonicalCandidateIdentity,
  type CounterpartyDiscoveryRequest,
  type CounterpartySelection,
  type CounterpartySelectionRequest,
  type SelectionCandidate,
  type SelectionCanonicalPayload,
  type SelectionClearance,
  type SelectionTenant,
  type UnresolvedCandidate,
} from "./types.ts";

type ServiceRow = {
  public_id: string;
  slug: string;
  category: string;
  status: string;
  review_status: string | null;
  availability_status: string | null;
  seller_wallet: string;
  price_usdc: string | number;
};

export class CounterpartySelectionError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 400,
    public readonly details?: unknown,
  ) {
    super(code);
    this.name = "CounterpartySelectionError";
  }
}

function numeric(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function confidencePercent(snapshot: ReputationSnapshot) {
  return COUNTERPARTY_SELECTION_POLICY.confidenceLabels[snapshot.confidence];
}

function sourceSummary(
  source: CandidateEvidence["sources"][number]["source"],
  evidence: ReputationEvidence[],
  nowMs: number,
) {
  const observed = evidence
    .map((item) => Date.parse(item.observedAt))
    .filter(Number.isFinite)
    .sort((left, right) => right - left)[0];
  const ageSeconds = observed === undefined ? null : Math.max(0, (nowMs - observed) / 1000);
  return {
    source,
    observedAt: observed === undefined ? null : new Date(observed).toISOString(),
    ageSeconds,
    freshness: freshnessFromAge(ageSeconds),
    evidenceCount: evidence.length,
  };
}

function serviceCapabilities(service: ServiceRow) {
  return [
    sellerWorkflowType(service.slug),
    service.slug.replace(/-/g, "_"),
    service.category.trim().toLowerCase().replace(/[\s-]+/g, "_"),
  ];
}

function toCandidateService(service: ServiceRow, capability: string): CandidateService {
  return {
    serviceId: service.public_id,
    workflowType: sellerWorkflowType(service.slug),
    slug: service.slug,
    category: service.category,
    status: service.status,
    reviewStatus: service.review_status || "unknown",
    availabilityStatus: service.availability_status || "unknown",
    advertisedPriceUsdc: numeric(service.price_usdc),
    sellerWallet: getAddress(service.seller_wallet),
    capabilityMatch: capabilityMatchFor(capability, serviceCapabilities(service)),
  };
}

async function servicesForWallet(wallet: string) {
  const { data, error } = await getByoaClient()
    .from("store_services")
    .select("public_id,slug,category,status,review_status,availability_status,seller_wallet,price_usdc")
    .ilike("seller_wallet", wallet);
  if (error) throw new CounterpartySelectionError("candidate_registry_unavailable", 503);
  return (data || []) as ServiceRow[];
}

async function serviceByPublicId(serviceId: string) {
  const { data, error } = await getByoaClient()
    .from("store_services")
    .select("public_id,slug,category,status,review_status,availability_status,seller_wallet,price_usdc")
    .eq("public_id", serviceId)
    .maybeSingle();
  if (error) throw new CounterpartySelectionError("candidate_registry_unavailable", 503);
  return data ? data as ServiceRow : null;
}

async function identityIdForWallet(wallet: string) {
  const { data, error } = await getByoaClient()
    .from("erc8004_agent_identity")
    .select("agent_id")
    .ilike("owner_address", wallet)
    .limit(2);
  if (error) throw new CounterpartySelectionError("candidate_registry_unavailable", 503);
  if (!data || data.length !== 1) return null;
  return String(data[0].agent_id);
}

async function resolveCandidateIdentity(
  candidate: CandidateInput,
  capability: string,
): Promise<{
  identity: CanonicalCandidateIdentity | null;
  services: CandidateService[];
  selectedService?: CandidateService;
  rejectionReason?: string;
}> {
  const keys = Object.keys(candidate);
  if (keys.length === 0 || keys.some((key) => !["agentId", "wallet", "serviceId"].includes(key))) {
    return { identity: null, services: [], rejectionReason: "candidate_input_invalid" };
  }
  let service: ServiceRow | null = null;
  if (candidate.serviceId) {
    service = await serviceByPublicId(candidate.serviceId.trim());
    if (!service) return { identity: null, services: [], rejectionReason: "service_not_found" };
  }
  const suppliedWallet = candidate.wallet?.trim();
  if (suppliedWallet && !isAddress(suppliedWallet)) {
    return { identity: null, services: [], rejectionReason: "wallet_invalid" };
  }
  if (
    service
    && suppliedWallet
    && service.seller_wallet.toLowerCase() !== suppliedWallet.toLowerCase()
  ) {
    return { identity: null, services: [], rejectionReason: "candidate_identifier_mismatch" };
  }

  const lookupWallet = service?.seller_wallet || suppliedWallet;
  const agentId = candidate.agentId?.trim() || (lookupWallet ? await identityIdForWallet(lookupWallet) : null);
  if (!agentId || !/^\d+$/.test(agentId)) {
    return { identity: null, services: [], rejectionReason: "identity_not_found" };
  }

  let record: Erc8004AgentIdentityRecord | null;
  try {
    record = await getCanonicalAgentIdentity(agentId);
  } catch {
    return { identity: null, services: [], rejectionReason: "identity_verification_failed" };
  }
  if (!record) return { identity: null, services: [], rejectionReason: "identity_not_found" };
  if (lookupWallet && record.owner_address.toLowerCase() !== lookupWallet.toLowerCase()) {
    return { identity: null, services: [], rejectionReason: "candidate_identifier_mismatch" };
  }
  const rawServices = await servicesForWallet(record.owner_address);
  const services = rawServices.map((row) => toCandidateService(row, capability));
  const selectedService = service
    ? services.find((item) => item.serviceId === service!.public_id)
    : [...services].sort((left, right) => {
        const matchOrder = { exact: 0, related: 1, generic: 2, none: 3 } as const;
        return matchOrder[left.capabilityMatch] - matchOrder[right.capabilityMatch]
          || left.advertisedPriceUsdc - right.advertisedPriceUsdc
          || left.serviceId.localeCompare(right.serviceId);
      })[0];
  return {
    identity: {
      agentId: record.agent_id,
      ownerAddress: getAddress(record.owner_address),
      registryAddress: getAddress(record.registry_address),
      metadataUri: record.metadata_uri,
      serviceIds: services.map((item) => item.serviceId).sort(),
      source: service ? "seller_registry" : "erc8004",
      verifiedOnchain: true,
    },
    services,
    selectedService,
  };
}

async function snapshotProofValid(snapshot: ReputationSnapshot) {
  if (
    !isHex(snapshot.canonicalHash)
    || snapshot.canonicalHash.length !== 66
    || /^0x0{64}$/i.test(snapshot.canonicalHash)
    || !snapshot.arcProofTx
    || !/^0x[0-9a-f]{64}$/i.test(snapshot.arcProofTx)
  ) return false;
  const registry = process.env.AGENT_COMMERCE_PROOF_REGISTRY_ADDRESS;
  if (!registry || !isAddress(registry)) return false;
  try {
    const client = getArcPublicClient();
    const [registered, proof, receipt] = await Promise.all([
      client.readContract({
        address: registry,
        abi: proofRegistryAbi,
        functionName: "isRegistered",
        args: [snapshot.canonicalHash as Hex],
      }),
      client.readContract({
        address: registry,
        abi: proofRegistryAbi,
        functionName: "getProof",
        args: [snapshot.canonicalHash as Hex],
      }),
      client.getTransactionReceipt({ hash: snapshot.arcProofTx as Hex }),
    ]);
    return registered
      && proof[5].toLowerCase() === snapshot.canonicalHash.toLowerCase()
      && receipt.status === "success";
  } catch {
    return false;
  }
}

async function buildEvidence(
  identity: CanonicalCandidateIdentity,
  services: CandidateService[],
  selectedService: CandidateService | undefined,
  nowMs: number,
) {
  const [snapshot, evidence] = await Promise.all([
    fetchLatestReputationSnapshot(identity.agentId),
    fetchReputationEvidenceForAgent(identity.agentId),
  ]);
  if (!snapshot) return { evidence: null, rejectionReason: "reputation_snapshot_missing" } as const;
  if (!await snapshotProofValid(snapshot)) {
    return { evidence: null, rejectionReason: "canonical_proof_invalid" } as const;
  }
  const byTypes = (types: ReputationEvidence["type"][]) =>
    evidence.filter((item) => types.includes(item.type));
  const executionCandidates = byTypes(["erc8183_job_completed", "erc8183_job_rejected"]);
  if (executionCandidates.some((item) => item.type === "erc8183_job_completed" && !/^\d+$/.test(item.sourceId))) {
    return { evidence: null, rejectionReason: "candidate_evidence_identity_mismatch" } as const;
  }
  const completedJobIds = Array.from(new Set(
    executionCandidates
      .filter((item) => item.type === "erc8183_job_completed" && /^\d+$/.test(item.sourceId))
      .map((item) => item.sourceId),
  ));
  let validCompletedJobIds = new Set<string>();
  if (completedJobIds.length > 0) {
    const evaluations = await getByoaClient()
      .from("erc8183_evaluations")
      .select("job_id,provider_wallet,status,decision,settlement_tx_hash")
      .in("job_id", completedJobIds);
    if (evaluations.error) throw new CounterpartySelectionError("candidate_evidence_unavailable", 503);
    validCompletedJobIds = new Set((evaluations.data || [])
      .filter((row) =>
        row.status === "completed"
        && row.decision === "complete"
        && row.provider_wallet?.toLowerCase() === identity.ownerAddress.toLowerCase()
        && /^0x[0-9a-f]{64}$/i.test(row.settlement_tx_hash || ""))
      .map((row) => String(row.job_id)));
    if (executionCandidates.some((item) =>
      item.type === "erc8183_job_completed"
      && (!validCompletedJobIds.has(item.sourceId) || !item.verifiedOnchain || !item.arcProofVerified))) {
      return { evidence: null, rejectionReason: "candidate_evidence_identity_mismatch" } as const;
    }
  }
  const execution = executionCandidates.filter((item) =>
    item.type === "erc8183_job_rejected" || validCompletedJobIds.has(item.sourceId));
  const evaluator = byTypes(["erc8183_evaluation", "erc8004_validation"]);
  const x402Candidates = byTypes(["x402_payment_success", "x402_payment_failure"]);
  const x402Ids = Array.from(new Set(x402Candidates.map((item) => item.sourceId).filter(Boolean)));
  let validX402Ids = new Set<string>();
  if (x402Ids.length > 0) {
    const payments = await getByoaClient()
      .from("payment_events")
      .select("id,onchain_seller,onchain_status,amount_usdc")
      .in("id", x402Ids);
    if (payments.error) throw new CounterpartySelectionError("candidate_evidence_unavailable", 503);
    validX402Ids = new Set((payments.data || [])
      .filter((row) =>
        row.onchain_status === "verified"
        && row.onchain_seller?.toLowerCase() === identity.ownerAddress.toLowerCase()
        && numeric(row.amount_usdc) > 0)
      .map((row) => String(row.id)));
    if (x402Candidates.some((item) => item.type === "x402_payment_success" && !validX402Ids.has(item.sourceId))) {
      return { evidence: null, rejectionReason: "candidate_evidence_identity_mismatch" } as const;
    }
  }
  const economic = [
    ...execution.filter((item) => item.type === "erc8183_job_completed"),
    ...x402Candidates.filter((item) => validX402Ids.has(item.sourceId)),
  ].filter((item) => numeric(item.economicValueUsdc) > 0);
  const serviceQualityCandidates = byTypes(["api_quality"]);
  const healthIds = serviceQualityCandidates
    .map((item) => item.sourceId.match(/^seller_health:([0-9a-f-]{36})$/i)?.[1])
    .filter((value): value is string => Boolean(value));
  const observationIds = serviceQualityCandidates
    .map((item) => item.sourceId)
    .filter((value) => /^[0-9a-f-]{36}$/i.test(value));
  const [ownedServices, healthChecks, observations] = await Promise.all([
    getByoaClient().from("store_services").select("id,public_id").ilike("seller_wallet", identity.ownerAddress),
    healthIds.length > 0
      ? getByoaClient().from("seller_service_health_checks").select("id,service_id").in("id", healthIds)
      : Promise.resolve({ data: [], error: null }),
    observationIds.length > 0
      ? getByoaClient().from("api_quality_observations").select("observation_id,service_id").in("observation_id", observationIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (ownedServices.error || healthChecks.error || observations.error) {
    throw new CounterpartySelectionError("candidate_evidence_unavailable", 503);
  }
  const ownedInternalIds = new Set((ownedServices.data || []).map((row) => String(row.id)));
  const ownedPublicIds = new Set((ownedServices.data || []).map((row) => String(row.public_id)));
  const validServiceQualityIds = new Set<string>([
    ...(healthChecks.data || [])
      .filter((row) => ownedInternalIds.has(String(row.service_id)))
      .map((row) => `seller_health:${row.id}`),
    ...(observations.data || [])
      .filter((row) => ownedPublicIds.has(String(row.service_id)))
      .map((row) => String(row.observation_id)),
  ]);
  if (serviceQualityCandidates.some((item) => !validServiceQualityIds.has(item.sourceId))) {
    return { evidence: null, rejectionReason: "candidate_evidence_identity_mismatch" } as const;
  }
  const serviceQuality = serviceQualityCandidates.filter((item) => validServiceQualityIds.has(item.sourceId));
  const counterparties = new Set(
    evidence.map((item) => item.counterpartyAddress?.toLowerCase()).filter(Boolean),
  );
  const sources: CandidateEvidence["sources"] = [
    sourceSummary("identity", [], nowMs),
    sourceSummary("reputation", evidence, nowMs),
    sourceSummary("execution", execution, nowMs),
    sourceSummary("economic", economic, nowMs),
    sourceSummary("service_quality", serviceQuality, nowMs),
    sourceSummary("evaluator", evaluator, nowMs),
    sourceSummary("risk", evidence.filter((item) => !item.positive), nowMs),
  ];
  sources[0] = {
    source: "identity",
    observedAt: snapshot.createdAt,
    ageSeconds: Math.max(0, (nowMs - Date.parse(snapshot.createdAt)) / 1000),
    freshness: freshnessFromAge(Math.max(0, (nowMs - Date.parse(snapshot.createdAt)) / 1000)),
    evidenceCount: 1,
  };
  const payload = {
    identity: {
      agentId: identity.agentId,
      ownerAddress: identity.ownerAddress.toLowerCase(),
      registryAddress: identity.registryAddress.toLowerCase(),
      metadataUri: identity.metadataUri,
    },
    snapshotHash: snapshot.canonicalHash,
    evidenceHashes: evidence.map((item) => item.canonicalHash).sort(),
    services: services.map((item) => ({
      serviceId: item.serviceId,
      status: item.status,
      reviewStatus: item.reviewStatus,
      availabilityStatus: item.availabilityStatus,
      advertisedPriceUsdc: item.advertisedPriceUsdc,
    })).sort((left, right) => left.serviceId.localeCompare(right.serviceId)),
  };
  const result: CandidateEvidence = {
    identity,
    snapshotHash: snapshot.canonicalHash as Hex,
    snapshotCreatedAt: snapshot.createdAt,
    trustScore: snapshot.trustScore,
    snapshotConfidence: confidencePercent(snapshot),
    snapshotCoverage: snapshot.coverage > 1 ? snapshot.coverage / 100 : snapshot.coverage,
    dimensions: {
      reputationQuality: snapshot.trustScore,
      executionReliability: snapshot.dimensions.execution,
      evaluatorSuccess: snapshot.dimensions.validation,
      economicReliability: snapshot.dimensions.economicReliability,
      serviceQuality: snapshot.dimensions.serviceQuality,
    },
    evidenceCounts: {
      total: evidence.length,
      execution: execution.length,
      evaluator: evaluator.length,
      economic: economic.length,
      serviceQuality: serviceQuality.length,
      independentCounterparties: counterparties.size,
    },
    sources,
    riskSignals: Array.from(new Set([
      ...snapshot.riskSignals,
      ...evidence.filter((item) => !item.positive).map((item) => item.reason || item.type),
    ])),
    positiveSignals: snapshot.topPositiveEvidence,
    services,
    selectedService,
    evidenceHash: hashCanonical(payload),
  };
  return { evidence: result, rejectionReason: undefined } as const;
}

function rejectedCandidate(input: {
  candidate: CandidateInput;
  identity?: CanonicalCandidateIdentity | null;
  budgetUsdc: number;
  reason: string;
  trustDecision?: TrustDecision;
  rank: number;
}): UnresolvedCandidate {
  const evidenceHash = hashCanonical({
    candidate: canonicalCandidateInput(input.candidate),
    identity: input.identity ? {
      agentId: input.identity.agentId,
      ownerAddress: input.identity.ownerAddress.toLowerCase(),
    } : null,
    unavailableEvidence: input.reason,
  });
  return {
    identity: input.identity ?? null,
    candidateInput: canonicalCandidateInput(input.candidate) as CandidateInput,
    serviceId: input.candidate.serviceId,
    capabilityMatch: "none",
    eligibility: "INELIGIBLE",
    trustDecision: "DENY",
    trustDecisionId: input.trustDecision?.decisionId,
    trustDecisionHash: input.trustDecision?.canonicalHash as Hex || hashCanonical({ reason: input.reason }),
    trustScore: 0,
    baseQualityScore: 0,
    rankingScore: 0,
    confidence: 0,
    requestedAmountUsdc: input.budgetUsdc,
    policyMaxExposureUsdc: 0,
    recommendedMaxExposureUsdc: 0,
    priceKind: "unknown",
    evidenceHash,
    evidenceCoverage: 0,
    evidenceCount: 0,
    evidenceSources: [],
    refreshSuggested: false,
    refreshableModules: [],
    dimensions: [],
    topReasons: [],
    riskSignals: [input.reason],
    tradeoffs: [],
    rejectionReason: input.reason,
    arcUsdcBlocklistStatus: "unknown",
    rank: input.rank,
  };
}

function selectionCandidateKey(candidate: SelectionCandidate) {
  return hashCanonical(
    "candidateInput" in candidate
      ? candidate.candidateInput
      : { agentId: candidate.identity.agentId, serviceId: candidate.serviceId || null },
  );
}

export function validateSelectionRequest(body: unknown): CounterpartySelectionRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new CounterpartySelectionError("invalid_request");
  }
  const input = body as Record<string, unknown>;
  const allowed = [
    "capability", "task", "budgetUsdc", "candidates", "network",
    "requireExactCapability", "publishProof", "visibility",
  ];
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new CounterpartySelectionError("client_derived_fields_forbidden");
  }
  let capability: string;
  try { capability = normalizeCapability(input.capability); }
  catch { throw new CounterpartySelectionError("capability_invalid"); }
  const budgetUsdc = Number(input.budgetUsdc);
  if (
    !Number.isFinite(budgetUsdc)
    || budgetUsdc <= 0
    || budgetUsdc > COUNTERPARTY_SELECTION_POLICY.maxBudgetUsdc
  ) throw new CounterpartySelectionError("budget_invalid");
  if (!Array.isArray(input.candidates)
    || input.candidates.length < COUNTERPARTY_SELECTION_POLICY.minCandidates
    || input.candidates.length > COUNTERPARTY_SELECTION_POLICY.maxCandidates) {
    throw new CounterpartySelectionError("candidate_count_invalid");
  }
  const task = input.task === undefined ? undefined : String(input.task).trim();
  if (task && task.length > 1_000) throw new CounterpartySelectionError("task_too_large");
  if (task) {
    try { rejectHostedWorkflowSecrets(task); }
    catch { throw new CounterpartySelectionError("sensitive_input_rejected"); }
  }
  if (input.publishProof !== undefined && input.publishProof !== false) {
    throw new CounterpartySelectionError("proof_requires_explicit_action");
  }
  const candidates = input.candidates.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new CounterpartySelectionError("candidate_input_invalid");
    }
    const value = candidate as Record<string, unknown>;
    const keys = Object.keys(value);
    if (keys.length === 0 || keys.some((key) => !["agentId", "wallet", "serviceId"].includes(key))) {
      throw new CounterpartySelectionError("candidate_input_invalid");
    }
    for (const key of keys) {
      if (typeof value[key] !== "string" || !String(value[key]).trim() || String(value[key]).length > 200) {
        throw new CounterpartySelectionError("candidate_input_invalid");
      }
    }
    return value as CandidateInput;
  });
  const candidateKeys = candidates.map((candidate) => JSON.stringify(canonicalCandidateInput(candidate)));
  if (new Set(candidateKeys).size !== candidateKeys.length) {
    throw new CounterpartySelectionError("duplicate_candidate_input");
  }
  let network: typeof COUNTERPARTY_NETWORK;
  try { network = normalizeNetwork(input.network); }
  catch { throw new CounterpartySelectionError("network_unsupported"); }
  return {
    capability,
    task,
    budgetUsdc: Number(budgetUsdc.toFixed(6)),
    candidates,
    network,
    requireExactCapability: Boolean(input.requireExactCapability),
    publishProof: false,
    visibility: input.visibility === "public" ? "public" : "private",
  };
}

export async function discoverCounterparties(input: CounterpartyDiscoveryRequest) {
  const startedAt = Date.now();
  let capability: string;
  let network: typeof COUNTERPARTY_NETWORK;
  try {
    capability = normalizeCapability(input.capability);
    network = normalizeNetwork(input.network);
  } catch (error) {
    throw new CounterpartySelectionError(error instanceof Error ? error.message : "discovery_input_invalid");
  }
  const requestedLimit = input.limit === undefined ? 10 : Number(input.limit);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 10) {
    throw new CounterpartySelectionError("limit_invalid");
  }
  const limit = requestedLimit;
  const maxPrice = input.maxPriceUsdc === undefined ? null : Number(input.maxPriceUsdc);
  if (maxPrice !== null && (!Number.isFinite(maxPrice) || maxPrice <= 0)) {
    throw new CounterpartySelectionError("max_price_invalid");
  }
  const { data, error } = await getByoaClient()
    .from("erc8004_agent_identity")
    .select("agent_id")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new CounterpartySelectionError("candidate_registry_unavailable", 503);
  const candidates = [];
  for (const row of data || []) {
    if (candidates.length >= limit) break;
    const resolved = await resolveCandidateIdentity({ agentId: String(row.agent_id) }, capability);
    if (!resolved.identity) continue;
    const matchingServices = resolved.services.filter((service) =>
      service.capabilityMatch !== "none"
      && ["active", "live"].includes(service.status)
      && (maxPrice === null || service.advertisedPriceUsdc <= maxPrice));
    candidates.push({
      agentId: resolved.identity.agentId,
      ownerAddress: resolved.identity.ownerAddress,
      registryAddress: resolved.identity.registryAddress,
      metadataUri: resolved.identity.metadataUri,
      verifiedOnchain: true,
      services: matchingServices.map((service) => ({
        serviceId: service.serviceId,
        workflowType: service.workflowType,
        category: service.category,
        advertisedPriceUsdc: service.advertisedPriceUsdc,
        priceKind: "advertised" as const,
        capabilityMatch: service.capabilityMatch,
      })),
      source: resolved.identity.source,
    });
  }
  const result = {
    capability,
    network,
    readOnly: true,
    paymentCreated: false,
    jobCreated: false,
    candidates,
  };
  console.info("counterparty_discovery_completed", {
    candidateCount: candidates.length,
    durationMs: Date.now() - startedAt,
  });
  return result;
}

export async function selectCounterparty(input: {
  request: CounterpartySelectionRequest;
  tenant: SelectionTenant;
  idempotencyKey: string;
  baseUrl?: string;
  now?: Date;
}) {
  if (!/^[\x21-\x7e]{8,200}$/.test(input.idempotencyKey)) {
    throw new CounterpartySelectionError("idempotency_key_missing", 400);
  }
  const request = validateSelectionRequest(input.request);
  const requestHash = selectionRequestHash(request);
  const keyHash = idempotencyKeyHash(input.tenant.tenantKey, input.idempotencyKey);
  const replay = await findIdempotentSelection(input.tenant.tenantKey, keyHash);
  if (replay) {
    if (replay.requestHash.toLowerCase() !== requestHash.toLowerCase()) {
      throw new CounterpartySelectionError("idempotency_conflict", 409);
    }
    return { selection: replay.selection, replayed: true };
  }

  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const rankingInputs: CandidateRankingInput[] = [];
  const rejected: UnresolvedCandidate[] = [];
  const decisions: TrustDecision[] = [];
  const seen = new Set<string>();
  for (const candidate of request.candidates) {
    const resolved = await resolveCandidateIdentity(candidate, request.capability);
    if (!resolved.identity) {
      rejected.push(rejectedCandidate({
        candidate,
        budgetUsdc: request.budgetUsdc,
        reason: resolved.rejectionReason || "identity_not_found",
        rank: 0,
      }));
      continue;
    }
    const key = `${resolved.identity.agentId}:${resolved.selectedService?.serviceId || "identity"}`;
    if (seen.has(key)) {
      rejected.push(rejectedCandidate({
        candidate,
        identity: resolved.identity,
        budgetUsdc: request.budgetUsdc,
        reason: "duplicate_candidate",
        rank: 0,
      }));
      continue;
    }
    seen.add(key);
    const built = await buildEvidence(
      resolved.identity,
      resolved.services,
      resolved.selectedService,
      nowMs,
    );
    const decision = await evaluateTrustDecision({
      subjectAgentId: resolved.identity.agentId,
      executorWallet: input.tenant.requesterWallet,
      counterpartyWallet: resolved.identity.ownerAddress,
      action: "service_purchase",
      requestedValueUsdc: request.budgetUsdc,
      serviceId: resolved.selectedService?.serviceId,
      workflowType: request.capability,
    });
    decisions.push(decision);
    if (!built.evidence) {
      rejected.push(rejectedCandidate({
        candidate,
        identity: resolved.identity,
        budgetUsdc: request.budgetUsdc,
        reason: built.rejectionReason,
        trustDecision: decision,
        rank: 0,
      }));
      continue;
    }
    const offered = resolved.services.flatMap((service) => [
      service.workflowType,
      service.slug.replace(/-/g, "_"),
      service.category.trim().toLowerCase().replace(/[\s-]+/g, "_"),
    ]);
    if (offered.length === 0 && built.evidence.evidenceCounts.total > 0) {
      offered.push("generic_agent_service");
    }
    const match = resolved.selectedService?.capabilityMatch
      ?? capabilityMatchFor(request.capability, offered);
    const arcUsdcBlocklistStatus = await readArcUsdcBlocklistStatus(
      resolved.identity.ownerAddress,
      getArcPublicClient(),
    );
    const hardExclusions: string[] = [];
    if (resolved.selectedService) {
      if (!["active", "live"].includes(resolved.selectedService.status)) hardExclusions.push("provider_suspended");
      if (resolved.selectedService.reviewStatus !== "approved") hardExclusions.push("service_not_approved");
      if (!["healthy", "unknown"].includes(resolved.selectedService.availabilityStatus)) hardExclusions.push("service_unavailable");
    }
    rankingInputs.push({
      identity: resolved.identity,
      evidence: built.evidence,
      trustDecision: decision,
      requestedBudgetUsdc: request.budgetUsdc,
      capability: request.capability,
      capabilityMatch: match,
      requireExactCapability: Boolean(request.requireExactCapability),
      advertisedPriceUsdc: resolved.selectedService?.advertisedPriceUsdc,
      priceKind: resolved.selectedService ? "advertised" : "unknown",
      hardExclusions,
      arcUsdcBlocklistStatus,
    });
  }

  const rankedResult = rankCounterparties(rankingInputs);
  const combined: SelectionCandidate[] = [...rankedResult.ranked, ...rejected];
  combined.sort((left, right) => {
    const leftExecutable = ["ELIGIBLE", "ELIGIBLE_WITH_LIMITS", "REQUIRES_EVALUATOR"].includes(left.eligibility);
    const rightExecutable = ["ELIGIBLE", "ELIGIBLE_WITH_LIMITS", "REQUIRES_EVALUATOR"].includes(right.eligibility);
    if (leftExecutable !== rightExecutable) return rightExecutable ? 1 : -1;
    return right.rankingScore - left.rankingScore
      || right.trustScore - left.trustScore
      || (left.identity?.agentId || left.evidenceHash).localeCompare(right.identity?.agentId || right.evidenceHash);
  });
  combined.forEach((candidate, index) => { candidate.rank = index + 1; });
  const winner = combined.find((candidate) =>
    candidate.identity
    && ["ELIGIBLE", "ELIGIBLE_WITH_LIMITS", "REQUIRES_EVALUATOR"].includes(candidate.eligibility));
  if (!winner?.identity || !["ALLOW", "ALLOW_WITH_LIMITS", "REQUIRE_EVALUATOR"].includes(winner.trustDecision)) {
    throw new CounterpartySelectionError("no_eligible_counterparty", 422, {
      candidates: combined.map((candidate) => ({
        agentId: candidate.identity?.agentId ?? null,
        eligibility: candidate.eligibility,
        reason: candidate.rejectionReason,
      })),
    });
  }

  const selectionId = `vcs_${randomBytes(8).toString("hex")}`;
  const publicId = `vcr_${randomBytes(8).toString("hex")}`;
  const createdAt = now.toISOString();
  const expiresAt = new Date(nowMs + COUNTERPARTY_SELECTION_POLICY.expirySeconds * 1000).toISOString();
  const canonicalRequest = canonicalSelectionRequest(request);
  const canonicalPayload: SelectionCanonicalPayload = {
    schema: "veyra.counterparty-selection.v1",
    selectionId,
    requester: {
      agentId: input.tenant.requesterAgentId ?? null,
      wallet: input.tenant.requesterWallet.toLowerCase(),
    },
    intent: {
      capability: canonicalRequest.capability,
      taskHash: canonicalRequest.taskHash,
      requestedBudgetUsdc: canonicalRequest.budgetUsdc,
      network: COUNTERPARTY_NETWORK,
      requireExactCapability: canonicalRequest.requireExactCapability,
    },
    selectedCandidateSet: combined.map((candidate) => ({
      candidateKey: selectionCandidateKey(candidate),
      agentId: candidate.identity?.agentId ?? null,
      ownerAddress: candidate.identity?.ownerAddress.toLowerCase() ?? null,
      serviceId: candidate.serviceId ?? null,
      evidenceHash: candidate.evidenceHash,
      trustDecisionHash: candidate.trustDecisionHash,
      arcUsdcBlocklistStatus: candidate.arcUsdcBlocklistStatus,
    })).sort((left, right) => left.candidateKey.localeCompare(right.candidateKey)),
    finalRanking: combined.map((candidate) => ({
      candidateKey: selectionCandidateKey(candidate),
      agentId: candidate.identity?.agentId ?? null,
      rank: candidate.rank,
      eligibility: candidate.eligibility,
      rankingScore: candidate.rankingScore,
      trustScore: candidate.trustScore,
      confidence: candidate.confidence,
      maxExposureUsdc: candidate.recommendedMaxExposureUsdc.toFixed(6),
      arcUsdcBlocklistStatus: candidate.arcUsdcBlocklistStatus,
    })),
    winner: {
      agentId: winner.identity.agentId,
      ownerAddress: winner.identity.ownerAddress.toLowerCase(),
      serviceId: winner.serviceId ?? null,
      trustDecision: winner.trustDecision as "ALLOW" | "ALLOW_WITH_LIMITS" | "REQUIRE_EVALUATOR",
      maxExposureUsdc: winner.recommendedMaxExposureUsdc.toFixed(6),
    },
    policyVersion: TRUST_POLICY_VERSION,
    rankingVersion: COUNTERPARTY_RANKING_VERSION,
    compliancePolicy: COUNTERPARTY_COMPLIANCE_POLICY,
    createdAt,
    expiresAt,
  };
  const canonicalHash = selectionCanonicalHash(canonicalPayload);
  const winnerExplanation = [
    `${winner.identity.agentId} is the highest-ranked executable candidate.`,
    `Ranking ${winner.rankingScore}/100 combines quality ${winner.baseQualityScore}/100 with confidence ${winner.confidence}%.`,
    `TrustGate returned ${winner.trustDecision} with ${winner.recommendedMaxExposureUsdc.toFixed(6)} USDC maximum exposure.`,
  ].join(" ");
  const selection: CounterpartySelection = {
    selectionId,
    publicId,
    requester: {
      agentId: input.tenant.requesterAgentId,
      wallet: input.tenant.requesterWallet,
    },
    capability: request.capability,
    taskHash: canonicalRequest.taskHash,
    requestedBudgetUsdc: request.budgetUsdc,
    network: COUNTERPARTY_NETWORK,
    requireExactCapability: Boolean(request.requireExactCapability),
    policyVersion: TRUST_POLICY_VERSION,
    rankingVersion: COUNTERPARTY_RANKING_VERSION,
    recommendedAgentId: winner.identity.agentId,
    recommendedWallet: winner.identity.ownerAddress,
    recommendedServiceId: winner.serviceId,
    decision: winner.trustDecision as "ALLOW" | "ALLOW_WITH_LIMITS" | "REQUIRE_EVALUATOR",
    recommendedMaxExposureUsdc: winner.recommendedMaxExposureUsdc,
    trustScore: winner.trustScore,
    rankingScore: winner.rankingScore,
    confidence: winner.confidence,
    winnerExplanation,
    candidates: combined,
    canonicalHash,
    createdAt,
    expiresAt,
    visibility: request.visibility === "public" ? "public" : "private",
    publicUrl: request.visibility === "public" && input.baseUrl
      ? `${input.baseUrl.replace(/\/$/, "")}/trust/selections/${publicId}`
      : undefined,
  };
  try {
    const saved = await saveCounterpartySelection({
      selection,
      tenant: input.tenant,
      requestHash,
      idempotencyKeyHash: keyHash,
      decisions,
    });
    console.info("counterparty_selection_created", {
      selectionId,
      candidateCount: combined.length,
      decision: selection.decision,
      confidence: selection.confidence,
      averageConfidence: combined.length > 0
        ? Math.round(combined.reduce((sum, candidate) => sum + candidate.confidence, 0) / combined.length)
        : 0,
      decisionDistribution: combined.reduce<Record<string, number>>((counts, candidate) => {
        counts[candidate.trustDecision] = (counts[candidate.trustDecision] || 0) + 1;
        return counts;
      }, {}),
      eligibilityDistribution: combined.reduce<Record<string, number>>((counts, candidate) => {
        counts[candidate.eligibility] = (counts[candidate.eligibility] || 0) + 1;
        return counts;
      }, {}),
      durationMs: Date.now() - nowMs,
    });
    return { selection: saved, replayed: false };
  } catch (error) {
    const raced = await findIdempotentSelection(input.tenant.tenantKey, keyHash);
    if (raced) {
      if (raced.requestHash.toLowerCase() === requestHash.toLowerCase()) {
        return { selection: raced.selection, replayed: true };
      }
      throw new CounterpartySelectionError("idempotency_conflict", 409);
    }
    throw error;
  }
}

function serializeClearanceMessage(message: ReturnType<typeof buildClearanceMessage>) {
  return Object.fromEntries(
    Object.entries(message).map(([key, value]) => [key, typeof value === "bigint" ? value.toString() : String(value)]),
  );
}

function deserializeClearanceMessage(message: Record<string, string>): ReturnType<typeof buildClearanceMessage> {
  return {
    decisionId: message.decisionId as Hex,
    subject: getAddress(message.subject),
    executor: getAddress(message.executor),
    counterparty: getAddress(message.counterparty),
    actionHash: message.actionHash as Hex,
    requestedAmount: BigInt(message.requestedAmount),
    maxAmount: BigInt(message.maxAmount),
    snapshotHash: message.snapshotHash as Hex,
    policyVersion: message.policyVersion as Hex,
    evaluator: getAddress(message.evaluator),
    issuedAt: BigInt(message.issuedAt),
    expiresAt: BigInt(message.expiresAt),
  };
}

async function assertClearanceVerifies(input: {
  clearance: SelectionClearance;
  expectedAttester: `0x${string}`;
  gate: `0x${string}`;
}) {
  const verification = await verifyTrustClearanceOnchain(
    deserializeClearanceMessage(input.clearance.clearance),
    input.clearance.signature,
    input.gate,
  );
  if (!verification.valid
    || !verification.signer
    || verification.signer.toLowerCase() !== input.expectedAttester.toLowerCase()) {
    throw new CounterpartySelectionError("clearance_onchain_verification_failed", 503);
  }
}

export async function issueCounterpartySelectionClearance(input: {
  selectionId: string;
  tenant: SelectionTenant;
}) {
  const selection = await fetchCounterpartySelection(input.selectionId, input.tenant);
  if (!selection) throw new CounterpartySelectionError("selection_not_found", 404);
  if (Date.parse(selection.expiresAt) <= Date.now()) {
    throw new CounterpartySelectionError("selection_expired", 409);
  }
  const winner = selection.candidates.find(
    (candidate) => candidate.identity?.agentId === selection.recommendedAgentId,
  );
  if (!winner?.identity) throw new CounterpartySelectionError("selection_winner_mismatch", 409);
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Math.min(
    Date.parse(selection.expiresAt),
    Date.now() + 5 * 60 * 1000,
  )).toISOString();
  const decision: TrustDecision = {
    decisionId: `vtd_sel_${selection.selectionId.slice(4)}`,
    decision: selection.decision,
    subject: {
      agentId: selection.requester.agentId || `wallet:${selection.requester.wallet.toLowerCase()}`,
      wallet: selection.requester.wallet,
    },
    trust: {
      score: winner.trustScore,
      confidence: winner.confidence / 100,
      coverage: winner.evidenceCoverage / 100,
      snapshotHash: selection.canonicalHash,
      snapshotAgeSeconds: 0,
    },
    request: {
      action: "service_purchase",
      requestedValueUsdc: selection.requestedBudgetUsdc,
      counterparty: selection.recommendedWallet,
      executor: selection.requester.wallet,
      serviceId: selection.recommendedServiceId,
      workflowType: `counterparty_selection:${selection.selectionId}:${selection.capability}:${selection.recommendedServiceId || "identity"}`,
    },
    policy: {
      version: selection.policyVersion,
      maxValueUsdc: selection.recommendedMaxExposureUsdc,
      evaluatorRequired: selection.decision === "REQUIRE_EVALUATOR",
      evaluatorAddress: selection.decision === "REQUIRE_EVALUATOR"
        ? process.env.NEXT_PUBLIC_VEYRA_ERC8183_EVALUATOR_ADDRESS
        : undefined,
    },
    reasons: [],
    riskSignals: winner.riskSignals as TrustDecision["riskSignals"],
    issuedAt,
    expiresAt,
    canonicalHash: "",
  };
  decision.canonicalHash = computeCanonicalDecisionHash(decision);
  const privateKey = process.env.VEYRA_TRUST_ATTESTER_PRIVATE_KEY
    || process.env.ERC8183_EVALUATOR_ATTESTER_PRIVATE_KEY;
  const gate = process.env.VEYRA_TRUST_GATE_ADDRESS;
  if (!privateKey || !/^0x[0-9a-f]{64}$/i.test(privateKey) || !gate || !isAddress(gate)) {
    throw new CounterpartySelectionError("clearance_signing_unavailable", 503);
  }
  const configuredAttester = getAddress((await import("viem/accounts")).privateKeyToAccount(privateKey as Hex).address);
  const gateAddress = getAddress(gate);
  const existing = await fetchSelectionClearance(selection.selectionId);
  if (existing) {
    await assertClearanceVerifies({
      clearance: existing,
      expectedAttester: configuredAttester,
      gate: gateAddress,
    });
    return { clearance: existing, replayed: true, onchainVerified: true };
  }
  const signed = await signTrustClearance(decision, 5_042_002, gateAddress, privateKey as Hex);
  const clearance: SelectionClearance = {
    clearanceId: `vcl_${randomBytes(8).toString("hex")}`,
    decisionId: decision.decisionId,
    clearanceDigest: signed.digest,
    selectionHash: selection.canonicalHash,
    clearance: serializeClearanceMessage(signed.clearanceMessage),
    signature: signed.signature,
    issuedAt,
    expiresAt,
  };
  await assertClearanceVerifies({
    clearance,
    expectedAttester: getAddress(signed.attester),
    gate: gateAddress,
  });
  return {
    clearance: await saveSelectionClearance({
      selectionId: selection.selectionId,
      decision,
      clearance,
    }),
    replayed: false,
    onchainVerified: true,
  };
}

export function sanitizePublicSelection(selection: CounterpartySelection) {
  return {
    selectionId: selection.selectionId,
    publicId: selection.publicId,
    capability: selection.capability,
    requestedBudgetUsdc: selection.requestedBudgetUsdc,
    network: selection.network,
    recommendedAgentId: selection.recommendedAgentId,
    recommendedWallet: selection.recommendedWallet,
    recommendedServiceId: selection.recommendedServiceId,
    decision: selection.decision,
    recommendedMaxExposureUsdc: selection.recommendedMaxExposureUsdc,
    trustScore: selection.trustScore,
    rankingScore: selection.rankingScore,
    confidence: selection.confidence,
    winnerExplanation: selection.winnerExplanation,
    candidates: selection.candidates.map((candidate) => ({
      agentId: candidate.identity?.agentId ?? null,
      wallet: candidate.identity?.ownerAddress ?? null,
      registryAddress: candidate.identity?.registryAddress ?? null,
      metadataUri: candidate.identity?.metadataUri ?? null,
      serviceId: candidate.serviceId ?? null,
      eligibility: candidate.eligibility,
      trustDecision: candidate.trustDecision,
      trustScore: candidate.trustScore,
      rankingScore: candidate.rankingScore,
      confidence: candidate.confidence,
      maxExposureUsdc: candidate.recommendedMaxExposureUsdc,
      capabilityMatch: candidate.capabilityMatch,
      priceKind: candidate.priceKind,
      advertisedPriceUsdc: candidate.advertisedPriceUsdc,
      evidenceHash: candidate.evidenceHash,
      evidenceCoverage: candidate.evidenceCoverage,
      evidenceSources: candidate.evidenceSources,
      reasons: candidate.topReasons,
      risks: candidate.riskSignals,
      rejectionReason: candidate.rejectionReason,
      arcUsdcBlocklistStatus: candidate.arcUsdcBlocklistStatus,
      rank: candidate.rank,
    })),
    canonicalHash: selection.canonicalHash,
    createdAt: selection.createdAt,
    expiresAt: selection.expiresAt,
    policyVersion: selection.policyVersion,
    rankingVersion: selection.rankingVersion,
    proof: selection.proof,
    publicUrl: selection.publicUrl,
  };
}
