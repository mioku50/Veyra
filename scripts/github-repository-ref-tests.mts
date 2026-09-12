/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { parseGitHubRepositoryInput, InvalidGitHubRepositoryError } from "../lib/providers/github-repository-ref.ts";

console.log("[github-ref-test] Running GitHub repository reference parser tests...");

// Valid inputs test cases
const validTestCases = [
  {
    input: "owner/repo",
    expected: {
      owner: "owner",
      name: "repo",
      fullName: "owner/repo",
      canonicalUrl: "https://github.com/owner/repo",
    },
  },
  {
    input: "github.com/owner/repo",
    expected: {
      owner: "owner",
      name: "repo",
      fullName: "owner/repo",
      canonicalUrl: "https://github.com/owner/repo",
    },
  },
  {
    input: "www.github.com/owner/repo",
    expected: {
      owner: "owner",
      name: "repo",
      fullName: "owner/repo",
      canonicalUrl: "https://github.com/owner/repo",
    },
  },
  {
    input: "https://github.com/owner/repo",
    expected: {
      owner: "owner",
      name: "repo",
      fullName: "owner/repo",
      canonicalUrl: "https://github.com/owner/repo",
    },
  },
  {
    input: "http://github.com/owner/repo",
    expected: {
      owner: "owner",
      name: "repo",
      fullName: "owner/repo",
      canonicalUrl: "https://github.com/owner/repo",
    },
  },
  {
    input: "https://www.github.com/owner/repo",
    expected: {
      owner: "owner",
      name: "repo",
      fullName: "owner/repo",
      canonicalUrl: "https://github.com/owner/repo",
    },
  },
  {
    input: "https://github.com/owner/repo.git",
    expected: {
      owner: "owner",
      name: "repo",
      fullName: "owner/repo",
      canonicalUrl: "https://github.com/owner/repo",
    },
  },
  {
    input: "owner/repo.git",
    expected: {
      owner: "owner",
      name: "repo",
      fullName: "owner/repo",
      canonicalUrl: "https://github.com/owner/repo",
    },
  },
  {
    input: "https://github.com/owner/repo/tree/main",
    expected: {
      owner: "owner",
      name: "repo",
      fullName: "owner/repo",
      canonicalUrl: "https://github.com/owner/repo",
    },
  },
  {
    input: "https://github.com/owner/repo/blob/main/README.md",
    expected: {
      owner: "owner",
      name: "repo",
      fullName: "owner/repo",
      canonicalUrl: "https://github.com/owner/repo",
    },
  },
  {
    input: "https://github.com/owner/repo/pull/42",
    expected: {
      owner: "owner",
      name: "repo",
      fullName: "owner/repo",
      canonicalUrl: "https://github.com/owner/repo",
    },
  },
  {
    input: "https://github.com/owner/repo/commit/abcdef123456",
    expected: {
      owner: "owner",
      name: "repo",
      fullName: "owner/repo",
      canonicalUrl: "https://github.com/owner/repo",
    },
  },
  {
    input: "  https://github.com/Owner-Name/Repo_Name.git/  ",
    expected: {
      owner: "owner-name",
      name: "repo_name",
      fullName: "owner-name/repo_name",
      canonicalUrl: "https://github.com/owner-name/repo_name",
    },
  },
  {
    input: "CircleFin/Agent-Commerce",
    expected: {
      owner: "circlefin",
      name: "agent-commerce",
      fullName: "circlefin/agent-commerce",
      canonicalUrl: "https://github.com/circlefin/agent-commerce",
    },
  },
];

for (const tc of validTestCases) {
  const result = parseGitHubRepositoryInput(tc.input);
  assert.deepEqual(result, tc.expected, `Failed for input: ${tc.input}`);
}

console.log(`[github-ref-test] Passed ${validTestCases.length} valid input test cases.`);

// Invalid inputs test cases
const invalidTestCases = [
  {
    input: "https://gitlab.com/owner/repo",
    expectedError: "Only public GitHub repositories (github.com) are supported.",
  },
  {
    input: "gitlab.com/owner/repo",
    expectedError: "Only public GitHub repositories (github.com) are supported.",
  },
  {
    input: "https://bitbucket.org/owner/repo",
    expectedError: "Only public GitHub repositories (github.com) are supported.",
  },
  {
    input: "http://127.0.0.1/repo",
    expectedError: "Only public GitHub repositories (github.com) are supported.",
  },
  {
    input: "127.0.0.1/owner/repo",
    expectedError: "Only public GitHub repositories (github.com) are supported.",
  },
  {
    input: "http://localhost/owner/repo",
    expectedError: "Only public GitHub repositories (github.com) are supported.",
  },
  {
    input: "localhost/owner/repo",
    expectedError: "Only public GitHub repositories (github.com) are supported.",
  },
  {
    input: "https://example.com/owner/repo",
    expectedError: "Only public GitHub repositories (github.com) are supported.",
  },
  {
    input: "owner",
    expectedError: "Enter a valid GitHub repository in owner/repository format.",
  },
  {
    input: "owner/",
    expectedError: "Enter a valid GitHub repository in owner/repository format.",
  },
  {
    input: "https://github.com/",
    expectedError: "Enter a valid GitHub repository in owner/repository format.",
  },
  {
    input: "https://github.com/owner",
    expectedError: "Enter a valid GitHub repository in owner/repository format.",
  },
  {
    input: "",
    expectedError: "Enter a public GitHub repository URL or owner/repository.",
  },
  {
    input: "   ",
    expectedError: "Enter a public GitHub repository URL or owner/repository.",
  },
  {
    input: null,
    expectedError: "Enter a public GitHub repository URL or owner/repository.",
  },
  {
    input: undefined,
    expectedError: "Enter a public GitHub repository URL or owner/repository.",
  },
  {
    input: 123,
    expectedError: "Enter a public GitHub repository URL or owner/repository.",
  },
  {
    input: "owner/repo!bad",
    expectedError: "Repository owner and name contain invalid characters.",
  },
  {
    input: "owner<script>/repo",
    expectedError: "Repository owner and name contain invalid characters.",
  },
  {
    input: "./repo",
    expectedError: "Repository owner and name contain invalid characters.",
  },
  {
    input: "../repo",
    expectedError: "Repository owner and name contain invalid characters.",
  },
];

for (const tc of invalidTestCases) {
  assert.throws(
    () => parseGitHubRepositoryInput(tc.input),
    (error: unknown) => {
      assert(error instanceof InvalidGitHubRepositoryError);
      assert.equal(error.message, tc.expectedError);
      return true;
    },
    `Failed to throw expected error for input: ${String(tc.input)}`,
  );
}

console.log(`[github-ref-test] Passed ${invalidTestCases.length} invalid input test cases.`);
console.log("[github-ref-test] ALL TESTS PASSED SUCCESSFULLY.");
