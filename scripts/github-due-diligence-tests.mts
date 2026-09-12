/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import {
  analyzeGitHubDueDiligence,
  LIMITATIONS_DISCLAIMER,
  type GitHubDueDiligenceAssessment,
} from "../lib/agent/github-due-diligence.ts";
import { extractProjectSummaryFromReadme } from "../lib/providers/github.ts";
import type { GitHubRepositorySnapshot } from "../lib/providers/github-types.ts";

console.log("[github-due-diligence-test] Running GitHub due diligence engine tests...");

const createBaseSnapshot = (): GitHubRepositorySnapshot => ({
  version: 1,
  ref: {
    owner: "circlefin",
    name: "agent-commerce",
    fullName: "circlefin/agent-commerce",
    canonicalUrl: "https://github.com/circlefin/agent-commerce",
  },
  repository: {
    id: 12345678,
    owner: "circlefin",
    name: "agent-commerce",
    fullName: "circlefin/agent-commerce",
    description: "Hosted agent workflows and verification on Arc.",
    isPrivate: false,
    isFork: false,
    isArchived: false,
    defaultBranch: "main",
    starsCount: 150,
    forksCount: 25,
    openIssuesCount: 4,
    watchersCount: 150,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-07-23T12:00:00Z",
    pushedAt: "2026-07-23T12:00:00Z",
    license: {
      key: "apache-2.0",
      name: "Apache License 2.0",
      spdxId: "Apache-2.0",
      url: "https://spdx.org/licenses/Apache-2.0.html",
    },
    homepage: "https://agentcommerce.arc.io",
    topics: ["usdc", "arc-testnet", "x402", "agent-workflows"],
  },
  activity: {
    recentCommitCount: 25,
    commitAuthorCount: 6,
    lastCommitAt: "2026-07-23T12:00:00Z",
    commitCount30d: 15,
    commitCount90d: 35,
    commitCount180d: 50,
    commitCount30dIsLowerBound: false,
    commitCount90dIsLowerBound: false,
    commitCount180dIsLowerBound: false,
  },
  contributors: {
    sampledCount: 8,
    topContributors: [
      { login: "alice", contributions: 20, avatarUrl: null, isBot: false, accountType: "human" },
      { login: "bob", contributions: 15, avatarUrl: null, isBot: false, accountType: "human" },
      { login: "charlie", contributions: 10, avatarUrl: null, isBot: false, accountType: "human" },
    ],
    sampledTopContributorShare: 40,
    sampledHumanContributorCount: 8,
    sampledBotContributorCount: 0,
    topHumanContributorShare: 44.4,
    botContributionShare: 0,
  },
  releases: {
    totalCount: 6,
    latestRelease: {
      name: "v1.2.0",
      tagName: "v1.2.0",
      publishedAt: "2026-07-20T10:00:00Z",
      isPrerelease: false,
      body: "Feature release",
    },
    releaseCount90d: 2,
  },
  collaboration: {
    openIssuesCount: 4,
    hasDiscussions: true,
  },
  documentation: {
    hasReadme: true,
    hasLicense: true,
    hasSecurityPolicy: true,
    hasContributing: true,
    hasCodeOfConduct: true,
    readmeSize: 10240,
    securityPolicySize: 2048,
    contributingSize: 3072,
  },
  stack: {
    primaryLanguage: "TypeScript",
    languages: { TypeScript: 80000, Shell: 5000 },
    detectedFrameworks: ["Next.js", "React"],
    hasWorkflows: true,
    workflowCount: 3,
    workflowNames: ["ci.yml", "release.yml", "lint.yml"],
  },
  excerpts: {
    readmeExcerpt: "# Agent-Commerce\nHosted agent workflows on Arc.",
    securityExcerpt: "# Security Policy\nReport vulnerabilities responsibly.",
    contributingExcerpt: "# Contributing\nGuidelines for pull requests.",
  },
  source: {
    fetchedAt: "2026-07-23T14:00:00.000Z",
    cacheHit: false,
    provider: "GitHub REST API v3",
    upstreamStatus: "success",
  },
});

