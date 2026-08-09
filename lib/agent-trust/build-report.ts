import { createHash } from "node:crypto";
import { BRAND } from "../brand.ts";
import type { GitHubCategoryAssessment } from "../agent/github-due-diligence.ts";
import { createEvidenceItem, evidenceConfidence } from "./evidence.ts";
import { calculateTrustScore, scoreCategory } from "./scoring.ts";
import type {
  AgentTrustReport,
  AgentTrustReportInput,
  AgentTrustSourceSnapshots,
  EvidenceItem,
  ScoreCategory,
} from "./types.ts";

const CATEGORY_LABELS = {
  codeHealth: "Code Health",
  agentIdentity: "Agent Identity",
  executionReliability: "Execution Reliability",
  paymentHistory: "Payment History",
  serviceReliability: "Service Reliability",
  contractTransparency: "Contract Transparency",
} as const;

function average(values: number[]) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function evidence(
  input: Omit<EvidenceItem, "id">,
) {
  return createEvidenceItem(input);
}

function codeCategory(
  sources: AgentTrustSourceSnapshots,
): ScoreCategory {
  const assessment = sources.code.assessment;
  if (!assessment || sources.code.status !== "available") {
    return scoreCategory({
      score: null,
      confidence: "low",
      summary:
        sources.code.status === "not_provided"
          ? "Repository intelligence was not requested and did not affect the score."
          : "Repository intelligence was unavailable and did not affect the score.",
    });
  }
  const positiveSignals: EvidenceItem[] = [];
  const reviewItems: EvidenceItem[] = [];
  const values: number[] = [];
  for (const [name, category] of Object.entries(assessment.categories) as Array<
    [string, GitHubCategoryAssessment]
  >) {
    if (category.status === "unknown") continue;
    values.push(
      category.status === "strong"
        ? 90
        : category.status === "moderate"
          ? 70
          : 35,
    );
    const item = evidence({
      category: "code_health",
      signal: category.status === "weak" ? "review" : "positive",
      title: name.replace(/([a-z])([A-Z])/g, "$1 $2"),
      detail: category.summary,
      source: "GitHub Project Due Diligence",
      observedAt: sources.code.checkedAt,
    });
    (category.status === "weak" ? reviewItems : positiveSignals).push(item);
  }
  return scoreCategory({
    score: average(values),
    confidence: assessment.verdict.confidence,
    summary: assessment.overallSummary,
    positiveSignals,
    reviewItems,
  });
}

function identityCategory(
  sources: AgentTrustSourceSnapshots,
): ScoreCategory {
  const identity = sources.identity;
  if (identity.status !== "found") {
    const unavailable = identity.status === "unavailable";
    return scoreCategory({
      score: null,
      confidence: "low",
      summary: unavailable
        ? "The Veyra registry was unavailable; identity did not affect the score."
        : "Not found in Veyra registry. This is missing context, not an automatic risk penalty.",
      reviewItems: [
        evidence({
          category: "agent_identity",
          signal: "neutral",
          title: unavailable ? "Registry unavailable" : "Agent not registered",
          detail: unavailable
            ? "Try again or add another public data source."
            : "No matching public Agent ID or registered wallet was found.",
          source: `${BRAND.name} Agent Registry`,
          observedAt: identity.checkedAt,
        }),
      ],
    });
  }

  const positiveSignals: EvidenceItem[] = [];
  const reviewItems: EvidenceItem[] = [];
  const scored: number[] = [];
  const add = (
    title: string,
    detail: string,
    value: number,
    positive: boolean,
  ) => {
    scored.push(value);
    const item = evidence({
      category: "agent_identity",
      signal: positive ? "positive" : "review",
      title,
      detail,
      source: `${BRAND.name} Agent Registry`,
      observedAt: identity.checkedAt,
    });
    (positive ? positiveSignals : reviewItems).push(item);
  };
  add(
    "Registry record",
    `Public agent ${identity.publicAgentId} is registered in Veyra.`,
    80,
    true,
  );
  add(
    "Agent status",
    `Registry status is ${identity.agentStatus}.`,
    identity.agentStatus === "active"
      ? 100
      : identity.agentStatus === "suspended" ||
          identity.agentStatus === "revoked"
        ? 20
        : 50,
    identity.agentStatus === "active",
  );
  add(
    "Wallet verification",
    identity.ownerVerified
      ? "The registered agent wallet has a completed owner verification."
      : "A completed agent-wallet ownership verification was not found.",
    identity.ownerVerified ? 100 : 50,
    identity.ownerVerified === true,
  );
  add(
    "Agent Passport",
    identity.passportPresent
      ? "A Veyra Agent Passport is available."
      : "No Agent Passport is currently available.",
    identity.passportPresent ? 85 : 45,
    identity.passportPresent,
  );
  add(
    "Active credentials",
    `${identity.activeCredentialCount ?? 0} active credential(s) exist; no credential IDs or secret material are included.`,
    (identity.activeCredentialCount ?? 0) > 0 ? 80 : 50,
    (identity.activeCredentialCount ?? 0) > 0,
  );
  if (identity.identifierConflict) {
    add(
      "Identifier mismatch",
      "The supplied Agent ID and wallet resolve to different registry records.",
      10,
      false,
    );
  }
  return scoreCategory({
    score: average(scored),
    confidence: evidenceConfidence([...positiveSignals, ...reviewItems]),
    summary:
      reviewItems.length > 0
        ? "The registry provides usable identity evidence with items to review."
        : "The registry provides consistent identity and ownership signals.",
    positiveSignals,
    reviewItems,
  });
}

