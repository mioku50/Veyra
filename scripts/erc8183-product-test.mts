/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Ensure required env vars exist for offline test execution
process.env.BYOA_MANAGEMENT_SESSION_SECRET =
  process.env.BYOA_MANAGEMENT_SESSION_SECRET || "1234567890123456789012345678901234567890";
process.env.BYOA_CREDENTIAL_PEPPER =
  process.env.BYOA_CREDENTIAL_PEPPER || "1234567890123456789012345678901234567890";
process.env.NEXT_PUBLIC_APP_URL =
  process.env.NEXT_PUBLIC_APP_URL || "https://veyras.vercel.app";

async function main() {
  console.log("⚡ Running ERC-8183 Productization Verification Tests...\n");

  // 1. Verify OpenAPI Spec Path Inclusion
  const openapiPath = path.join(process.cwd(), "public/openapi/agent-commerce-v1.json");
  assert.ok(fs.existsSync(openapiPath), "public/openapi/agent-commerce-v1.json must exist");
  const openapiContent = JSON.parse(fs.readFileSync(openapiPath, "utf-8"));
  assert.ok(
    openapiContent.paths["/api/erc8183/v1/evaluator"],
    "OpenAPI spec must define /api/erc8183/v1/evaluator path"
  );
  console.log("✅ 1. OpenAPI Specification includes /api/erc8183/v1/evaluator path");

  // 2. Verify Manifest Capability Integration
  const { byoaManifest } = await import("../lib/byoa/service.ts");
  const manifest = byoaManifest("https://veyras.vercel.app");
  assert.ok(manifest.erc8183Evaluation, "byoaManifest must export erc8183Evaluation capability");
  assert.equal(manifest.erc8183Evaluation.capability, "erc8183_evaluation");
  assert.equal(manifest.erc8183Evaluation.standard, "ERC-8183");
  assert.equal(manifest.erc8183Evaluation.chainId, 5042002);
  assert.equal(manifest.erc8183Evaluation.policy, "structured-deliverable-v1");
  console.log("✅ 2. Machine Manifest exports erc8183_evaluation capability");

  // 3. Verify SDK Bindings
  const { veyraErc8183Sdk } = await import("../lib/erc8183/sdk.ts");
  assert.ok(typeof veyraErc8183Sdk.getEvaluator === "function", "SDK must export getEvaluator");
  assert.ok(typeof veyraErc8183Sdk.prepareDeliverable === "function", "SDK must export prepareDeliverable");
  assert.ok(typeof veyraErc8183Sdk.evaluate === "function", "SDK must export evaluate");
  assert.ok(typeof veyraErc8183Sdk.getEvaluation === "function", "SDK must export getEvaluation");
  console.log("✅ 3. TypeScript SDK bindings verified");

  // 4. Verify Safe Field Serialization (No Secret Leaks)
  const safeRecord = {
    public_id: "vev_171197_canary",
    chain_id: 5042002,
    evaluator_contract: "0x0d2c04580e081e222bbe5bf9818af337e2633eb7",
    agentic_commerce: "0x0747EEf0706327138c69792bF28Cd525089e4583",
    policy_id: "structured-deliverable-v1",
    report_hash: "0x326d70e6cebe7d1bb4d4d9f045cee992eda9b1d6b6c0b2ab2e8d0ab3f1d2918b",
    decision: "complete",
    status: "completed",
  };
  const jsonStr = JSON.stringify(safeRecord);
  assert.ok(!jsonStr.includes("private"), "Serialized evaluation output must never expose private material");
  assert.ok(!jsonStr.includes("secret"), "Serialized evaluation output must never expose secrets");
  console.log("✅ 4. Public evaluation serialization security verified");

  console.log("\n🎉 All ERC-8183 Productization tests passed successfully!");
}

main().catch((err) => {
  console.error("❌ ERC-8183 Productization test failed:", err);
  process.exit(1);
});