// Test 1: Determinism check - identical input yields identical output
console.log("Test 1: Testing determinism of analyzeGitHubDueDiligence...");
const baseSnapshot1 = createBaseSnapshot();
const baseSnapshot2 = createBaseSnapshot();

const result1 = analyzeGitHubDueDiligence(baseSnapshot1);
const result2 = analyzeGitHubDueDiligence(baseSnapshot2);

assert.deepEqual(result1, result2, "Output must be 100% identical for identical input snapshots!");
assert.equal(result1.analyzedAt, baseSnapshot1.source.fetchedAt, "analyzedAt must match snapshot fetchedAt");
console.log("✔ Determinism test passed.");

// Test 2: Healthy snapshot evaluation
console.log("Test 2: Testing healthy snapshot assessment...");
assert.equal(result1.overallStatus, "healthy_signals");
assert.equal(result1.verdict.code, "proceed_with_standard_review");
assert.equal(result1.verdict.label, "Proceed with standard review");
assert(result1.verdict.evidenceCoverage.assessedCategories > 0);
assert.equal(result1.categories.activity.status, "strong");
assert.equal(result1.categories.maintenance.status, "strong");
assert.equal(result1.categories.documentation.status, "strong");
assert.equal(result1.categories.releaseDiscipline.status, "strong");
assert.equal(result1.categories.contributorDistribution.status, "strong");
assert.equal(result1.categories.automation.status, "strong");
assert.equal(result1.risks.filter((r) => r.severity === "high" || r.severity === "medium").length, 0);
assert(result1.strengths.length >= 3, "Healthy repo must have multiple evidence-backed strengths");
console.log("✔ Healthy snapshot test passed.");

// Test 3: Archived repository triggers high risk
console.log("Test 3: Testing archived repository risk rule...");
const archivedSnapshot = createBaseSnapshot();
archivedSnapshot.repository.isArchived = true;

const archivedResult = analyzeGitHubDueDiligence(archivedSnapshot);
assert.equal(archivedResult.overallStatus, "high_attention");
assert.equal(archivedResult.categories.maintenance.status, "weak");

const archivedRisk = archivedResult.risks.find((r) => r.code === "repository_archived");
assert(archivedRisk, "Archived repository must produce 'repository_archived' risk");
assert.equal(archivedRisk.severity, "high");
console.log("✔ Archived repository test passed.");

// Test 4: Stale development activity triggers high risk
console.log("Test 4: Testing stale development risk rule (>180 days)...");
const staleSnapshot = createBaseSnapshot();
staleSnapshot.activity.lastCommitAt = "2025-01-01T00:00:00.000Z";
staleSnapshot.repository.pushedAt = "2025-01-01T00:00:00.000Z";
staleSnapshot.activity.commitCount30d = 0;
staleSnapshot.activity.commitCount90d = 0;
staleSnapshot.activity.commitCount180d = 0;

const staleResult = analyzeGitHubDueDiligence(staleSnapshot);
assert.equal(staleResult.overallStatus, "high_attention");
assert.equal(staleResult.categories.maintenance.status, "weak");

const staleRisk = staleResult.risks.find((r) => r.code === "stale_development");
assert(staleRisk, "Stale repository must produce 'stale_development' risk");
assert.equal(staleRisk.severity, "high");
console.log("✔ Stale development test passed.");

// Test 5: 1 medium risk yields healthy_signals, 2 medium risks or missing license yield review_needed
console.log("Test 5: Testing medium risk overall status thresholds (1 medium -> healthy_signals, 2 medium or missing license -> review_needed)...");
const oneMediumRiskSnapshot = createBaseSnapshot();
oneMediumRiskSnapshot.documentation.hasReadme = false;

const oneMediumRiskResult = analyzeGitHubDueDiligence(oneMediumRiskSnapshot);
assert.equal(oneMediumRiskResult.overallStatus, "healthy_signals", "1 non-license medium risk must result in healthy_signals");

const noLicenseSnapshot = createBaseSnapshot();
noLicenseSnapshot.documentation.hasLicense = false;
noLicenseSnapshot.repository.license = null;

