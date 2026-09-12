/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

async function main() {
  console.log("🌐 Syncing production environment variables to Vercel...");

  const envPath = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) {
    throw new Error(".env.local not found");
  }
  const envContent = fs.readFileSync(envPath, "utf-8");

  function getEnvVal(key: string): string {
    const match = envContent.match(new RegExp(`${key}=(.*)`));
    if (!match || !match[1]) throw new Error(`Missing ${key} in .env.local`);
    return match[1].trim();
  }

  const varsToSync = [
    { key: "ARC_ERC8183_AGENTIC_COMMERCE_ADDRESS", val: "0x0747EEf0706327138c69792bF28Cd525089e4583", sensitive: false },
    { key: "NEXT_PUBLIC_VEYRA_ERC8183_EVALUATOR_ADDRESS", val: getEnvVal("NEXT_PUBLIC_VEYRA_ERC8183_EVALUATOR_ADDRESS"), sensitive: false },
    { key: "ERC8183_EVALUATOR_ATTESTER_PRIVATE_KEY", val: getEnvVal("ERC8183_EVALUATOR_ATTESTER_PRIVATE_KEY"), sensitive: true },
    { key: "ERC8183_EVALUATOR_RELAYER_PRIVATE_KEY", val: getEnvVal("ERC8183_EVALUATOR_RELAYER_PRIVATE_KEY"), sensitive: true },
    { key: "ERC8183_EVALUATOR_CANARY_ENABLED", val: "true", sensitive: false },
    { key: "ERC8183_EVALUATION_MAX_ARTIFACT_BYTES", val: "1048576", sensitive: false },
    { key: "ERC8183_EVALUATION_FETCH_TIMEOUT_MS", val: "15000", sensitive: false },
    { key: "ERC8183_VERDICT_MAX_VALIDITY_SECONDS", val: "600", sensitive: false },
  ];

  for (const item of varsToSync) {
    console.log(`Setting ${item.key} on Vercel Production...`);
    try {
      // Remove existing variable if present
      try {
        execSync(`npx -y vercel env rm ${item.key} production -y`, { stdio: "pipe" });
      } catch {}

      // Add variable
      const sensitiveFlag = item.sensitive ? "--sensitive" : "";
      execSync(`echo "${item.val}" | npx -y vercel env add ${item.key} production ${sensitiveFlag}`, {
        stdio: "pipe",
        shell: "/bin/bash",
      });
      console.log(`✅ Set ${item.key} successfully.`);
    } catch (err: any) {
      console.warn(`Warning setting ${item.key}:`, err.message || err);
    }
  }

  console.log("\n🚀 Environment variables synced to Vercel Production!");
}

main().catch(console.error);
