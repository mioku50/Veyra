/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GitHubRepositorySnapshot, DataConfidence } from "../providers/github-types.ts";
import {
  analyzeGitHubDueDiligence,
  type GitHubDueDiligenceAssessment,
  type GitHubCategoryAssessment,
  type DueDiligenceOverallStatus,
  type GitHubDueDiligenceVerdict,
  type RiskSeverity,
  LIMITATIONS_DISCLAIMER,
} from "../agent/github-due-diligence.ts";
import { BRAND } from "../brand.ts";

export interface NumericMetric {
  value: number;
  isLowerBound?: boolean;
  confidence: DataConfidence;
}

export interface HostedWorkflowArcProofItem {
  receiptId?: string;
  txHash: string | null;
  status: string;
  explorerUrl: string | null;
  blockNumber?: number | null;
  contractAddress?: string | null;
}

export interface HostedWorkflowReceiptItem {
  receiptId: string;
  serviceSlug: string;
  serviceName: string;
  priceUsdc: string;
  status: string;
}

export interface BuildGitHubPublicReportInput {
  jobId: string;
  workflow?: string;
  status?: string;
  repository?: {
    fullName: string;
    canonicalUrl: string;
  } | null;
  snapshot: GitHubRepositorySnapshot | null;
  assessment: GitHubDueDiligenceAssessment | null;
  proofs?: HostedWorkflowArcProofItem[];
  receipts?: HostedWorkflowReceiptItem[];
  generatedAt?: string;
}

export interface GitHubPublicReport {
  reportId: string;
  workflow: string;
  status: string;
  repository: {
    fullName: string;
    canonicalUrl: string;
  } | null;
  overallStatus: DueDiligenceOverallStatus;
  verdict: GitHubDueDiligenceVerdict | null;
  executiveSummary: string;
  confidence: DataConfidence;
  generatedAt: string;

  // 15 Evidence Sections:
  projectPurpose: {
    summary: string;
    primaryInterface: string;
    developmentStage: string;
    targetUsers: string;
    capabilities: string[];
  };

  architectureAndTechnology: {
    primaryLanguage: string;
    defaultBranch: string;
    licenseName: string;
    languages: Record<string, number>;
    manifests: string[];
    detectedCapabilities: string[];
    sourceDirectories: string[];
    testDirectories: string[];
    entrypoints: string[];
    dockerFiles: string[];
    frameworks: string[];
    hasWorkflows: boolean;
    workflowCount: NumericMetric;
  };

  developmentActivity: {
    lastCommitAt: string | null;
    commitCount30d: NumericMetric;
    commitCount90d: NumericMetric;
    commitCount180d: NumericMetric;
    recentCommitCount: NumericMetric;
  };

  contributors: {
    sampledCount: NumericMetric;
    sampledHumanCount: NumericMetric;
    sampledBotCount: NumericMetric;
    topHumanMaintainerShare: NumericMetric;
    botContributionShare: NumericMetric;
    topContributors: Array<{
      login: string;
      contributions: number;
      isBot?: boolean;
      accountType?: string;
    }>;
  };

  automationAccounts: {
    botCount: NumericMetric;
    botContributionShare: NumericMetric;
    botLogins: string[];
    hasHeavyAutomation: boolean;
    summary: string;
  };

  engineeringQuality: {
    testing: GitHubCategoryAssessment;
    dependencyHygiene: GitHubCategoryAssessment;
    documentationDepth: GitHubCategoryAssessment;
    deploymentReadiness: GitHubCategoryAssessment;
    operationalMaturity: GitHubCategoryAssessment;
  };

  documentationAndGovernance: {
    hasReadme: boolean;
    hasLicense: boolean;
    hasSecurityPolicy: boolean;
    hasContributing: boolean;
    hasCodeOfConduct: boolean;
    hasCodeowners: boolean;
    hasWorkflows: boolean;
    readmeSize: NumericMetric;
    summary: string;
  };

  releasesAndMaintenance: {
    totalReleases: NumericMetric;
    releases90d: NumericMetric;
    latestReleaseTag: string | null;
    latestReleasePublishedAt: string | null;
    maintenance: GitHubCategoryAssessment;
  };

  strengths: string[];

