/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { ProviderError } from "./errors.ts";
import type { GitHubRepositoryRef } from "./github-repository-ref.ts";
import type {
  GitHubRepositorySnapshot,
  GitHubRepositoryMetadata,
  GitHubActivityMetrics,
  GitHubContributorItem,
  GitHubContributorsMetrics,
  GitHubReleasesMetrics,
  GitHubCollaborationMetrics,
  GitHubDocumentationMetrics,
  GitHubStackMetrics,
  GitHubExcerpts,
  GitHubSourceMetadata,
  GitHubProjectPurpose,
  GitHubDependencyProfile,
  GitHubRepositoryStructure,
} from "./github-types.ts";
import { redactHostedWorkflowText } from "../agent/hosted-workflows.ts";

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_RAW_BASE = "https://raw.githubusercontent.com";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_EXCERPT_BYTES = 128 * 1024; // 128KB
const DISCOVERY_FALLBACK_PATHS = [
  "README.md",
  "README",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "foundry.toml",
  "hardhat.config.ts",
  "hardhat.config.js",
  "vercel.json",
  "docker-compose.yml",
  "docker-compose.yaml",
  "docs/agent-api.md",
  "docs/operations.md",
  "contracts/README.md",
  "public/openapi/agent-commerce-v1.json",
] as const;

type CacheEntry = {
  snapshot: GitHubRepositorySnapshot;
  expiresAt: number;
};

const snapshotCache = new Map<string, CacheEntry>();

export function clearGitHubSnapshotCache(): void {
  snapshotCache.clear();
}

function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "Agent-Commerce-Repository-Intelligence",
  };
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) {
    if (token.toLowerCase().startsWith("bearer ") || token.toLowerCase().startsWith("token ")) {
      headers.Authorization = token;
    } else {
      headers.Authorization = `Bearer ${token}`;
    }
  }
  return headers;
}