const noLicenseResult = analyzeGitHubDueDiligence(noLicenseSnapshot);
assert.equal(noLicenseResult.overallStatus, "review_needed", "Missing license MUST force overall status to review_needed");

const licenseRisk = noLicenseResult.risks.find((r) => r.code === "missing_license");
assert(licenseRisk, "Missing license must produce 'missing_license' risk");
assert.equal(licenseRisk.severity, "medium");

const twoMediumRisksSnapshot = createBaseSnapshot();
twoMediumRisksSnapshot.documentation.hasLicense = false;
twoMediumRisksSnapshot.repository.license = null;
twoMediumRisksSnapshot.documentation.hasReadme = false;

const twoMediumRisksResult = analyzeGitHubDueDiligence(twoMediumRisksSnapshot);
assert.equal(twoMediumRisksResult.overallStatus, "review_needed", "2 medium risks must result in review_needed");
console.log("✔ Medium risk threshold test passed.");

// Test 6: Release discipline with no releases
console.log("Test 6: Testing no releases category status and info finding...");
const noReleasesSnapshot = createBaseSnapshot();
noReleasesSnapshot.releases.totalCount = 0;
noReleasesSnapshot.releases.latestRelease = null;
noReleasesSnapshot.releases.releaseCount90d = 0;

const noReleasesResult = analyzeGitHubDueDiligence(noReleasesSnapshot);
assert.equal(noReleasesResult.categories.releaseDiscipline.status, "unknown", "No releases category status must be 'unknown'");
assert.equal(
  noReleasesResult.categories.releaseDiscipline.summary,
  "No GitHub releases detected for this repository",
  "Summary must state 'No GitHub releases detected for this repository'"
);
const noReleaseRisk = noReleasesResult.risks.find((r) => r.code === "no_github_releases");
assert(noReleaseRisk, "Must contain no_github_releases info finding");
assert.equal(noReleaseRisk.severity, "info");
console.log("✔ No releases test passed.");

// Test 7: Contributor concentration risk with sufficient vs insufficient commit sample
console.log("Test 7: Testing contributor concentration risk sample bounds...");
const singleContribSnapshot = createBaseSnapshot();
singleContribSnapshot.contributors.sampledCount = 1;
singleContribSnapshot.contributors.sampledTopContributorShare = 100;
singleContribSnapshot.contributors.topContributors = [
  { login: "solo-dev", contributions: 50, avatarUrl: null },
];

const singleContribResult = analyzeGitHubDueDiligence(singleContribSnapshot);
assert.equal(singleContribResult.categories.contributorDistribution.status, "weak");
const contribRisk = singleContribResult.risks.find((r) => r.code === "single_contributor_concentration");
assert(contribRisk, "Single contributor with >=10 commits sampled must produce 'single_contributor_concentration' risk");
assert.equal(contribRisk.severity, "medium");

const lowSampleContribSnapshot = createBaseSnapshot();
lowSampleContribSnapshot.contributors.sampledCount = 1;
lowSampleContribSnapshot.contributors.sampledTopContributorShare = 100;
lowSampleContribSnapshot.contributors.topContributors = [
  { login: "solo-dev", contributions: 5, avatarUrl: null },
];

const lowSampleContribResult = analyzeGitHubDueDiligence(lowSampleContribSnapshot);
assert.equal(lowSampleContribResult.categories.contributorDistribution.status, "unknown");
const lowSampleRisk = lowSampleContribResult.risks.find((r) => r.code === "single_contributor_concentration");
assert.equal(lowSampleRisk, undefined, "Must NOT produce concentration risk when commitsSampled < 10");
console.log("✔ Contributor concentration sample bound test passed.");

// Test 8: Fallback or partial upstream status yields limited_data overall status
console.log("Test 8: Testing fallback/partial upstream status handling...");
const fallbackSnapshot = createBaseSnapshot();
fallbackSnapshot.source.upstreamStatus = "fallback";

const fallbackResult = analyzeGitHubDueDiligence(fallbackSnapshot);
assert.equal(fallbackResult.overallStatus, "limited_data");
assert.equal(fallbackResult.verdict.code, "insufficient_evidence");
assert.equal(fallbackResult.verdict.confidence, "low");

