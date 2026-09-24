import { randomBytes } from "node:crypto";
import { getAddress, isAddress, type Hex } from "viem";
import { rejectHostedWorkflowSecrets } from "../agent/hosted-workflows.ts";
import {
  buildX402ProbeEvidence,
  probeX402Resource,
  X402_PROBE_VERSION,
  type X402ProbeEvidence,
  type X402ProbeExpectation,
  type X402ProbeResult,
} from "../providers/x402-probe.ts";
import { evmChainIdFromCaip2 } from "../x402/browser-payment.ts";
import { gatewayContextForChain, readGatewayBalance } from "../x402/gateway-deposit.ts";
import { railReadiness, routeToPayableRail } from "./payment-rail.ts";
import { computeCanonicalDecisionHash } from "../trust-gate/canonical.ts";
import { DENY_TIER, resolvePolicy } from "../trust-gate/policy.ts";
import { signTrustClearance } from "../trust-gate/sign.ts";
import type { TrustDecision, TrustRiskCode } from "../trust-gate/types.ts";
import { isExecutableTrustDecision, TRUST_DECISION_EXPIRY_SECONDS, TRUST_POLICY_VERSION } from "../trust-gate/types.ts";
import { verifyTrustClearanceOnchain } from "../trust-gate/verify.ts";
import { hashCanonical, normalizeCapability } from "./canonical.ts";
import { rankCounterparties } from "./engine.ts";
import {
  buildEvidenceWithHistory,
  loadEndpointObservations,
  recordEndpointObservation,
} from "../x402/trust-api/observations.ts";
import { recordX402Selection } from "../x402/decision-store.ts";
import { normalizeResourceUrl, resourceKeyFor } from "../x402/trust-api/resource.ts";
import {
  discoverMarketplaceCandidates,
  marketplacePayToAddress,
  MARKETPLACE_DISCOVERY_LIMITS,
  MARKETPLACE_SOURCE,
  MARKETPLACE_SOURCE_VERSION,
  MarketplaceDiscoveryError,
  normalizeMarketplaceNetwork,
  type MarketplaceCandidate,
  type MarketplaceNetwork,
} from "./marketplace-source.ts";
import { COUNTERPARTY_SELECTION_POLICY, MARKETPLACE_RANKING_WEIGHTS } from "./policy.ts";
import { CounterpartySelectionError } from "./service.ts";
import type {
  CandidateEvidence,
  CandidateRankingInput,
  CanonicalCandidateIdentity,
  EvidenceFreshness,
  RankedCandidate,
  SelectionTenant,
} from "./types.ts";

/**
 * Marketplace counterparty selection.
 *
 * Same engine, same policy tiers, same EIP-712 clearance as ERC-8004
 * counterparty selection. What differs is the candidate source (Circle's x402
 * discovery API instead of the Arc identity registry) and the evidence shape
 * (a free protocol probe instead of settled Arc history).
 *
 * Deliberately stateless: nothing is written to `counterparty_selections`.
 * The call is an advisory pre-flight issued seconds before `circle services
 * pay`, and persisting an advisory verdict about a third-party endpoint would
 * imply a durable Veyra relationship that does not exist.
 */

export const MARKETPLACE_SELECTION_VERSION = "veyra-marketplace-selection-v1" as const;
export const MARKETPLACE_SELECTION_EXPIRY_SECONDS = 300;

/** Arc has zero published x402 resources, so marketplace settlement is off-Arc
 *  by construction. The clearance is still signed against the Arc Trust Gate:
 *  the payment happens where the services are, the authorization record lives
 *  where Veyra's verification does. */
export const MARKETPLACE_CLEARANCE_CHAIN_ID = 5_042_002;

/**
 * Evidence dimensions a marketplace counterparty could theoretically carry.
 * Coverage is the honest fraction of these that were actually observed, and it
 * is what caps the policy tier - a first-contact endpoint cannot reach ALLOW.
 */
export const MARKETPLACE_EVIDENCE_DIMENSIONS = [
  "protocol_integrity",
  "catalog_integrity",
  "statistical_availability",
  "veyra_reputation",
  "erc8183_execution",
  "evaluator_verdicts",
] as const;

export type MarketplaceSelectionRequest = {
  capability: string;
  query?: string;
  /** A counterparty that is named rather than searched for. See
   *  MarketplaceDiscoveryInput.mustInclude. */
  mustInclude?: string | null;
  task?: string;
  budgetUsdc: number;
  maxPriceUsdc?: number;
  network?: string;
  limit?: number;
  requireExactCapability?: boolean;
  requireCircleGateway?: boolean;
};

export type MarketplaceRankedCandidate = RankedCandidate & {
  marketplace: {
    candidateId: string;
    resource: string;
    provider: MarketplaceCandidate["provider"];
    method: "GET" | "POST";
    priceUsdc: number;
    payTo: string;
    network: string;
    asset: string;
    supportsVanillaX402: boolean;
    supportsCircleGateway: boolean;
    /* Where the money leaves from, so the screen can say it before a wallet
       opens instead of after a refusal. */
    funding: "wallet" | "gateway_deposit";
    payableNow: boolean | null;
    railNote: string;
    declaresInputSchema: boolean;
    declaresOutputSchema: boolean;
    inputSchema: Record<string, unknown> | null;
    outputSchema: Record<string, unknown> | null;
    /** Where the request schema came from, so the screen can say which. */
    inputSchemaSource: "catalog" | "challenge" | null;
    lastUpdated: string | null;
    catalogHash: Hex;
  };
  probe: {
    probeVersion: typeof X402_PROBE_VERSION;
    integrityScore: number;
    reachable: boolean;
    respondedWith402: boolean;
    latencyMs: number | null;
    catalogDrift: string[];
    criticalFailure: string | null;
    failedChecks: string[];
    statisticalEvidenceAvailable: boolean;
    qualityStatus: string;
  };
  evidenceLimits: {
    arcProofBacked: false;
    veyraReputationRecords: 0;
    settledExecutions: 0;
    observedDimensions: string[];
    missingDimensions: string[];
  };
};