function executionCategory(
  sources: AgentTrustSourceSnapshots,
): ScoreCategory {
  const execution = sources.execution;
  if (
    execution.status === "unavailable" ||
    execution.status === "insufficient" ||
    execution.successRate === null
  ) {
    return scoreCategory({
      score: null,
      confidence: "low",
      summary:
        execution.status === "unavailable"
          ? "Execution history was unavailable and did not affect the score."
          : "Insufficient execution history. This category did not affect the score.",
    });
  }
  const positiveSignals: EvidenceItem[] = [];
  const reviewItems: EvidenceItem[] = [];
  const success = execution.successRate;
  const verification = execution.verificationCoverage;
  const successItem = evidence({
    category: "execution_reliability",
    signal: success >= 80 ? "positive" : "review",
    title: "Workflow completion rate",
    detail: `${success}% success rate across the available terminal workflow history.`,
    source:
      execution.status === "restricted"
        ? `${BRAND.name} Agent Passport aggregate`
        : `${BRAND.name} workflow history`,
    observedAt: execution.checkedAt,
  });
  (success >= 80 ? positiveSignals : reviewItems).push(successItem);
  if (verification !== null) {
    const item = evidence({
      category: "execution_reliability",
      signal: verification >= 75 ? "positive" : "review",
      title: "Verification coverage",
      detail: `${verification}% of the available completed history has verified proof coverage.`,
      source: `${BRAND.name} Arc proof aggregates`,
      observedAt: execution.checkedAt,
    });
    (verification >= 75 ? positiveSignals : reviewItems).push(item);
  }
  const score =
    verification === null
      ? success
      : success * 0.7 + verification * 0.3;
  return scoreCategory({
    score,
    confidence:
      execution.status === "restricted"
        ? "medium"
        : evidenceConfidence([...positiveSignals, ...reviewItems]),
    summary:
      execution.status === "restricted"
        ? "Only public Agent Passport aggregates were used; private runs remain isolated."
        : "Score reflects completed, failed, warning, and verified execution signals.",
    positiveSignals,
    reviewItems,
  });
}

