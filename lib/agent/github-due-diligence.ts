/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GitHubRepositorySnapshot, DataConfidence } from "@/lib/providers/github-types";

export type AssessmentStatus = "strong" | "moderate" | "weak" | "unknown";

export type DueDiligenceOverallStatus =
  | "healthy_signals"
  | "review_needed"
  | "high_attention"
  | "limited_data";

export type RiskSeverity = "high" | "medium" | "low" | "info";

export type DueDiligenceVerdictCode =
  | "proceed_with_standard_review"
  | "proceed_with_conditions"
  | "pause_for_review"
  | "insufficient_evidence";

export interface GitHubDueDiligenceVerdict {
  code: DueDiligenceVerdictCode;
  label: string;
  confidence: DataConfidence;
  summary: string;
  reasons: string[];
  blockingFindings: string[];
  evidenceCoverage: {
    assessedCategories: number;
    highConfidenceCategories: number;
    totalCategories: number;
    ratio: number;
  };
}

export type GitHubDueDiligenceRiskCode =
  | "repository_archived"
  | "stale_development"
  | "low_recent_activity"
  | "missing_license"
  | "missing_readme"
  | "single_contributor_concentration"
  | "missing_security_policy"
  | "no_ci_detected"
  | "repository_is_fork"
  | "no_github_releases"
  | "automation_heavy_history";

export interface GitHubDueDiligenceRisk {
  code: GitHubDueDiligenceRiskCode | string;
  title: string;
  severity: RiskSeverity;
  description: string;
  impact: string;
}

export interface GitHubCategoryAssessment {
  status: AssessmentStatus;
  confidence: DataConfidence;
  summary: string;
  evidence: string[];
}

export interface GitHubDueDiligenceCategories {
  activity: GitHubCategoryAssessment;
  maintenance: GitHubCategoryAssessment;
  documentation: GitHubCategoryAssessment;
  releaseDiscipline: GitHubCategoryAssessment;
  contributorDistribution: GitHubCategoryAssessment;
  automation: GitHubCategoryAssessment;
  testing: GitHubCategoryAssessment;
  dependencyHygiene: GitHubCategoryAssessment;
  documentationDepth: GitHubCategoryAssessment;
  deploymentReadiness: GitHubCategoryAssessment;
  operationalMaturity: GitHubCategoryAssessment;
}

export interface GitHubDueDiligenceAssessment {
  overallStatus: DueDiligenceOverallStatus;
  overallSummary: string;
  verdict: GitHubDueDiligenceVerdict;
  categories: GitHubDueDiligenceCategories;
  risks: GitHubDueDiligenceRisk[];
  strengths: string[];
  suggestedQuestions: string[];
  limitationsDisclaimer: string;
  analyzedAt: string;
  /** Public, deterministic signals retained by Project 360 monitoring snapshots. */
  monitoringSignals?: {
    commitCount30d: number;
    commitCount90d: number;
    sampledHumanContributorCount: number;
    hasSecurityPolicy: boolean;
    hasLicense: boolean;
    workflowCount: number;
    latestReleaseTag: string | null;
    latestReleaseAt: string | null;
    isArchived: boolean;
    pushedAt: string | null;
  };
}

export const LIMITATIONS_DISCLAIMER =
  "This is a repository health and activity report based on public GitHub metadata. It is NOT a security audit, code vulnerability scan, or investment recommendation. Always review source code independently before deploying to production.";

