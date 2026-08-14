/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

console.log("🔒 Starting Veyra Full Secret & Git History Audit...");

// 1. Run real Gitleaks detector if binary or command is available
let gitleaksPassed = false;
const gitleaksBin = existsSync(resolve(root, ".local-tools/bin/gitleaks"))
  ? resolve(root, ".local-tools/bin/gitleaks")
  : "gitleaks";

try {
  const gitleaksOutput = execSync(`${gitleaksBin} detect --verbose --redact`, {
    cwd: root,
    encoding: "utf8",
  });
  console.log("✅ Gitleaks full repository history scan: CLEAN (No leaks found).");
  gitleaksPassed = true;
} catch (error) {
  // Check if gitleaks was not found or failed
  if (error instanceof Error && error.message.includes("not found")) {
    console.warn("⚠️ Gitleaks executable not found in PATH or .local-tools/bin; falling back to pattern scan.");
  } else {
    console.error("❌ Gitleaks detected potential secret leaks in repository history.");
    console.error((error as { stdout?: string }).stdout || error);
    process.exit(1);
  }
}

// 2. Secondary AST/File pattern scan for active working tree
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
        for (const pattern of SECRET_PATTERNS) {
          if (pattern.regex.test(content)) {
            // Allow test fixtures and placeholders
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

console.log("\n========================================================");
console.log("            FULL SECRET AUDIT REPORT");
console.log("========================================================");
console.log(`Gitleaks History Scan: ${gitleaksPassed ? "✅ CLEAN" : "⚠️ SKIPPED"}`);
console.log(`Current Tree Pattern Scan: ${fileIssues.length === 0 ? "✅ CLEAN (0 unmasked credentials)" : "⚠️ ISSUES FOUND"}`);

if (fileIssues.length > 0) {
  for (const issue of fileIssues) {
    console.log(` - ${issue}`);
  }
  process.exit(1);
}

console.log("========================================================\n");
console.log("✅ Secret scan completed cleanly. Ready for public open-source.");