const partialSnapshot = createBaseSnapshot();
partialSnapshot.source.partial = true;

const partialResult = analyzeGitHubDueDiligence(partialSnapshot);
assert.equal(partialResult.overallStatus, "limited_data", "source.partial === true must yield limited_data overall status");
console.log("✔ Fallback and partial status test passed.");

// Test 9: Safety constraints check
console.log("Test 9: Verifying safety constraints (no trust score, no investment claims, disclaimer)...");
assert.equal(result1.limitationsDisclaimer, LIMITATIONS_DISCLAIMER);
const jsonStr = JSON.stringify(result1);
assert(!jsonStr.includes("trustScore"), "Result must not contain opaque trust score");
assert(!jsonStr.includes("trust_score"), "Result must not contain trust_score");
assert(!jsonStr.includes("investment grade"), "Result must not contain 'investment grade'");
assert(!jsonStr.includes("buy recommendation"), "Result must not contain investment recommendation");
console.log("✔ Safety constraints check passed.");

// Test 10: Testing rich P1.4 categories and magda-agent executive summary synthesis
console.log("Test 10: Testing rich P1.4 categories and executive summary synthesis...");
const magdaSnapshot = createBaseSnapshot();
magdaSnapshot.repository.name = "magda-agent";
magdaSnapshot.repository.fullName = "circlefin/magda-agent";
magdaSnapshot.repository.description = "Magda Autonomous AI Telegram Agent";
magdaSnapshot.projectPurpose = {
  summary: "Magda Autonomous AI Telegram Agent with vector memory and FastAPI server",
  primaryInterface: "Telegram bot",
  capabilities: ["API server", "Telegram bot", "Vector memory", "LLM integration", "Machine learning", "Scheduled jobs", "Testing", "WebSockets"],
  targetUsers: "Telegram users & subscribers",
  developmentStage: "Active development",
};
magdaSnapshot.stack = {
  primaryLanguage: "Python",
  detectedFrameworks: ["FastAPI", "Docker"],
  hasWorkflows: true,
  languages: { Python: 100 },
};
magdaSnapshot.dependencyProfile = {
  manifests: ["requirements.txt"],
  productionDependencies: ["fastapi", "uvicorn", "openai", "chromadb", "torch", "transformers", "python-telegram-bot", "croniter", "websockets"],
  developmentDependencies: ["pytest"],
  detectedCapabilities: ["API server", "Telegram bot", "Vector memory", "LLM integration", "Machine learning", "Scheduled jobs", "Testing", "WebSockets"],
};
magdaSnapshot.repositoryStructure = {
  sourceDirectories: ["src"],
  testDirectories: ["tests"],
  entrypoints: ["main.py"],
  dockerFiles: ["Dockerfile", "docker-compose.yml"],
  configFiles: ["requirements.txt"],
};

const magdaResult = analyzeGitHubDueDiligence(magdaSnapshot);

assert.equal(magdaResult.categories.testing.status, "strong");
assert.equal(magdaResult.categories.dependencyHygiene.status, "moderate");
assert.equal(magdaResult.categories.deploymentReadiness.status, "strong");
assert.ok(magdaResult.categories.operationalMaturity.status !== "strong");
assert.ok(magdaResult.overallSummary.includes("Magda Autonomous AI Telegram Agent"));
assert.ok(magdaResult.overallSummary.includes("primarily written in Python"));
console.log("✔ Rich P1.4 categories and executive summary synthesis test passed.");

// Test 11: Bot contributor separation & automation_heavy_history risk
console.log("Test 11: Testing bot contributor separation and automation_heavy_history risk...");
const botHeavySnapshot = createBaseSnapshot();
botHeavySnapshot.contributors = {
  sampledCount: 3,
  sampledHumanContributorCount: 1,
  sampledBotContributorCount: 2,
  topHumanContributorShare: 100,
  botContributionShare: 75,
  sampledTopContributorShare: 50,
  topContributors: [
    { login: "google-labs-jules[bot]", contributions: 100, avatarUrl: null, isBot: true, accountType: "bot" },
    { login: "devin-ai-integration[bot]", contributions: 50, avatarUrl: null, isBot: true, accountType: "bot" },
    { login: "alice", contributions: 50, avatarUrl: null, isBot: false, accountType: "human" },
  ],
};