  risks: Array<{
    code: string;
    title: string;
    severity: RiskSeverity | string;
    description: string;
    impact: string;
  }>;

  questionsBeforeAdoption: string[];

  evidenceAndFreshness: {
    dataProvider: string;
    cacheHit: boolean;
    cacheAgeSeconds: number | null;
    fetchedAt: string | null;
    upstreamStatus: string;
  };

  limitations: {
    disclaimer: string;
    analyzedAt: string | null;
  };

  categoryConfidence: Record<string, DataConfidence>;

  verification: {
    status: string;
    network: string;
    proofs: HostedWorkflowArcProofItem[];
    receipts: HostedWorkflowReceiptItem[];
    verifiedSteps: number;
    requiredSteps: number;
  };

  // Backward compatibility shortcuts
  technology: {
    primaryLanguage: string;
    frameworks: string[];
    hasWorkflows: boolean;
    workflowCount: number;
  };

  activity: {
    commitCount30d: number;
    commitCount90d: number;
    commitCount180d: number;
    lastCommitAt: string | null;
  };
}

function defaultCategoryAssessment(summary: string): GitHubCategoryAssessment {
  return {
    status: "unknown",
    confidence: "low",
    summary,
    evidence: [],
  };
}

export function buildGitHubPublicReport(
  input: BuildGitHubPublicReportInput,
): GitHubPublicReport {
  const snapshot = input.snapshot;
  const assessment =
    input.assessment?.verdict
      ? input.assessment
      : snapshot
        ? analyzeGitHubDueDiligence(snapshot)
        : input.assessment;

  const globalConfidence: DataConfidence =
    !snapshot ||
    snapshot.source?.upstreamStatus === "fallback" ||
    snapshot.source?.partial
      ? "low"
      : "high";

  // 1. Repository Info & Purpose
  const repoFullName =
    input.repository?.fullName || snapshot?.repository?.fullName || "Target Repository";
  const repoCanonicalUrl =
    input.repository?.canonicalUrl ||
    snapshot?.ref?.canonicalUrl ||
    (snapshot?.repository?.fullName
      ? `https://github.com/${snapshot.repository.fullName}`
      : `https://github.com/${repoFullName}`);

  const repository = input.repository || {
    fullName: repoFullName,
    canonicalUrl: repoCanonicalUrl,
  };

  const projectPurpose = {
    summary:
      snapshot?.projectPurpose?.summary ||
      snapshot?.repository?.description ||
      "Repository health and due diligence analysis.",
    primaryInterface: snapshot?.projectPurpose?.primaryInterface || "Unspecified interface",
    developmentStage: snapshot?.projectPurpose?.developmentStage || "Active project",
    targetUsers:
      snapshot?.projectPurpose?.targetUsers ||
      "General developers & open-source community",
    capabilities: snapshot?.projectPurpose?.capabilities || [],
  };

  // 2. Architecture & Technology
  const architectureAndTechnology = {
    primaryLanguage: snapshot?.stack?.primaryLanguage || "Unknown",
    defaultBranch: snapshot?.repository?.defaultBranch || "main",
    licenseName:
      snapshot?.repository?.license?.name ||
      (snapshot?.documentation?.hasLicense ? "Detected" : "None detected"),
    languages: snapshot?.stack?.languages || {},
    manifests: snapshot?.dependencyProfile?.manifests || [],
    detectedCapabilities: snapshot?.dependencyProfile?.detectedCapabilities || [],
    sourceDirectories: snapshot?.repositoryStructure?.sourceDirectories || [],
    testDirectories: snapshot?.repositoryStructure?.testDirectories || [],
    entrypoints: snapshot?.repositoryStructure?.entrypoints || [],
    dockerFiles: snapshot?.repositoryStructure?.dockerFiles || [],
    frameworks: snapshot?.stack?.detectedFrameworks || [],
    hasWorkflows: Boolean(snapshot?.stack?.hasWorkflows),
    workflowCount: {
      value: snapshot?.stack?.workflowCount ?? 0,
      confidence: globalConfidence,
    },
  };

  // 3. Development Activity
  const developmentActivity = {
    lastCommitAt: snapshot?.activity?.lastCommitAt ?? null,
    commitCount30d: {
      value: snapshot?.activity?.commitCount30d ?? 0,
      isLowerBound: snapshot?.activity?.commitCount30dIsLowerBound,
      confidence: globalConfidence,
    },
    commitCount90d: {
      value: snapshot?.activity?.commitCount90d ?? 0,
      isLowerBound: snapshot?.activity?.commitCount90dIsLowerBound,
      confidence: globalConfidence,
    },
    commitCount180d: {
      value: snapshot?.activity?.commitCount180d ?? 0,
      isLowerBound: snapshot?.activity?.commitCount180dIsLowerBound,
      confidence: globalConfidence,
    },
    recentCommitCount: {
      value: snapshot?.activity?.recentCommitCount ?? 0,
      confidence: globalConfidence,
    },
  };

  // 4. Contributors
  const topContributors = snapshot?.contributors?.topContributors || [];
  const humanContributors = topContributors.filter(
    (c) => !c.isBot && c.accountType !== "bot",
  );
  const botContributors = topContributors.filter(
    (c) => c.isBot || c.accountType === "bot",
  );

  const sampledCount =
    snapshot?.contributors?.sampledCount ?? topContributors.length;
  const sampledHumanCount =
    snapshot?.contributors?.sampledHumanContributorCount ?? humanContributors.length;
  const sampledBotCount =
    snapshot?.contributors?.sampledBotContributorCount ?? botContributors.length;

  const topHumanMaintainerShare =
    snapshot?.contributors?.topHumanContributorShare ??
    snapshot?.contributors?.sampledTopContributorShare ??
    0;
  const botContributionShare = snapshot?.contributors?.botContributionShare ?? 0;

  const contributors = {
    sampledCount: { value: sampledCount, confidence: globalConfidence },
    sampledHumanCount: { value: sampledHumanCount, confidence: globalConfidence },
    sampledBotCount: { value: sampledBotCount, confidence: globalConfidence },
    topHumanMaintainerShare: {
      value: topHumanMaintainerShare,
      confidence: globalConfidence,
    },
    botContributionShare: {
      value: botContributionShare,
      confidence: globalConfidence,
    },
    topContributors: topContributors.map((c) => ({
      login: c.login,
      contributions: c.contributions,
      isBot: c.isBot || c.accountType === "bot",
      accountType: c.accountType || (c.isBot ? "bot" : "user"),
    })),
  };

  // 5. Automation Accounts
  const hasHeavyAutomation = botContributionShare >= 50;
  const automationAccounts = {
    botCount: { value: sampledBotCount, confidence: globalConfidence },
    botContributionShare: {
      value: botContributionShare,
      confidence: globalConfidence,
    },
    botLogins: botContributors.map((c) => c.login),
    hasHeavyAutomation,
    summary: hasHeavyAutomation
      ? "Automation-heavy contribution history: A significant portion of repository contributions originate from automated bot accounts."
      : "Standard maintainer and bot contribution distribution.",
  };

  // 6. Engineering Quality
  const defaultEq = defaultCategoryAssessment("Category evaluation pending");
  const engineeringQuality = {
    testing: assessment?.categories?.testing || defaultEq,
    dependencyHygiene: assessment?.categories?.dependencyHygiene || defaultEq,
    documentationDepth: assessment?.categories?.documentationDepth || defaultEq,
    deploymentReadiness: assessment?.categories?.deploymentReadiness || defaultEq,
    operationalMaturity: assessment?.categories?.operationalMaturity || defaultEq,
  };

  // 7. Documentation & Governance
  const documentationAndGovernance = {
    hasReadme: Boolean(snapshot?.documentation?.hasReadme),
    hasLicense: Boolean(snapshot?.documentation?.hasLicense),
    hasSecurityPolicy: Boolean(snapshot?.documentation?.hasSecurityPolicy),
    hasContributing: Boolean(snapshot?.documentation?.hasContributing),
    hasCodeOfConduct: Boolean(snapshot?.documentation?.hasCodeOfConduct),
    hasCodeowners: Boolean(snapshot?.documentation?.hasCodeowners),
    hasWorkflows: Boolean(snapshot?.stack?.hasWorkflows),
    readmeSize: {
      value: snapshot?.documentation?.readmeSize ?? 0,
      confidence: globalConfidence,
    },
    summary:
      assessment?.categories?.documentation?.summary ||
      "Governance files documentation analysis complete.",
  };

  // 8. Releases & Maintenance
  const releasesAndMaintenance = {
    totalReleases: {
      value: snapshot?.releases?.totalCount ?? 0,
      confidence: globalConfidence,
    },
    releases90d: {
      value: snapshot?.releases?.releaseCount90d ?? 0,
      confidence: globalConfidence,
    },
    latestReleaseTag: snapshot?.releases?.latestRelease?.tagName || null,
    latestReleasePublishedAt:
      snapshot?.releases?.latestRelease?.publishedAt || null,
    maintenance: assessment?.categories?.maintenance || defaultEq,
  };

  // 9. Strengths
  const strengths = assessment?.strengths || [];

  // 10. Risks
  const risks = (assessment?.risks || []).map((r) => ({
    code: String(r.code || "risk_factor"),
    title: String(r.title || "Identified Risk"),
    severity: (r.severity || "medium") as RiskSeverity,
    description: String(r.description || ""),
    impact: String(r.impact || ""),
  }));

  // 11. Questions Before Adoption
  const questionsBeforeAdoption = assessment?.suggestedQuestions || [];

  // 12. Evidence & Data Freshness
  const evidenceAndFreshness = {
    dataProvider: snapshot?.source?.provider || "GitHub REST API v3",
    cacheHit: Boolean(snapshot?.source?.cacheHit),
    cacheAgeSeconds: snapshot?.source?.cacheAgeSeconds ?? null,
    fetchedAt: snapshot?.source?.fetchedAt || null,
    upstreamStatus: snapshot?.source?.upstreamStatus || "success",
  };

  // 13. Limitations
  const limitations = {
    disclaimer: assessment?.limitationsDisclaimer || LIMITATIONS_DISCLAIMER,
    analyzedAt: assessment?.analyzedAt || new Date().toISOString(),
  };

  // 14. Category Confidence
  const categoryConfidence: Record<string, DataConfidence> = {};
  if (assessment?.categories) {
    for (const [key, val] of Object.entries(assessment.categories)) {
      categoryConfidence[key] = (val as GitHubCategoryAssessment).confidence || globalConfidence;
    }
  } else {
    const categoriesList = [
      "activity",
      "maintenance",
      "documentation",
      "releaseDiscipline",
      "contributorDistribution",
      "automation",
      "testing",
      "dependencyHygiene",
      "documentationDepth",
      "deploymentReadiness",
      "operationalMaturity",
    ];
    for (const key of categoriesList) {
      categoryConfidence[key] = globalConfidence;
    }
  }

  // 15. Verification
  const proofs = input.proofs || [];
  const receipts = input.receipts || [];
  const verifiedProofs = proofs.filter(
    (p) => p.status === "verified" && Boolean(p.txHash),
  );
  const hasFailedProof = proofs.some((p) => p.status === "failed");
  const requiredSteps =
    receipts.length > 0 ? receipts.length : Math.max(proofs.length, 1);
  const verifiedSteps = verifiedProofs.length;

  let verificationStatus: string;
  if (hasFailedProof || (input.status === "failed" && verifiedSteps === 0)) {
    verificationStatus = "verification_failed";
  } else if (verifiedSteps > 0 && verifiedSteps >= requiredSteps) {
    verificationStatus = "verified";
  } else if (verifiedSteps > 0 && verifiedSteps < requiredSteps) {
    verificationStatus = "partially_verified";
  } else {
    verificationStatus = "verification_pending";
  }

  const verification = {
    status: verificationStatus,
    network: "arc-testnet",
    proofs,
    receipts,
    verifiedSteps,
    requiredSteps,
  };

  const executiveSummary =
    assessment?.overallSummary ||
    projectPurpose.summary ||
    "Repository due diligence analysis completed.";

  const overallStatus = assessment?.overallStatus || "healthy_signals";
  const generatedAt = input.generatedAt || new Date().toISOString();

  return {
    reportId: input.jobId,
    workflow: input.workflow || "github_due_diligence",
    status: input.status || "completed",
    repository,
    overallStatus,
    verdict: assessment?.verdict ?? null,
    executiveSummary,
    confidence: globalConfidence,
    generatedAt,

    projectPurpose,
    architectureAndTechnology,
    developmentActivity,
    contributors,
    automationAccounts,
    engineeringQuality,
    documentationAndGovernance,
    releasesAndMaintenance,
    strengths,
    risks,
    questionsBeforeAdoption,
    evidenceAndFreshness,
    limitations,
    categoryConfidence,
    verification,

    // Backward compatibility shortcuts
    technology: {
      primaryLanguage: architectureAndTechnology.primaryLanguage,
      frameworks: architectureAndTechnology.frameworks,
      hasWorkflows: architectureAndTechnology.hasWorkflows,
      workflowCount: architectureAndTechnology.workflowCount.value,
    },
    activity: {
      commitCount30d: developmentActivity.commitCount30d.value,
      commitCount90d: developmentActivity.commitCount90d.value,
      commitCount180d: developmentActivity.commitCount180d.value,
      lastCommitAt: developmentActivity.lastCommitAt,
    },
  };
}

