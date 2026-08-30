/**
 * Copyright 2026 Circle Internet Group, Inc.  All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  parseUnits,
  verifyMessage,
  type Hex,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { HostedPlannerSnapshot } from "../lib/agent/hosted-workflows.ts";
import {
  getHostedWorkflowCheckoutConfig,
  priceHostedWorkflow,
} from "../lib/agent/workflow-pricing.ts";
import {
  plannerSnapshotForHostedQuote,
  sponsoredWorkflowAuthorizationMessage,
  validateHostedWorkflowPaymentEvidence,
} from "../lib/commerce/workflow-checkout.ts";
import {
  ARC_MEMO_WORKFLOW_PAYMENT_PROTOCOL,
  encodeWorkflowPaymentTransaction,
  workflowPaymentDescriptor,
} from "../lib/commerce/workflow-payment.ts";
import {
  ARC_MEMO_ABI,
  ARC_TESTNET_NATIVE_USDC_EMITTER,
  ARC_USDC_TRANSFER_ABI,
  arcAccountKind,
  readArcUsdcBlocklistStatus,
} from "../lib/wallet/arc-usdc.ts";
import {
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_USDC_ADDRESS,
} from "../lib/wallet/arc.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function expectFailure(action: () => unknown, pattern: RegExp, label: string) {
  try {
    action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(pattern.test(message), `${label} returned an unexpected error: ${message}`);
    return;
  }
  throw new Error(`${label} unexpectedly succeeded.`);
}

const requester = getAddress("0x1111111111111111111111111111111111111111");
const treasury = getAddress("0x2222222222222222222222222222222222222222");

const plan: HostedPlannerSnapshot = {
  version: 3,
  workflowType: "market_context",
  workflowLabel: "Market Context Brief",
  effectiveTask: "Analyze current ETH market context from paid APIs.",
  selectedServices: [],
  skippedServices: [],
  estimatedSpendUsdc: 0.0013,
  remainingBudgetUsdc: 0.0037,
  maxPaidCalls: 3,
  budgetCapUsdc: 0.005,
  aggregationMode: "deterministic_execution_optional_llm",
  aggregationLabel: "Deterministic paid execution with optional StepFun synthesis",
  inputPreview: "A sufficiently long workflow checkout test input.",
  inputSha256: "a".repeat(64),
  marketSymbol: "ETH/USD",
  warnings: [],
};

async function main() {
  const config = getHostedWorkflowCheckoutConfig({
    SELLER_ADDRESS: treasury,
    HOSTED_WORKFLOW_PLATFORM_FEE_USDC: "0.0007",
    HOSTED_WORKFLOW_MAX_PRICE_USDC: "0.005",
    HOSTED_WORKFLOW_SPONSORED_QUOTA: "2",
    HOSTED_WORKFLOW_QUOTE_EXPIRY_SECONDS: "600",
  });
  const pricing = priceHostedWorkflow(plan, config);
  assert(pricing.estimatedProviderCostUsdc === 0.0013, "Provider cost changed during pricing.");
  assert(pricing.platformFeeUsdc === 0.0007, "Platform fee is incorrect.");
  assert(pricing.listPriceUsdc === 0.002, "Workflow list price is not 0.002 USDC.");
  assert(config.sponsoredQuota === 2, "Sponsored quota configuration is incorrect.");
  assert(config.chainId === ARC_TESTNET_CHAIN_ID, "Checkout is not restricted to Arc Testnet.");

  const trustInput = { agentId: "agt_0123456789abcdefghij" };
  const trustPlan = {
    ...plan,
    version: 4 as const,
    workflowType: "agent_trust_report" as const,
    metadata: {
      agentTrustInput: trustInput,
      requestedSources: { agentRegistry: true },
    },
  };
  const persistedTrustPlan = plannerSnapshotForHostedQuote(trustPlan, {
    machine_credential_id: "credential-internal-id",
  });
  assert(
    JSON.stringify(persistedTrustPlan.metadata?.agentTrustInput) ===
      JSON.stringify(trustInput),
    "Immutable Agent Trust input was dropped from the quote planner snapshot.",
  );
  assert(
    persistedTrustPlan.metadata?.machine_credential_id ===
      "credential-internal-id",
    "Internal quote ownership metadata was not merged into the planner snapshot.",
  );

  expectFailure(
    () => priceHostedWorkflow({ ...plan, estimatedSpendUsdc: 0.0044 }, config),
    /exceeds the .* checkout cap/i,
    "Workflow price cap",
  );
  expectFailure(
    () => getHostedWorkflowCheckoutConfig({ SELLER_ADDRESS: treasury, HOSTED_WORKFLOW_SPONSORED_QUOTA: "4" }),
    /integer from 1 to 3/i,
    "Sponsored quota cap",
  );

  const quote = {
    amount_due_usdc: "0.002000",
    requester_wallet: requester,
    treasury_address: treasury,
    created_at: "2026-07-20T11:59:00.000Z",
    expires_at: "2026-07-20T12:10:00.000Z",
  };
  const validTransaction = {
    chainId: ARC_TESTNET_CHAIN_ID,
    from: requester,
    to: treasury,
    value: parseUnits("0.002000", 18),
    input: "0x",
  };
  validateHostedWorkflowPaymentEvidence({
    quote,
    transaction: validTransaction,
    receiptStatus: "success",
    settledAt: "2026-07-20T12:00:00.000Z",
  });
  expectFailure(
    () => validateHostedWorkflowPaymentEvidence({ quote, transaction: { ...validTransaction, value: parseUnits("0.001999", 18) }, receiptStatus: "success", settledAt: "2026-07-20T12:00:00.000Z" }),
    /does not match/i,
    "Underpayment",
  );
  expectFailure(
    () => validateHostedWorkflowPaymentEvidence({ quote, transaction: { ...validTransaction, chainId: 1 }, receiptStatus: "success", settledAt: "2026-07-20T12:00:00.000Z" }),
    /does not match/i,
    "Wrong chain",
  );
  expectFailure(
    () => validateHostedWorkflowPaymentEvidence({ quote, transaction: { ...validTransaction, to: requester }, receiptStatus: "success", settledAt: "2026-07-20T12:00:00.000Z" }),
    /does not match/i,
    "Wrong treasury",
  );
  expectFailure(
    () => validateHostedWorkflowPaymentEvidence({ quote, transaction: { ...validTransaction, input: "0x01" }, receiptStatus: "success", settledAt: "2026-07-20T12:00:00.000Z" }),
    /does not match/i,
    "Unexpected calldata",
  );
  expectFailure(
    () => validateHostedWorkflowPaymentEvidence({ quote, transaction: validTransaction, receiptStatus: "reverted", settledAt: "2026-07-20T12:00:00.000Z" }),
    /reverted/i,
    "Reverted payment",
  );
  expectFailure(
    () => validateHostedWorkflowPaymentEvidence({ quote, transaction: validTransaction, receiptStatus: "success", settledAt: "2026-07-20T11:00:00.000Z" }),
    /does not match/i,
    "Pre-quote payment replay",
  );

  const memoQuote = {
    id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    request_hash: `0x${"c".repeat(64)}`,
    input_hash: `0x${"d".repeat(64)}`,
    amount_due_usdc: "0.002000",
    requester_wallet: requester,
    treasury_address: treasury,
    created_at: "2026-07-20T11:59:00.000Z",
    expires_at: "2026-07-20T12:10:00.000Z",
    planner_snapshot: {
      metadata: { checkout_payment_protocol: ARC_MEMO_WORKFLOW_PAYMENT_PROTOCOL },
    },
  };
  const memoDescriptor = workflowPaymentDescriptor(memoQuote);
  const memoTransaction = encodeWorkflowPaymentTransaction(memoDescriptor);
  assert(memoDescriptor.memo !== null, "Memo quote did not produce a Memo payment descriptor.");
  assert(
    JSON.stringify(workflowPaymentDescriptor(memoQuote)) === JSON.stringify(memoDescriptor),
    "Memo payment descriptor is not deterministic.",
  );
  const memoTopics = encodeEventTopics({
    abi: ARC_MEMO_ABI,
    eventName: "Memo",
    args: {
      sender: requester,
      target: ARC_TESTNET_USDC_ADDRESS,
      memoId: memoDescriptor.memo.memoId,
    },
  });
  const memoData = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes" }, { type: "uint256" }],
    [memoDescriptor.memo.callDataHash, memoDescriptor.memo.memoData, BigInt(1)],
  );
  const transferTopics = encodeEventTopics({
    abi: ARC_USDC_TRANSFER_ABI,
    eventName: "Transfer",
    args: { from: requester, to: treasury },
  });
  const amountAtomic6 = BigInt(memoDescriptor.amountAtomic6);
  const transferData = encodeAbiParameters([{ type: "uint256" }], [amountAtomic6]);
  const nativeTransferData = encodeAbiParameters(
    [{ type: "uint256" }],
    [amountAtomic6 * (BigInt(10) ** BigInt(12))],
  );
  const memoLogs = [
    {
      address: memoDescriptor.memo.contractAddress,
      topics: memoTopics,
      data: memoData,
    },
    {
      address: ARC_TESTNET_USDC_ADDRESS,
      topics: transferTopics,
      data: transferData,
    },
    {
      address: ARC_TESTNET_NATIVE_USDC_EMITTER,
      topics: transferTopics,
      data: nativeTransferData,
    },
  ];
  validateHostedWorkflowPaymentEvidence({
    quote: memoQuote,
    transaction: {
      chainId: ARC_TESTNET_CHAIN_ID,
      from: requester,
      to: memoTransaction.to,
      value: memoTransaction.value,
      input: memoTransaction.data,
    },
    logs: memoLogs,
    receiptStatus: "success",
    settledAt: "2026-07-20T12:00:00.000Z",
  });
  expectFailure(
    () => validateHostedWorkflowPaymentEvidence({
      quote: memoQuote,
      transaction: {
        chainId: ARC_TESTNET_CHAIN_ID,
        from: requester,
        to: memoTransaction.to,
        value: memoTransaction.value,
        input: memoTransaction.data,
      },
      logs: memoLogs.slice(0, 2),
      receiptStatus: "success",
      settledAt: "2026-07-20T12:00:00.000Z",
    }),
    /required Arc memo evidence/i,
    "Missing EIP-7708 payment evidence",
  );
  const tamperedMemoData = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes" }, { type: "uint256" }],
    [memoDescriptor.memo.callDataHash, "0x1234" as Hex, BigInt(1)],
  );
  expectFailure(
    () => validateHostedWorkflowPaymentEvidence({
      quote: memoQuote,
      transaction: {
        chainId: ARC_TESTNET_CHAIN_ID,
        from: requester,
        to: memoTransaction.to,
        value: memoTransaction.value,
        input: memoTransaction.data,
      },
      logs: [{ ...memoLogs[0], data: tamperedMemoData }, ...memoLogs.slice(1)],
      receiptStatus: "success",
      settledAt: "2026-07-20T12:00:00.000Z",
    }),
    /required Arc memo evidence/i,
    "Tampered Memo evidence",
  );

  const blocklistedClient = {
    readContract: async () => true,
  } as unknown as PublicClient;
  const clearClient = {
    readContract: async () => false,
  } as unknown as PublicClient;
  const unavailableClient = {
    readContract: async () => { throw new Error("provider unavailable"); },
  } as unknown as PublicClient;
  assert(
    await readArcUsdcBlocklistStatus(requester, blocklistedClient) === "blocklisted",
    "Confirmed Arc USDC blocklist status was not preserved.",
  );
  assert(
    await readArcUsdcBlocklistStatus(requester, clearClient) === "clear",
    "Clear Arc USDC blocklist status was not preserved.",
  );
  assert(
    await readArcUsdcBlocklistStatus(requester, unavailableClient) === "unknown",
    "Blocklist provider failure did not fail closed to unknown.",
  );
  assert(
    await arcAccountKind(requester, {
      getBytecode: async () => "0x",
    } as unknown as PublicClient) === "eoa",
    "EOA detection failed for the Memo checkout gate.",
  );

  const account = privateKeyToAccount(generatePrivateKey());
  const sponsoredQuote = {
    id: "11111111-2222-4333-8444-555555555555",
    requesterWallet: account.address,
    inputSha256: "b".repeat(64),
    expiresAt: "2026-07-20T12:00:00.000Z",
  };
  const message = sponsoredWorkflowAuthorizationMessage(sponsoredQuote);
  assert(message.includes("No USDC payment is authorized"), "Sponsored signature is not payment-safe.");
  const signature = await account.signMessage({ message });
  assert(
    await verifyMessage({ address: account.address, message, signature }),
    "Sponsored requester signature could not be verified.",
  );
  assert(
    !(await verifyMessage({ address: account.address, message: `${message}\nchanged`, signature })),
    "Sponsored signature was not bound to the immutable authorization message.",
  );

  console.log(
    "[hosted-checkout-test] passed: exact pricing, legacy compatibility, deterministic Memo checkout, EIP-7708 receipt evidence, blocklist/EOA gates, and sponsored signature binding",
  );
}

main().catch((error) => {
  console.error(
    `[hosted-checkout-test] failed: ${error instanceof Error ? error.message : "Unknown error"}`,
  );
  process.exitCode = 1;
});
