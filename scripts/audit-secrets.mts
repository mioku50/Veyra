/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

console.log("🔒 Starting Veyra Secret & Sensitive Commit Audit...");

// 1. Current Tree Scan (Excluding .env.local, .git, node_modules, .next)
const IGNORED_PATHS = [
  ".git",
  ".next",
  "node_modules",
  ".env.local",
  "out",
  "tsconfig.tsbuildinfo",
  "contracts/cache",
  "contracts/out",
];

const SECRET_PATTERNS = [
  { name: "Private Key (Hex 64)", regex: /(?:private_key|privatekey|secret_key|signing_key)\s*[:=]\s*["']?0x[0-9a-fA-F]{64}["']?/i },
  { name: "Supabase JWT Service Key", regex: /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+/ },
  { name: "OpenRouter API Key", regex: /sk-or-v1-[a-f0-9]{64}/ },
  { name: "GitHub Personal Token", regex: /ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82}/ },
];

function scanDir(dir: string, issues: string[]) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = resolve(dir, entry.name);
    const relPath = fullPath.slice(root.length + 1);

    if (IGNORED_PATHS.some((ignored) => relPath === ignored || relPath.startsWith(ignored + "/"))) {
      continue;
    }

    if (entry.isDirectory()) {
      scanDir(fullPath, issues);
    } else if (entry.isFile()) {
      try {
        const content = readFileSync(fullPath, "utf8");
        const isTestFile = relPath.startsWith("scripts/") || relPath.startsWith("contracts/test/") || relPath.includes("test");
        for (const pattern of SECRET_PATTERNS) {
          if (pattern.regex.test(content)) {
            // Check if it's a test fixture or placeholder
            if (
              content.includes("0xYour") ||
              content.includes("0x0000000000000000000000000000000000000000") ||
              content.includes("0x1111111111111111111111111111111111111111") ||
              content.includes("0x0123456789012345678901234567890123456789") ||
              content.includes("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80") ||
              content.includes("dummy_anon_key") ||
              content.includes("ghp_123456789012345678901234567890123456")
            ) {
              continue;
            }
            issues.push(`[File Scan] Potential ${pattern.name} detected in ${relPath}`);
          }
        }
      } catch {
        // Skip binary files
      }
    }
  }
}

const fileIssues: string[] = [];
scanDir(root, fileIssues);

// 2. Git History Commit Log Review
console.log("📜 Scanning sensitive git commits...");
const commitLog = execSync('git log --oneline -n 100', { cwd: root, encoding: 'utf8' });
const sensitiveCommits = commitLog
  .split('\n')
  .filter((line) => /secret|env|key|token|credential/i.test(line));

console.log(`Found ${sensitiveCommits.length} commits mentioning config/secret keywords.`);

// 3. Output Sanitized Summary Report
console.log("\n========================================================");
console.log("               SECRET AUDIT REPORT");
console.log("========================================================");
console.log(`Current Tree Status: ${fileIssues.length === 0 ? "✅ CLEAN (No unmasked secrets found)" : "⚠️ ISSUES FOUND"}`);
if (fileIssues.length > 0) {
  for (const issue of fileIssues) {
    console.log(` - ${issue}`);
  }
}

console.log(`\nSensitive Commit Review: ${sensitiveCommits.length} inspected`);
for (const commit of sensitiveCommits.slice(0, 10)) {
  console.log(` - ${commit}`);
}
console.log("========================================================\n");

if (fileIssues.length > 0) {
  process.exit(1);
} else {
  console.log("✅ Secret scan completed cleanly. Ready for public open-source.");
}