export function formatGitHubPublicReportAsMarkdown(
  report: GitHubPublicReport,
): string {
  const repoHeader = report.repository
    ? `[${report.repository.fullName}](${report.repository.canonicalUrl})`
    : report.workflow;

  const strengthsList =
    report.strengths.length > 0
      ? report.strengths.map((s) => `- ${s}`).join("\n")
      : "- None noted.";

  const risksList =
    report.risks.length > 0
      ? report.risks
          .map(
            (r) =>
              `- **[${String(r.severity).toUpperCase()}]** ${r.title} (\`${r.code}\`)\n  ${r.description}\n  *Impact:* ${r.impact}`,
          )
          .join("\n")
      : "- No significant risk factors identified.";

  const questionsList =
    report.questionsBeforeAdoption.length > 0
      ? report.questionsBeforeAdoption.map((q) => `- ${q}`).join("\n")
      : "- Standard integration review recommended.";

  const proofsList =
    report.verification.proofs.length > 0
      ? report.verification.proofs
          .map(
            (p) =>
              `- ${p.txHash ? `\`${p.txHash}\`` : p.receiptId ? `Receipt \`${p.receiptId}\`` : "Proof record"} (${p.status})${p.explorerUrl ? ` — [View Arc Proof](${p.explorerUrl})` : ""}`,
          )
          .join("\n")
      : "- No on-chain proof metadata recorded.";

  return `# GitHub Due Diligence Report: ${repoHeader}

**Report ID:** \`${report.reportId}\`  
**Workflow:** \`${report.workflow}\`  
**Status:** \`${report.status}\`  
**Confidence:** \`${report.confidence}\`  
**Generated At:** ${report.generatedAt}
**Generated by:** ${BRAND.name}

---

## Verdict
${report.verdict ? `**${report.verdict.label}** (\`${report.verdict.code}\`, ${report.verdict.confidence} confidence)

${report.verdict.summary}

${report.verdict.reasons.map((reason) => `- ${reason}`).join("\n")}` : "A verdict could not be produced from the available evidence."}

## Executive Summary
${report.executiveSummary}

## Project Purpose
${report.projectPurpose.summary}

## Architecture & Technology
- **Primary Language:** ${report.architectureAndTechnology.primaryLanguage}
- **Frameworks:** ${report.architectureAndTechnology.frameworks.join(", ") || "None detected"}
- **Automated Workflows:** ${report.architectureAndTechnology.hasWorkflows ? `${report.architectureAndTechnology.workflowCount.value} GitHub Actions workflow(s)` : "None detected"}

## Development Activity
- **Commits (30d):** ${report.developmentActivity.commitCount30d.value}
- **Commits (90d):** ${report.developmentActivity.commitCount90d.value}
- **Commits (180d):** ${report.developmentActivity.commitCount180d.value}
- **Latest Commit:** ${report.developmentActivity.lastCommitAt || "N/A"}

## Verified Strengths
${strengthsList}

## Identified Risks
${risksList}

## Suggested Questions Before Adoption
${questionsList}

---

## Verification & Arc Proofs
- **Verification Status:** \`${report.verification.status}\`
- **Network:** \`${report.verification.network}\`

${proofsList}
`;
}