async function githubFetch<T>(
  endpoint: string,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const url = `${GITHUB_API_BASE}${endpoint}`;
  const timeoutMs = options.timeoutMs ?? 8000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: getAuthHeaders(),
      signal: controller.signal,
    });

    if (res.status === 404) {
      throw new ProviderError("github_repository_not_found", {
        httpStatus: 404,
        upstreamStatus: 404,
      });
    }

    if (res.status === 403 || res.status === 429) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      if (remaining === "0" || res.status === 429) {
        throw new ProviderError("github_rate_limited", {
          httpStatus: 429,
          upstreamStatus: res.status,
          retryable: true,
        });
      }
      throw new ProviderError("github_repository_inaccessible", {
        httpStatus: 403,
        upstreamStatus: 403,
      });
    }

    if (res.status === 401) {
      throw new ProviderError("github_repository_inaccessible", {
        httpStatus: 401,
        upstreamStatus: 401,
      });
    }

    if (!res.ok) {
      throw new ProviderError("upstream_error", {
        httpStatus: 502,
        upstreamStatus: res.status,
        retryable: true,
      });
    }

    return (await res.json()) as T;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new ProviderError("github_provider_timeout", {
        httpStatus: 504,
        retryable: true,
      });
    }
    throw new ProviderError("upstream_error", {
      httpStatus: 502,
      upstreamMessage: error instanceof Error ? error.message : String(error),
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function githubFetchContentExcerpt(
  owner: string,
  name: string,
  pathOrPaths: string | string[],
): Promise<string | null> {
  const paths = Array.isArray(pathOrPaths) ? pathOrPaths : [pathOrPaths];
  for (const path of paths) {
    try {
      const endpoint = `/repos/${owner}/${name}/contents/${path}`;
      const data = await githubFetch<{
        content?: string;
        encoding?: string;
        size?: number;
      }>(endpoint, { timeoutMs: 5000 });

      if (!data || !data.content) continue;
      let rawText = "";
      if (data.encoding === "base64") {
        const cleanBase64 = data.content.replace(/\s/g, "");
        rawText = Buffer.from(cleanBase64, "base64").toString("utf-8");
      } else {
        rawText = String(data.content);
      }

      const bounded = rawText.slice(0, MAX_EXCERPT_BYTES);
      return redactHostedWorkflowText(bounded);
    } catch (err) {
      if (err instanceof ProviderError && err.httpStatus === 404) {
        continue;
      }
      throw err;
    }
  }
  return null;
}

async function githubFetchReadmeExcerpt(
  owner: string,
  name: string,
): Promise<string | null> {
  try {
    const endpoint = `/repos/${owner}/${name}/readme`;
    const data = await githubFetch<{
      content?: string;
      encoding?: string;
    }>(endpoint, { timeoutMs: 5000 });

    if (!data || !data.content) return null;
    let rawText = "";
    if (data.encoding === "base64") {
      const cleanBase64 = data.content.replace(/\s/g, "");
      rawText = Buffer.from(cleanBase64, "base64").toString("utf-8");
    } else {
      rawText = String(data.content);
    }

    const bounded = rawText.slice(0, MAX_EXCERPT_BYTES);
    return redactHostedWorkflowText(bounded);
  } catch (err) {
    if (err instanceof ProviderError && err.httpStatus === 404) {
      return null;
    }
    throw err;
  }
}

export type GitHubDiscoveryFile = {
  path: string;
  content: string;
  sizeBytes: number;
};

function discoveryPathPriority(path: string) {
  const normalized = path.toLowerCase();
  const fileName = normalized.split("/").at(-1) ?? normalized;
  if (!normalized.includes("/") && /^readme(?:\.[a-z0-9]+)?$/.test(fileName)) return 0;
  if (
    /(?:^|\/)(?:openapi|agent-api)(?:[./_-]|$)/.test(normalized) ||
    /(?:^|\/)contracts?\/readme(?:\.[a-z0-9]+)?$/.test(normalized)
  ) return 1;
  if (/^readme(?:\.[a-z0-9]+)?$/.test(fileName)) return 2;
  if (
    [
      "package.json", "pyproject.toml", "requirements.txt", "cargo.toml",
      "go.mod", "foundry.toml", "hardhat.config.ts", "hardhat.config.js",
      "vercel.json", "docker-compose.yml", "docker-compose.yaml",
    ].includes(fileName)
  ) return 3;
  if (
    /(?:^|\/)(?:config|configs|deploy|deployment|docs?|\.github)(?:\/|$)/.test(normalized) ||
    /\.(?:ya?ml|json|toml|ini|config|md|mdx)$/.test(normalized)
  ) return 4;
  if (
    /(?:^|\/)(?:src|app|lib|contracts?|packages?|services?)(?:\/|$)/.test(normalized) &&
    /\.(?:ts|tsx|js|jsx|mts|mjs|py|go|rs|sol)$/.test(normalized)
  ) return 5;
  return 9;
}

/**
 * Bounded public-file reader used by the free Project 360 discovery plane.
 * It only calls fixed GitHub API hosts through githubFetch and never executes
 * repository content.
 */
async function fetchGitHubDiscoveryFilesFromApi(
  repository: GitHubRepositoryRef,
  limits: {
    maxFiles?: number;
    maxFileBytes?: number;
    maxTotalBytes?: number;
  } = {},
): Promise<GitHubDiscoveryFile[]> {
  const deadline = Date.now() + 14_000;
  const remainingTimeout = (capMs: number) =>
    Math.max(250, Math.min(capMs, deadline - Date.now()));
  const maxFiles = Math.max(1, Math.min(limits.maxFiles ?? 40, 40));
  const maxFileBytes = Math.max(1_024, Math.min(limits.maxFileBytes ?? 64 * 1_024, 64 * 1_024));
  const maxTotalBytes = Math.max(maxFileBytes, Math.min(limits.maxTotalBytes ?? 512 * 1_024, 512 * 1_024));
  const metadata = await githubFetch<{ default_branch?: string }>(
    `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`,
    { timeoutMs: remainingTimeout(4_000) },
  );
  const branch = metadata.default_branch?.trim() || "main";
  const tree = await githubFetch<{
    tree?: Array<{ path?: string; type?: string; size?: number }>;
  }>(
    `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    { timeoutMs: remainingTimeout(5_000) },
  );
  const selected = (tree.tree ?? [])
    .filter((item) =>
      item.type === "blob" &&
      typeof item.path === "string" &&
      item.path.length <= 240 &&
      item.path.split("/").length <= 8 &&
      typeof item.size === "number" &&
      item.size > 0 &&
      (
        item.size <= maxFileBytes ||
        (discoveryPathPriority(item.path) <= 1 && item.size <= maxFileBytes * 2)
      ) &&
      discoveryPathPriority(item.path) < 9,
    )
    .sort((left, right) => {
      const priority = discoveryPathPriority(left.path!) - discoveryPathPriority(right.path!);
      return priority || left.path!.localeCompare(right.path!);
    })
    .slice(0, maxFiles);

  const fetched: Array<GitHubDiscoveryFile | null> = Array(selected.length).fill(null);
  let nextIndex = 0;
  let firstNonMissingError: unknown = null;
  const worker = async () => {
    while (Date.now() < deadline) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= selected.length) return;
      const item = selected[index];
      const path = item.path!;
      try {
        const data = await githubFetch<{
          content?: string;
          encoding?: string;
          size?: number;
        }>(
          `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branch)}`,
          { timeoutMs: remainingTimeout(3_000) },
        );
        if (!data.content) continue;
        const raw = data.encoding === "base64"
          ? Buffer.from(data.content.replace(/\s/g, ""), "base64").toString("utf8")
          : String(data.content);
        const content = raw.slice(0, maxFileBytes);
        const sizeBytes = Buffer.byteLength(content, "utf8");
        if (sizeBytes > 0) fetched[index] = { path, content, sizeBytes };
      } catch (error) {
        if (error instanceof ProviderError && error.httpStatus === 404) continue;
        firstNonMissingError ??= error;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(8, selected.length) }, () => worker()),
  );

  const files: GitHubDiscoveryFile[] = [];
  let totalBytes = 0;
  for (const file of fetched) {
    if (!file) continue;
    if (totalBytes >= maxTotalBytes) break;
    const availableBytes = maxTotalBytes - totalBytes;
    const content = file.sizeBytes <= availableBytes
      ? file.content
      : Buffer.from(file.content, "utf8").subarray(0, availableBytes).toString("utf8");
    const sizeBytes = Buffer.byteLength(content, "utf8");
    if (sizeBytes === 0) continue;
    files.push({ path: file.path, content, sizeBytes });
    totalBytes += sizeBytes;
  }
  if (files.length === 0 && firstNonMissingError) throw firstNonMissingError;
  return files;
}

async function boundedResponseText(response: Response, maxBytes: number) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const result = await reader.read();
    if (result.done) break;
    const available = maxBytes - total;
    const chunk = result.value.subarray(0, available);
    chunks.push(chunk);
    total += chunk.byteLength;
    if (chunk.byteLength < result.value.byteLength) {
      await reader.cancel();
      break;
    }
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

async function fetchGitHubDiscoveryFilesFromRaw(
  repository: GitHubRepositoryRef,
  limits: {
    maxFiles?: number;
    maxFileBytes?: number;
    maxTotalBytes?: number;
  },
) {
  const maxFiles = Math.max(1, Math.min(limits.maxFiles ?? 40, 40));
  const maxFileBytes = Math.max(1_024, Math.min(limits.maxFileBytes ?? 64 * 1_024, 64 * 1_024));
  const maxTotalBytes = Math.max(maxFileBytes, Math.min(limits.maxTotalBytes ?? 512 * 1_024, 512 * 1_024));
  const encodedRepository = [repository.owner, repository.name].map(encodeURIComponent).join("/");

  for (const branch of ["main", "master"]) {
    const files = await Promise.all(
      DISCOVERY_FALLBACK_PATHS.slice(0, maxFiles).map(async (path) => {
        const encodedPath = path.split("/").map(encodeURIComponent).join("/");
        const urls = [
          `${GITHUB_RAW_BASE}/${encodedRepository}/${encodeURIComponent(branch)}/${encodedPath}`,
          `https://cdn.jsdelivr.net/gh/${encodedRepository}@${encodeURIComponent(branch)}/${encodedPath}`,
        ];
        for (const url of urls) {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 4_000);
          try {
            const response = await fetch(url, {
              headers: {
                Accept: "text/plain",
                Range: `bytes=0-${maxFileBytes - 1}`,
                "User-Agent": "Veyra-Project-360-Discovery",
              },
              signal: controller.signal,
            });
            if (!response.ok) continue;
            const content = await boundedResponseText(response, maxFileBytes);
            const sizeBytes = Buffer.byteLength(content, "utf8");
            if (sizeBytes > 0) return { path, content, sizeBytes };
          } catch {
            // The next fixed public-content host is the bounded fallback.
          } finally {
            clearTimeout(timer);
          }
        }
        return null;
      }),
    );
    const bounded: GitHubDiscoveryFile[] = [];
    let totalBytes = 0;
    for (const file of files) {
      if (!file || totalBytes >= maxTotalBytes) continue;
      const availableBytes = maxTotalBytes - totalBytes;
      const content = file.sizeBytes <= availableBytes
        ? file.content
        : Buffer.from(file.content, "utf8").subarray(0, availableBytes).toString("utf8");
      const sizeBytes = Buffer.byteLength(content, "utf8");
      if (sizeBytes > 0) {
        bounded.push({ path: file.path, content, sizeBytes });
        totalBytes += sizeBytes;
      }
    }
    if (bounded.length > 0) return bounded;
  }
  return [];
}

export async function fetchGitHubDiscoveryFiles(
  repository: GitHubRepositoryRef,
  limits: {
    maxFiles?: number;
    maxFileBytes?: number;
    maxTotalBytes?: number;
  } = {},
): Promise<GitHubDiscoveryFile[]> {
  try {
    return await fetchGitHubDiscoveryFilesFromApi(repository, limits);
  } catch (error) {
    const fallback = await fetchGitHubDiscoveryFilesFromRaw(repository, limits);
    if (fallback.length > 0) return fallback;
    throw error;
  }
}

