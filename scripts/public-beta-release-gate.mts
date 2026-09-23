/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
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
    "docs/contracts.md",
    "public/openapi/veyra-agent-api-v1.json",
  ];
  for (const file of requiredFiles) {
    if (!existsSync(resolve(root, file))) {
      throw new Error(`Required open-source release file missing: ${file}`);
    }
  }
});

// 2a. Every migration has a version of its own
runStep("Migration Versions Are Unique", () => {
  /* The ledger records versions, not filenames. Two files sharing one version
     are one row between them: on the database where both were new they both
     ran and the duplicate insert looked like success, while on a fresh database
     the first marks the version applied and the second is skipped in silence.
     20260720120000 carried two for eight weeks, and the only reason production
     was not missing three tables is that they happened to be applied together.
     Caught here, at the moment the file is added, rather than on whichever
     rebuild first came up short. */
  const directory = resolve(root, "supabase/migrations");
  const seen = new Map<string, string>();
  for (const name of readdirSync(directory).filter((f) => /^\d+_[a-z0-9_]+\.sql$/i.test(f)).sort()) {
    const version = name.split("_")[0];
    const previous = seen.get(version);
    if (previous) {
      throw new Error(
        `Migrations ${previous} and ${name} share the version ${version}. ` +
        "Only one of them would reach a fresh database. Renumber the later one.",
      );
    }
    seen.set(version, name);
  }
});

// 2b. The published Trust Gate is the one the code calls
runStep("Documented Trust Gate Matches Deployed Default", () => {
  /* docs/contracts.md published 0x1cD66BCd... as canonical for as long as the
     executor hardcoded it as a fallback, while production ran a different gate
     entirely. Both answer on Arc, so nothing failed loudly; the only symptom
     was a clearance verified against a contract that does not implement
     verifyClearance. A document and a default that can drift apart silently
     will, so they are compared here. */
  const doc = readFileSync(resolve(root, "docs/contracts.md"), "utf8");
  const section = doc.split("### 2. Veyra Trust Gate")[1]?.split("###")[0] ?? "";
  const documented = section.match(/\*\*Address\*\*: \[`(0x[0-9a-fA-F]{40})`\]/)?.[1];
  if (!documented) {
    throw new Error("docs/contracts.md does not publish a Veyra Trust Gate address");
  }
  const source = readFileSync(resolve(root, "lib/trust-gate/address.ts"), "utf8");
  const coded = source.match(/DEFAULT_VEYRA_TRUST_GATE_ADDRESS = "(0x[0-9a-fA-F]{40})"/)?.[1];
  if (!coded) {
    throw new Error("lib/trust-gate/address.ts does not declare a default gate");
  }
  if (documented.toLowerCase() !== coded.toLowerCase()) {
    throw new Error(
      `docs/contracts.md publishes ${documented} but the code defaults to ${coded}`,
    );
  }
  /* And the superseded one must not come back as a live reference. */
  for (const file of ["lib/execution/executor.ts", "lib/execution/adapters/erc8183.ts"]) {
    if (readFileSync(resolve(root, file), "utf8").includes("0x1cD66BCd4FCB73a079c05635840Fde029Ce6BEbB")) {
      throw new Error(`${file} hardcodes the superseded Trust Gate`);
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

runStep("Marketplace Candidate Source & x402 Probe Tests", () => {
  execSync("npm run marketplace:test", { cwd: root, stdio: "inherit" });
});

runStep("Project 360 Deterministic Tests", () => {
  execSync("npm run project-360:test", { cwd: root, stdio: "inherit" });
});

runStep("Canonical Request Binding Tests", () => {
  execSync("npm run canonical:test", { cwd: root, stdio: "inherit" });
});

runStep("x402 Mandatory Decision Enforcement Tests", () => {
  execSync("npm run x402-decision:test", { cwd: root, stdio: "inherit" });
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
/* Nova's own suites, which this gate did not run.
   They exist and they pass, and nothing here checked them -- so a stale
   assertion in the live script went out with a push whose gate was green. A
   test the release gate does not run is a test that stops being true quietly. */
runStep("Nova Agent Tests", () => {
  execSync("npm run nova:test", { cwd: root, stdio: "inherit" });
});

runStep("Nova Arc Identity Tests", () => {
  execSync("npm run nova-identity:test", { cwd: root, stdio: "inherit" });
});

runStep("Nova Standing Tests", () => {
  execSync("npm run nova-standing:test", { cwd: root, stdio: "inherit" });
});

runStep("Nova Presentation Invariants", () => {
  execSync("npm run nova-presentation:test", { cwd: root, stdio: "inherit" });
});

runStep("Nova Shadow Autonomy", () => {
  execSync("npm run nova-autonomy:test", { cwd: root, stdio: "inherit" });
});

runStep("Nova Product Value", () => {
  execSync("npm run nova-product-value:test", { cwd: root, stdio: "inherit" });
});

runStep("Nova Project Context", () => {
  execSync("npm run nova-project-context:test", { cwd: root, stdio: "inherit" });
});

runStep("Nova Coverage", () => {
  execSync("npm run nova-coverage:test", { cwd: root, stdio: "inherit" });
});

runStep("Nova Feedback", () => {
  execSync("npm run nova-feedback:test", { cwd: root, stdio: "inherit" });
});

runStep("Nova Substance", () => {
  execSync("npm run nova-substance:test", { cwd: root, stdio: "inherit" });
});

runStep("Nova Tools", () => {
  execSync("npm run nova-tools:test", { cwd: root, stdio: "inherit" });
});

runStep("Nova Calibration Report", () => {
  execSync("npm run nova-calibration:test", { cwd: root, stdio: "inherit" });
});

runStep("Nova Shadow Diagnostics", () => {
  execSync("npm run nova-shadow-observability:test", { cwd: root, stdio: "inherit" });
});

runStep("Nova Discovery and Request Preparation", () => {
  execSync("npm run nova-discovery:test", { cwd: root, stdio: "inherit" });
  execSync("npm run x402-request-body:test", { cwd: root, stdio: "inherit" });
});

runStep("Nova Arc Proof Tests", () => {
  execSync("npm run nova-arc-proof:test", { cwd: root, stdio: "inherit" });
});

runStep("x402 Post-Call Verification Tests", () => {
  execSync("npm run x402-verification:test", { cwd: root, stdio: "inherit" });
});

runStep("Foundry Smart Contract Tests (forge test)", () => {
  execSync("forge test", { cwd: resolve(root, "contracts"), stdio: "inherit" });
});

// 8. Next.js Production Build
runStep("Next.js Production Build", () => {
  execSync("npm run build", { cwd: root, stdio: "inherit" });
});

console.log("\n🎉 ALL P6.0 PUBLIC BETA RELEASE GATE CHECKS PASSED SUCCESSFULLY! 🎉\n");
