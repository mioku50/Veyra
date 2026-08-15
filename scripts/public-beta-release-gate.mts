/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

console.log("🚀 Starting Veyra Public Beta Release Gate Suite...");

function runStep(name: string, fn: () => void) {
  process.stdout.write(`\n⏳ Running: ${name}... `);
  try {
    fn();
    console.log(`✅ PASS`);
  } catch (error) {
    console.log(`❌ FAIL`);
    console.error(error);
    process.exit(1);
  }
}

// 1. Secret Audit Check
runStep("Secret Pattern & Commit Audit", () => {
  execSync("node --experimental-transform-types --no-warnings scripts/audit-secrets.mts", {
    cwd: root,
    stdio: "inherit",
  });
});

// 2. Open-Source Required Files Check
runStep("Required Documentation & Notice Files", () => {
  const requiredFiles = [
    "README.md",
    "LICENSE",
    "NOTICE",
    "SECURITY.md",
    "CONTRIBUTING.md",
    "CHANGELOG.md",
    "docs/architecture.md",
    "docs/contracts.md",
    "public/openapi/veyra-agent-api-v1.json",
  ];
  for (const file of requiredFiles) {
    if (!existsSync(resolve(root, file))) {
      throw new Error(`Required open-source release file missing: ${file}`);
    }
  }
});

// 3. Legacy String / Stale Repository URL Scan
runStep("Legacy Repository URL & Clone Instructions Scan", () => {
  const readme = readFileSync(resolve(root, "README.md"), "utf8");
  if (readme.includes("git clone https://github.com/mioku50/Agent-Commerce.git")) {
    throw new Error("README contains legacy git clone URL");
  }
  if (!readme.includes("git clone https://github.com/mioku50/Veyra.git")) {
    throw new Error("README missing canonical Veyra clone URL");
  }

  const sidebar = readFileSync(resolve(root, "components/layout/sidebar.tsx"), "utf8");
  if (sidebar.includes("Agent-Commerce#readme")) {
    throw new Error("Sidebar contains legacy Agent-Commerce#readme link");
  }
});

// 4. Lint Check
runStep("ESLint Code Hygiene", () => {
  execSync("npm run lint", { cwd: root, stdio: "inherit" });
});

// 5. SDK Build & Typecheck
runStep("Veyra TypeScript SDK Build", () => {
  execSync("npm run machine:sdk-build", { cwd: root, stdio: "inherit" });
});

// 6. Core Deterministic Test Suites
runStep("ERC-8004 Identity & Validation Tests", () => {
  execSync("npm run erc8004:test", { cwd: root, stdio: "inherit" });
});

runStep("ERC-8183 Independent Evaluator Tests", () => {
  execSync("npm run erc8183:test", { cwd: root, stdio: "inherit" });
});

runStep("Evidence-Weighted Reputation Engine Tests", () => {
  execSync("npm run reputation:test", { cwd: root, stdio: "inherit" });
});

runStep("Trust Gate Policy & Clearance Tests", () => {
  execSync("npm run trust-gate:test", { cwd: root, stdio: "inherit" });
});

runStep("Counterparty Selection Engine Tests", () => {
  execSync("npm run counterparty:test", { cwd: root, stdio: "inherit" });
});

runStep("Project 360 Deterministic Tests", () => {
  execSync("npm run project-360:test", { cwd: root, stdio: "inherit" });
});

runStep("Trust-Routed Execution Unit Tests", () => {
  execSync("npm run execution:test", { cwd: root, stdio: "inherit" });
});

runStep("Trust-Routed Execution Negative & Security Tests", () => {
  execSync("npm run execution:negative-test", { cwd: root, stdio: "inherit" });
});

runStep("Trust-Routed Execution Product & Anti-Cheat V4 Tests", () => {
  execSync("npm run execution:product-test", { cwd: root, stdio: "inherit" });
});

// 7. Foundry Smart Contract Test Suite
runStep("Foundry Smart Contract Tests (forge test)", () => {
  execSync("forge test", { cwd: resolve(root, "contracts"), stdio: "inherit" });
});

// 8. Next.js Production Build
runStep("Next.js Production Build", () => {
  execSync("npm run build", { cwd: root, stdio: "inherit" });
});

console.log("\n🎉 ALL P6.0 PUBLIC BETA RELEASE GATE CHECKS PASSED SUCCESSFULLY! 🎉\n");