function parseRequirementsTxt(content: string): { prod: string[]; dev: string[] } {
  const prod = new Set<string>();
  const dev = new Set<string>();

  const devPackages = new Set([
    "pytest", "pytest-cov", "black", "flake8", "mypy", "ruff",
    "coverage", "isort", "tox", "pytest-asyncio", "pytest-mock"
  ]);

  const lines = content.split("\n");
  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith("#") || line.startsWith("-r") || line.startsWith("-e")) continue;
    const commentIdx = line.indexOf("#");
    if (commentIdx !== -1) {
      line = line.slice(0, commentIdx).trim();
    }
    const match = line.match(/^([a-zA-Z0-9_\-\.]+)/);
    if (match) {
      const pkg = match[1].toLowerCase();
      if (devPackages.has(pkg)) {
        dev.add(pkg);
      } else {
        prod.add(pkg);
      }
    }
  }

  return { prod: Array.from(prod), dev: Array.from(dev) };
}

function parsePyprojectToml(content: string): { prod: string[]; dev: string[] } {
  const prod = new Set<string>();
  const dev = new Set<string>();

  const devPackages = new Set([
    "pytest", "pytest-cov", "black", "flake8", "mypy", "ruff",
    "coverage", "isort", "tox", "pytest-asyncio", "pytest-mock"
  ]);

  const matches = content.match(/["']([a-zA-Z0-9_\-\.]+)(?:[<>=~!\[;]|\s*["'])/g) || [];
  for (const match of matches) {
    const pkgMatch = match.match(/["']([a-zA-Z0-9_\-\.]+)/);
    if (pkgMatch) {
      const pkg = pkgMatch[1].toLowerCase();
      if (["dependencies", "dev-dependencies", "tool", "poetry", "project", "build-system", "requires"].includes(pkg)) continue;
      if (devPackages.has(pkg)) {
        dev.add(pkg);
      } else {
        prod.add(pkg);
      }
    }
  }

  return { prod: Array.from(prod), dev: Array.from(dev) };
}

function parsePackageJson(content: string): { prod: string[]; dev: string[] } {
  const prod = new Set<string>();
  const dev = new Set<string>();

  try {
    const parsed = JSON.parse(content);
    if (parsed.dependencies && typeof parsed.dependencies === "object") {
      Object.keys(parsed.dependencies).forEach((k) => prod.add(k.toLowerCase()));
    }
    if (parsed.devDependencies && typeof parsed.devDependencies === "object") {
      Object.keys(parsed.devDependencies).forEach((k) => dev.add(k.toLowerCase()));
    }
  } catch {
    const depMatches = content.match(/"dependencies"\s*:\s*\{([^}]+)\}/);
    if (depMatches) {
      const keys = depMatches[1].match(/"([^"]+)":/g) || [];
      for (const k of keys) prod.add(k.replace(/"/g, "").replace(":", "").trim().toLowerCase());
    }
    const devDepMatches = content.match(/"devDependencies"\s*:\s*\{([^}]+)\}/);
    if (devDepMatches) {
      const keys = devDepMatches[1].match(/"([^"]+)":/g) || [];
      for (const k of keys) dev.add(k.replace(/"/g, "").replace(":", "").trim().toLowerCase());
    }
  }

  return { prod: Array.from(prod), dev: Array.from(dev) };
}

function parseCargoToml(content: string): { prod: string[]; dev: string[] } {
  const prod = new Set<string>();
  const dev = new Set<string>();

  const matches = content.match(/^([a-zA-Z0-9_\-]+)\s*=\s*/gm) || [];
  for (const match of matches) {
    const name = match.split("=")[0].trim().toLowerCase();
    if (!["package", "dependencies", "dev-dependencies", "workspace", "profile"].includes(name)) {
      prod.add(name);
    }
  }

  return { prod: Array.from(prod), dev: Array.from(dev) };
}

function parseGoMod(content: string): { prod: string[]; dev: string[] } {
  const prod = new Set<string>();
  const dev = new Set<string>();

  const matches = content.match(/require\s+\(?([^\)]+)\)?/);
  if (matches) {
    const lines = matches[1].split("\n");
    for (let line of lines) {
      line = line.trim();
      const parts = line.split(/\s+/);
      if (parts[0] && parts[0].includes("/")) {
        prod.add(parts[0]);
      }
    }
  }

  return { prod: Array.from(prod), dev: Array.from(dev) };
}

export function isBotContributor(login: string, type?: string): boolean {
  if (!login) return false;
  const lower = login.toLowerCase();
  if (type === "Bot" || type === "bot") return true;
  if (lower.endsWith("[bot]")) return true;
  const knownBotPatterns = [
    "dependabot",
    "renovate",
    "github-actions",
    "jules",
    "devin",
    "copilot",
    "codecov",
    "snyk",
    "greenkeeper",
    "semantic-release",
    "stale",
    "allcontributors",
  ];
  return knownBotPatterns.some((pattern) => lower.includes(pattern));
}

async function fetchWindowCommits(
  owner: string,
  name: string,
  sinceIso: string,
  maxPages = 5,
): Promise<{ count: number; isLowerBound: boolean; authors: Set<string>; lastCommitAt: string | null }> {
  let count = 0;
  let isLowerBound = false;
  const authors = new Set<string>();
  let lastCommitAt: string | null = null;
  const windowTime = new Date(sinceIso).getTime();

  for (let page = 1; page <= maxPages; page++) {
    const endpoint = `/repos/${owner}/${name}/commits?since=${encodeURIComponent(sinceIso)}&per_page=100&page=${page}`;
    const pageCommits = await githubFetch<Array<Record<string, any>>>(endpoint, { timeoutMs: 6000 });
    if (!Array.isArray(pageCommits) || pageCommits.length === 0) break;

    for (const c of pageCommits) {
      const commitDateStr = c.commit?.committer?.date || c.commit?.author?.date;
      if (commitDateStr) {
        const time = new Date(commitDateStr).getTime();
        if (!isNaN(time) && time >= windowTime) {
          count++;
          if (!lastCommitAt) lastCommitAt = commitDateStr;
          const authorLogin = c.author?.login || c.commit?.author?.email || c.commit?.author?.name;
          if (authorLogin) authors.add(authorLogin);
        }
      } else {
        count++;
        const authorLogin = c.author?.login || c.commit?.author?.email || c.commit?.author?.name;
        if (authorLogin) authors.add(authorLogin);
      }
    }

    if (pageCommits.length < 100) break;
    if (page === maxPages) {
      isLowerBound = true;
    }
  }

  if (count >= maxPages * 100) {
    isLowerBound = true;
    count = maxPages * 100;
  }

  return {
    count,
    isLowerBound,
    authors,
    lastCommitAt,
  };
}

export function extractProjectSummaryFromReadme(readme: string): string | null {
  if (!readme || typeof readme !== "string") return null;

  // 1. Remove HTML comments, style, script, convert block tags to paragraph breaks, and strip remaining tags
  let text = readme
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<\/?(div|p|h[1-6]|section|header|article|blockquote|picture|table|tr|td|li|ul|ol)[^>]*>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ");

  // 2. Remove code blocks
  text = text.replace(/```[\s\S]*?```/g, "");

  // 3. Remove inline code
  text = text.replace(/`[^`]+`/g, "");

  // 4. Remove badge links [![alt](img_url)](link_url)
  text = text.replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, "");

  // 5. Remove standalone images ![alt](url)
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, "");

  // 6. Replace regular markdown links [text](url) with text
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

  // 7. Remove raw HTTP/HTTPS URLs
  text = text.replace(/https?:\/\/\S+/g, "");

  // 8. Remove markdown headers (# Header)
  text = text.replace(/^#{1,6}\s+.*$/gm, "");

  // 9. Remove horizontal rules (---, ***, ___)
  text = text.replace(/^[-*=_]{3,}$/gm, "");

  // 10. Remove blockquotes (> quote)
  text = text.replace(/^>.*$/gm, "");

  // 11. Remove table formatting lines (lines starting with or containing pipe |)
  text = text.replace(/^\s*\|.*$/gm, "");

  // 12. Split into paragraphs and find first clean prose paragraph (40..500 chars)
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => {
      if (p.length < 40) return false;
      if (p.startsWith("|") || p.startsWith("-") || p.startsWith("*")) return false;
      return true;
    });

  if (paragraphs.length === 0) return null;
  let chosen = paragraphs[0];
  if (chosen.includes(" / ")) {
    const parts = chosen.split(" / ").map((p) => p.trim());
    const englishPart = parts.find((p) => /^[a-z0-9\s.,!?:;()'"-]+$/i.test(p));
    if (englishPart && englishPart.length >= 20) {
      chosen = englishPart;
    }
  }
  return chosen.length > 500 ? chosen.slice(0, 497) + "..." : chosen;
}

export interface GitTreeItem {
  path: string;
  type?: string;
  size?: number;
}

export function buildRepositoryStructureFromGitTree(
  rawTree: GitTreeItem[]
): GitHubRepositoryStructure {
  const sourceDirectories = new Set<string>();
  const testDirectories = new Set<string>();
  const entrypoints = new Set<string>();
  const dockerFiles = new Set<string>();
  const configFiles = new Set<string>();

  const srcDirNames = new Set(["src", "lib", "app", "pkg", "packages", "core", "services", "modules", "internal", "api"]);
  const testDirNames = new Set(["tests", "test", "spec", "__tests__"]);

  // Limit to max 1000 paths and depth <= 6
  const items = rawTree
    .filter((item) => item.path && item.path.split("/").length <= 6)
    .slice(0, 1000);

  for (const item of items) {
    const rawPath = item.path;
    const parts = rawPath.split("/");
    const depth = parts.length;
    const fileName = parts[parts.length - 1];
    const fileNameLower = fileName.toLowerCase();
    const isFile = item.type === "blob" || item.type === "file" || (!item.type && Boolean(item.size));
    const isDir = item.type === "tree" || item.type === "dir" || (!item.type && !item.size);

    // 1. Detect Source and Test Directories
    if (isDir || depth > 1) {
      const topDir = parts[0];
      const topDirLower = topDir.toLowerCase();
      if (srcDirNames.has(topDirLower)) sourceDirectories.add(topDir);
      if (testDirNames.has(topDirLower)) testDirectories.add(topDir);
    }

    // 2. Detect Entrypoints
    if (isFile) {
      if (
        ["main.py", "app.py", "server.py", "index.ts", "index.js", "server.js", "server.ts", "cli.ts", "cli.py", "main.go", "bot.py", "run.py", "agent.py"].includes(fileNameLower) ||
        fileNameLower === "__main__.py" ||
        rawPath === "src/main.py" ||
        rawPath === "app/main.py" ||
        rawPath === "src/agent.py" ||
        rawPath === "agent/main.py" ||
        rawPath === "src/index.ts" ||
        rawPath === "src/server.ts" ||
        rawPath === "app/page.tsx" ||
        rawPath === "src/main.rs" ||
        rawPath === "src/lib.rs" ||
        /^cmd\/[^\/]+\/main\.go$/i.test(rawPath) ||
        /^services\/[^\/]+\/main\.py$/i.test(rawPath) ||
        /^[^\/]+_agent\/__main__\.py$/i.test(rawPath) ||
        /^packages\/[^\/]+\/(?:src\/)?index\.(?:ts|js)$/i.test(rawPath)
      ) {
        entrypoints.add(rawPath);
      }
    }

    // 3. Detect Docker Files
    if (isFile) {
      if (
        fileNameLower === "dockerfile" ||
        fileNameLower === "docker-compose.yml" ||
        fileNameLower === "docker-compose.yaml" ||
        fileNameLower === "containerfile" ||
        /^dockerfile\..*$/i.test(fileName) ||
        /^docker-compose\..*\.ya?ml$/i.test(fileName)
      ) {
        dockerFiles.add(depth === 1 ? fileName : rawPath);
      }
    }

    // 4. Detect Config Files
    if (isFile) {
      if (
        fileNameLower === "tsconfig.json" ||
        fileNameLower === "pytest.ini" ||
        fileNameLower === "setup.cfg" ||
        fileNameLower === "tox.ini" ||
        fileNameLower === "ruff.toml" ||
        fileNameLower === "package.json" ||
        fileNameLower === "pyproject.toml" ||
        fileNameLower === "requirements.txt" ||
        fileNameLower === "cargo.toml" ||
        fileNameLower === "go.mod" ||
        fileNameLower === "foundry.toml" ||
        fileNameLower === ".env.example" ||
        /^\.eslintrc/i.test(fileName) ||
        /^hardhat\.config\.(?:ts|js)$/i.test(fileName) ||
        /^next\.config\.(?:ts|js|mjs)$/i.test(fileName)
      ) {
        configFiles.add(depth === 1 ? fileName : rawPath);
      }
    }
  }

  return {
    sourceDirectories: Array.from(sourceDirectories),
    testDirectories: Array.from(testDirectories),
    entrypoints: Array.from(entrypoints),
    dockerFiles: Array.from(dockerFiles),
    configFiles: Array.from(configFiles),
  };
}

function detectCapabilities(
  prodDeps: string[],
  devDeps: string[],
  manifests: string[],
  structure: GitHubRepositoryStructure,
  readmeExcerpt: string | null,
): string[] {
  const capabilities = new Set<string>();
  const allDeps = new Set([
    ...prodDeps.map((d) => d.toLowerCase()),
    ...devDeps.map((d) => d.toLowerCase()),
  ]);
  const readmeLower = (readmeExcerpt || "").toLowerCase();

  // 1. API server
  if (
    allDeps.has("fastapi") ||
    allDeps.has("uvicorn") ||
    allDeps.has("express") ||
    allDeps.has("next") ||
    allDeps.has("flask") ||
    allDeps.has("django") ||
    allDeps.has("gin") ||
    allDeps.has("actix-web") ||
    allDeps.has("axum")
  ) {
    capabilities.add("API server");
  }

  // 2. Telegram bot
  if (
    allDeps.has("python-telegram-bot") ||
    allDeps.has("aiogram") ||
    allDeps.has("telebot") ||
    allDeps.has("pytelegrambotapi") ||
    allDeps.has("telegraf") ||
    allDeps.has("grammy") ||
    allDeps.has("go-telegram-bot-api") ||
    readmeLower.includes("telegram bot")
  ) {
    capabilities.add("Telegram bot");
  }

  // 3. Vector memory
  if (
    allDeps.has("chromadb") ||
    allDeps.has("pinecone") ||
    allDeps.has("qdrant") ||
    allDeps.has("weaviate") ||
    allDeps.has("milvus") ||
    allDeps.has("pgvector") ||
    allDeps.has("faiss") ||
    allDeps.has("faiss-cpu")
  ) {
    capabilities.add("Vector memory");
  }

  // 4. LLM integration
  if (
    allDeps.has("openai") ||
    allDeps.has("langchain") ||
    allDeps.has("llama-index") ||
    allDeps.has("anthropic") ||
    allDeps.has("@ai-sdk/openai") ||
    allDeps.has("ollama") ||
    readmeLower.includes("llm") ||
    readmeLower.includes("gpt")
  ) {
    capabilities.add("LLM integration");
  }

  // 5. Machine learning
  if (
    allDeps.has("transformers") ||
    allDeps.has("torch") ||
    allDeps.has("pytorch") ||
    allDeps.has("tensorflow") ||
    allDeps.has("scikit-learn") ||
    allDeps.has("onnx")
  ) {
    capabilities.add("Machine learning");
  }

  // 6. Scheduled jobs
  if (
    allDeps.has("croniter") ||
    allDeps.has("celery") ||
    allDeps.has("apscheduler") ||
    allDeps.has("node-cron") ||
    allDeps.has("bull") ||
    allDeps.has("bullmq")
  ) {
    capabilities.add("Scheduled jobs");
  }

  // 7. Testing
  if (
    allDeps.has("pytest") ||
    allDeps.has("pytest-cov") ||
    allDeps.has("vitest") ||
    allDeps.has("jest") ||
    allDeps.has("mocha") ||
    allDeps.has("playwright") ||
    allDeps.has("cypress") ||
    structure.testDirectories.length > 0
  ) {
    capabilities.add("Testing");
  }

  // 8. WebSockets
  if (
    allDeps.has("websockets") ||
    allDeps.has("ws") ||
    allDeps.has("socket.io") ||
    allDeps.has("gorilla/websocket")
  ) {
    capabilities.add("WebSockets");
  }

  return Array.from(capabilities);
}

function buildProjectPurpose(
  repository: GitHubRepositoryMetadata,
  readmeExcerpt: string | null,
  detectedCapabilities: string[],
  structure: GitHubRepositoryStructure,
  releasesTotalCount: number,
  commitCount90d: number,
  primaryLanguage?: string | null,
): GitHubProjectPurpose {
  let summary = repository.description?.trim() || "";
  if (!summary && readmeExcerpt) {
    summary = extractProjectSummaryFromReadme(readmeExcerpt) || "";
  }
  if (!summary) {
    summary = `${repository.fullName} repository.`;
  }

  let primaryInterface = "Library / Service";
  if (detectedCapabilities.includes("Telegram bot")) {
    primaryInterface = "Telegram bot";
  } else if (detectedCapabilities.includes("API server")) {
    primaryInterface = "REST API";
  } else if (structure.entrypoints.some((e) => e.includes("cli"))) {
    primaryInterface = "CLI tool";
  } else if (primaryLanguage) {
    primaryInterface = `${primaryLanguage} Application`;
  }

  let targetUsers = "Software developers & engineers";
  if (detectedCapabilities.includes("Telegram bot")) {
    targetUsers = "Telegram users & subscribers";
  } else if (detectedCapabilities.includes("LLM integration") || detectedCapabilities.includes("API server")) {
    targetUsers = "Developers & AI agent systems";
  }

  let developmentStage = "Active development";
  if (repository.isArchived) {
    developmentStage = "Archived";
  } else if (releasesTotalCount > 0) {
    developmentStage = "Production ready";
  } else if (commitCount90d === 0) {
    developmentStage = "Maintenance / Inactive";
  }

  return {
    summary,
    primaryInterface,
    capabilities: detectedCapabilities,
    targetUsers,
    developmentStage,
  };
}

export async function fetchGitHubRepositorySnapshot(
  ref: GitHubRepositoryRef,
  options?: { forceFresh?: boolean },
): Promise<GitHubRepositorySnapshot> {
  const cacheKey = ref.fullName.toLowerCase();
  const cached = snapshotCache.get(cacheKey);
  const now = Date.now();

  if (!options?.forceFresh && cached && now < cached.expiresAt) {
    const fetchedAtTime = new Date(cached.snapshot.source.fetchedAt).getTime();
    const cacheAgeSeconds = Math.max(0, Math.floor((now - fetchedAtTime) / 1000));

    return {
      ...cached.snapshot,
      source: {
        ...cached.snapshot.source,
        cacheHit: true,
        cacheStatus: "cached",
        cacheAgeSeconds,
      },
    };
  }

  // Required main repository fetch
  const repoData = await githubFetch<Record<string, any>>(
    `/repos/${ref.owner}/${ref.name}`,
  );

  if (repoData.private === true) {
    throw new ProviderError("github_repository_inaccessible", {
      httpStatus: 403,
      upstreamStatus: 403,
    });
  }

  const repository: GitHubRepositoryMetadata = {
    id: Number(repoData.id ?? 0),
    owner: String(repoData.owner?.login || ref.owner).toLowerCase(),
    name: String(repoData.name || ref.name).toLowerCase(),
    fullName: String(repoData.full_name || ref.fullName).toLowerCase(),
    description: repoData.description ? String(repoData.description) : null,
    isPrivate: Boolean(repoData.private),
    isFork: Boolean(repoData.fork),
    isArchived: Boolean(repoData.archived),
    defaultBranch: String(repoData.default_branch || "main"),
    starsCount: Number(repoData.stargazers_count ?? 0),
    forksCount: Number(repoData.forks_count ?? 0),
    openIssuesCount: Number(repoData.open_issues_count ?? 0),
    watchersCount: Number(repoData.subscribers_count ?? repoData.watchers_count ?? 0),
    createdAt: String(repoData.created_at || new Date().toISOString()),
    updatedAt: String(repoData.updated_at || new Date().toISOString()),
    pushedAt: String(repoData.pushed_at || new Date().toISOString()),
    license: repoData.license
      ? {
          key: String(repoData.license.key || ""),
          name: String(repoData.license.name || ""),
          spdxId: repoData.license.spdx_id ? String(repoData.license.spdx_id) : null,
          url: repoData.license.url ? String(repoData.license.url) : null,
        }
      : null,
    homepage: repoData.homepage ? String(repoData.homepage) : null,
    topics: Array.isArray(repoData.topics) ? repoData.topics.map(String) : [],
  };

  const d30Iso = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  const d90Iso = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString();
  const d180Iso = new Date(now - 180 * 24 * 60 * 60 * 1000).toISOString();

  // Parallel sub-fetches
  const [
    commits30dResult,
    commits90dResult,
    commits180dResult,
    releasesResult,
    contributorsResult,
    languagesResult,
    contentsResult,
    dotGithubContentsResult,
    workflowsResult,
    pullsResult,
    issuesResult,
    readmeExcerptResult,
    securityExcerptResult,
    contributingExcerptResult,
    requirementsExcerptResult,
    pyprojectExcerptResult,
    packageJsonExcerptResult,
    cargoExcerptResult,
    goModExcerptResult,
    gitTreeResult,
  ] = await Promise.allSettled([
    fetchWindowCommits(ref.owner, ref.name, d30Iso),
    fetchWindowCommits(ref.owner, ref.name, d90Iso),
    fetchWindowCommits(ref.owner, ref.name, d180Iso),
    githubFetch<Array<Record<string, any>>>(
      `/repos/${ref.owner}/${ref.name}/releases?per_page=20`,
      { timeoutMs: 6000 },
    ),
    githubFetch<Array<Record<string, any>>>(
      `/repos/${ref.owner}/${ref.name}/contributors?per_page=20`,
      { timeoutMs: 6000 },
    ),
    githubFetch<Record<string, number>>(
      `/repos/${ref.owner}/${ref.name}/languages`,
      { timeoutMs: 6000 },
    ),
    githubFetch<Array<Record<string, any>>>(
      `/repos/${ref.owner}/${ref.name}/contents`,
      { timeoutMs: 6000 },
    ),
    githubFetch<Array<Record<string, any>>>(
      `/repos/${ref.owner}/${ref.name}/contents/.github`,
      { timeoutMs: 6000 },
    ).catch((err) => {
      if (err instanceof ProviderError && err.httpStatus === 404) {
        return [];
      }
      throw err;
    }),
    githubFetch<Array<Record<string, any>>>(
      `/repos/${ref.owner}/${ref.name}/contents/.github/workflows`,
      { timeoutMs: 6000 },
    ).catch((err) => {
      if (err instanceof ProviderError && err.httpStatus === 404) {
        return [];
      }
      throw err;
    }),
    githubFetch<Array<Record<string, any>>>(
      `/repos/${ref.owner}/${ref.name}/pulls?state=open&per_page=1`,
      { timeoutMs: 6000 },
    ),
    githubFetch<Array<Record<string, any>>>(
      `/repos/${ref.owner}/${ref.name}/issues?state=open&per_page=1`,
      { timeoutMs: 6000 },
    ),
    githubFetchReadmeExcerpt(ref.owner, ref.name),
    githubFetchContentExcerpt(ref.owner, ref.name, ["SECURITY.md", ".github/SECURITY.md"]),
    githubFetchContentExcerpt(ref.owner, ref.name, ["CONTRIBUTING.md", ".github/CONTRIBUTING.md"]),
    githubFetchContentExcerpt(ref.owner, ref.name, ["requirements.txt", "requirements.in", "requirements/prod.txt"]),
    githubFetchContentExcerpt(ref.owner, ref.name, "pyproject.toml"),
    githubFetchContentExcerpt(ref.owner, ref.name, "package.json"),
    githubFetchContentExcerpt(ref.owner, ref.name, "Cargo.toml"),
    githubFetchContentExcerpt(ref.owner, ref.name, "go.mod"),
    githubFetch<{ tree?: Array<{ path: string; type: string }>; truncated?: boolean }>(
      `/repos/${ref.owner}/${ref.name}/git/trees/${repository.defaultBranch}?recursive=1`,
      { timeoutMs: 6000 },
    ).catch(() => null),
  ]);

  const warnings: string[] = [];

  // Process Commits
  let activity: GitHubActivityMetrics = {
    recentCommitCount: 0,
    commitAuthorCount: 0,
    lastCommitAt: repository.pushedAt,
    commitCount30d: 0,
    commitCount90d: 0,
    commitCount180d: 0,
    commitCount30dIsLowerBound: false,
    commitCount90dIsLowerBound: false,
    commitCount180dIsLowerBound: false,
  };

  const c30Ok = commits30dResult.status === "fulfilled";
  const c90Ok = commits90dResult.status === "fulfilled";
  const c180Ok = commits180dResult.status === "fulfilled";

  if (c30Ok || c90Ok || c180Ok) {
    const c30 = c30Ok ? commits30dResult.value : { count: 0, isLowerBound: false, authors: new Set<string>(), lastCommitAt: null };
    const c90 = c90Ok ? commits90dResult.value : { count: 0, isLowerBound: false, authors: new Set<string>(), lastCommitAt: null };
    const c180 = c180Ok ? commits180dResult.value : { count: 0, isLowerBound: false, authors: new Set<string>(), lastCommitAt: null };

    const allAuthors = new Set<string>([
      ...c30.authors,
      ...c90.authors,
      ...c180.authors,
    ]);

    const lastCommit = c30.lastCommitAt || c90.lastCommitAt || c180.lastCommitAt || repository.pushedAt;

    activity = {
      recentCommitCount: c30.count,
      commitAuthorCount: allAuthors.size,
      lastCommitAt: lastCommit,
      commitCount30d: c30.count,
      commitCount90d: c90.count,
      commitCount180d: c180.count,
      commitCount30dIsLowerBound: c30.isLowerBound,
      commitCount90dIsLowerBound: c90.isLowerBound,
      commitCount180dIsLowerBound: c180.isLowerBound,
    };
  } else {
    warnings.push("commits_unavailable");
  }

  // Process Releases
  let releases: GitHubReleasesMetrics = {
    totalCount: 0,
    latestRelease: null,
    releaseCount90d: 0,
  };

  if (releasesResult.status === "fulfilled" && Array.isArray(releasesResult.value)) {
    const rawReleases = releasesResult.value;
    const d90 = now - 90 * 24 * 60 * 60 * 1000;
    let count90d = 0;

    for (const r of rawReleases) {
      if (r.published_at) {
        const time = new Date(r.published_at).getTime();
        if (time >= d90) count90d++;
      }
    }

    const latest = rawReleases[0]
      ? {
          name: rawReleases[0].name ? String(rawReleases[0].name) : null,
          tagName: String(rawReleases[0].tag_name || ""),
          publishedAt: rawReleases[0].published_at ? String(rawReleases[0].published_at) : null,
          isPrerelease: Boolean(rawReleases[0].prerelease),
          body: rawReleases[0].body ? redactHostedWorkflowText(String(rawReleases[0].body)).slice(0, 1000) : null,
        }
      : null;

    releases = {
      totalCount: rawReleases.length,
      latestRelease: latest,
      releaseCount90d: count90d,
    };
  } else {
    warnings.push("releases_unavailable");
  }

  // Process Contributors
  let contributors: GitHubContributorsMetrics = {
    sampledCount: 0,
    topContributors: [],
    sampledTopContributorShare: 0,
    sampledHumanContributorCount: 0,
    sampledBotContributorCount: 0,
    topHumanContributorShare: 0,
    botContributionShare: 0,
  };

  if (contributorsResult.status === "fulfilled" && Array.isArray(contributorsResult.value)) {
    const rawContribs = contributorsResult.value;
    const mapped: GitHubContributorItem[] = rawContribs.map((c) => {
      const login = String(c.login || "unknown");
      const isBot = isBotContributor(login, c.type ? String(c.type) : undefined);
      const accountType: "human" | "bot" | "unknown" = login === "unknown" ? "unknown" : isBot ? "bot" : "human";
      return {
        login,
        contributions: Number(c.contributions ?? 0),
        avatarUrl: c.avatar_url ? String(c.avatar_url) : null,
        isBot,
        accountType,
      };
    });

    const top = mapped.slice(0, 10);
    const sumTop = mapped.reduce((acc, curr) => acc + curr.contributions, 0);
    const topPct = sumTop > 0 && top[0] ? Math.round((top[0].contributions / sumTop) * 1000) / 10 : 0;

    const humanContribs = mapped.filter((c) => !c.isBot);
    const botContribs = mapped.filter((c) => c.isBot);

    const sumHuman = humanContribs.reduce((acc, curr) => acc + curr.contributions, 0);
    const sumBot = botContribs.reduce((acc, curr) => acc + curr.contributions, 0);

    const topHuman = humanContribs[0];
    const topHumanPct = sumHuman > 0 && topHuman ? Math.round((topHuman.contributions / sumHuman) * 1000) / 10 : 0;
    const botPct = sumTop > 0 ? Math.round((sumBot / sumTop) * 1000) / 10 : 0;

    contributors = {
      sampledCount: mapped.length,
      topContributors: top,
      sampledTopContributorShare: topPct,
      sampledHumanContributorCount: humanContribs.length,
      sampledBotContributorCount: botContribs.length,
      topHumanContributorShare: topHumanPct,
      botContributionShare: botPct,
    };
  } else {
    warnings.push("contributors_unavailable");
  }

  // Process Languages & Contents
  let languages: Record<string, number> = {};
  let primaryLanguage: string | null = repoData.language ? String(repoData.language) : null;

  if (languagesResult.status === "fulfilled" && languagesResult.value) {
    languages = languagesResult.value;
    const entries = Object.entries(languages);
    if (entries.length > 0) {
      entries.sort((a, b) => b[1] - a[1]);
      primaryLanguage = entries[0][0];
    }
  } else {
    warnings.push("languages_unavailable");
  }

  const rootFiles = contentsResult.status === "fulfilled" && Array.isArray(contentsResult.value)
    ? contentsResult.value
    : [];

  const dotGithubFiles = dotGithubContentsResult.status === "fulfilled" && Array.isArray(dotGithubContentsResult.value)
    ? dotGithubContentsResult.value
    : [];

  if (contentsResult.status !== "fulfilled") {
    warnings.push("contents_unavailable");
  }

  const fileMap = new Map<string, { size: number }>();
  for (const f of rootFiles) {
    if (f.name) fileMap.set(String(f.name).toLowerCase(), { size: Number(f.size ?? 0) });
  }
  for (const f of dotGithubFiles) {
    if (f.name) {
      fileMap.set(`.github/${String(f.name).toLowerCase()}`, { size: Number(f.size ?? 0) });
      if (!fileMap.has(String(f.name).toLowerCase())) {
        fileMap.set(String(f.name).toLowerCase(), { size: Number(f.size ?? 0) });
      }
    }
  }

  // Documentation metrics
  const readmeFile = Array.from(fileMap.keys()).find((k) => /^readme(?:\.(?:md|txt|rst))?$/i.test(k) || /^\.github\/readme(?:\.(?:md|txt|rst))?$/i.test(k));
  const licenseFile = Array.from(fileMap.keys()).find((k) => /^license(?:\.(?:md|txt))?$/i.test(k) || /^\.github\/license(?:\.(?:md|txt))?$/i.test(k));
  const securityFile = Array.from(fileMap.keys()).find((k) => /^security(?:\.md)?$/i.test(k) || /^\.github\/security(?:\.md)?$/i.test(k));
  const contributingFile = Array.from(fileMap.keys()).find((k) => /^contributing(?:\.md)?$/i.test(k) || /^\.github\/contributing(?:\.md)?$/i.test(k));
  const cocFile = Array.from(fileMap.keys()).find((k) => /^code_of_conduct(?:\.md)?$/i.test(k) || /^\.github\/code_of_conduct(?:\.md)?$/i.test(k));
  const codeownersFile = Array.from(fileMap.keys()).find((k) => /^codeowners$/i.test(k) || /^\.github\/codeowners$/i.test(k));

  const documentation: GitHubDocumentationMetrics = {
    hasReadme: Boolean(readmeFile),
    hasLicense: Boolean(repository.license || licenseFile),
    hasSecurityPolicy: Boolean(securityFile || (securityExcerptResult.status === "fulfilled" && Boolean(securityExcerptResult.value))),
    hasContributing: Boolean(contributingFile || (contributingExcerptResult.status === "fulfilled" && Boolean(contributingExcerptResult.value))),
    hasCodeOfConduct: Boolean(cocFile),
    hasCodeowners: Boolean(codeownersFile),
    readmeSize: readmeFile ? fileMap.get(readmeFile)?.size ?? null : null,
    securityPolicySize: securityFile ? fileMap.get(securityFile)?.size ?? null : null,
    contributingSize: contributingFile ? fileMap.get(contributingFile)?.size ?? null : null,
  };

  // Stack Framework Detection
  const detectedFrameworksSet = new Set<string>();
  const langKeys = Object.keys(languages);

  if (fileMap.has("next.config.js") || fileMap.has("next.config.ts") || fileMap.has("next.config.mjs")) {
    detectedFrameworksSet.add("Next.js");
  }
  if (fileMap.has("hardhat.config.js") || fileMap.has("hardhat.config.ts")) {
    detectedFrameworksSet.add("Hardhat");
  }
  if (fileMap.has("foundry.toml")) {
    detectedFrameworksSet.add("Foundry");
  }
  if (fileMap.has("package.json")) {
    detectedFrameworksSet.add("Node.js");
  }
  if (fileMap.has("cargo.toml") || langKeys.includes("Rust")) {
    detectedFrameworksSet.add("Rust / Cargo");
  }
  if (fileMap.has("go.mod") || langKeys.includes("Go")) {
    detectedFrameworksSet.add("Go");
  }
  if (fileMap.has("pyproject.toml") || fileMap.has("requirements.txt") || langKeys.includes("Python")) {
    detectedFrameworksSet.add("Python");
  }
  if (fileMap.has("dockerfile") || fileMap.has("docker-compose.yml")) {
    detectedFrameworksSet.add("Docker");
  }

  // Workflows
  let hasWorkflows = false;
  let workflowCount = 0;
  let workflowNames: string[] = [];

  if (workflowsResult.status === "fulfilled" && Array.isArray(workflowsResult.value)) {
    const rawWorkflows = workflowsResult.value;
    hasWorkflows = rawWorkflows.length > 0;
    workflowCount = rawWorkflows.length;
    workflowNames = rawWorkflows
      .map((w) => String(w.name || ""))
      .filter((n) => n.endsWith(".yml") || n.endsWith(".yaml"));
  } else {
    warnings.push("workflows_unavailable");
  }

  if (pullsResult.status !== "fulfilled") {
    warnings.push("pull_requests_unavailable");
  }
  if (issuesResult.status !== "fulfilled") {
    warnings.push("issues_unavailable");
  }
  if (readmeExcerptResult.status !== "fulfilled") {
    warnings.push("readme_unavailable");
  }
  if (securityExcerptResult.status !== "fulfilled") {
    warnings.push("security_policy_unavailable");
  }
  if (contributingExcerptResult.status !== "fulfilled") {
    warnings.push("contributing_guide_unavailable");
  }

  const stack: GitHubStackMetrics = {
    primaryLanguage,
    languages,
    detectedFrameworks: Array.from(detectedFrameworksSet),
    hasWorkflows,
    workflowCount,
    workflowNames,
  };

  // Excerpts
  const excerpts: GitHubExcerpts = {
    readmeExcerpt: readmeExcerptResult.status === "fulfilled" ? readmeExcerptResult.value : null,
    securityExcerpt: securityExcerptResult.status === "fulfilled" ? securityExcerptResult.value : null,
    contributingExcerpt: contributingExcerptResult.status === "fulfilled" ? contributingExcerptResult.value : null,
  };

  // Collaboration
  const openPullRequestsCount = pullsResult.status === "fulfilled" && Array.isArray(pullsResult.value)
    ? pullsResult.value.length
    : undefined;

  const collaboration: GitHubCollaborationMetrics = {
    openIssuesCount: repository.openIssuesCount,
    openPullRequestsCount,
    hasDiscussions: Boolean(repoData.has_discussions),
  };

  const partial = warnings.length > 0;
  const upstreamStatus = partial ? "partial_success" : "success";

  // Parse manifests and build rich intelligence
  const reqContent = requirementsExcerptResult.status === "fulfilled" ? requirementsExcerptResult.value : null;
  const pyprojectContent = pyprojectExcerptResult.status === "fulfilled" ? pyprojectExcerptResult.value : null;
  const pkgJsonContent = packageJsonExcerptResult.status === "fulfilled" ? packageJsonExcerptResult.value : null;
  const cargoContent = cargoExcerptResult.status === "fulfilled" ? cargoExcerptResult.value : null;
  const goModContent = goModExcerptResult.status === "fulfilled" ? goModExcerptResult.value : null;

  const manifests: string[] = [];
  const prodDepsSet = new Set<string>();
  const devDepsSet = new Set<string>();

  if (reqContent) {
    manifests.push("requirements.txt");
    const { prod, dev } = parseRequirementsTxt(reqContent);
    prod.forEach((d) => prodDepsSet.add(d));
    dev.forEach((d) => devDepsSet.add(d));
  }
  if (pyprojectContent) {
    manifests.push("pyproject.toml");
    const { prod, dev } = parsePyprojectToml(pyprojectContent);
    prod.forEach((d) => prodDepsSet.add(d));
    dev.forEach((d) => devDepsSet.add(d));
  }
  if (pkgJsonContent) {
    manifests.push("package.json");
    const { prod, dev } = parsePackageJson(pkgJsonContent);
    prod.forEach((d) => prodDepsSet.add(d));
    dev.forEach((d) => devDepsSet.add(d));
  }
  if (cargoContent) {
    manifests.push("Cargo.toml");
    const { prod, dev } = parseCargoToml(cargoContent);
    prod.forEach((d) => prodDepsSet.add(d));
    dev.forEach((d) => devDepsSet.add(d));
  }
  if (goModContent) {
    manifests.push("go.mod");
    const { prod, dev } = parseGoMod(goModContent);
    prod.forEach((d) => prodDepsSet.add(d));
    dev.forEach((d) => devDepsSet.add(d));
  }

  if (fileMap.has("requirements.txt") && !manifests.includes("requirements.txt")) manifests.push("requirements.txt");
  if (fileMap.has("package.json") && !manifests.includes("package.json")) manifests.push("package.json");
  if (fileMap.has("pyproject.toml") && !manifests.includes("pyproject.toml")) manifests.push("pyproject.toml");
  if (fileMap.has("cargo.toml") && !manifests.includes("Cargo.toml")) manifests.push("Cargo.toml");
  if (fileMap.has("go.mod") && !manifests.includes("go.mod")) manifests.push("go.mod");

  let repositoryStructure: GitHubRepositoryStructure;
  if (
    gitTreeResult.status === "fulfilled" &&
    gitTreeResult.value &&
    Array.isArray(gitTreeResult.value.tree) &&
    gitTreeResult.value.tree.length > 0 &&
    !gitTreeResult.value.truncated
  ) {
    repositoryStructure = buildRepositoryStructureFromGitTree(gitTreeResult.value.tree);
  } else {
    const fallbackItems: GitTreeItem[] = rootFiles.map((f) => ({
      path: String(f.name || ""),
      type: f.type === "dir" || (!f.size && f.type !== "file") ? "tree" : "blob",
    }));
    repositoryStructure = buildRepositoryStructureFromGitTree(fallbackItems);
  }
  const detectedCapabilities = detectCapabilities(
    Array.from(prodDepsSet),
    Array.from(devDepsSet),
    manifests,
    repositoryStructure,
    excerpts.readmeExcerpt,
  );

  const dependencyProfile: GitHubDependencyProfile = {
    manifests,
    productionDependencies: Array.from(prodDepsSet),
    developmentDependencies: Array.from(devDepsSet),
    detectedCapabilities,
  };

  const projectPurpose = buildProjectPurpose(
    repository,
    excerpts.readmeExcerpt,
    detectedCapabilities,
    repositoryStructure,
    releases.totalCount,
    activity.commitCount90d,
    primaryLanguage,
  );

  const snapshot: GitHubRepositorySnapshot = {
    version: 1,
    ref,
    repository,
    activity,
    contributors,
    releases,
    collaboration,
    documentation,
    stack,
    projectPurpose,
    dependencyProfile,
    repositoryStructure,
    excerpts,
    source: {
      fetchedAt: new Date(now).toISOString(),
      cacheHit: false,
      cacheStatus: "live",
      cacheAgeSeconds: 0,
      provider: "GitHub REST API v3",
      upstreamStatus,
      warnings,
      partial,
    },
  };

  // Save to cache
  snapshotCache.set(cacheKey, {
    snapshot,
    expiresAt: now + CACHE_TTL_MS,
  });

  return snapshot;
}