function paymentCategory(
  sources: AgentTrustSourceSnapshots,
): ScoreCategory {
  const history = sources.execution;
  if (
    history.receiptsCount === null ||
    history.receiptsCount === 0 ||
    history.verificationCoverage === null
  ) {
    return scoreCategory({
      score: null,
      confidence: "low",
      summary:
        "Insufficient receipt and payment history. This category did not affect the score.",
    });
  }
  const verification = history.verificationCoverage;
  const receiptItem = evidence({
    category: "payment_history",
    signal: "positive",
    title: "Receipts recorded",
    detail: `${history.receiptsCount} receipt(s) and ${history.totalPaidUsdc ?? "unknown"} USDC in available workflow spend were recorded.`,
    source: `${BRAND.name} payment aggregates`,
    observedAt: history.checkedAt,
  });
  const proofItem = evidence({
    category: "payment_history",
    signal: verification >= 75 ? "positive" : "review",
    title: "Receipt proof coverage",
    detail: `${verification}% verification coverage was observed.`,
    source: `${BRAND.name} Arc proof aggregates`,
    observedAt: history.checkedAt,
  });
  return scoreCategory({
    score: 30 + verification * 0.7,
    confidence: "medium",
    summary:
      "Payment history is scored from safe receipt, spend, and verified-proof aggregates.",
    positiveSignals:
      verification >= 75 ? [receiptItem, proofItem] : [receiptItem],
    reviewItems: verification >= 75 ? [] : [proofItem],
  });
}

function serviceCategory(
  sources: AgentTrustSourceSnapshots,
): ScoreCategory {
  const positiveSignals: EvidenceItem[] = [];
  const reviewItems: EvidenceItem[] = [];
  const values: number[] = [];
  for (const service of sources.services.services) {
    const active = ["active", "live"].includes(service.status);
    values.push(active ? 85 : 35);
    const statusItem = evidence({
      category: "service_reliability",
      signal: active ? "positive" : "review",
      title: `${service.name} publication status`,
      detail: `Version ${service.version} is ${service.status} at ${service.priceUsdc} USDC.`,
      source: `${BRAND.name} public seller catalog`,
      observedAt: sources.services.checkedAt,
    });
    (active ? positiveSignals : reviewItems).push(statusItem);
    if (service.availabilityStatus !== "unknown") {
      const healthy = service.availabilityStatus === "healthy";
      values.push(
        healthy
          ? 90
          : service.availabilityStatus === "degraded"
            ? 60
            : 25,
      );
      const item = evidence({
        category: "service_reliability",
        signal: healthy ? "positive" : "review",
        title: `${service.name} availability`,
        detail: `Latest persisted service availability status is ${service.availabilityStatus}.`,
        source: `${BRAND.name} seller availability monitor`,
        observedAt: sources.services.checkedAt,
      });
      (healthy ? positiveSignals : reviewItems).push(item);
    }
    if (service.failureRate !== null) {
      const reliable = service.failureRate <= 10;
      values.push(100 - service.failureRate);
      const item = evidence({
        category: "service_reliability",
        signal: reliable ? "positive" : "review",
        title: `${service.name} execution outcomes`,
        detail: `${service.successfulExecutions ?? 0} successful execution(s) and ${service.failureRate}% failure/reversal rate are present in the persisted seller ledger aggregate.`,
        source: `${BRAND.name} seller revenue ledger aggregate`,
        observedAt: sources.services.checkedAt,
      });
      (reliable ? positiveSignals : reviewItems).push(item);
    }
    if (service.verifiedSettlementCount !== null) {
      positiveSignals.push(
        evidence({
          category: "service_reliability",
          signal: "positive",
          title: `${service.name} verified settlements`,
          detail: `${service.verifiedSettlementCount} settlement(s) reached the persisted settled state.`,
          source: `${BRAND.name} seller settlement aggregate`,
          observedAt: sources.services.checkedAt,
        }),
      );
    }
  }
  const endpoint = sources.endpoint;
  if (endpoint.status !== "not_provided") {
    const reachable = endpoint.reachable === true;
    values.push(reachable ? 75 : 25);
    const item = evidence({
      category: "service_reliability",
      signal: reachable ? "positive" : "review",
      title: "Endpoint Availability Snapshot",
      detail: reachable
        ? `One protected read-only check returned ${endpoint.httpStatusCategory ?? "an HTTP response"} in ${endpoint.responseTimeMs ?? "unknown"}ms. This is not an uptime measurement.`
        : `The protected one-request snapshot failed with ${endpoint.errorCategory ?? "endpoint_unreachable"}. This is not an uptime measurement.`,
      source: `${BRAND.name} SSRF-safe endpoint probe`,
      observedAt: endpoint.checkedAt,
    });
    (reachable ? positiveSignals : reviewItems).push(item);
  }
  if (values.length === 0) {
    return scoreCategory({
      score: null,
      confidence: "low",
      summary:
        sources.services.status === "unavailable"
          ? "Service signals were unavailable and did not affect the score."
          : "No linked services or endpoint snapshot were available.",
    });
  }
  return scoreCategory({
    score: average(values),
    confidence:
      values.length >= 3
        ? "medium"
        : "low",
    summary:
      "Service scoring uses persisted catalog/health signals and, when supplied, a single availability snapshot—not inferred uptime.",
    positiveSignals,
    reviewItems,
  });
}

