/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { decodeFunctionData, erc20Abi } from "viem";
import { ERC8183_AGENTIC_COMMERCE_ABI } from "../lib/erc8183/abi.ts";
import {
  agenticCommerceAddress,
  encodeApproveUsdc,
  encodeCreateJob,
  encodeFundEscrow,
  evaluatorAddress,
} from "../lib/erc8183/client-transactions.ts";
import { ARC_CHAIN_ID, ARC_USDC_ADDRESS } from "../lib/execution/adapters/erc8183-lifecycle.ts";

const PROVIDER = "0x6d6E695b09861467c7d462f5AAF31cF3540B9192" as const;

/* ---- createJob ---- */

const create = encodeCreateJob({ provider: PROVIDER, description: "Veyra web_research · vexec_1" });
assert.equal(create.step, "create_job");
assert.equal(create.to.toLowerCase(), agenticCommerceAddress().toLowerCase());
assert.equal(create.chainId, ARC_CHAIN_ID);
// Nothing may carry native value: on Arc that would be spending gas as payment.
assert.equal(create.value, "0x0");

const createArgs = decodeFunctionData({ abi: ERC8183_AGENTIC_COMMERCE_ABI, data: create.data });
assert.equal(createArgs.functionName, "createJob");
assert.equal((createArgs.args as unknown[])[0], PROVIDER);
// The evaluator is Veyra's, and it is bound at creation: the job cannot later
// be pointed at an evaluator the buyer did not agree to.
assert.equal(
  String((createArgs.args as unknown[])[1]).toLowerCase(),
  evaluatorAddress().toLowerCase(),
);
assert.ok(BigInt((createArgs.args as unknown[])[2] as bigint) > BigInt(Math.floor(Date.now() / 1000)));

/* ---- approve ---- */

const approve = encodeApproveUsdc(BigInt(60_000));
assert.equal(approve.to.toLowerCase(), ARC_USDC_ADDRESS.toLowerCase());
const approveArgs = decodeFunctionData({ abi: erc20Abi, data: approve.data as `0x${string}` });
assert.equal(approveArgs.functionName, "approve");
assert.equal(
  String((approveArgs.args as unknown[])[0]).toLowerCase(),
  agenticCommerceAddress().toLowerCase(),
);
// Exactly the budget. An unlimited allowance is an authorization the buyer did
// not ask to give, and it would outlive the job it was granted for.
assert.equal((approveArgs.args as unknown[])[1], BigInt(60_000));
assert.notEqual((approveArgs.args as unknown[])[1], BigInt(2) ** BigInt(256) - BigInt(1));
assert.match(approve.detail, /0\.060000 USDC/);

/* ---- fund ---- */

const fund = encodeFundEscrow("186207");
assert.equal(fund.to.toLowerCase(), agenticCommerceAddress().toLowerCase());
const fundArgs = decodeFunctionData({ abi: ERC8183_AGENTIC_COMMERCE_ABI, data: fund.data });
assert.equal(fundArgs.functionName, "fund");
assert.equal((fundArgs.args as unknown[])[0], BigInt(186207));

/* ---- every step is unsigned and self-describing ---- */

for (const step of [create, approve, fund]) {
  assert.match(step.data, /^0x[0-9a-f]+$/i, "calldata must be hex");
  assert.equal(step.chainId, ARC_CHAIN_ID);
  assert.equal(step.value, "0x0");
  // The buyer is asked to approve a sentence, not a selector.
  assert.ok(step.title.length > 8, `${step.step} needs a human title`);
  assert.ok(step.detail.length > 24, `${step.step} needs a human explanation`);
  // Nothing resembling a key or signature may ride along.
  assert.ok(!("privateKey" in step) && !("signature" in step));
}

console.log("[erc8183-client-transaction-test] passed: createJob binds the Veyra evaluator, approval is exactly the budget rather than unlimited, fund targets the job, and every step is unsigned calldata on Arc with a human explanation");
