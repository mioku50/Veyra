/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { parseGitHubRepositoryInput } from "../lib/providers/github-repository-ref.ts";
import {
  fetchGitHubRepositorySnapshot,
  clearGitHubSnapshotCache,
  extractProjectSummaryFromReadme,
  isBotContributor,
} from "../lib/providers/github.ts";
import { ProviderError } from "../lib/providers/errors.ts";

async function runTests() {
  console.log("Running GitHub Provider tests...");

  // Mock global fetch for deterministic testing
  const originalFetch = globalThis.fetch;

  try {
    // 1. Mock successful GitHub API responses
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = url.toString();

      // Recursive Git Tree API
      if (urlStr.includes("/git/trees")) {
        return new Response(
          JSON.stringify({
            sha: "tree123",
            tree: [
              { path: "README.md", type: "blob", size: 2500 },
              { path: "app/main.py", type: "blob", size: 1200 },
              { path: "src/index.ts", type: "blob", size: 800 },
              { path: "cmd/server/main.go", type: "blob", size: 900 },
              { path: "packages/core/index.ts", type: "blob", size: 600 },
              { path: "tests/test_main.py", type: "blob", size: 500 },
              { path: "docker-compose.prod.yml", type: "blob", size: 400 },
              { path: "tsconfig.json", type: "blob", size: 300 },
              { path: ".eslintrc.js", type: "blob", size: 200 },
              { path: "ruff.toml", type: "blob", size: 150 },
            ],
            truncated: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Main repository metadata
      if (urlStr.includes("/repos/circle/agent-commerce") && !urlStr.includes("/commits") && !urlStr.includes("/releases") && !urlStr.includes("/contributors") && !urlStr.includes("/languages") && !urlStr.includes("/contents") && !urlStr.includes("/readme") && !urlStr.includes("/git/trees")) {
        return new Response(
          JSON.stringify({
            id: 123456,
            name: "agent-commerce",
            full_name: "circle/agent-commerce",
            owner: { login: "circle" },
            description: "Agent Commerce on Arc",
            private: false,
            fork: false,
            archived: false,
            default_branch: "main",
            stargazers_count: 42,
            forks_count: 5,
            open_issues_count: 3,
            watchers_count: 10,
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-07-23T00:00:00Z",
            pushed_at: "2026-07-23T12:00:00Z",
            license: { key: "apache-2.0", name: "Apache License 2.0", spdx_id: "Apache-2.0", url: "https://api.github.com/licenses/apache-2.0" },
            homepage: "https://arc.circle.com",
            topics: ["arc", "usdc", "x402", "agents"],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Commits
      if (urlStr.includes("/commits")) {
        return new Response(
          JSON.stringify([
            {
              commit: {
                committer: { date: new Date().toISOString() },
                author: { name: "Alice", email: "alice@example.com", date: new Date().toISOString() },
              },
              author: { login: "alice" },
            },
            {
              commit: {
                committer: { date: "2026-07-01T00:00:00Z" },
                author: { name: "Bob", email: "bob@example.com", date: "2026-07-01T00:00:00Z" },
              },
              author: { login: "bob" },
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Releases
      if (urlStr.includes("/releases")) {
        return new Response(
          JSON.stringify([
            {
              name: "v1.0.0",
              tag_name: "v1.0.0",
              published_at: new Date().toISOString(),
              prerelease: false,
              body: "Initial release with secret ghp_123456789012345678901234567890123456 inside.",
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Contributors
      if (urlStr.includes("/contributors")) {
        return new Response(
          JSON.stringify([
            { login: "alice", contributions: 80, avatar_url: "https://github.com/alice.png" },
            { login: "bob", contributions: 20, avatar_url: "https://github.com/bob.png" },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Languages
      if (urlStr.includes("/languages")) {
        return new Response(
          JSON.stringify({ TypeScript: 80000, JavaScript: 20000 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Contents (Root)
      if (urlStr.endsWith("/contents")) {
        return new Response(
          JSON.stringify([
            { name: "README.md", size: 2500 },
            { name: "LICENSE", size: 1000 },
            { name: "SECURITY.md", size: 1200 },
            { name: "CONTRIBUTING.md", size: 1500 },
            { name: "package.json", size: 800 },
            { name: "next.config.ts", size: 400 },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Workflows
      if (urlStr.includes("/contents/.github/workflows")) {
        return new Response(
          JSON.stringify([
            { name: "ci.yml" },
            { name: "release.yml" },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Readme excerpt
      if (urlStr.endsWith("/readme")) {
        const secretContent = Buffer.from(
          "# Agent Commerce\n\nContact support@example.com for help.\nUse token ghp_123456789012345678901234567890123456 or private key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0\n-----END RSA PRIVATE KEY-----\n",
        ).toString("base64");
        return new Response(
          JSON.stringify({ encoding: "base64", content: secretContent }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // SECURITY.md
      if (urlStr.includes("/contents/SECURITY.md")) {
        const secContent = Buffer.from("# Security Policy\nReport vulnerabilities to security@example.com.").toString("base64");
        return new Response(
          JSON.stringify({ encoding: "base64", content: secContent }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // CONTRIBUTING.md
      if (urlStr.includes("/contents/CONTRIBUTING.md")) {
        const contribContent = Buffer.from("# Contributing Guide\nPull requests are welcome.").toString("base64");
        return new Response(
          JSON.stringify({ encoding: "base64", content: contribContent }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Pulls
      if (urlStr.includes("/pulls")) {
        return new Response(
          JSON.stringify([{ id: 1, number: 101, title: "Initial PR" }]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Issues
      if (urlStr.includes("/issues")) {
        return new Response(
          JSON.stringify([{ id: 2, number: 5, title: "Bug report" }]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    }) as typeof fetch;

    clearGitHubSnapshotCache();

    const ref = parseGitHubRepositoryInput("circle/agent-commerce");

    // Test 1: Snapshot structure
    console.log("  - Test 1: Fetching snapshot structure...");
    const snapshot1 = await fetchGitHubRepositorySnapshot(ref);
    assert.equal(snapshot1.version, 1);
    assert.equal(snapshot1.repository.owner, "circle");
    assert.equal(snapshot1.repository.name, "agent-commerce");
    assert.equal(snapshot1.repository.starsCount, 42);
    assert.equal(snapshot1.activity.recentCommitCount, 2);
    assert.equal(snapshot1.activity.commitAuthorCount, 2);
    assert.equal(snapshot1.contributors.sampledCount, 2);
    assert.equal(snapshot1.contributors.sampledTopContributorShare, 80);
    assert.equal(snapshot1.releases.totalCount, 1);
    assert.equal(snapshot1.releases.latestRelease?.tagName, "v1.0.0");
    assert.equal(snapshot1.documentation.hasReadme, true);
    assert.equal(snapshot1.documentation.hasLicense, true);
    assert.equal(snapshot1.documentation.hasSecurityPolicy, true);
    assert.equal(snapshot1.documentation.hasContributing, true);
    assert.ok(snapshot1.stack.detectedFrameworks.includes("Next.js"));
    assert.ok(snapshot1.stack.detectedFrameworks.includes("Node.js"));
    assert.equal(snapshot1.stack.workflowCount, 2);
    assert.equal(snapshot1.source.cacheHit, false);
    assert.equal(snapshot1.source.cacheStatus, "live");
    assert.equal(snapshot1.source.cacheAgeSeconds, 0);
    assert.equal(snapshot1.source.provider, "GitHub REST API v3");
    assert.ok(snapshot1.repositoryStructure?.entrypoints.includes("app/main.py"));
    assert.ok(snapshot1.repositoryStructure?.entrypoints.includes("src/index.ts"));
    assert.ok(snapshot1.repositoryStructure?.entrypoints.includes("cmd/server/main.go"));
    assert.ok(snapshot1.repositoryStructure?.entrypoints.includes("packages/core/index.ts"));
    assert.ok(snapshot1.repositoryStructure?.sourceDirectories.includes("app"));
    assert.ok(snapshot1.repositoryStructure?.sourceDirectories.includes("src"));
    assert.ok(snapshot1.repositoryStructure?.sourceDirectories.includes("packages"));
    assert.ok(snapshot1.repositoryStructure?.testDirectories.includes("tests"));
    assert.ok(snapshot1.repositoryStructure?.dockerFiles.includes("docker-compose.prod.yml"));
    assert.ok(snapshot1.repositoryStructure?.configFiles.includes("tsconfig.json"));
    assert.ok(snapshot1.repositoryStructure?.configFiles.includes(".eslintrc.js"));
    assert.ok(snapshot1.repositoryStructure?.configFiles.includes("ruff.toml"));
    console.log("    ✓ Snapshot structure matches expected schema");

    // Test 2: In-memory cache behavior & timestamp preservation
    console.log("  - Test 2: Cache behavior & timestamp preservation...");
    const originalFetchedAt = snapshot1.source.fetchedAt;
    await new Promise((resolve) => setTimeout(resolve, 50));

    const snapshot2 = await fetchGitHubRepositorySnapshot(ref);
    assert.equal(snapshot2.source.cacheHit, true);
    assert.equal(snapshot2.source.cacheStatus, "cached");
    assert.equal(snapshot2.source.fetchedAt, originalFetchedAt);
    assert.ok(typeof snapshot2.source.cacheAgeSeconds === "number");
    assert.ok(snapshot2.source.cacheAgeSeconds >= 0);
    console.log("    ✓ Cache hit preserves original fetchedAt timestamp and computes cacheAgeSeconds");

    clearGitHubSnapshotCache();
    const snapshot3 = await fetchGitHubRepositorySnapshot(ref);
    assert.equal(snapshot3.source.cacheHit, false);
    assert.equal(snapshot3.source.cacheStatus, "live");
    assert.equal(snapshot3.source.cacheAgeSeconds, 0);
    console.log("    ✓ Cache clear resets cacheHit: false and cacheStatus: live");

    // Test 3: Secret redaction in excerpts and release body
    console.log("  - Test 3: Secret redaction in excerpts...");
    assert.ok(snapshot1.excerpts.readmeExcerpt?.includes("[redacted-email]"));
    assert.ok(snapshot1.excerpts.readmeExcerpt?.includes("[redacted-token]"));
    assert.ok(snapshot1.excerpts.readmeExcerpt?.includes("[redacted-private-key]"));
    assert.ok(!snapshot1.excerpts.readmeExcerpt?.includes("ghp_123456789012345678901234567890123456"));
    assert.ok(!snapshot1.excerpts.readmeExcerpt?.includes("support@example.com"));
    assert.ok(snapshot1.releases.latestRelease?.body?.includes("[redacted-token]"));
    console.log("    ✓ Tokens, emails, and private keys correctly redacted");

    // Test 4: Excerpt bounding
    console.log("  - Test 4: Excerpt bounding limit...");
    assert.ok(snapshot1.excerpts.readmeExcerpt!.length <= 128 * 1024);
    console.log("    ✓ Excerpt size bounded within 128KB limit");

    // Test 5: Not found error handling
    console.log("  - Test 5: Not found repository handling...");
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    }) as typeof fetch;

    clearGitHubSnapshotCache();
    const badRef = parseGitHubRepositoryInput("circle/non-existent-repo");
    await assert.rejects(
      async () => {
        await fetchGitHubRepositorySnapshot(badRef);
      },
      (err: unknown) => {
        return err instanceof ProviderError && err.code === "github_repository_not_found" && err.httpStatus === 404;
      },
    );
    console.log("    ✓ 404 response throws github_repository_not_found ProviderError");

    // Test 6: Rate limit handling
    console.log("  - Test 6: Rate limit error handling...");
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({ message: "API rate limit exceeded" }),
        { status: 403, headers: { "x-ratelimit-remaining": "0" } },
      );
    }) as typeof fetch;

    clearGitHubSnapshotCache();
    await assert.rejects(
      async () => {
        await fetchGitHubRepositorySnapshot(badRef);
      },
      (err: unknown) => {
        return err instanceof ProviderError && err.code === "github_rate_limited" && err.httpStatus === 429;
      },
    );
    console.log("    ✓ Rate limit response throws github_rate_limited ProviderError");

    // Test 7: Private repository handling
    console.log("  - Test 7: Private repository rejection...");
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          id: 999,
          name: "private-repo",
          full_name: "circle/private-repo",
          owner: { login: "circle" },
          private: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    clearGitHubSnapshotCache();
    const privateRef = parseGitHubRepositoryInput("circle/private-repo");
    await assert.rejects(
      async () => {
        await fetchGitHubRepositorySnapshot(privateRef);
      },
      (err: unknown) => {
        return err instanceof ProviderError && err.code === "github_repository_inaccessible" && err.httpStatus === 403;
      },
    );
    console.log("    ✓ Private repository throws github_repository_inaccessible ProviderError (403)");

    // Test 8: Optional sub-fetch failures & warning tracking
    console.log("  - Test 8: Optional sub-fetch warnings and partial status...");
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = url.toString();

      // Main repository metadata succeeds
      if (urlStr.includes("/repos/circle/partial-repo") && !urlStr.includes("/commits") && !urlStr.includes("/releases") && !urlStr.includes("/contributors") && !urlStr.includes("/languages") && !urlStr.includes("/contents") && !urlStr.includes("/readme") && !urlStr.includes("/pulls") && !urlStr.includes("/issues")) {
        return new Response(
          JSON.stringify({
            id: 888,
            name: "partial-repo",
            full_name: "circle/partial-repo",
            owner: { login: "circle" },
            private: false,
            stargazers_count: 10,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Simulate failure for sub-fetches
      return new Response(
        JSON.stringify({ message: "Internal Server Error" }),
        { status: 500 },
      );
    }) as typeof fetch;

    clearGitHubSnapshotCache();
    const partialRef = parseGitHubRepositoryInput("circle/partial-repo");
    const partialSnapshot = await fetchGitHubRepositorySnapshot(partialRef);

    assert.equal(partialSnapshot.source.partial, true);
    assert.equal(partialSnapshot.source.upstreamStatus, "partial_success");
    assert.ok(Array.isArray(partialSnapshot.source.warnings));
    assert.ok(partialSnapshot.source.warnings.includes("commits_unavailable"));
    assert.ok(partialSnapshot.source.warnings.includes("workflows_unavailable"));
    assert.ok(partialSnapshot.source.warnings.includes("pull_requests_unavailable"));
    console.log("    ✓ Sub-fetch failures populate source.warnings and set source.partial = true");

    // Test 9: magda-agent fixture dependency profiling, capabilities, & structure
    console.log("  - Test 9: magda-agent fixture dependency profiling, capabilities, & structure...");
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = url.toString();

      // Git tree recursive call returning nested entrypoint app/main.py
      if (urlStr.includes("/git/trees")) {
        return new Response(
          JSON.stringify({
            sha: "tree777",
            tree: [
              { path: "README.md", type: "blob", size: 3000 },
              { path: "requirements.txt", type: "blob", size: 400 },
              { path: "app/main.py", type: "blob", size: 1200 },
              { path: "tests/test_main.py", type: "blob", size: 500 },
            ],
            truncated: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (urlStr.includes("/repos/circle/magda-agent") && !urlStr.includes("/commits") && !urlStr.includes("/releases") && !urlStr.includes("/contributors") && !urlStr.includes("/languages") && !urlStr.includes("/contents") && !urlStr.includes("/readme") && !urlStr.includes("/pulls") && !urlStr.includes("/issues")) {
        return new Response(
          JSON.stringify({
            id: 777,
            name: "magda-agent",
            full_name: "circle/magda-agent",
            owner: { login: "circle" },
            description: "Experimental cognitive agent framework built around Telegram, FastAPI, vector memory, LLM integration, and automated self-improvement.",
            private: false,
            stargazers_count: 50,
            language: "Python",
            license: null,
            default_branch: "main",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (urlStr.includes("/commits")) {
        // Return 500 commits to trigger 500+ lower bound flag
        const commits = Array.from({ length: 500 }, (_, i) => ({
          commit: {
            committer: { date: new Date().toISOString() },
            author: { name: `Author${i}`, email: `author${i}@example.com`, date: new Date().toISOString() },
          },
          author: { login: `author${i}` },
        }));
        return new Response(JSON.stringify(commits), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (urlStr.includes("/contributors")) {
        return new Response(
          JSON.stringify([
            { login: "google-labs-jules[bot]", contributions: 120, type: "Bot" },
            { login: "devin-ai-integration[bot]", contributions: 80, type: "Bot" },
            { login: "alice", contributions: 50, type: "User" },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (urlStr.includes("requirements.txt")) {
        const reqs = "fastapi==0.109.0\nuvicorn==0.27.0\nopenai==1.12.0\nchromadb==0.4.22\ntorch==2.2.0\ntransformers==4.37.2\npython-telegram-bot==20.8\ncroniter==2.0.1\nwebsockets==12.0\npytest==8.0.0\n";
        return new Response(
          JSON.stringify({ encoding: "base64", content: Buffer.from(reqs).toString("base64") }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (urlStr.endsWith("/readme")) {
        const rawReadme = '<div align="center"><img src="https://example.com/logo.png" /><h1>magda-agent</h1></div>\n\n<p>Experimental cognitive agent framework built around Telegram, FastAPI, vector memory, LLM integration, and automated self-improvement.</p>';
        return new Response(
          JSON.stringify({ encoding: "base64", content: Buffer.from(rawReadme).toString("base64") }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (urlStr.endsWith("/contents")) {
        return new Response(
          JSON.stringify([
            { name: "README.md", size: 3000 },
            { name: "requirements.txt", size: 400 },
            { name: "app", type: "dir" },
            { name: "tests", type: "dir" },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (urlStr.includes("/languages")) {
        return new Response(JSON.stringify({ Python: 50000 }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (urlStr.includes("/releases")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    }) as typeof fetch;

    clearGitHubSnapshotCache();
    const magdaRef = parseGitHubRepositoryInput("circle/magda-agent");
    const magdaSnapshot = await fetchGitHubRepositorySnapshot(magdaRef);

    assert.equal(magdaSnapshot.dependencyProfile?.manifests.includes("requirements.txt"), true);
    assert.ok(magdaSnapshot.dependencyProfile?.productionDependencies.includes("fastapi"));
    assert.ok(magdaSnapshot.dependencyProfile?.productionDependencies.includes("openai"));
    assert.ok(magdaSnapshot.dependencyProfile?.productionDependencies.includes("chromadb"));
    assert.ok(magdaSnapshot.dependencyProfile?.productionDependencies.includes("torch"));
    assert.ok(magdaSnapshot.dependencyProfile?.productionDependencies.includes("transformers"));
    assert.ok(magdaSnapshot.dependencyProfile?.productionDependencies.includes("python-telegram-bot"));
    assert.ok(magdaSnapshot.dependencyProfile?.developmentDependencies.includes("pytest"));

    const caps = magdaSnapshot.dependencyProfile?.detectedCapabilities ?? [];
    assert.ok(caps.includes("API server"));
    assert.ok(caps.includes("Telegram bot"));
    assert.ok(caps.includes("Vector memory"));
    assert.ok(caps.includes("LLM integration"));
    assert.ok(caps.includes("Machine learning"));
    assert.ok(caps.includes("Testing"));

    assert.ok(magdaSnapshot.repositoryStructure?.entrypoints.includes("app/main.py"));
    assert.ok(magdaSnapshot.repositoryStructure?.configFiles.includes("requirements.txt"));
    assert.equal(magdaSnapshot.activity.commitCount90d, 500);
    assert.equal(magdaSnapshot.activity.commitCount90dIsLowerBound, true);
    assert.equal(magdaSnapshot.contributors.sampledHumanContributorCount, 1);
    assert.equal(magdaSnapshot.contributors.sampledBotContributorCount, 2);
    assert.equal(magdaSnapshot.releases.totalCount, 0);
    assert.equal(magdaSnapshot.documentation.hasLicense, false);
    assert.equal(magdaSnapshot.documentation.hasSecurityPolicy, false);
    assert.equal(magdaSnapshot.projectPurpose?.primaryInterface, "Telegram bot");

    const cleanReadmeText = extractProjectSummaryFromReadme(magdaSnapshot.excerpts.readmeExcerpt!);
    assert.equal(
      cleanReadmeText,
      "Experimental cognitive agent framework built around Telegram, FastAPI, vector memory, LLM integration, and automated self-improvement.",
    );
    console.log("    ✓ magda-agent fixture dependency profile, capabilities, commit bounds, bot separation, entrypoint, and readme summary correctly extracted");

    // Test 10: extractProjectSummaryFromReadme HTML and markdown sanitizer
    console.log("  - Test 10: extractProjectSummaryFromReadme HTML and markdown sanitizer...");
    const dirtyReadme = `
<div align="center">
  <picture>
    <img src="https://example.com/logo.png" alt="Logo" width="200" />
  </picture>
  <h1>magda-agent</h1>
  [![Build Status](https://img.shields.io/badge/build-passing-brightgreen)](https://example.com)
  [![Coverage](https://img.shields.io/badge/coverage-100%25-green)](https://example.com)
</div>

# magda-agent

Magda is an autonomous AI Telegram agent with vector memory and FastAPI server for automated customer intelligence.

## Quick Start
\`\`\`bash
pip install magda
\`\`\`

> Note: Blockquote text
`;

    const cleanSummary = extractProjectSummaryFromReadme(dirtyReadme);
    assert.equal(
      cleanSummary,
      "Magda is an autonomous AI Telegram agent with vector memory and FastAPI server for automated customer intelligence.",
    );
    assert.ok(!cleanSummary?.includes("<div"));
    assert.ok(!cleanSummary?.includes("img.shields.io"));
    assert.ok(!cleanSummary?.includes("#"));
    console.log("    ✓ extractProjectSummaryFromReadme strips HTML containers, badges, and headers cleanly");

    // Test 11: 500+ commit lower bound pagination cap
    console.log("  - Test 11: 500+ commit lower bound cap...");
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes("/git/trees")) {
        return new Response(JSON.stringify({ tree: [], truncated: false }), { status: 200 });
      }
      if (urlStr.includes("/commits")) {
        const commits = Array.from({ length: 100 }, (_, i) => ({
          commit: {
            committer: { date: new Date().toISOString() },
            author: { name: `Dev${i}`, email: `dev${i}@example.com`, date: new Date().toISOString() },
          },
          author: { login: `dev${i}` },
        }));
        return new Response(JSON.stringify(commits), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (urlStr.includes("/repos/circle/cap-repo") && !urlStr.includes("/releases") && !urlStr.includes("/contributors")) {
        return new Response(
          JSON.stringify({ id: 1010, name: "cap-repo", full_name: "circle/cap-repo", owner: { login: "circle" }, private: false, default_branch: "main" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    clearGitHubSnapshotCache();
    const capRef = parseGitHubRepositoryInput("circle/cap-repo");
    const capSnapshot = await fetchGitHubRepositorySnapshot(capRef);

    assert.equal(capSnapshot.activity.commitCount30d, 500);
    assert.equal(capSnapshot.activity.commitCount30dIsLowerBound, true);
    assert.equal(capSnapshot.activity.commitCount90d, 500);
    assert.equal(capSnapshot.activity.commitCount90dIsLowerBound, true);
    assert.equal(capSnapshot.activity.commitCount180d, 500);
    assert.equal(capSnapshot.activity.commitCount180dIsLowerBound, true);
    console.log("    ✓ 500 pagination cap sets commitCount30dIsLowerBound: true");

    // Test 12: Bot contributor detection & separation
    console.log("  - Test 12: Bot contributor separation (google-labs-jules[bot], devin-ai-integration[bot])...");
    assert.equal(isBotContributor("google-labs-jules[bot]"), true);
    assert.equal(isBotContributor("devin-ai-integration[bot]"), true);
    assert.equal(isBotContributor("dependabot[bot]"), true);
    assert.equal(isBotContributor("renovate"), true);
    assert.equal(isBotContributor("alice"), false);

    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes("/contributors")) {
        return new Response(
          JSON.stringify([
            { login: "google-labs-jules[bot]", contributions: 100, type: "Bot" },
            { login: "devin-ai-integration[bot]", contributions: 50, type: "Bot" },
            { login: "alice", contributions: 50, type: "User" },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (urlStr.includes("/repos/circle/bot-repo") && !urlStr.includes("/commits") && !urlStr.includes("/releases")) {
        return new Response(
          JSON.stringify({ id: 2020, name: "bot-repo", full_name: "circle/bot-repo", owner: { login: "circle" }, private: false, default_branch: "main" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    clearGitHubSnapshotCache();
    const botRef = parseGitHubRepositoryInput("circle/bot-repo");
    const botSnapshot = await fetchGitHubRepositorySnapshot(botRef);

    assert.equal(botSnapshot.contributors.sampledCount, 3);
    assert.equal(botSnapshot.contributors.sampledHumanContributorCount, 1);
    assert.equal(botSnapshot.contributors.sampledBotContributorCount, 2);
    assert.equal(botSnapshot.contributors.topHumanContributorShare, 100);
    assert.equal(botSnapshot.contributors.botContributionShare, 75);
    assert.equal(botSnapshot.contributors.topContributors[0].isBot, true);
    assert.equal(botSnapshot.contributors.topContributors[0].accountType, "bot");
    assert.equal(botSnapshot.contributors.topContributors[2].isBot, false);
    assert.equal(botSnapshot.contributors.topContributors[2].accountType, "human");
    console.log("    ✓ Bot accounts separated from human maintainers with topHumanContributorShare and botContributionShare calculated");

  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log("All GitHub Provider tests passed successfully!");
}

runTests().catch((err) => {
  console.error("Test failure:", err);
  process.exit(1);
});