export type MarketplaceSelectionClearance = {
  clearanceId: string;
  decisionId: string;
  clearanceDigest: Hex;
  selectionHash: Hex;
  chainId: number;
  verifyingContract: `0x${string}`;
  attester: `0x${string}`;
  clearance: Record<string, string>;
  signature: Hex;
  onchainVerified: boolean;
  issuedAt: string;
  expiresAt: string;
};

export type MarketplaceSelection = {
  selectionId: string;
  source: typeof MARKETPLACE_SOURCE;
  sourceVersion: typeof MARKETPLACE_SOURCE_VERSION;
  selectionVersion: typeof MARKETPLACE_SELECTION_VERSION;
  probeVersion: typeof X402_PROBE_VERSION;
  policyVersion: string;
  requester: { agentId?: string; wallet: `0x${string}` };
  capability: string;
  query: string;
  network: MarketplaceNetwork;
  networkLabel: string;
  settlementNetworkIsArc: false;
  requestedBudgetUsdc: number;
  maxPriceUsdc: number | null;
  catalogTotal: number;
  discovered: number;
  probed: number;
  candidates: MarketplaceRankedCandidate[];
  recommendation: {
    granted: boolean;
    reason: string;
    candidateId: string | null;
    resource: string | null;
    payTo: string | null;
    priceUsdc: number | null;
    decision: TrustDecision["decision"] | null;
    maxExposureUsdc: number;
    postCallVerificationRequired: boolean;
    /* Which rail the winner settles on, and whether the requester can pay it
       without setting something up first. */
    funding: "wallet" | "gateway_deposit" | null;
    payableNow: boolean | null;
    /* Set only when payability changed which candidate was chosen, or when
       nothing here is payable. Silence means the ranking stood unaltered. */
    routingNote: string | null;
    explanation: string;
  };
  clearance: MarketplaceSelectionClearance | null;
  canonicalHash: Hex;
  createdAt: string;
  expiresAt: string;
};

function freshnessNow(): EvidenceFreshness {
  return "fresh";
}

export function validateMarketplaceSelectionRequest(body: unknown): MarketplaceSelectionRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new CounterpartySelectionError("invalid_request");
  }
  const input = body as Record<string, unknown>;
  const allowed = [
    "capability", "query", "task", "budgetUsdc", "maxPriceUsdc",
    "network", "limit", "requireExactCapability", "requireCircleGateway",
    "mustInclude",
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

  const maxPriceUsdc = input.maxPriceUsdc === undefined ? undefined : Number(input.maxPriceUsdc);
  if (
    maxPriceUsdc !== undefined
    && (!Number.isFinite(maxPriceUsdc)
      || maxPriceUsdc <= 0
      || maxPriceUsdc > MARKETPLACE_DISCOVERY_LIMITS.maxUsdPrice)
  ) throw new CounterpartySelectionError("max_price_invalid");

  const limit = input.limit === undefined ? MARKETPLACE_DISCOVERY_LIMITS.defaultLimit : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MARKETPLACE_DISCOVERY_LIMITS.maxLimit) {
    throw new CounterpartySelectionError("limit_invalid");
  }

  const query = input.query === undefined ? undefined : String(input.query).trim();
  if (query !== undefined && (query.length === 0 || query.length > 120)) {
    throw new CounterpartySelectionError("query_invalid");
  }
  const task = input.task === undefined ? undefined : String(input.task).trim();
  if (task && task.length > 1_000) throw new CounterpartySelectionError("task_too_large");
  if (task) {
    try { rejectHostedWorkflowSecrets(task); }
    catch { throw new CounterpartySelectionError("sensitive_input_rejected"); }
  }
  try { normalizeMarketplaceNetwork(input.network); }
  catch { throw new CounterpartySelectionError("network_unsupported"); }

  return {
    capability,
    query,
    task,
    budgetUsdc: Number(budgetUsdc.toFixed(6)),
    maxPriceUsdc: maxPriceUsdc === undefined ? undefined : Number(maxPriceUsdc.toFixed(6)),
    network: input.network === undefined ? undefined : String(input.network),
    limit,
    requireExactCapability: Boolean(input.requireExactCapability),
    requireCircleGateway: Boolean(input.requireCircleGateway),
    /* An id, not free text: it only ever selects one row out of the catalogue
       the caller could already see, so there is nothing here to widen a search
       with. Anything that is not a well-formed candidate id is dropped rather
       than refused, because a stale subject is a card going out of date, not a
       bad request. */
    mustInclude: typeof input.mustInclude === "string" && /^x402:[0-9a-f]{1,64}$/.test(input.mustInclude)
      ? input.mustInclude
      : null,
  };
}

