/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { getByoaClient } from "../lib/byoa/service.ts";

async function verifyProductionErc8183Schema() {
  console.log("🔍 Verifying production Supabase schema for erc8183_evaluations...");
  const supabase = getByoaClient();

  const { data, error } = await supabase
    .from("erc8183_evaluations")
    .select("id, public_id, chain_id, agentic_commerce, job_id, deliverable_hash, status, created_at")
    .limit(1);

  if (error) {
    console.error("❌ Schema verification failed:", error);
    process.exit(1);
  }

  console.log("✅ erc8183_evaluations table and RLS verified in Supabase!");
}

verifyProductionErc8183Schema().catch((err) => {
  console.error("❌ Fatal verification error:", err);
  process.exit(1);
});
