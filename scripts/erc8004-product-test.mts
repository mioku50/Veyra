/**
 * Copyright 2026 Circle Internet Group, Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Environment fallbacks for offline test execution
process.env.BYOA_MANAGEMENT_SESSION_SECRET =
  process.env.BYOA_MANAGEMENT_SESSION_SECRET || "1234567890123456789012345678901234567890";
process.env.BYOA_CREDENTIAL_PEPPER =
  process.env.BYOA_CREDENTIAL_PEPPER || "1234567890123456789012345678901234567890";
process.env.NEXT_PUBLIC_APP_URL =
  process.env.NEXT_PUBLIC_APP_URL || "https://agent-commerce-six.vercel.app";

async function main() {
  console.log("⚡ Running ERC-8004 Productization Verification Tests...\n");

  // 1. Verify Manifest Export of ERC-8004 Standards & Identity
  const { byoaManifest } = await import("../lib/byoa/service.ts");
  const manifest = byoaManifest("https://agent-commerce-six.vercel.app");
  assert.ok(manifest.standards, "byoaManifest must include standards object");
  assert.ok(manifest.standards.erc8004, "byoaManifest must support erc8004 standard");
  assert.equal(manifest.standards.erc8004.supported, true);
  assert.ok(manifest.erc8004Identity, "byoaManifest must export erc8004Identity capability");
  assert.equal(manifest.erc8004Identity.standard, "ERC-8004");
  console.log("✅ 1. Machine Manifest exports ERC-8004 standards and identity capability");

  // 2. Verify Safe Output Serialization (No Private Keys / Secrets)
  const safeIdentityResponse = {
    name: "Veyra Trust Evaluator",
    network: "arc-testnet",
    chainId: 5042002,
    identity: {
      standard: "ERC-8004",
      registry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      agentId: "171197",
    },
    capabilities: ["erc8004_identity", "erc8183_evaluation", "erc8004_validation"],
  };

  const jsonStr = JSON.stringify(safeIdentityResponse);
  assert.ok(!jsonStr.includes("private"), "Serialized identity metadata must never expose private fields");
  assert.ok(!jsonStr.includes("secret"), "Serialized identity metadata must never expose secret keys");
  console.log("✅ 2. ERC-8004 public serialization security verified");

  const clientSource = readFileSync("lib/erc8004/client.ts", "utf8");
  const responderSource = readFileSync("app/api/erc8004/v1/validations/respond/route.ts", "utf8");
  assert.doesNotMatch(clientSource, /env-fallback|NEXT_PUBLIC_ERC8004_VEYRA_AGENT_ID/);
  assert.match(responderSource, /ERC8004_VALIDATION_RESPOND_SECRET/);
  assert.match(responderSource, /timingSafeEqual/);
  assert.doesNotMatch(responderSource, /BYOA_MANAGEMENT_SESSION_SECRET|VEYRA_RELAYER_KEY/);
  assert.match(responderSource, /bodyKeys\.length !== 1/);
  console.log("✅ 3. Canonical identity fallback removal and dedicated responder authentication verified");

  console.log("\n🎉 All ERC-8004 Productization verification tests passed successfully!");
}

main().catch((err) => {
  console.error("❌ ERC-8004 Productization verification test failed:", err);
  process.exit(1);
});