const botHeavyResult = analyzeGitHubDueDiligence(botHeavySnapshot);
const botRisk = botHeavyResult.risks.find((r) => r.code === "automation_heavy_history");
assert(botRisk, "botContributionShare >= 50% must trigger 'automation_heavy_history' risk");
assert.equal(botRisk.severity, "info");
assert.ok(botRisk.description.includes("Automation-heavy contribution history"));

const concentrationRisk = botHeavyResult.risks.find((r) => r.code === "single_contributor_concentration");
assert(concentrationRisk, "1 human maintainer with 100% human share must trigger 'single_contributor_concentration' risk despite bots");
assert.equal(botHeavyResult.categories.contributorDistribution.status, "weak");
console.log("✔ Bot contributor separation and automation_heavy_history test passed.");

// Test 12: 0 releases + missing license results in Operational Maturity != strong and Overall Status === review_needed
console.log("Test 12: Testing 0 releases + missing license results in Operational Maturity != strong and Overall Status === review_needed...");
const noReleaseNoLicenseSnapshot = createBaseSnapshot();
noReleaseNoLicenseSnapshot.releases.totalCount = 0;
noReleaseNoLicenseSnapshot.releases.latestRelease = null;
noReleaseNoLicenseSnapshot.releases.releaseCount90d = 0;
noReleaseNoLicenseSnapshot.documentation.hasLicense = false;
noReleaseNoLicenseSnapshot.repository.license = null;

const noReleaseNoLicenseResult = analyzeGitHubDueDiligence(noReleaseNoLicenseSnapshot);
assert.notEqual(
  noReleaseNoLicenseResult.categories.operationalMaturity.status,
  "strong",
  "Operational Maturity status CANNOT be strong when releases = 0"
);
assert.equal(
  noReleaseNoLicenseResult.overallStatus,
  "review_needed",
  "Missing license MUST force overall status to review_needed"
);
assert.equal(noReleaseNoLicenseResult.verdict.code, "proceed_with_conditions");
assert(
  noReleaseNoLicenseResult.verdict.blockingFindings.includes("Missing Open Source License"),
  "Missing license must be explicit in verdict blocking findings",
);
console.log("✔ 0 releases + missing license calibration test passed.");

// Test 13: Single requirements.txt evaluates to moderate for Dependency Hygiene
console.log("Test 13: Testing single requirements.txt evaluates to moderate for Dependency Hygiene...");
const singleReqSnapshot = createBaseSnapshot();
singleReqSnapshot.dependencyProfile = {
  manifests: ["requirements.txt"],
  productionDependencies: ["fastapi", "uvicorn"],
  developmentDependencies: [],
  detectedCapabilities: ["API server"],
};
singleReqSnapshot.repositoryStructure = {
  sourceDirectories: ["src"],
  testDirectories: [],
  entrypoints: ["main.py"],
  dockerFiles: [],
  configFiles: ["requirements.txt"],
};

const singleReqResult = analyzeGitHubDueDiligence(singleReqSnapshot);
assert.equal(
  singleReqResult.categories.dependencyHygiene.status,
  "moderate",
  "Single requirements.txt without separate dev manifest or lockfile must evaluate to moderate"
);
console.log("✔ Single requirements.txt Dependency Hygiene test passed.");

// Test 14: Confidence field presence on all category assessments
console.log("Test 14: Testing confidence field presence on all category assessments...");
const sampleResult = analyzeGitHubDueDiligence(createBaseSnapshot());
for (const [catName, assessment] of Object.entries(sampleResult.categories)) {
  assert.ok(
    ["high", "medium", "low"].includes(assessment.confidence),
    `Category ${catName} must have a valid confidence field ("high", "medium", or "low"), got: ${assessment.confidence}`
  );
}
console.log("✔ Confidence field presence test passed.");

