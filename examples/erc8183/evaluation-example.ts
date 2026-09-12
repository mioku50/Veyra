/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { keccak256, stringToBytes } from "viem";
import { prepareDeliverableCommitment } from "../../lib/erc8183/deliverable.ts";

async function main() {
  console.log("🚀 Veyra ERC-8183 Evaluator Example");

  // 1. Prepare deliverable commitment
  const contentUri = "https://raw.githubusercontent.com/circlefin/skills/master/README.md";
  const rawBytes = stringToBytes("Sample deliverable content");
  const contentHash = keccak256(rawBytes);

  const commitment = prepareDeliverableCommitment({
    contentUri,
    contentHash,
    contentType: "application/json",
    schemaId: "veyra://schemas/structured-deliverable-v1",
    policyId: "structured-deliverable-v1",
  });

  console.log("\n1️⃣  Deliverable Commitment V1 Prepared:");
  console.log("Deliverable Hash:", commitment.deliverableHash);
  console.log("Policy Hash:     ", commitment.policyHash);
  console.log("Submit Args:     ", commitment.submitArgs);

  console.log("\n2️⃣  To use in provider onchain workflow:");
  console.log(`cast send <ERC8183_CONTRACT> "submit(uint256,bytes32)" <JOB_ID> ${commitment.deliverableHash}`);
}

main().catch(console.error);