export function analyzeGitHubDueDiligence(
  snapshot: GitHubRepositorySnapshot,
): GitHubDueDiligenceAssessment {
  const refDate = snapshot.source?.fetchedAt
    ? new Date(snapshot.source.fetchedAt)
    : new Date();
  const refTime = isNaN(refDate.getTime()) ? Date.now() : refDate.getTime();

  // Helper for days calculation
  const getDaysAgo = (dateStr: string | null | undefined): number | null => {
    if (!dateStr) return null;
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    return Math.max(0, Math.floor((refTime - d.getTime()) / (1000 * 60 * 60 * 24)));
  };

  const lastCommitDays = getDaysAgo(snapshot.activity?.lastCommitAt);
  const lastPushDays = getDaysAgo(snapshot.repository?.pushedAt);
  const effectiveLastDays =
    lastCommitDays !== null && lastPushDays !== null
      ? Math.min(lastCommitDays, lastPushDays)
      : (lastCommitDays ?? lastPushDays);

  const isFallback = snapshot.source?.upstreamStatus === "fallback";

  // --- 1. Category Assessments ---

  // Development Activity
  let activityStatus: AssessmentStatus = "unknown";
  let activitySummary = "";
  const activityEvidence: string[] = [];

  if (isFallback) {
    activityStatus = "unknown";
    activitySummary = "Activity data is incomplete due to upstream fallback mode.";
    activityEvidence.push("GitHub API returned partial or fallback snapshot.");
  } else {
    const c30 = snapshot.activity?.commitCount30d ?? 0;
    const c90 = snapshot.activity?.commitCount90d ?? 0;
    const c180 = snapshot.activity?.commitCount180d ?? 0;
    const recentCount = snapshot.activity?.recentCommitCount ?? 0;

    activityEvidence.push(
      `Commits recorded: ${c30} in last 30 days, ${c90} in last 90 days, ${c180} in last 180 days.`,
    );
    if (snapshot.activity?.lastCommitAt) {
      activityEvidence.push(`Latest commit timestamp: ${snapshot.activity.lastCommitAt}.`);
    }

    if (c30 >= 10 || c90 >= 25) {
      activityStatus = "strong";
      activitySummary = `Frequent development activity with ${c30} commits in the past 30 days and ${c90} in 90 days.`;
    } else if (c90 >= 5 || c180 >= 10 || recentCount >= 3) {
      activityStatus = "moderate";
      activitySummary = `Moderate development activity with ${c90} commits in the past 90 days.`;
    } else {
      activityStatus = "weak";
      activitySummary = `Low development activity detected (${c180} commits in the past 180 days).`;
    }
  }

  // Maintenance
  let maintenanceStatus: AssessmentStatus = "unknown";
  let maintenanceSummary = "";
  const maintenanceEvidence: string[] = [];

  const isArchived = Boolean(snapshot.repository?.isArchived);
  maintenanceEvidence.push(`Repository archived status: ${isArchived ? "Yes (Archived)" : "No (Active)"}.`);
  if (snapshot.repository?.pushedAt) {
    maintenanceEvidence.push(`Last pushed at: ${snapshot.repository.pushedAt}.`);
  }
  maintenanceEvidence.push(`Open issues count: ${snapshot.repository?.openIssuesCount ?? 0}.`);

  if (isArchived) {
    maintenanceStatus = "weak";
    maintenanceSummary = "Repository is marked as archived and read-only by maintainers.";
  } else if (effectiveLastDays !== null) {
    if (effectiveLastDays <= 30) {
      maintenanceStatus = "strong";
      maintenanceSummary = `Pushed/committed recently (${effectiveLastDays} days ago). Active maintenance.`;
    } else if (effectiveLastDays <= 180) {
      maintenanceStatus = "moderate";
      maintenanceSummary = `Last update was ${effectiveLastDays} days ago. Periodic maintenance observed.`;
    } else {
      maintenanceStatus = "weak";
      maintenanceSummary = `No updates for ${effectiveLastDays} days. Repository maintenance appears inactive.`;
    }
  } else {
    maintenanceStatus = "unknown";
    maintenanceSummary = "Maintenance status cannot be determined from metadata.";
  }

  // Documentation
  let docStatus: AssessmentStatus = "unknown";
  let docSummary = "";
  const docEvidence: string[] = [];

  const hasReadme = Boolean(snapshot.documentation?.hasReadme);
  const hasLicense = Boolean(snapshot.documentation?.hasLicense);
  const hasSec = Boolean(snapshot.documentation?.hasSecurityPolicy);
  const hasContrib = Boolean(snapshot.documentation?.hasContributing);
  const hasCoc = Boolean(snapshot.documentation?.hasCodeOfConduct);

  docEvidence.push(`README.md: ${hasReadme ? "Present" : "Missing"}`);
  docEvidence.push(`LICENSE: ${hasLicense ? "Present (" + (snapshot.repository?.license?.name || "Detected") + ")" : "Missing"}`);
  docEvidence.push(`SECURITY.md: ${hasSec ? "Present" : "Missing"}`);
  docEvidence.push(`CONTRIBUTING.md: ${hasContrib ? "Present" : "Missing"}`);
  docEvidence.push(`CODE_OF_CONDUCT.md: ${hasCoc ? "Present" : "Missing"}`);

  if (hasReadme && hasLicense && (hasSec || hasContrib)) {
    docStatus = "strong";
    docSummary = "Comprehensive documentation including README, License, and governance policies.";
  } else if (hasReadme && hasLicense) {
    docStatus = "moderate";
    docSummary = "Core documentation present (README and License), but missing governance policies.";
  } else if (hasReadme) {
    docStatus = "weak";
    docSummary = "README present, but open-source License is missing.";
  } else {
    docStatus = "weak";
    docSummary = "Key documentation files (README, License) are missing.";
  }

  // Release Discipline
  let releaseStatus: AssessmentStatus = "unknown";
  let releaseSummary = "";
  const releaseEvidence: string[] = [];

  const relTotal = snapshot.releases?.totalCount ?? 0;
  const rel90d = snapshot.releases?.releaseCount90d ?? 0;
  const latestRel = snapshot.releases?.latestRelease;

  releaseEvidence.push(`Total tagged GitHub releases: ${relTotal}.`);
  if (latestRel) {
    releaseEvidence.push(`Latest release tag: ${latestRel.tagName}${latestRel.publishedAt ? " (published " + latestRel.publishedAt + ")" : ""}.`);
  }
  releaseEvidence.push(`Releases in last 90 days: ${rel90d}.`);

  if (rel90d >= 1 || (relTotal >= 5 && latestRel?.publishedAt && (getDaysAgo(latestRel.publishedAt) ?? 999) <= 180)) {
    releaseStatus = "strong";
    releaseSummary = `Regular release cadence with ${relTotal} total releases, latest tag ${latestRel?.tagName || ""}.`;
  } else if (relTotal >= 1) {
    releaseStatus = "moderate";
    releaseSummary = `Tagged releases exist (${relTotal} total), but no recent releases in past 90 days.`;
  } else {
    releaseStatus = "unknown";
    releaseSummary = "No GitHub releases detected for this repository";
  }

  // Contributor Distribution
  let contribStatus: AssessmentStatus = "unknown";
  let contribSummary = "";
  const contribEvidence: string[] = [];

  const sampledCount = snapshot.contributors?.sampledCount ?? 0;
  const topContributors = snapshot.contributors?.topContributors ?? [];
  const humanContributors = topContributors.filter((c) => !c.isBot && c.accountType !== "bot");
  const botContributors = topContributors.filter((c) => c.isBot || c.accountType === "bot");

  const sampledHumanCount = snapshot.contributors?.sampledHumanContributorCount ?? (humanContributors.length > 0 ? humanContributors.length : sampledCount);
  const sampledBotCount = snapshot.contributors?.sampledBotContributorCount ?? botContributors.length;

  const humanCommitsSampled = humanContributors.reduce((acc, c) => acc + (c.contributions ?? 0), 0);
  const totalCommitsSampled = topContributors.reduce((acc, c) => acc + (c.contributions ?? 0), 0);

  const topHuman = humanContributors[0];
  const topHumanShare = humanCommitsSampled > 0 && topHuman
    ? Math.round((topHuman.contributions / humanCommitsSampled) * 1000) / 10
    : snapshot.contributors?.topHumanContributorShare ?? snapshot.contributors?.sampledTopContributorShare ?? 0;

  const botShare = totalCommitsSampled > 0 && botContributors.length > 0
    ? Math.round((botContributors.reduce((acc, c) => acc + (c.contributions ?? 0), 0) / totalCommitsSampled) * 1000) / 10
    : snapshot.contributors?.botContributionShare ?? 0;

  const topHumanLogins = humanContributors
    .slice(0, 3)
    .map((c) => `${c.login} (${c.contributions} commits)`)
    .join(", ");

  contribEvidence.push(`Sampled contributors: ${sampledCount} (${sampledHumanCount} human, ${sampledBotCount} bot accounts).`);
  contribEvidence.push(`Lifetime GitHub contribution totals sampled: ${totalCommitsSampled} commits (${humanCommitsSampled} human commits).`);
  contribEvidence.push(`Top human maintainer share: ${topHumanShare}% of human commits.`);
  if (botShare > 0) {
    contribEvidence.push(`Bot contribution share: ${botShare}% of sampled commits.`);
  }
  if (topHumanLogins) {
    contribEvidence.push(`Top human maintainers: ${topHumanLogins}.`);
  }

  if (humanCommitsSampled >= 10 && sampledHumanCount >= 5 && topHumanShare < 60) {
    contribStatus = "strong";
    contribSummary = `Well-distributed contributor base with ${sampledHumanCount} sampled human maintainers (top maintainer: ${topHumanShare}% of human commits).`;
  } else if (humanCommitsSampled >= 10 && sampledHumanCount >= 2 && topHumanShare < 80) {
    contribStatus = "moderate";
    contribSummary = `Multiple human maintainers (${sampledHumanCount}), with primary maintainer accounting for ${topHumanShare}% of sampled human commits.`;
  } else if (humanCommitsSampled >= 10 && topHumanShare >= 80) {
    contribStatus = "weak";
    contribSummary = `High maintainer concentration: single key human contributor accounts for ${topHumanShare}% of sampled human commits.`;
  } else {
    contribStatus = "unknown";
    contribSummary = humanCommitsSampled < 10
      ? `Insufficient commit sample (${humanCommitsSampled} human commits sampled) to determine contributor concentration.`
      : "Contributor data unavailable or unlisted.";
  }

  // Automation
  let autoStatus: AssessmentStatus = "unknown";
  let autoSummary = "";
  const autoEvidence: string[] = [];

  const hasWorkflows = Boolean(snapshot.stack?.hasWorkflows);
  const wfCount = snapshot.stack?.workflowCount ?? 0;
  const wfNames = snapshot.stack?.workflowNames ?? [];

  autoEvidence.push(`GitHub Actions CI workflows detected: ${hasWorkflows ? "Yes" : "No"}.`);
  autoEvidence.push(`Workflow count: ${wfCount}.`);
  if (wfNames.length > 0) {
    autoEvidence.push(`Workflow files: ${wfNames.join(", ")}.`);
  }

  if (hasWorkflows && wfCount >= 2) {
    autoStatus = "strong";
    autoSummary = `Automated CI workflows active (${wfCount} GitHub Actions detected).`;
  } else if (hasWorkflows && wfCount >= 1) {
    autoStatus = "moderate";
    autoSummary = `Basic automation present (${wfNames[0] || "1 workflow"}).`;
  } else {
    autoStatus = "weak";
    autoSummary = "No GitHub Actions CI workflow files (.github/workflows) detected.";
  }

  // Testing
  let testingStatus: AssessmentStatus = "unknown";
  let testingSummary = "";
  const testingEvidence: string[] = [];

  const detectedCaps = snapshot.dependencyProfile?.detectedCapabilities ?? [];
  const testDirs = snapshot.repositoryStructure?.testDirectories ?? [];
  const hasTestCap = detectedCaps.includes("Testing");

  testingEvidence.push(`Test directories detected: ${testDirs.length > 0 ? testDirs.join(", ") : "None"}.`);
  testingEvidence.push(`Testing framework detected: ${hasTestCap ? "Yes" : "No"}.`);

  if (hasTestCap && testDirs.length > 0 && Boolean(snapshot.stack?.hasWorkflows)) {
    testingStatus = "strong";
    testingSummary = "Active test suite and test runner detected alongside CI automation.";
  } else if (hasTestCap || testDirs.length > 0) {
    testingStatus = "moderate";
    testingSummary = "Test framework or test directory present in repository.";
  } else {
    testingStatus = "weak";
    testingSummary = "No unit test framework or test directory detected.";
  }

  // Dependency Hygiene
  let depStatus: AssessmentStatus = "unknown";
  let depSummary = "";
  const depEvidence: string[] = [];

  const manifests = snapshot.dependencyProfile?.manifests ?? [];
  const prodDeps = snapshot.dependencyProfile?.productionDependencies ?? [];
  const devDeps = snapshot.dependencyProfile?.developmentDependencies ?? [];
  const configFiles = snapshot.repositoryStructure?.configFiles ?? [];

  depEvidence.push(`Dependency manifests found: ${manifests.length > 0 ? manifests.join(", ") : "None"}.`);
  depEvidence.push(`Production dependencies count: ${prodDeps.length}.`);
  depEvidence.push(`Development dependencies count: ${devDeps.length}.`);

  const hasLockfile =
    manifests.some((m) => /lock|go\.sum/i.test(m)) ||
    configFiles.some((f) => /lock|go\.sum/i.test(f));

  const hasSeparateDevManifest = manifests.some((m) =>
    /requirements[-_]?dev|dev[-_]?requirements|\.dev\./i.test(m)
  );

  const hasExplicitDevGroup =
    devDeps.length >= 1 &&
    (manifests.some((m) => m.endsWith("package.json") || m.endsWith("pyproject.toml")) ||
      hasSeparateDevManifest);

  if (manifests.length >= 1 && (hasLockfile || hasSeparateDevManifest || hasExplicitDevGroup)) {
    depStatus = "strong";
    depSummary = `Structured dependency manifests (${manifests.join(", ")}) with explicit dev dependency separation or lockfile.`;
  } else if (manifests.length >= 1) {
    depStatus = "moderate";
    depSummary = `Dependency manifests present (${manifests.join(", ")}).`;
  } else {
    depStatus = "weak";
    depSummary = "No standard dependency manifests detected in repository root.";
  }

  // Documentation Depth
  let docDepthStatus: AssessmentStatus = "unknown";
  let docDepthSummary = "";
  const docDepthEvidence: string[] = [];

  const readmeBytes = snapshot.documentation?.readmeSize ?? 0;
  docDepthEvidence.push(`README size: ${readmeBytes} bytes.`);
  docDepthEvidence.push(`Security policy present: ${snapshot.documentation?.hasSecurityPolicy ? "Yes" : "No"}.`);
  docDepthEvidence.push(`Contributing guide present: ${snapshot.documentation?.hasContributing ? "Yes" : "No"}.`);

  if (readmeBytes > 5000 && snapshot.documentation?.hasSecurityPolicy && snapshot.documentation?.hasContributing) {
    docDepthStatus = "strong";
    docDepthSummary = "In-depth documentation with detailed README (>5KB), security policy, and contributing guide.";
  } else if (readmeBytes > 1000) {
    docDepthStatus = "moderate";
    docDepthSummary = "Standard documentation depth present in repository.";
  } else {
    docDepthStatus = "weak";
    docDepthSummary = "Minimal documentation depth detected.";
  }

  // Deployment Readiness
  let deployStatus: AssessmentStatus = "unknown";
  let deploySummary = "";
  const deployEvidence: string[] = [];

  const dockerFiles = snapshot.repositoryStructure?.dockerFiles ?? [];
  const entrypoints = snapshot.repositoryStructure?.entrypoints ?? [];

  deployEvidence.push(`Containerization files: ${dockerFiles.length > 0 ? dockerFiles.join(", ") : "None"}.`);
  deployEvidence.push(`Application entrypoints: ${entrypoints.length > 0 ? entrypoints.join(", ") : "None"}.`);
  deployEvidence.push(`CI workflows: ${snapshot.stack?.hasWorkflows ? "Present" : "Missing"}.`);

  if (dockerFiles.length > 0 && snapshot.stack?.hasWorkflows) {
    if (entrypoints.length === 0) {
      deployStatus = "moderate";
      deploySummary = `Containerization assets (${dockerFiles.join(", ")}) and CI build workflows configured, but no explicit application entrypoint was identified.`;
    } else {
      deployStatus = "strong";
      deploySummary = `Containerization assets (${dockerFiles.join(", ")}) and CI build workflows configured.`;
    }
  } else if (dockerFiles.length > 0 || snapshot.stack?.hasWorkflows || entrypoints.length > 0) {
    deployStatus = "moderate";
    deploySummary = "Basic deployment or entrypoint configuration present.";
  } else {
    deployStatus = "weak";
    deploySummary = "No containerization or deployment workflow files detected.";
  }

  // Operational Maturity
  let opMaturityStatus: AssessmentStatus = "unknown";
  let opMaturitySummary = "";
  const opMaturityEvidence: string[] = [];

  const strongCount = [activityStatus, maintenanceStatus, docStatus, releaseStatus, contribStatus, autoStatus, testingStatus, depStatus, deployStatus].filter((s) => s === "strong").length;
  opMaturityEvidence.push(`High confidence engineering signals: ${strongCount} of 9 categories strong.`);

  if (
    releaseStatus === "strong" &&
    autoStatus === "strong" &&
    testingStatus !== "weak" &&
    docStatus !== "weak" &&
    deployStatus !== "weak"
  ) {
    opMaturityStatus = "strong";
  } else if (
    autoStatus !== "weak" &&
    testingStatus !== "weak" &&
    deployStatus !== "weak"
  ) {
    opMaturityStatus = "moderate";
  } else {
    opMaturityStatus = "weak";
  }

  const confirmedStrongList: string[] = [];
  if (releaseStatus === "strong") confirmedStrongList.push("release management");
  if (autoStatus === "strong") confirmedStrongList.push("CI automation");
  if (testingStatus === "strong") confirmedStrongList.push("test coverage");
  if (docStatus === "strong") confirmedStrongList.push("governance documentation");
  if (deployStatus === "strong") confirmedStrongList.push("deployment readiness");
  if (activityStatus === "strong") confirmedStrongList.push("development activity");
  if (maintenanceStatus === "strong") confirmedStrongList.push("active maintenance");

  if (opMaturityStatus === "strong") {
    opMaturitySummary = `High operational maturity across ${confirmedStrongList.join(", ")}.`;
  } else if (opMaturityStatus === "moderate") {
    opMaturitySummary = confirmedStrongList.length > 0
      ? `Moderate operational maturity with strong ${confirmedStrongList.join(", ")}.`
      : "Moderate operational maturity signals observed.";
  } else {
    opMaturitySummary = confirmedStrongList.length > 0
      ? `Low operational maturity despite strong ${confirmedStrongList.join(", ")}.`
      : "Low operational maturity signals detected.";
  }

  const isPartialOrIncomplete =
    isFallback ||
    snapshot.source?.partial === true ||
    !snapshot.repository?.fullName;

  const getCategoryConfidence = (catKey: string, catStatus: AssessmentStatus): DataConfidence => {
    if (isPartialOrIncomplete || isFallback || catStatus === "unknown") {
      return "low";
    }
    if (["activity", "documentation", "releaseDiscipline", "documentationDepth"].includes(catKey)) {
      return "high";
    }
    return "medium";
  };

  const categories: GitHubDueDiligenceCategories = {
    activity: { status: activityStatus, confidence: getCategoryConfidence("activity", activityStatus), summary: activitySummary, evidence: activityEvidence },
    maintenance: { status: maintenanceStatus, confidence: getCategoryConfidence("maintenance", maintenanceStatus), summary: maintenanceSummary, evidence: maintenanceEvidence },
    documentation: { status: docStatus, confidence: getCategoryConfidence("documentation", docStatus), summary: docSummary, evidence: docEvidence },
    releaseDiscipline: { status: releaseStatus, confidence: getCategoryConfidence("releaseDiscipline", releaseStatus), summary: releaseSummary, evidence: releaseEvidence },
    contributorDistribution: { status: contribStatus, confidence: getCategoryConfidence("contributorDistribution", contribStatus), summary: contribSummary, evidence: contribEvidence },
    automation: { status: autoStatus, confidence: getCategoryConfidence("automation", autoStatus), summary: autoSummary, evidence: autoEvidence },
    testing: { status: testingStatus, confidence: getCategoryConfidence("testing", testingStatus), summary: testingSummary, evidence: testingEvidence },
    dependencyHygiene: { status: depStatus, confidence: getCategoryConfidence("dependencyHygiene", depStatus), summary: depSummary, evidence: depEvidence },
    documentationDepth: { status: docDepthStatus, confidence: getCategoryConfidence("documentationDepth", docDepthStatus), summary: docDepthSummary, evidence: docDepthEvidence },
    deploymentReadiness: { status: deployStatus, confidence: getCategoryConfidence("deploymentReadiness", deployStatus), summary: deploySummary, evidence: deployEvidence },
    operationalMaturity: { status: opMaturityStatus, confidence: getCategoryConfidence("operationalMaturity", opMaturityStatus), summary: opMaturitySummary, evidence: opMaturityEvidence },
  };

  // --- 2. Risk Evaluation ---

  const risks: GitHubDueDiligenceRisk[] = [];

  // R1: repository_archived (high)
  if (isArchived) {
    risks.push({
      code: "repository_archived",
      title: "Repository is Archived",
      severity: "high",
      description: "The repository has been marked as read-only by its maintainers.",
      impact: "No future bug fixes, security patches, or feature updates will be published.",
    });
  }

  // R2: stale_development (high)
  if (!isArchived && effectiveLastDays !== null && effectiveLastDays > 180) {
    risks.push({
      code: "stale_development",
      title: "Stale Development Activity",
      severity: "high",
      description: `No commits or code pushes recorded in the past ${effectiveLastDays} days.`,
      impact: "Active maintenance may have ceased, leaving reported issues or security flaws unaddressed.",
    });
  }

  // R3: low_recent_activity (medium)
  if (
    !isArchived &&
    (effectiveLastDays === null || effectiveLastDays <= 180) &&
    (snapshot.activity?.commitCount90d ?? 0) === 0 &&
    (snapshot.activity?.recentCommitCount ?? 0) < 5
  ) {
    risks.push({
      code: "low_recent_activity",
      title: "Low Recent Activity",
      severity: "medium",
      description: "No commits recorded in the past 90 days despite past repository history.",
      impact: "Development velocity has slowed down, which may delay updates or bug fixes.",
    });
  }

  // R4: missing_license (medium)
  if (!hasLicense) {
    risks.push({
      code: "missing_license",
      title: "Missing Open Source License",
      severity: "medium",
      description: "No explicit SPDX license file (LICENSE, LICENSE.md) was found in the repository.",
      impact: "Without an open-source license, default copyright laws apply, restricting legal reuse and redistribution.",
    });
  }

  // R5: missing_readme (medium)
  if (!hasReadme) {
    risks.push({
      code: "missing_readme",
      title: "Missing README File",
      severity: "medium",
      description: "No README documentation file was found in the repository root.",
      impact: "Lack of setup instructions, architectural overview, or operational guidance.",
    });
  }

  // R6: single_contributor_concentration (medium)
  if (humanCommitsSampled >= 10 && topHumanShare >= 80) {
    risks.push({
      code: "single_contributor_concentration",
      title: "Single Contributor Concentration",
      severity: "medium",
      description: `One account represents ${topHumanShare}% of the sampled lifetime contributions attributed to human contributors.`,
      impact: "High bus-factor risk if the primary maintainer steps away or becomes unavailable.",
    });
  }

  // R11: automation_heavy_history (info)
  if (botShare >= 50) {
    risks.push({
      code: "automation_heavy_history",
      title: "Automation-Heavy Contribution History",
      severity: "info",
      description: "Automation-heavy contribution history: A significant portion of repository contributions originate from automated bot accounts.",
      impact: "Automated tooling accounts for a substantial portion of repository activity.",
    });
  }

  // R7: missing_security_policy (low)
  if (!hasSec) {
    risks.push({
      code: "missing_security_policy",
      title: "Missing Security Policy (SECURITY.md)",
      severity: "low",
      description: "No SECURITY.md policy file detailing vulnerability disclosure procedures was found.",
      impact: "Security researchers lack clear guidelines for reporting disclosures responsibly.",
    });
  }

  // R8: no_ci_detected (low)
  if (!hasWorkflows) {
    risks.push({
      code: "no_ci_detected",
      title: "No Automated Workflows / CI Detected",
      severity: "low",
      description: "No GitHub Actions workflow files (.github/workflows) were detected.",
      impact: "Automated unit tests, linting, and build validation may not be enforced on pull requests.",
    });
  }

  // R9: repository_is_fork (info)
  if (snapshot.repository?.isFork) {
    risks.push({
      code: "repository_is_fork",
      title: "Repository is a Fork",
      severity: "info",
      description: "This repository was forked from another upstream source.",
      impact: "Changes may diverge from upstream or depend on upstream maintainer sync.",
    });
  }

  // R10: no_github_releases (info)
  if (relTotal === 0) {
    risks.push({
      code: "no_github_releases",
      title: "No Tagged GitHub Releases",
      severity: "info",
      description: "No tagged GitHub releases were published in this repository.",
      impact: "Consumers must rely on git commit SHAs or branch tips rather than semantic release tags.",
    });
  }

  // --- 3. Overall Status Calculation & Synthesized Executive Summary ---

  let overallStatus: DueDiligenceOverallStatus = "healthy_signals";
  let overallSummary = "";

  const highRisks = risks.filter((r) => r.severity === "high");
  const mediumRisks = risks.filter((r) => r.severity === "medium");

  const purposePrefix = snapshot.projectPurpose?.summary
    ? `${snapshot.projectPurpose.summary.replace(/\.$/, "")}. `
    : "";
  const primaryLang = snapshot.stack?.primaryLanguage || "Software";

  const filteredFrameworks = (snapshot.stack?.detectedFrameworks || []).filter(
    (f) =>
      f.toLowerCase() !== primaryLang.toLowerCase() &&
      !["docker", "container"].includes(f.toLowerCase())
  );
  const frameworksText = filteredFrameworks.length > 0
    ? ` built with ${filteredFrameworks.join(", ")}`
    : "";

  const hasDocker =
    dockerFiles.length > 0 ||
    (snapshot.stack?.detectedFrameworks || []).some(
      (f) => f.toLowerCase() === "docker"
    );
  const containerName = dockerFiles.length > 0 ? dockerFiles[0] : "Docker";
  const containerText = hasDocker
    ? ` and uses ${containerName} for containerization`
    : "";

  const hasTest = testingStatus === "strong" || testingStatus === "moderate";
  const hasCI = Boolean(snapshot.stack?.hasWorkflows);
  let testingSignal = "";
  if (hasTest && hasCI) {
    testingSignal = "A test suite and CI automation were detected.";
  } else if (hasTest) {
    testingSignal = "A test suite was detected.";
  } else if (hasCI) {
    testingSignal = "CI automation was detected.";
  } else {
    testingSignal = "Limited automated testing was detected.";
  }

  const govSignal =
    docStatus === "strong"
      ? "comprehensive governance documentation"
      : hasSec || hasLicense
      ? "standard repository governance"
      : "standard repository structure and CI automation";

  const stackSummary = `The project is primarily written in ${primaryLang}${frameworksText}${containerText}. ${testingSignal}`;

  if (isPartialOrIncomplete) {
    overallStatus = "limited_data";
    overallSummary = `Limited repository metadata could be retrieved for ${snapshot.repository?.fullName || "the target repository"}. ${purposePrefix}Exercise caution due to partial upstream API response.`;
  } else if (highRisks.length >= 1) {
    overallStatus = "high_attention";
    overallSummary = `${purposePrefix}${stackSummary} Significant risk factors detected (${highRisks.map((r) => r.title.toLowerCase()).join(", ")}) with ${govSignal}. Careful manual review is required before integration.`;
  } else if (mediumRisks.length >= 2 || !hasLicense) {
    overallStatus = "review_needed";
    overallSummary = `${purposePrefix}${stackSummary} The repository shows active development with ${govSignal}, but contains notable risk factors (${mediumRisks.map((r) => r.title.toLowerCase()).join(", ")}) requiring review before integration.`;
  } else {
    overallStatus = "healthy_signals";
    overallSummary = `${purposePrefix}${stackSummary} The repository demonstrates healthy activity and ${govSignal} with minimal risk factors detected.`;
  }

  // --- 4. Evidence-backed Strengths List ---

  const strengths: string[] = [];

  if ((snapshot.activity?.commitCount30d ?? 0) >= 10) {
    strengths.push(
      `High development activity with ${snapshot.activity.commitCount30d} commits recorded in the past 30 days.`,
    );
  } else if ((snapshot.activity?.commitCount90d ?? 0) >= 15) {
    strengths.push(
      `Consistent commit cadence with ${snapshot.activity.commitCount90d} commits in the past 90 days.`,
    );
  }

  if (hasLicense && snapshot.repository?.license?.name) {
    strengths.push(
      `Clear open-source licensing: ${snapshot.repository.license.name} (${snapshot.repository.license.spdxId || "SPDX"}).`,
    );
  }

  if (relTotal >= 1 && latestRel?.tagName) {
    strengths.push(
      `Tagged release management with latest version ${latestRel.tagName}${latestRel.publishedAt ? " published " + latestRel.publishedAt : ""}.`,
    );
  }

  if (sampledHumanCount >= 5 && topHumanShare < 60) {
    strengths.push(
      `Healthy contributor community with ${sampledHumanCount} distinct human maintainers.`,
    );
  }

  if (hasWorkflows && wfCount > 0) {
    strengths.push(
      `Automated CI pipelines configured with ${wfCount} GitHub Actions workflow file(s).`,
    );
  }

  if (hasReadme && hasSec && hasContrib) {
    strengths.push(
      "Comprehensive governance files present (README, SECURITY policy, and CONTRIBUTING guidelines).",
    );
  } else if (hasReadme) {
    strengths.push("Public README documentation present in repository root.");
  }

  // --- 5. Suggested Questions Before Relying on Project ---

  const suggestedQuestions: string[] = [];

  if (sampledHumanCount === 1 || topHumanShare >= 80) {
    suggestedQuestions.push(
      "What is the maintainer team size and policy for maintainer handoff or co-maintenance?",
    );
  }

  if (relTotal === 0) {
    suggestedQuestions.push(
      "Are production builds tagged with semantic version releases, or should consumers pin specific commit SHAs?",
    );
  }

  if (!hasWorkflows) {
    suggestedQuestions.push(
      "How are unit tests, linting, and security static analysis performed before merging pull requests?",
    );
  }

  if (!hasSec) {
    suggestedQuestions.push(
      "What is the private reporting process and contacts for responsible security disclosures?",
    );
  }

  if (!hasLicense) {
    suggestedQuestions.push(
      "Under what legal license terms can this repository be modified and redistributed?",
    );
  }

  if (effectiveLastDays !== null && effectiveLastDays > 90) {
    suggestedQuestions.push(
      "Is this repository actively maintained, or has development moved to another repository or branch?",
    );
  }

  suggestedQuestions.push(
    "What is the project roadmap and breaking change policy for future releases?",
  );

  const categoryValues = Object.values(categories);
  const assessedCategories = categoryValues.filter(
    (category) => category.status !== "unknown",
  ).length;
  const highConfidenceCategories = categoryValues.filter(
    (category) => category.confidence === "high",
  ).length;
  const totalCategories = categoryValues.length;
  const evidenceRatio =
    totalCategories > 0
      ? Math.round((assessedCategories / totalCategories) * 100) / 100
      : 0;
  const verdictConfidence: DataConfidence =
    isPartialOrIncomplete || evidenceRatio < 0.6
      ? "low"
      : highConfidenceCategories >= Math.ceil(totalCategories * 0.6)
        ? "high"
        : "medium";

  let verdictCode: DueDiligenceVerdictCode;
  let verdictLabel: string;
  if (overallStatus === "limited_data") {
    verdictCode = "insufficient_evidence";
    verdictLabel = "Insufficient evidence";
  } else if (overallStatus === "high_attention") {
    verdictCode = "pause_for_review";
    verdictLabel = "Pause for manual review";
  } else if (overallStatus === "review_needed") {
    verdictCode = "proceed_with_conditions";
    verdictLabel = "Proceed only with conditions";
  } else {
    verdictCode = "proceed_with_standard_review";
    verdictLabel = "Proceed with standard review";
  }

  const verdictReasons = [
    ...highRisks.map((risk) => `${risk.title}: ${risk.impact}`),
    ...mediumRisks.slice(0, Math.max(0, 3 - highRisks.length)).map(
      (risk) => `${risk.title}: ${risk.impact}`,
    ),
    ...strengths.slice(0, 2),
  ].slice(0, 4);
  if (verdictReasons.length === 0) {
    verdictReasons.push(
      overallStatus === "limited_data"
        ? "The available public GitHub evidence is too incomplete for a reliable repository-health conclusion."
        : "No high- or medium-severity repository-health findings were detected in the collected evidence.",
    );
  }

  const blockingFindings = highRisks.map((risk) => risk.title);
  if (!hasLicense && !blockingFindings.includes("Missing Open Source License")) {
    blockingFindings.push("Missing Open Source License");
  }
  if (overallStatus === "limited_data") {
    blockingFindings.push("Incomplete GitHub evidence");
  }

  const verdict: GitHubDueDiligenceVerdict = {
    code: verdictCode,
    label: verdictLabel,
    confidence: verdictConfidence,
    summary:
      verdictCode === "proceed_with_standard_review"
        ? "The collected repository-health evidence supports continuing normal technical and legal review."
        : verdictCode === "proceed_with_conditions"
          ? "Resolve or explicitly accept the listed conditions before relying on this repository."
          : verdictCode === "pause_for_review"
            ? "Do not rely on this repository until the high-severity findings receive manual review."
            : "Collect complete repository evidence before making an adoption decision.",
    reasons: verdictReasons,
    blockingFindings,
    evidenceCoverage: {
      assessedCategories,
      highConfidenceCategories,
      totalCategories,
      ratio: evidenceRatio,
    },
  };

  return {
    overallStatus,
    overallSummary,
    verdict,
    categories,
    risks,
    strengths,
    suggestedQuestions,
    limitationsDisclaimer: LIMITATIONS_DISCLAIMER,
    analyzedAt: snapshot.source?.fetchedAt || new Date().toISOString(),
  };
}