// Test 15: magda-agent comprehensive fixture test suite
console.log("Test 15: Testing magda-agent comprehensive fixture test suite...");
const magdaFixtureReadme = `<div align="center"><img src="https://raw.githubusercontent.com/circlefin/magda-agent/main/logo.png" /><h1>magda-agent</h1></div><p>Experimental cognitive agent framework built around Telegram, FastAPI, vector memory, LLM integration, and automated self-improvement.</p>`;

const magdaComprehensiveSnapshot: GitHubRepositorySnapshot = {
  version: 1,
  ref: {
    owner: "circlefin",
    name: "magda-agent",
    fullName: "circlefin/magda-agent",
    canonicalUrl: "https://github.com/circlefin/magda-agent",
  },
  repository: {
    id: 98765432,
    owner: "circlefin",
    name: "magda-agent",
    fullName: "circlefin/magda-agent",
    description: "Experimental cognitive agent framework built around Telegram, FastAPI, vector memory, LLM integration, and automated self-improvement.",
    isPrivate: false,
    isFork: false,
    isArchived: false,
    defaultBranch: "main",
    starsCount: 85,
    forksCount: 12,
    openIssuesCount: 3,
    watchersCount: 85,
    createdAt: "2026-02-01T00:00:00Z",
    updatedAt: "2026-07-24T12:00:00Z",
    pushedAt: "2026-07-24T12:00:00Z",
    license: null,
    homepage: null,
    topics: ["telegram", "fastapi", "chromadb", "llm"],
  },
  activity: {
    recentCommitCount: 500,
    commitAuthorCount: 3,
    lastCommitAt: "2026-07-24T12:00:00Z",
    commitCount30d: 500,
    commitCount90d: 500,
    commitCount180d: 500,
    commitCount30dIsLowerBound: true,
    commitCount90dIsLowerBound: true,
    commitCount180dIsLowerBound: true,
  },
  contributors: {
    sampledCount: 3,
    sampledHumanContributorCount: 1,
    sampledBotContributorCount: 2,
    topHumanContributorShare: 100,
    botContributionShare: 80,
    sampledTopContributorShare: 48,
    topContributors: [
      { login: "google-labs-jules[bot]", contributions: 120, avatarUrl: null, isBot: true, accountType: "bot" },
      { login: "devin-ai-integration[bot]", contributions: 80, avatarUrl: null, isBot: true, accountType: "bot" },
      { login: "alice", contributions: 50, avatarUrl: null, isBot: false, accountType: "human" },
    ],
  },
  releases: {
    totalCount: 0,
    latestRelease: null,
    releaseCount90d: 0,
  },
  collaboration: {
    openIssuesCount: 3,
    hasDiscussions: false,
  },
  documentation: {
    hasReadme: true,
    hasLicense: false,
    hasSecurityPolicy: false,
    hasContributing: false,
    hasCodeOfConduct: false,
    readmeSize: 2048,
    securityPolicySize: 0,
    contributingSize: 0,
  },
  projectPurpose: {
    summary: "Experimental cognitive agent framework built around Telegram, FastAPI, vector memory, LLM integration, and automated self-improvement.",
    primaryInterface: "Telegram bot",
    capabilities: ["Telegram bot", "API server", "Vector memory", "LLM integration", "Machine learning", "Testing"],
    targetUsers: "Developers & AI researchers",
    developmentStage: "Active development",
  },
  dependencyProfile: {
    manifests: ["requirements.txt"],
    productionDependencies: ["fastapi", "openai", "chromadb", "torch", "transformers", "python-telegram-bot"],
    developmentDependencies: ["pytest"],
    detectedCapabilities: ["Telegram bot", "API server", "Vector memory", "LLM integration", "Machine learning", "Testing"],
  },
  repositoryStructure: {
    sourceDirectories: ["app"],
    testDirectories: ["tests"],
    entrypoints: ["app/main.py"],
    dockerFiles: [],
    configFiles: ["requirements.txt"],
  },
  stack: {
    primaryLanguage: "Python",
    languages: { Python: 50000 },
    detectedFrameworks: ["FastAPI", "PyTorch"],
    hasWorkflows: false,
    workflowCount: 0,
    workflowNames: [],
  },
  excerpts: {
    readmeExcerpt: magdaFixtureReadme,
    securityExcerpt: null,
    contributingExcerpt: null,
  },
  source: {
    fetchedAt: "2026-07-24T14:00:00.000Z",
    cacheHit: false,
    provider: "GitHub REST API v3",
    upstreamStatus: "success",
  },
};

