/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { byoaManifest } from "../lib/byoa/service.ts";
import { sanitizeEvidenceForPublic } from "../lib/reputation/engine.ts";
import { veyraReputationSdk } from "../lib/reputation/sdk.ts";
import type { ReputationEvidence } from "../lib/reputation/types.ts";

async function main() {
  console.log("⚡ Running P5.3 Reputation Productization Verification Tests...\n");

  // [1] OpenAPI Specification verification
  const openApiPath = path.join(process.cwd(), "public/openapi/agent-commerce-v1.json");
  const openApiRaw = fs.readFileSync(openApiPath, "utf8");
  const openApi = JSON.parse(openApiRaw);
  assert.ok(
    openApi.paths["/api/reputation/v1/agents/{agentId}"],
    "[1] OpenAPI spec missing /api/reputation/v1/agents/{agentId} path"
  );
  console.log("✅ 1. OpenAPI Specification includes /api/reputation/v1/agents/{agentId} path");

  // [2] Machine Manifest capability export verification
  if (!process.env.BYOA_MANAGEMENT_SESSION_SECRET) {
    process.env.BYOA_MANAGEMENT_SESSION_SECRET = "sample_test_byoa_management_session_secret_32_chars_long";
  }
  if (!process.env.BYOA_CREDENTIAL_PEPPER) {
    process.env.BYOA_CREDENTIAL_PEPPER = "sample_test_byoa_credential_pepper_32_chars_long";
  }
  const manifest = byoaManifest("https://agent-commerce-six.vercel.app");
  assert.ok(
    (manifest as Record<string, unknown>).agentReputation,
    "[2] Machine Manifest missing agentReputation capability"
  );
  const cap = (manifest as Record<string, unknown>).agentReputation as Record<string, unknown>;
  assert.equal(cap.capability, "agent_reputation", "[2] Manifest capability key mismatch");
  assert.equal(cap.standard, "ERC-8004", "[2] Manifest standard mismatch");
  console.log("✅ 2. Machine Manifest exports agent_reputation capability");

  // [3] TypeScript SDK bindings verification
  assert.equal(typeof veyraReputationSdk.getAgent, "function", "[3] veyraReputationSdk.getAgent is missing");
  assert.equal(typeof veyraReputationSdk.getHistory, "function", "[3] veyraReputationSdk.getHistory is missing");
  assert.equal(typeof veyraReputationSdk.getEvidence, "function", "[3] veyraReputationSdk.getEvidence is missing");
  console.log("✅ 3. TypeScript SDK bindings verified (veyraReputationSdk)");

  // [4] Public evidence serialization security verification
  const rawEvidenceItem: ReputationEvidence = {
    evidenceId: "ev_secret_123",
    agentId: "1",
    type: "erc8183_job_completed",
    tier: 4,
    sourceId: "job_0x123",
    score: 100,
    positive: true,
    confidence: 1.0,
    economicValueUsdc: 25.0,
    counterpartyAddress: "0x1111111111111111111111111111111111111111",
    verifiedOnchain: true,
    arcProofVerified: true,
    sybilRisk: "none",
    observedAt: new Date().toISOString(),
    canonicalHash: "0xabc123def456",
    reason: "Internal secret reason that should be stripped",
  };

  const sanitized = sanitizeEvidenceForPublic([rawEvidenceItem]);
  assert.equal(sanitized.length, 1, "[4] Sanitized output length mismatch");
  assert.equal((sanitized[0] as Record<string, unknown>).reason, undefined, "[4] Security violation: internal reason exposed in public evidence");
  assert.equal((sanitized[0] as Record<string, unknown>).counterpartyAddress, undefined, "[4] Security violation: raw counterparty address exposed in public evidence");
  console.log("✅ 4. Public evidence serialization security verified (zero sensitive field leaks)");

  console.log("\n🎉 All P5.3 Reputation Productization verification tests passed successfully!");
}

main().catch((err) => {
  console.error("❌ Productization verification failed:", err);
  process.exit(1);
});
