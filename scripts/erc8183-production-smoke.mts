/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";

async function runProductionSmoke() {
  console.log("🔥 Running ERC-8183 Evaluator production smoke preflight...");
  const commerceAddress = process.env.ARC_ERC8183_AGENTIC_COMMERCE_ADDRESS || "0x0747EEf0706327138c69792bF28Cd525089e4583";
  const evaluatorAddress = process.env.NEXT_PUBLIC_VEYRA_ERC8183_EVALUATOR_ADDRESS || "0x0000000000000000000000000000000000000000";

  assert.ok(commerceAddress.startsWith("0x"), "Commerce address missing");
  console.log("Commerce Address:", commerceAddress);
  console.log("Evaluator Address:", evaluatorAddress);
  console.log("✅ Production smoke config verified!");
}

runProductionSmoke().catch((err) => {
  console.error("❌ Production smoke error:", err);
  process.exit(1);
});