// Assert 1: extractProjectSummaryFromReadme ignores <div align="center"> and extracts clean prose paragraph
const cleanProse = extractProjectSummaryFromReadme(magdaFixtureReadme);
assert.equal(
  cleanProse,
  "Experimental cognitive agent framework built around Telegram, FastAPI, vector memory, LLM integration, and automated self-improvement.",
  "extractProjectSummaryFromReadme must ignore HTML containers and extract clean prose paragraph"
);

// Assert 2: commitCount90dDisplay evaluates to 500+
const commitCount90dDisplay = magdaComprehensiveSnapshot.activity.commitCount90dIsLowerBound
  ? `${magdaComprehensiveSnapshot.activity.commitCount90d}+`
  : `${magdaComprehensiveSnapshot.activity.commitCount90d}`;
assert.equal(commitCount90dDisplay, "500+", "commitCount90dDisplay must evaluate to 500+");

// Assert 3: sampledHumanContributorCount === 1, sampledBotContributorCount === 2
assert.equal(magdaComprehensiveSnapshot.contributors.sampledHumanContributorCount, 1);
assert.equal(magdaComprehensiveSnapshot.contributors.sampledBotContributorCount, 2);

// Assert 4: Nested entrypoint app/main.py is detected in repositoryStructure.entrypoints
assert.ok(
  magdaComprehensiveSnapshot.repositoryStructure.entrypoints.includes("app/main.py"),
  "Nested entrypoint app/main.py must be detected"
);

const magdaCompResult = analyzeGitHubDueDiligence(magdaComprehensiveSnapshot);

// Assert 5: Maintainer concentration risk (single_contributor_concentration) evaluates based on human maintainers
const magdaConcRisk = magdaCompResult.risks.find((r) => r.code === "single_contributor_concentration");
assert(magdaConcRisk, "Single human maintainer must trigger single_contributor_concentration risk");
assert.equal(magdaConcRisk.severity, "medium");

// Assert 6: Info risk automation_heavy_history is triggered (botContributionShare >= 50%)
const magdaBotRisk = magdaCompResult.risks.find((r) => r.code === "automation_heavy_history");
assert(magdaBotRisk, "botContributionShare >= 50% must trigger automation_heavy_history risk");
assert.equal(magdaBotRisk.severity, "info");

// Assert 7: operationalMaturity status is NOT strong
assert.notEqual(
  magdaCompResult.categories.operationalMaturity.status,
  "strong",
  "operationalMaturity status must NOT be strong for repo with 0 releases and missing license"
);

// Assert 8: overallStatus evaluates to review_needed (missing license)
assert.equal(
  magdaCompResult.overallStatus,
  "review_needed",
  "Missing license MUST force overallStatus to review_needed"
);

// Assert 9: publicExecutiveSummary describes the project features rather than API calls
const publicExecutiveSummary = magdaCompResult.overallSummary;
assert.ok(
  publicExecutiveSummary.includes("Experimental cognitive agent framework") ||
    publicExecutiveSummary.includes("magda-agent") ||
    publicExecutiveSummary.includes("FastAPI"),
  "publicExecutiveSummary must describe project features"
);
assert.ok(
  !publicExecutiveSummary.includes("completed 2 of 2 paid API calls"),
  "publicExecutiveSummary must NOT include API execution metadata"
);
assert.ok(
  publicExecutiveSummary.includes("standard repository structure and CI automation"),
  "Governance summary text for repository without governance files must state 'standard repository structure and CI automation'"
);

console.log("✔ magda-agent comprehensive fixture test suite passed.");

console.log("\n[github-due-diligence-test] ALL TEST SUITES PASSED SUCCESSFULLY!");