export function probeExpectationFor(candidate: MarketplaceCandidate): X402ProbeExpectation {
  return {
    candidateId: candidate.candidateId,
    resource: candidate.resource,
    method: candidate.method,
    network: candidate.selectedAccept.network,
    payTo: candidate.selectedAccept.payTo,
    asset: candidate.selectedAccept.asset,
    amountAtomic: candidate.selectedAccept.amountAtomic,
    priceUsdc: candidate.priceUsdc,
    maxTimeoutSeconds: candidate.selectedAccept.maxTimeoutSeconds,
    siwx: candidate.siwx,
    supportsVanillaX402: candidate.supportsVanillaX402,
    supportsCircleGateway: candidate.supportsCircleGateway,
    gatewayBatched: candidate.selectedAccept.gatewayBatched,
    declaresInputSchema: candidate.declaresInputSchema,
    declaresOutputSchema: candidate.declaresOutputSchema,
    docsUrl: candidate.provider.docsUrl,
  };
}

/**
 * Honest coverage: the fraction of evidence dimensions actually observed.
 * A first-contact marketplace endpoint tops out at 2/6, which is what keeps
 * the policy tier below ALLOW no matter how clean the probe comes back.
 */
export function marketplaceEvidenceCoverage(evidence: X402ProbeEvidence) {
  const observed = ["protocol_integrity", "catalog_integrity"];
  if (evidence.statisticalEvidenceAvailable) observed.push("statistical_availability");
  const missing = MARKETPLACE_EVIDENCE_DIMENSIONS.filter((item) => !observed.includes(item));
  return {
    observed,
    missing: [...missing],
    coverage: observed.length / MARKETPLACE_EVIDENCE_DIMENSIONS.length,
  };
}

/**
 * Builds the trust decision through the SAME policy tiers used everywhere else.
 *
 * `evaluateTrustDecision` is intentionally not reused here: it raises
 * ARC_PROOF_UNVERIFIED whenever a stored reputation snapshot lacks an Arc proof
 * transaction, and that flag is critical, so every marketplace candidate would
 * DENY. That rule guards against a *forged stored snapshot*; marketplace
 * evidence is computed in-request from a live probe and is never stored, so
 * there is nothing to forge. The absence of Arc backing is instead reported
 * explicitly as NO_REPUTATION_DATA plus `evidenceLimits.arcProofBacked: false`.
 */
export function buildMarketplaceTrustDecision(input: {
  requesterWallet: `0x${string}`;
  payTo: `0x${string}`;
  candidate: MarketplaceCandidate;
  integrityScore: number;
  coverage: number;
  confidence: number;
  evidenceHash: Hex;
  capability: string;
  requestedValueUsdc: number;
  issuedAt: string;
  expiresAt: string;
  riskSignals: TrustRiskCode[];
}): TrustDecision {
  const riskSignals: TrustRiskCode[] = Array.from(new Set<TrustRiskCode>([
    "NO_REPUTATION_DATA",
    ...input.riskSignals,
    ...(input.confidence < 0.3 ? (["LOW_CONFIDENCE"] as TrustRiskCode[]) : []),
    ...(input.coverage < 0.3 ? (["INSUFFICIENT_COVERAGE"] as TrustRiskCode[]) : []),
  ]));

  let { tier, reasons } = resolvePolicy(
    input.integrityScore,
    input.confidence,
    input.coverage,
    0,
    riskSignals,
  );
  if (input.requestedValueUsdc > tier.maxValueUsdc && tier.level !== "DENY") {
    reasons = [...reasons, "VALUE_EXCEEDS_TRUST_LIMIT"];
    tier = DENY_TIER;
  }

  const decision: TrustDecision = {
    decisionId: `vtd_mkt_${randomBytes(8).toString("hex")}`,
    decision: tier.level,
    subject: {
      agentId: `x402:${input.candidate.candidateId}`,
      wallet: input.requesterWallet,
    },
    trust: {
      score: input.integrityScore,
      confidence: input.confidence,
      coverage: input.coverage,
      snapshotHash: input.evidenceHash,
      snapshotAgeSeconds: 0,
    },
    request: {
      action: "x402_payment",
      requestedValueUsdc: input.requestedValueUsdc,
      counterparty: input.payTo,
      executor: input.requesterWallet,
      serviceId: input.candidate.candidateId,
      // The `counterparty_selection:` prefix makes `buildClearanceMessage` fold
      // this binding into the EIP-712 actionHash, so a clearance issued for one
      // resource cannot be replayed against another.
      workflowType: `counterparty_selection:marketplace:${input.candidate.candidateId}:${input.capability}:${input.candidate.catalogHash}`,
    },
    policy: {
      version: TRUST_POLICY_VERSION,
      maxValueUsdc: tier.maxValueUsdc,
      evaluatorRequired: tier.evaluatorRequired,
    },
    reasons: Array.from(new Set(reasons)),
    riskSignals,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    canonicalHash: "",
  };
  decision.canonicalHash = computeCanonicalDecisionHash(decision);
  return decision;
}