function contractCategory(
  sources: AgentTrustSourceSnapshots,
): ScoreCategory {
  const contract = sources.contract;
  if (contract.status === "not_provided" || contract.status === "unavailable") {
    return scoreCategory({
      score: null,
      confidence: "low",
      summary:
        contract.status === "not_provided"
          ? "No Arc Testnet contract was supplied."
          : "Contract analysis unavailable; no mock data was substituted.",
    });
  }
  if (contract.status === "not_found") {
    const item = evidence({
      category: "contract_transparency",
      signal: "review",
      title: "Contract bytecode not found",
      detail: contract.providerMessage ?? "No bytecode was found on Arc Testnet.",
      source: "Arc Testnet JSON-RPC",
      observedAt: contract.checkedAt,
    });
    return scoreCategory({
      score: 10,
      confidence: "high",
      summary: "The supplied address did not contain contract bytecode on Arc Testnet.",
      reviewItems: [item],
    });
  }
  const positiveSignals = [
    evidence({
      category: "contract_transparency",
      signal: "positive",
      title: "Contract bytecode",
      detail: `${contract.bytecodeSize ?? "Unknown"} bytes of bytecode were returned by Arc Testnet.`,
      source: "Arc Testnet JSON-RPC",
      observedAt: contract.checkedAt,
    }),
  ];
  const reviewItems: EvidenceItem[] = [];
  if (contract.proxyDetected) {
    reviewItems.push(
      evidence({
        category: "contract_transparency",
        signal: "review",
        title: "EIP-1967 implementation detected",
        detail: `Implementation ${contract.implementationAddress}; review upgrade and admin controls independently.`,
        source: "Arc Testnet JSON-RPC",
        observedAt: contract.checkedAt,
      }),
    );
  }
  if (contract.verificationStatus === "unavailable") {
    reviewItems.push(
      evidence({
        category: "contract_transparency",
        signal: "neutral",
        title: "Source verification unavailable",
        detail: "Explorer source verification was not included in this snapshot.",
        source: `${BRAND.name} contract snapshot`,
        observedAt: contract.checkedAt,
      }),
    );
  }
  return scoreCategory({
    score: contract.proxyDetected ? 60 : 70,
    confidence: "medium",
    summary:
      "Contract Transparency Snapshot reports only confirmed bytecode and standard readable slots/functions; it does not claim safety.",
    positiveSignals,
    reviewItems,
  });
}

function reportHash(input: {
  reportId: string;
  sources: AgentTrustSourceSnapshots;
  score: ReturnType<typeof calculateTrustScore>;
}) {
  return `0x${createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")}`;
}

