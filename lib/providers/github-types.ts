/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GitHubRepositoryRef } from "./github-repository-ref";

export type DataConfidence = "high" | "medium" | "low";

export interface GitHubRepositoryMetadata {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  description: string | null;
  isPrivate: boolean;
  isFork: boolean;
  isArchived: boolean;
  defaultBranch: string;
  starsCount: number;
  forksCount: number;
  openIssuesCount: number;
  watchersCount: number;
  createdAt: string;
  updatedAt: string;
  pushedAt: string;
  license: {
    key: string;
    name: string;
    spdxId: string | null;
    url: string | null;
  } | null;
  homepage: string | null;
  topics: string[];
}

export interface GitHubActivityMetrics {
  recentCommitCount: number;
  commitAuthorCount: number;
  lastCommitAt: string | null;
  commitCount30d: number;
  commitCount90d: number;
  commitCount180d: number;
  commitCount30dIsLowerBound: boolean;
  commitCount90dIsLowerBound: boolean;
  commitCount180dIsLowerBound: boolean;
}

export interface GitHubContributorItem {
  login: string;
  contributions: number;
  avatarUrl: string | null;
  isBot: boolean;
  accountType: "human" | "bot" | "unknown";
}

export interface GitHubContributorsMetrics {
  sampledCount: number;
  topContributors: GitHubContributorItem[];
  sampledTopContributorShare: number;
  sampledHumanContributorCount: number;
  sampledBotContributorCount: number;
  topHumanContributorShare: number;
  botContributionShare: number;
}

export interface GitHubReleaseItem {
  name: string | null;
  tagName: string;
  publishedAt: string | null;
  isPrerelease: boolean;
  body: string | null;
}

export interface GitHubReleasesMetrics {
  totalCount: number;
  latestRelease: GitHubReleaseItem | null;
  releaseCount90d: number;
}

export interface GitHubCollaborationMetrics {
  openIssuesCount: number;
  openPullRequestsCount?: number;
  hasDiscussions: boolean;
}

export interface GitHubDocumentationMetrics {
  hasReadme: boolean;
  hasLicense: boolean;
  hasSecurityPolicy: boolean;
  hasContributing: boolean;
  hasCodeOfConduct: boolean;
  hasCodeowners?: boolean;
  readmeSize: number | null;
  securityPolicySize: number | null;
  contributingSize: number | null;
}

export interface GitHubStackMetrics {
  primaryLanguage: string | null;
  languages: Record<string, number>;
  detectedFrameworks: string[];
  hasWorkflows: boolean;
  workflowCount: number;
  workflowNames: string[];
}

export interface GitHubExcerpts {
  readmeExcerpt: string | null;
  securityExcerpt: string | null;
  contributingExcerpt: string | null;
}

export interface GitHubSourceMetadata {
  fetchedAt: string;
  cacheHit: boolean;
  cacheStatus?: "live" | "cached";
  cacheAgeSeconds?: number;
  provider: "GitHub REST API v3";
  upstreamStatus: "success" | "partial_success" | "fallback";
  warnings?: string[];
  partial?: boolean;
}

export interface GitHubProjectPurpose {
  summary: string;
  primaryInterface: string;
  capabilities: string[];
  targetUsers: string;
  developmentStage: string;
}

export interface GitHubDependencyProfile {
  manifests: string[];
  productionDependencies: string[];
  developmentDependencies: string[];
  detectedCapabilities: string[];
}

export interface GitHubRepositoryStructure {
  sourceDirectories: string[];
  testDirectories: string[];
  entrypoints: string[];
  dockerFiles: string[];
  configFiles: string[];
}

export interface GitHubRepositorySnapshot {
  version: 1;
  ref: GitHubRepositoryRef;
  repository: GitHubRepositoryMetadata;
  activity: GitHubActivityMetrics;
  contributors: GitHubContributorsMetrics;
  releases: GitHubReleasesMetrics;
  collaboration: GitHubCollaborationMetrics;
  documentation: GitHubDocumentationMetrics;
  stack: GitHubStackMetrics;
  projectPurpose?: GitHubProjectPurpose;
  dependencyProfile?: GitHubDependencyProfile;
  repositoryStructure?: GitHubRepositoryStructure;
  excerpts: GitHubExcerpts;
  source: GitHubSourceMetadata;
}

export function isGitHubRepositorySnapshot(value: unknown): value is GitHubRepositorySnapshot {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  const ref = item.ref as Record<string, unknown> | undefined;
  const repo = item.repository as Record<string, unknown> | undefined;
  const src = item.source as Record<string, unknown> | undefined;
  return (
    item.version === 1 &&
    Boolean(ref && typeof ref.owner === "string" && typeof ref.name === "string") &&
    Boolean(repo && typeof repo.fullName === "string" && typeof repo.defaultBranch === "string") &&
    Boolean(item.activity && typeof item.activity === "object") &&
    Boolean(item.documentation && typeof item.documentation === "object") &&
    Boolean(item.stack && typeof item.stack === "object") &&
    Boolean(src && typeof src.provider === "string")
  );
}