function buildCandidateEvidence(input: {
  identity: CanonicalCandidateIdentity;
  candidate: MarketplaceCandidate;
  evidence: X402ProbeEvidence;
  coverage: number;
  confidencePercent: number;
  observedAt: string;
}): CandidateEvidence {
  const { candidate, evidence } = input;
  const probeCount = evidence.probes.length;
  const failedChecks = evidence.probes.flatMap((probe) =>
    probe.checks.filter((check) => !check.passed).map((check) => check.id));
  const positiveSignals = [
    ...(evidence.probes.every((probe) => probe.respondedWith402)
      ? ["Live x402 challenge verified"] : []),
    ...(evidence.probes.every((probe) => probe.catalogDrift.length === 0)
      ? ["Catalog price and payee match the live challenge"] : []),
    ...(candidate.declaresOutputSchema ? ["Output schema published"] : []),
  ];
  const sourceRow = (
    source: CandidateEvidence["sources"][number]["source"],
    count: number,
  ) => ({
    source,
    observedAt: count > 0 ? input.observedAt : null,
    ageSeconds: count > 0 ? 0 : null,
    freshness: (count > 0 ? freshnessNow() : "missing") as EvidenceFreshness,
    evidenceCount: count,
  });

  return {
    identity: input.identity,
    snapshotHash: hashCanonical({ candidateId: candidate.candidateId, catalogHash: candidate.catalogHash }),
    snapshotCreatedAt: input.observedAt,
    trustScore: evidence.integrityScore,
    snapshotConfidence: input.confidencePercent,
    snapshotCoverage: input.coverage,
    dimensions: {
      // Zeroed dimensions are reported, not hidden: the engine forces any
      // dimension with `evidenceCount: 0` to score 0, and the marketplace
      // weight profile gives them zero weight rather than pretending.
      reputationQuality: 0,
      executionReliability: 0,
      evaluatorSuccess: 0,
      economicReliability: 0,
      serviceQuality: evidence.integrityScore,
    },
    evidenceCounts: {
      total: probeCount,
      execution: 0,
      evaluator: 0,
      economic: 0,
      serviceQuality: probeCount,
      independentCounterparties: 0,
    },
    sources: [
      sourceRow("identity", 1),
      sourceRow("reputation", 0),
      sourceRow("execution", 0),
      sourceRow("economic", 0),
      sourceRow("service_quality", probeCount),
      sourceRow("evaluator", 0),
      sourceRow("risk", failedChecks.length),
    ],
    riskSignals: Array.from(new Set([
      ...failedChecks.map((check) => `probe_check_failed:${check}`),
      ...evidence.probes.flatMap((probe) => probe.catalogDrift.map((drift) => `catalog_drift:${drift}`)),
      "no_arc_settlement_history",
    ])),
    positiveSignals,
    services: [],
    evidenceHash: hashCanonical({
      candidateId: candidate.candidateId,
      catalogHash: candidate.catalogHash,
      probeVersion: X402_PROBE_VERSION,
      probes: evidence.probes.map((probe) => ({
        respondedWith402: probe.respondedWith402,
        integrityScore: probe.integrityScore,
        catalogDrift: probe.catalogDrift,
        observedPriceUsdc: probe.observedPriceUsdc,
        observedPayTo: probe.observedPayTo?.toLowerCase() ?? null,
        checks: probe.checks.map((check) => ({ id: check.id, passed: check.passed })),
      })),
      statisticalEvidenceAvailable: evidence.statisticalEvidenceAvailable,
    }),
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function selectMarketplaceCounterparty(input: {
  request: MarketplaceSelectionRequest;
  tenant: SelectionTenant;
  now?: Date;
  fetchImpl?: typeof fetch;
  probeFetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  issueClearance?: boolean;
  /**
   * Lets a caller pick the winner out of the ranked, decided, routed list.
   *
   * Not a way to override policy: the candidates handed to it have already been
   * probed, scored and tiered, and returning one changes which of them the
   * recommendation describes and the clearance authorizes -- nothing else. A
   * caller that returns null, or something not on the list, gets the engine's
   * own choice.
   *
   * This exists because Nova picks differently from the developer surface: it
   * prefers a counterparty payable from the wallet balance over one needing a
   * Circle Gateway deposit, because the person it is asking has not heard of
   * Circle Gateway. Before this hook it made that choice afterwards, on the
   * returned selection, which meant the card named one counterparty while the
   * clearance -- had one been issued -- would have authorized another.
   */
  preferCandidate?: (candidates: MarketplaceRankedCandidate[]) =>
    { candidate: MarketplaceRankedCandidate; note?: string | null } | null;
  /**
   * Hands back the winner's full trust decision, for a caller that has to issue
   * its own clearance against a different amount than this selection budgeted.
   *
   * Nova needs it: it decides whether to authorize anything only after reading
   * the live 402 challenge for the exact request body, which is the only thing
   * that knows the exact price -- x402 charges per call, and the free probe
   * above cannot raise the same challenge a paid body does. So the selection
   * runs with `issueClearance: false`, the price is read, the terms are checked
   * against what the person was actually shown, and the clearance is signed
   * afterwards for that exact number or not at all.
   *
   * Server-side only. Nothing here reaches an API payload.
   */
  onWinnerDecision?: (input: {
    decision: TrustDecision;
    selectionHash: Hex;
    expiresAt: string;
  }) => void;
  /**
   * Record the decision even though no clearance was issued with it.
   *
   * For the caller described above: Nova quotes before it clears, because
   * only the quote knows the exact price, and the quote route reads the
   * decision back from the store. With `issueClearance: false` nothing was
   * stored, so every Nova approval since the relay began reading decisions
   * (2026-09-16) was refused as "No Veyra decision with that id". The row is
   * the same decision -- payee, asset, chain, ceiling, expiry -- with no
   * clearance digest, and the caller signs its clearance for the quoted amount
   * or not at all. Off unless asked for: a proposal that only prices must not
   * leave a quotable decision behind.
   */
  recordDecision?: boolean;
}): Promise<MarketplaceSelection> {
  const request = validateMarketplaceSelectionRequest(input.request);
  const now = input.now ?? new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + MARKETPLACE_SELECTION_EXPIRY_SECONDS * 1000).toISOString();

  let discovery;
  try {
    discovery = await discoverMarketplaceCandidates({
      capability: request.capability,
      query: request.query,
      mustInclude: request.mustInclude,
      network: request.network,
      maxPriceUsdc: request.maxPriceUsdc,
      limit: request.limit,
      requireCircleGateway: request.requireCircleGateway,
      fetchImpl: input.fetchImpl,
    });
  } catch (error) {
    if (error instanceof MarketplaceDiscoveryError) {
      throw new CounterpartySelectionError(error.code, error.status);
    }
    throw error;
  }

  const affordable = discovery.candidates.filter(
    (candidate) => candidate.priceUsdc <= request.budgetUsdc,
  );

  /* Read once, for this buyer, on the chain these candidates settle on. A
     batched endpoint spends a Gateway deposit rather than the wallet balance,
     so whether one is funded decides which candidates this wallet can pay at
     all — a fact about the buyer, deliberately kept out of the trust score and
     applied only when choosing between candidates already ranked on evidence.
     Null means the question could not be asked, and never demotes anything. */
  const gatewayChainId = evmChainIdFromCaip2(discovery.network);
  const gatewayContext = gatewayChainId === null ? null : gatewayContextForChain(gatewayChainId);
  const gatewayFundedAtomic = gatewayContext && affordable.some((candidate) => candidate.funding === "gateway_deposit")
    ? (await readGatewayBalance(gatewayContext, input.tenant.requesterWallet))?.availableAtomic ?? null
    : null;

  /* Probe, then remember. Every probe used to be discarded the moment the
     response was rendered, so Veyra met each endpoint for the first time on
     every single run - which is why statistical evidence was never available
     and why a payee that changed between two runs went unnoticed. The write is
     best-effort: it improves the next verdict, never this one. */
  const probes = await mapWithConcurrency(affordable, 4, async (candidate) => {
    const probe = await probeX402Resource(probeExpectationFor(candidate), {
      fetchImpl: input.probeFetchImpl,
      now,
    });
    let resourceKey: string | null = null;
    let history: Awaited<ReturnType<typeof loadEndpointObservations>> = [];
    try {
      const normalized = normalizeResourceUrl(candidate.resource);
      resourceKey = resourceKeyFor(candidate.method, normalized);
      history = await loadEndpointObservations(resourceKey);
      void recordEndpointObservation({
        resourceKey,
        resourceUrl: normalized,
        method: candidate.method,
        network: candidate.selectedAccept.network,
        candidateId: candidate.candidateId,
        asset: candidate.selectedAccept.asset,
        probe,
      });
    } catch {
      resourceKey = null;
      history = [];
    }
    return { candidate, probe, history };
  });

  const rankingInputs: CandidateRankingInput[] = [];
  const marketplaceByAgentId = new Map<string, {
    candidate: MarketplaceCandidate;
    probe: X402ProbeResult;
    evidence: X402ProbeEvidence;
    coverage: ReturnType<typeof marketplaceEvidenceCoverage>;
  }>();

  for (const { candidate, probe, history } of probes) {
    const payTo = marketplacePayToAddress(candidate);
    if (!payTo) continue;
    const evidence = history.length > 0
      ? buildEvidenceWithHistory(probe, history)
      : buildX402ProbeEvidence([probe]);
    const coverage = marketplaceEvidenceCoverage(evidence);
    const confidenceLevel = evidence.qualityScore.confidenceLevel;
    const confidencePercent = confidenceLevel === "high" ? 90 : confidenceLevel === "medium" ? 60 : 30;
    const identity: CanonicalCandidateIdentity = {
      agentId: candidate.candidateId,
      ownerAddress: payTo,
      registryAddress: payTo,
      metadataUri: candidate.resource,
      serviceIds: [candidate.candidateId],
      source: "circle_marketplace",
      verifiedOnchain: false,
    };
    const candidateEvidence = buildCandidateEvidence({
      identity,
      candidate,
      evidence,
      coverage: coverage.coverage,
      confidencePercent,
      observedAt: probe.probedAt,
    });
    const decision = buildMarketplaceTrustDecision({
      requesterWallet: input.tenant.requesterWallet,
      payTo,
      candidate,
      integrityScore: evidence.integrityScore,
      coverage: coverage.coverage,
      confidence: confidencePercent / 100,
      evidenceHash: candidateEvidence.evidenceHash,
      capability: request.capability,
      requestedValueUsdc: candidate.priceUsdc,
      issuedAt: createdAt,
      expiresAt: new Date(now.getTime() + TRUST_DECISION_EXPIRY_SECONDS * 1000).toISOString(),
      riskSignals: [],
    });
    const hardExclusions: string[] = [];
    if (probe.criticalFailure) hardExclusions.push(`probe_${probe.criticalFailure}`);
    if (candidate.siwx) hardExclusions.push("siwx_requires_browser_auth");

    rankingInputs.push({
      identity,
      evidence: candidateEvidence,
      trustDecision: decision,
      requestedBudgetUsdc: request.budgetUsdc,
      capability: request.capability,
      capabilityMatch: candidate.capabilityMatch,
      requireExactCapability: Boolean(request.requireExactCapability),
      advertisedPriceUsdc: candidate.priceUsdc,
      priceKind: "advertised",
      hardExclusions,
      // Arc's USDC blocklist does not govern a Base/Polygon payee; claiming a
      // status here would be a fabricated compliance signal.
      arcUsdcBlocklistStatus: "unknown",
      weights: MARKETPLACE_RANKING_WEIGHTS,
    });
    marketplaceByAgentId.set(candidate.candidateId, { candidate, probe, evidence, coverage });
  }

  const rankedResult = rankCounterparties(rankingInputs);
  const { ranked } = rankedResult;
  const candidates: MarketplaceRankedCandidate[] = ranked.map((item) => {
    const context = marketplaceByAgentId.get(item.identity.agentId)!;
    return {
      ...item,
      marketplace: {
        candidateId: context.candidate.candidateId,
        resource: context.candidate.resource,
        provider: context.candidate.provider,
        method: context.candidate.method,
        priceUsdc: context.candidate.priceUsdc,
        payTo: context.candidate.selectedAccept.payTo,
        network: context.candidate.selectedAccept.network,
        asset: context.candidate.selectedAccept.asset,
        supportsVanillaX402: context.candidate.supportsVanillaX402,
        supportsCircleGateway: context.candidate.supportsCircleGateway,
        funding: context.candidate.funding,
        payableNow: railReadiness({
          funding: context.candidate.funding,
          priceAtomic: BigInt(Math.round(context.candidate.priceUsdc * 1e6)),
          gatewayFundedAtomic,
        }).payableNow,
        railNote: railReadiness({
          funding: context.candidate.funding,
          priceAtomic: BigInt(Math.round(context.candidate.priceUsdc * 1e6)),
          gatewayFundedAtomic,
        }).reason,
        /* The catalog is the first source, the live challenge the second, and
           the second is not a lesser one: Circle's entry for
           np.orthogonal.com/serper carries no `input` while the endpoint's own
           402 declares `required: ["q"]`. Reading only the catalog is what sent
           `{"query": ...}` to an endpoint that wanted `q`. */
        declaresInputSchema: context.candidate.declaresInputSchema
          || context.probe.publishedInputSchema !== null,
        declaresOutputSchema: context.candidate.declaresOutputSchema
          || context.probe.publishedOutputSchema !== null,
        inputSchema: context.candidate.inputSchema ?? context.probe.publishedInputSchema,
        outputSchema: context.candidate.outputSchema ?? context.probe.publishedOutputSchema,
        inputSchemaSource: context.candidate.inputSchema
          ? "catalog"
          : context.probe.publishedInputSchema
            ? "challenge"
            : null,
        lastUpdated: context.candidate.lastUpdated,
        catalogHash: context.candidate.catalogHash,
      },
      probe: {
        probeVersion: X402_PROBE_VERSION,
        integrityScore: context.probe.integrityScore,
        reachable: context.probe.reachable,
        respondedWith402: context.probe.respondedWith402,
        latencyMs: context.probe.latencyMs,
        catalogDrift: context.probe.catalogDrift,
        criticalFailure: context.probe.criticalFailure,
        failedChecks: context.probe.checks.filter((check) => !check.passed).map((check) => check.id),
        statisticalEvidenceAvailable: context.evidence.statisticalEvidenceAvailable,
        qualityStatus: context.evidence.qualityScore.status,
      },
      evidenceLimits: {
        arcProofBacked: false,
        veyraReputationRecords: 0,
        settledExecutions: 0,
        observedDimensions: context.coverage.observed,
        missingDimensions: context.coverage.missing,
      },
    };
  });

  /* Rank on evidence, then route on payability. The ranking above is neither
     re-ordered nor re-weighted: this walks it in order and takes the first
     candidate whose rail this wallet can settle on, so an unpayable rail loses
     only to a candidate that was already eligible. When it passes over the
     top-ranked one it says so, because silently substituting a counterparty is
     exactly the kind of unexplained decision this product exists to refuse. */
  const route = routeToPayableRail(
    candidates.map((item) => ({
      candidateId: item.identity.agentId,
      rank: item.rank,
      funding: item.marketplace.funding,
      priceAtomic: BigInt(Math.round(item.marketplace.priceUsdc * 1e6)),
      /* Anything Veyra would let proceed, which includes the evaluator tier —
         that is the tier a first purchase normally lands in. A candidate
         needing a human or refused outright is not an alternative. */
      eligible: item.eligibility !== "INELIGIBLE" && item.eligibility !== "REVIEW_REQUIRED",
    })),
    gatewayFundedAtomic,
  );
  const routedWinner = route.winner
    ? candidates.find((item) => item.identity.agentId === route.winner!.candidateId) ?? null
    : null;
  const routed = route.passedOver && routedWinner
    ? rankedResult.ranked.find((item) => item.identity.agentId === routedWinner.identity.agentId) ?? rankedResult.winner
    : rankedResult.winner;

  /* The caller's preference, checked against the list it was given. An id that
     is not on it is ignored rather than trusted: the hook may narrow who wins,
     never who was eligible. */
  const preference = input.preferCandidate?.(candidates) ?? null;
  const winner = preference
    ? rankedResult.ranked.find((item) => item.identity.agentId === preference.candidate.identity.agentId) ?? routed
    : routed;
  /* Only when the preference actually moved the outcome. A note explaining a
     substitution that did not happen is the screen apologising for nothing. */
  const preferenceNote = preference?.note && winner && routed
    && winner.identity.agentId !== routed.identity.agentId
    ? preference.note
    : null;

  const winnerContext = winner ? marketplaceByAgentId.get(winner.identity.agentId) : undefined;
  const winnerPayTo = winnerContext ? marketplacePayToAddress(winnerContext.candidate) : null;
  const winnerDecision = winner
    ? rankingInputs.find((item) => item.identity.agentId === winner.identity.agentId)?.trustDecision
    : undefined;

  const selectionId = `vms_${randomBytes(8).toString("hex")}`;
  const canonicalHash = hashCanonical({
    schema: "veyra.marketplace-selection.v1",
    selectionId,
    selectionVersion: MARKETPLACE_SELECTION_VERSION,
    sourceVersion: MARKETPLACE_SOURCE_VERSION,
    probeVersion: X402_PROBE_VERSION,
    policyVersion: TRUST_POLICY_VERSION,
    requester: {
      agentId: input.tenant.requesterAgentId ?? null,
      wallet: input.tenant.requesterWallet.toLowerCase(),
    },
    intent: {
      capability: request.capability,
      query: discovery.query,
      network: discovery.network,
      budgetUsdc: request.budgetUsdc.toFixed(6),
      maxPriceUsdc: request.maxPriceUsdc?.toFixed(6) ?? null,
      requireExactCapability: Boolean(request.requireExactCapability),
    },
    ranking: candidates.map((item) => ({
      candidateId: item.marketplace.candidateId,
      catalogHash: item.marketplace.catalogHash,
      evidenceHash: item.evidenceHash,
      trustDecisionHash: item.trustDecisionHash,
      rank: item.rank,
      eligibility: item.eligibility,
      rankingScore: item.rankingScore,
      integrityScore: item.probe.integrityScore,
      maxExposureUsdc: item.recommendedMaxExposureUsdc.toFixed(6),
    })),
    winner: winner
      ? {
          candidateId: winner.identity.agentId,
          payTo: winnerPayTo?.toLowerCase() ?? null,
          decision: winner.trustDecision,
          maxExposureUsdc: winner.recommendedMaxExposureUsdc.toFixed(6),
        }
      : null,
    createdAt,
    expiresAt,
  });

  if (winner && winnerDecision && winnerPayTo) {
    input.onWinnerDecision?.({ decision: winnerDecision, selectionHash: canonicalHash, expiresAt });
  }

  let clearance: MarketplaceSelectionClearance | null = null;
  let clearanceReason = "";
  if (winner && winnerDecision && winnerPayTo && input.issueClearance !== false) {
    try {
      clearance = await issueMarketplaceClearance({
        // The signature must authorize the exposure actually recommended, not
        // the policy tier's ceiling. `recommendedMaxExposureUsdc` is the lower
        // of the caller's budget and the tier limit; signing the tier limit
        // would hand out a clearance stronger than the verdict it accompanies.
        decision: {
          ...winnerDecision,
          policy: {
            ...winnerDecision.policy,
            maxValueUsdc: winner.recommendedMaxExposureUsdc,
          },
        },
        selectionHash: canonicalHash,
        issuedAt: createdAt,
        expiresAt: new Date(Math.min(
          Date.parse(expiresAt),
          Date.parse(winnerDecision.expiresAt),
        )).toISOString(),
      });
    } catch (error) {
      clearanceReason = error instanceof CounterpartySelectionError
        ? error.code
        : "clearance_signing_unavailable";
    }
  }

  /* The verdict, written down, because from here it may authorize a payment.
   *
   * This file was deliberately stateless, and the reasoning was sound while the
   * verdict was advice about a third-party endpoint: persisting it would have
   * implied a durable Veyra relationship that does not exist. It stops being
   * advice the moment Veyra's own relay moves money on the strength of it --
   * and until now the relay took every policy-bearing field back from the
   * browser, because there was nothing stored to check them against.
   *
   * Recorded only when there is a cleared winner with a payee: there is no
   * spend to authorize otherwise, and a row for a refusal would be a permission
   * slip for a decision that granted nothing.
   *
   * A failure to store is not a failure to advise. The caller still gets the
   * verdict; what it will not get is a quote, because the quote route refuses
   * a selection it cannot read back. The advisory surface keeps working and the
   * paying one stops, which is the correct way round. */
  if (
    winner && winnerDecision && winnerPayTo && winnerContext
    && (clearance || input.recordDecision === true)
    /* REVIEW_REQUIRED and DENY are verdicts too, and neither authorizes a
       spend. The project already has one definition of which levels may
       execute; using it rather than a second list here is what keeps the two
       from diverging the next time a level is added. */
    && isExecutableTrustDecision(winnerDecision.decision)
  ) {
    const winnerRanked = candidates.find(
      (item) => item.identity.agentId === winner.identity.agentId,
    );
    const stored = await recordX402Selection({
      selectionId,
      tenantKey: input.tenant.tenantKey,
      ownerWallet: getAddress(input.tenant.requesterWallet),
      requesterAgentId: input.tenant.requesterAgentId ?? null,
      candidateId: winnerContext.candidate.candidateId,
      resource: winnerContext.candidate.resource,
      /* The catalog publishes this per endpoint. The browser sent POST
         unconditionally, so a GET endpoint could be quoted as a POST -- one
         more thing the caller chose and the server accepted. */
      method: winnerContext.candidate.method,
      capability: request.capability,
      payTo: getAddress(winnerPayTo),
      settlementNetwork: winnerContext.candidate.selectedAccept.network,
      asset: getAddress(winnerContext.candidate.selectedAccept.asset),
      /* Atomic, never USDC decimals: a ceiling that rounds, rounds towards
         spending more. */
      maxExposureAtomic: BigInt(
        Math.round(winner.recommendedMaxExposureUsdc * 1_000_000),
      ).toString(),
      decision: winnerDecision.decision as "ALLOW" | "ALLOW_WITH_LIMITS" | "REQUIRE_EVALUATOR",
      verificationRequired: winnerDecision.decision !== "ALLOW",
      policyVersion: TRUST_POLICY_VERSION,
      evidenceHash: winnerRanked?.evidenceHash ?? null,
      selectionHash: canonicalHash,
      /* The digest and not the signature. The digest is what a reader checks
         the decision against; the signature is what acts on it, and nothing on
         this rail ever calls consumeClearance. */
      clearanceDigest: clearance?.clearanceDigest ?? null,
      createdAt,
      expiresAt,
    });
    if (!stored.stored) {
      console.warn("x402_selection_not_recorded", {
        selectionId,
        reason: stored.reason ?? "unknown",
      });
    }
  }

  const granted = Boolean(winner && clearance);
  const recommendation: MarketplaceSelection["recommendation"] = {
    granted,
    reason: granted
      ? "cleared"
      : winner
        ? (clearanceReason || "clearance_unavailable")
        : candidates.length > 0
          ? "no_eligible_counterparty"
          : "no_candidates_discovered",
    candidateId: winner?.identity.agentId ?? null,
    resource: winnerContext?.candidate.resource ?? null,
    payTo: winnerPayTo,
    priceUsdc: winnerContext?.candidate.priceUsdc ?? null,
    decision: winner ? (winner.trustDecision as TrustDecision["decision"]) : null,
    maxExposureUsdc: winner?.recommendedMaxExposureUsdc ?? 0,
    postCallVerificationRequired: winner ? winner.trustDecision !== "ALLOW" : false,
    funding: winnerContext?.candidate.funding ?? null,
    payableNow: winnerContext
      ? railReadiness({
          funding: winnerContext.candidate.funding,
          priceAtomic: BigInt(Math.round(winnerContext.candidate.priceUsdc * 1e6)),
          gatewayFundedAtomic,
        }).payableNow
      : null,
    routingNote: preferenceNote ?? route.note,
    explanation: winner && winnerContext
      ? [
          `${winnerContext.candidate.provider.name || winnerContext.candidate.origin} ranks ${winner.rankingScore}/100`,
          `on probe integrity ${winnerContext.probe.integrityScore}/100 with ${winner.confidence}% confidence.`,
          `No Arc settlement history exists for this counterparty, so trust is capped at ${winner.trustDecision}`,
          `with ${winner.recommendedMaxExposureUsdc.toFixed(6)} USDC maximum exposure.`,
        ].join(" ")
      : candidates.length > 0
        ? "No discovered endpoint satisfied the probe and policy checks."
        : "Circle's catalog returned no endpoint matching this capability, network and price ceiling.",
  };

  return {
    selectionId,
    source: MARKETPLACE_SOURCE,
    sourceVersion: MARKETPLACE_SOURCE_VERSION,
    selectionVersion: MARKETPLACE_SELECTION_VERSION,
    probeVersion: X402_PROBE_VERSION,
    policyVersion: TRUST_POLICY_VERSION,
    requester: {
      agentId: input.tenant.requesterAgentId,
      wallet: input.tenant.requesterWallet,
    },
    capability: request.capability,
    query: discovery.query,
    network: discovery.network,
    networkLabel: discovery.networkLabel,
    settlementNetworkIsArc: false,
    requestedBudgetUsdc: request.budgetUsdc,
    maxPriceUsdc: request.maxPriceUsdc ?? null,
    catalogTotal: discovery.catalogTotal,
    discovered: discovery.candidates.length,
    probed: probes.length,
    candidates,
    recommendation,
    clearance,
    canonicalHash,
    createdAt,
    expiresAt,
  };
}

export async function issueMarketplaceClearance(input: {
  decision: TrustDecision;
  selectionHash: Hex;
  issuedAt: string;
  expiresAt: string;
}): Promise<MarketplaceSelectionClearance> {
  const privateKey = process.env.VEYRA_TRUST_ATTESTER_PRIVATE_KEY
    || process.env.ERC8183_EVALUATOR_ATTESTER_PRIVATE_KEY;
  const gate = process.env.VEYRA_TRUST_GATE_ADDRESS;
  if (!privateKey || !/^0x[0-9a-f]{64}$/i.test(privateKey) || !gate || !isAddress(gate)) {
    throw new CounterpartySelectionError("clearance_signing_unavailable", 503);
  }
  const gateAddress = getAddress(gate);
  const decision: TrustDecision = { ...input.decision, issuedAt: input.issuedAt, expiresAt: input.expiresAt };
  decision.canonicalHash = computeCanonicalDecisionHash(decision);

  const signed = await signTrustClearance(
    decision,
    MARKETPLACE_CLEARANCE_CHAIN_ID,
    gateAddress,
    privateKey as Hex,
  );
  const verification = await verifyTrustClearanceOnchain(
    signed.clearanceMessage,
    signed.signature,
    gateAddress,
  );
  if (
    !verification.valid
    || !verification.signer
    || verification.signer.toLowerCase() !== signed.attester.toLowerCase()
  ) {
    throw new CounterpartySelectionError("clearance_onchain_verification_failed", 503);
  }

  return {
    clearanceId: `vcl_mkt_${randomBytes(8).toString("hex")}`,
    decisionId: decision.decisionId,
    clearanceDigest: signed.digest,
    selectionHash: input.selectionHash,
    chainId: MARKETPLACE_CLEARANCE_CHAIN_ID,
    verifyingContract: gateAddress,
    attester: getAddress(signed.attester),
    clearance: Object.fromEntries(
      Object.entries(signed.clearanceMessage).map(([key, value]) => [
        key,
        typeof value === "bigint" ? value.toString() : String(value),
      ]),
    ),
    signature: signed.signature,
    onchainVerified: true,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
  };
}