export function buildAgentTrustReport(input: {
  reportId: string;
  reportInput: AgentTrustReportInput;
  sources: AgentTrustSourceSnapshots;
  generatedAt?: string;
}): AgentTrustReport {
  const categories = {
    codeHealth: codeCategory(input.sources),
    agentIdentity: identityCategory(input.sources),
    executionReliability: executionCategory(input.sources),
    paymentHistory: paymentCategory(input.sources),
    serviceReliability: serviceCategory(input.sources),
    contractTransparency: contractCategory(input.sources),
  };
  const calculatedScore = calculateTrustScore(categories);
  const compliance = input.sources.arcCompliance;
  const complianceEvidence = compliance.status === "not_provided"
    ? []
    : [evidence({
        category: "agent_identity",
        signal: compliance.status === "clear"
          ? "positive"
          : compliance.status === "blocklisted"
            ? "review"
            : "neutral",
        title: compliance.status === "blocklisted"
          ? "Arc USDC blocklist restriction"
          : "Arc USDC blocklist status",
        detail: compliance.status === "clear"
          ? "The supplied agent wallet was not blocklisted by the Arc USDC contract at the recorded check time."
          : compliance.status === "blocklisted"
            ? "The supplied agent wallet is blocklisted by the Arc USDC contract; Arc rejects USDC transfers involving it."
            : "The Arc USDC blocklist status could not be verified, so no clear result was inferred.",
        source: compliance.source,
        observedAt: compliance.checkedAt,
      })];
  const trustScore = compliance.status === "blocklisted"
    ? {
        ...calculatedScore,
        overall: calculatedScore.overall === null
          ? 0
          : Math.min(calculatedScore.overall, 20),
        status: "high_attention" as const,
      }
    : calculatedScore;
  const evidenceItems = [
    ...Object.values(categories).flatMap((category) => [
    ...category.positiveSignals,
    ...category.reviewItems,
    ]),
    ...complianceEvidence,
  ];
  const strengths = evidenceItems.filter((item) => item.signal === "positive");
  const reviews = evidenceItems.filter((item) => item.signal === "review");
  const identity = input.sources.identity;
  const repository = input.sources.code.repository;
  const subjectName =
    identity.displayName ??
    identity.publicAgentId ??
    repository?.fullName ??
    input.reportInput.agentWallet ??
    "Agent or agent-powered project";
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const excluded = trustScore.excludedCategories
    .map((key) => CATEGORY_LABELS[key as keyof typeof CATEGORY_LABELS] ?? key);
  const executiveSummary = [
    `${BRAND.name} evaluated ${subjectName} using ${evidenceItems.length} evidence item(s) from the sources available for this snapshot.`,
    trustScore.overall === null
      ? "There were fewer than two scorable categories, so no overall Trust Score was produced."
      : `The deterministic Trust Score is ${trustScore.overall}/100 with status ${trustScore.status.replaceAll("_", " ")}.`,
    strengths.length > 0
      ? `The strongest observed signal is: ${strengths[0].detail}`
      : "No strong signal was inferred where supporting data was unavailable.",
    reviews.length > 0
      ? `The leading review item is: ${reviews[0].detail}`
      : "No material review item was found in the collected evidence, but independent review is still required.",
    excluded.length > 0
      ? `Categories excluded from the overall score due to missing evidence: ${excluded.join(", ")}.`
      : "All configured score categories contributed evidence.",
  ];
  const unavailableSources = [
    input.sources.code.status === "unavailable" ? "GitHub intelligence" : null,
    input.sources.identity.status === "unavailable"
      ? `${BRAND.name} Agent Registry`
      : null,
    input.sources.execution.status === "unavailable" ? "Execution history" : null,
    input.sources.services.status === "unavailable" ? "Seller services" : null,
    input.sources.contract.status === "unavailable" ? "Arc contract provider" : null,
    input.sources.endpoint.status === "unreachable" ? "Service endpoint" : null,
    input.sources.arcCompliance.status === "unknown" ? "Arc USDC blocklist" : null,
  ].filter((value): value is string => Boolean(value));
  const hash = reportHash({
    reportId: input.reportId,
    sources: input.sources,
    score: trustScore,
  });

  return {
    kind: "agent_trust_report",
    version: 1,
    workflowType: "agent_trust_report",
    reportId: input.reportId,
    input: input.reportInput,
    subject: {
      name: subjectName,
      agentId: identity.publicAgentId,
      wallet: identity.registeredWallet ?? input.reportInput.agentWallet ?? null,
      repository,
    },
    trustScore,
    executiveSummary,
    identity,
    codeIntelligence: input.sources.code,
    executionReliability: input.sources.execution,
    paymentsAndReceipts: input.sources.execution,
    services: input.sources.services,
    contractTransparency: input.sources.contract,
    endpointAvailability: input.sources.endpoint,
    arcCompliance: input.sources.arcCompliance,
    evidenceBackedStrengths: strengths,
    risksAndReviewItems: reviews,
    questionsBeforeIntegration: [
      "Do the registered identity and wallet match the agent you intend to use?",
      "Are the observed execution and verification coverage sufficient for your risk tolerance?",
      repository
        ? "Have you reviewed the full GitHub Due Diligence report and current source code?"
        : "Can the operator provide a public repository or equivalent implementation evidence?",
      input.sources.contract.status === "available"
        ? "Who controls any readable owner, admin, pause, or upgrade capability?"
        : "Is there a relevant Arc Testnet contract that should be reviewed separately?",
      "What operational fallback exists if the agent or its services become unavailable?",
      compliance.status === "clear"
        ? "Will you recheck the Arc USDC blocklist immediately before payment?"
        : "Can the Arc USDC blocklist status be cleared or independently reverified before payment?",
    ],
    evidence: evidenceItems,
    dataFreshness: [
      ...(input.sources.code.snapshot
        ? [{
            source: "GitHub REST API v3",
            fetchedAt: input.sources.code.snapshot.source.fetchedAt,
            cacheMode: input.sources.code.snapshot.source.cacheHit
              ? "cached"
              : "live",
            upstreamStatus: input.sources.code.snapshot.source.upstreamStatus,
          }]
        : []),
      {
        source: `${BRAND.name} Agent Registry`,
        fetchedAt: input.sources.identity.checkedAt,
        cacheMode: "server_read",
        upstreamStatus: input.sources.identity.status,
      },
      {
        source: `${BRAND.name} workflow and receipt aggregates`,
        fetchedAt: input.sources.execution.checkedAt,
        cacheMode: "server_read",
        upstreamStatus: input.sources.execution.status,
      },
      ...(input.reportInput.contractAddress
        ? [{
            source: "Arc Testnet JSON-RPC",
            fetchedAt: input.sources.contract.checkedAt,
            cacheMode: "live_read",
            upstreamStatus: input.sources.contract.status,
          }]
        : []),
      ...(input.reportInput.serviceEndpoint
        ? [{
            source: "Endpoint Availability Snapshot",
            fetchedAt: input.sources.endpoint.checkedAt,
            cacheMode: "single_live_request",
            upstreamStatus: input.sources.endpoint.status,
          }]
        : []),
      ...(compliance.status !== "not_provided"
        ? [{
            source: compliance.source,
            fetchedAt: compliance.checkedAt,
            cacheMode: "live_read",
            upstreamStatus: compliance.status,
          }]
        : []),
    ],
    unavailableSources,
    limitations: [
      "This report is not a security audit or vulnerability scan.",
      "The Trust Score is an evidence summary, not a guarantee of trust, safety, availability, or future behavior.",
      "This report is not an investment recommendation.",
      "A single endpoint request is an availability snapshot and must not be interpreted as uptime.",
      "Missing optional data is excluded from scoring rather than treated as a zero.",
      "Private tenant runs, credential identifiers, credential hashes, secrets, raw provider errors, and private seller configuration are not included.",
    ],
    githubDueDiligenceReportUrl: repository
      ? `/agent-runner?workflow=github_due_diligence&repository=${encodeURIComponent(repository.canonicalUrl)}`
      : null,
    verification: {
      status: "verification_pending",
      verifiedOnArc: false,
      network: "arc-testnet",
      chainId: 5_042_002,
      reportHash: hash,
      proofs: [],
    },
    generatedAt,
  };
}

export function applyAgentTrustVerification(
  report: AgentTrustReport,
  proofs: Array<{
    receiptId: string;
    status: "pending" | "verified" | "failed";
    transactionHash: string | null;
    transactionUrl?: string | null;
    explorerUrl?: string | null;
    responseHash?: string | null;
  }>,
): AgentTrustReport {
  const expectedReportHash = report.verification.reportHash.toLowerCase();
  const reportProofs = proofs.filter(
    (proof) => proof.responseHash?.toLowerCase() === expectedReportHash,
  );
  const hasFailed = reportProofs.some((proof) => proof.status === "failed");
  const verified =
    reportProofs.length > 0 &&
    reportProofs.every((proof) => proof.status === "verified");
  return {
    ...report,
    verification: {
      ...report.verification,
      status: hasFailed
        ? "verification_failed"
        : verified
          ? "verified"
          : "verification_pending",
      verifiedOnArc: verified,
      proofs: reportProofs.map((proof) => ({
        receiptId: proof.receiptId,
        status: proof.status,
        transactionHash: proof.transactionHash,
        explorerUrl: proof.transactionUrl ?? proof.explorerUrl ?? null,
      })),
    },
  };
}
