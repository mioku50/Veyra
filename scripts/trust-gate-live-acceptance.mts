/**
 * Copyright 2026 Circle Internet Group, Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import {
  createWalletClient,
  decodeEventLog,
  erc20Abi,
  http,
  keccak256,
  parseUnits,
  stringToBytes,
  zeroAddress,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import {
  ARC_ERC8004_IDENTITY_REGISTRY,
  fetchAgentIdentityOnchain,
  getArcPublicClient,
  getCanonicalVeyraAgentIdentity,
} from "../lib/erc8004/client.ts";
import { ERC8183_AGENTIC_COMMERCE_ABI } from "../lib/erc8183/abi.ts";
import { fetchOnchainJob } from "../lib/erc8183/client.ts";
import { prepareDeliverableCommitment } from "../lib/erc8183/deliverable.ts";
import { executeOffchainJobEvaluation } from "../lib/erc8183/evaluator.ts";
import { persistTerminalErc8183Evaluation } from "../lib/erc8183/persist.ts";
import { getByoaClient } from "../lib/byoa/service.ts";
import { proofRegistryAbi } from "../lib/commerce/onchain-proof.ts";
import {
  fetchLatestReputationSnapshot,
  fetchReputationEvidenceForAgent,
  saveReputationSnapshot,
} from "../lib/reputation/db.ts";
import { computeAgentReputation, createReputationSnapshot } from "../lib/reputation/engine.ts";
import {
  deriveReputationScoreFromEvaluation,
  deriveSettledErc8183ValueUsdc,
} from "../lib/reputation/erc8183-adapter.ts";
import { publishReputationSnapshotProofToArc } from "../lib/reputation/snapshot.ts";
import type { CanonicalAgentIdentity, ReputationSnapshot } from "../lib/reputation/types.ts";
import { buildClearanceMessage, signTrustClearance } from "../lib/trust-gate/sign.ts";
import { evaluateTrustDecision } from "../lib/trust-gate/decision.ts";
import { saveTrustDecision } from "../lib/trust-gate/db.ts";
import { feedbackFromErc8183Completion } from "../lib/trust-gate/feedback.ts";
import { isExecutableTrustDecision, type TrustDecision } from "../lib/trust-gate/types.ts";
import { verifyTrustClearanceOnchain } from "../lib/trust-gate/verify.ts";

const RPC_URL = process.env.ARC_TESTNET_RPC_URL || "https://rpc.testnet.arc.network";
const TRUST_GATE_ADDRESS = process.env.VEYRA_TRUST_GATE_ADDRESS as `0x${string}`;
const PROOF_REGISTRY_ADDRESS = (
  process.env.AGENT_COMMERCE_PROOF_REGISTRY_ADDRESS
  || "0x0db0b8ddc03c3c56c0662b547822e4654167b684"
) as `0x${string}`;
const COMMERCE_ADDRESS = "0x0747EEf0706327138c69792bF28Cd525089e4583" as const;
const USDC_ADDRESS = "0x3600000000000000000000000000000000000000" as const;
const VEYRA_EVALUATOR_ADDRESS = (
  process.env.NEXT_PUBLIC_VEYRA_ERC8183_EVALUATOR_ADDRESS
  || "0x0d2c04580e081e222bbe5bf9818af337e2633eb7"
) as `0x${string}`;
const DELIVERABLE_URI =
  "https://raw.githubusercontent.com/mioku50/Agent-Commerce/main/public/canary-deliverable.json";
const BLOCKED_X402_ENDPOINT =
  process.env.TRUST_GATE_LIVE_X402_ENDPOINT
  || "/api/reference-seller/project-update-intelligence";
const BASE_URL = (
  process.env.NEXT_PUBLIC_APP_URL || "https://agent-commerce-six.vercel.app"
).replace(/\/$/, "");

async function publishCanonicalSnapshotProof(
  snapshot: ReputationSnapshot,
  identityOwner: `0x${string}`,
  settledValueUsdc: number,
  buyer: `0x${string}`,
  seller: `0x${string}`,
  sourceId: string,
) {
  const serverSecret = process.env.REPUTATION_PROOF_PUBLISH_SECRET;
  if (!serverSecret) {
    return publishReputationSnapshotProofToArc(
      snapshot,
      identityOwner,
      undefined,
      settledValueUsdc,
      { buyer, seller, source: "erc8183_job", sourceId },
    );
  }

  const response = await fetch(`${BASE_URL}/api/internal/reputation/proofs`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${serverSecret}`,
      "content-type": "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(300_000),
  });
  const payload = await response.json() as {
    snapshotId?: string;
    canonicalHash?: Hex;
    arcProofTx?: Hex;
    blockNumber?: string | number;
    proofAlreadyRegistered?: boolean;
    error?: { code?: string; message?: string };
  };
  assert.equal(
    response.status,
    200,
    `Server proof publication failed: ${payload.error?.code || "unknown_error"}`,
  );
  assert.equal(payload.snapshotId, snapshot.snapshotId, "Server published a different snapshot");
  assert.equal(
    payload.canonicalHash?.toLowerCase(),
    snapshot.canonicalHash.toLowerCase(),
    "Server published a different canonical hash",
  );
  assert.ok(payload.arcProofTx, "Server proof response has no transaction hash");
  return {
    verifiedOnchain: true as const,
    transactionHash: payload.arcProofTx,
    blockNumber: payload.blockNumber === undefined ? undefined : BigInt(payload.blockNumber),
    proofAlreadyRegistered: Boolean(payload.proofAlreadyRegistered),
  };
}

const trustGateAbi = [
  {
    type: "function",
    name: "hashClearance",
    stateMutability: "view",
    inputs: [{
      name: "clearance",
      type: "tuple",
      components: [
        { name: "decisionId", type: "bytes32" },
        { name: "subject", type: "address" },
        { name: "executor", type: "address" },
        { name: "counterparty", type: "address" },
        { name: "actionHash", type: "bytes32" },
        { name: "requestedAmount", type: "uint256" },
        { name: "maxAmount", type: "uint256" },
        { name: "snapshotHash", type: "bytes32" },
        { name: "policyVersion", type: "bytes32" },
        { name: "evaluator", type: "address" },
        { name: "issuedAt", type: "uint64" },
        { name: "expiresAt", type: "uint64" },
      ],
    }],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "consumedClearances",
    stateMutability: "view",
    inputs: [{ name: "digest", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "consumeClearance",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "clearance",
        type: "tuple",
        components: [
          { name: "decisionId", type: "bytes32" },
          { name: "subject", type: "address" },
          { name: "executor", type: "address" },
          { name: "counterparty", type: "address" },
          { name: "actionHash", type: "bytes32" },
          { name: "requestedAmount", type: "uint256" },
          { name: "maxAmount", type: "uint256" },
          { name: "snapshotHash", type: "bytes32" },
          { name: "policyVersion", type: "bytes32" },
          { name: "evaluator", type: "address" },
          { name: "issuedAt", type: "uint64" },
          { name: "expiresAt", type: "uint64" },
        ],
      },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

type BlockedPathEvidence = {
  decision: TrustDecision;
  dbJobDelta: number;
  dbPaymentDelta: number;
  x402SettlementDelta: number;
  jobCreatedDelta: number;
  clearanceConsumptionDelta: number;
};

type ArcPublicClient = ReturnType<typeof getArcPublicClient>;

function requirePrivateKey(value: string | undefined, label: string): Hex {
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`[SETUP] Missing valid ${label}`);
  }
  return value as Hex;
}

async function requireCount(
  promise: PromiseLike<{ count: number | null; error: { message: string } | null }>,
  label: string,
): Promise<number> {
  const { count, error } = await promise;
  if (error) throw new Error(`${label} query failed`);
  if (count === null) throw new Error(`${label} count was not returned`);
  return count;
}

function countHostedJobsForBuyer(buyer: string) {
  const client = getByoaClient();
  return requireCount(
    client
      .from("hosted_agent_jobs")
      .select("id", { count: "exact", head: true })
      .ilike("requester_wallet", buyer),
    "hosted_agent_jobs",
  );
}

function paymentEventsQuery(
  buyer: string,
  seller: string,
  endpoint: string,
  settledOnly: boolean,
) {
  let query = getByoaClient()
    .from("payment_events")
    .select("id", { count: "exact", head: true })
    .ilike("payer", buyer)
    .ilike("onchain_seller", seller)
    .eq("endpoint", endpoint)
    .eq("network", "eip155:5042002");
  if (settledOnly) query = query.not("gateway_tx", "is", null);
  return query;
}

function countPaymentEvents(buyer: string, seller: string, endpoint: string) {
  return requireCount(paymentEventsQuery(buyer, seller, endpoint, false), "payment_events");
}

function countX402Settlements(buyer: string, seller: string, endpoint: string) {
  return requireCount(paymentEventsQuery(buyer, seller, endpoint, true), "x402 settlements");
}

async function countX402SettlementsInWindow(
  buyer: string,
  seller: string,
  endpoint: string,
  startedAt: string,
  endedAt: string,
) {
  return requireCount(
    paymentEventsQuery(buyer, seller, endpoint, true)
      .gte("created_at", startedAt)
      .lte("created_at", endedAt),
    "bounded x402 settlements",
  );
}

async function waitForNextBlock(publicClient: ArcPublicClient, blockBefore: bigint) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = await publicClient.getBlockNumber();
    if (current > blockBefore) return current;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Arc Testnet did not advance within the blocked-path observation window");
}

async function queryMatchingJobCreatedEvents(input: {
  publicClient: ArcPublicClient;
  fromBlockExclusive: bigint;
  toBlockInclusive: bigint;
  buyer: `0x${string}`;
  provider: `0x${string}`;
  evaluator: `0x${string}`;
}) {
  if (input.toBlockInclusive <= input.fromBlockExclusive) return [];
  const logs = await input.publicClient.getLogs({
    address: COMMERCE_ADDRESS,
    event: ERC8183_AGENTIC_COMMERCE_ABI[7],
    args: { client: input.buyer, provider: input.provider },
    fromBlock: input.fromBlockExclusive + 1n,
    toBlock: input.toBlockInclusive,
  });
  return logs.filter(
    (log) => log.args.evaluator?.toLowerCase() === input.evaluator.toLowerCase(),
  );
}

async function readClearanceConsumption(
  publicClient: ArcPublicClient,
  clearance: ReturnType<typeof buildClearanceMessage>,
) {
  const digest = await publicClient.readContract({
    address: TRUST_GATE_ADDRESS,
    abi: trustGateAbi,
    functionName: "hashClearance",
    args: [clearance],
  });
  const consumed = await publicClient.readContract({
    address: TRUST_GATE_ADDRESS,
    abi: trustGateAbi,
    functionName: "consumedClearances",
    args: [digest],
  });
  return { digest, consumed };
}

async function verifyCanonicalSnapshotProof(
  publicClient: ArcPublicClient,
  snapshot: ReputationSnapshot,
) {
  assert.ok(/^0x[0-9a-fA-F]{64}$/.test(snapshot.canonicalHash), "Snapshot canonical hash is invalid");
  assert.ok(snapshot.arcProofTx, "Snapshot Arc proof transaction is missing");
  const isRegistered = await publicClient.readContract({
    address: PROOF_REGISTRY_ADDRESS,
    abi: proofRegistryAbi,
    functionName: "isRegistered",
    args: [snapshot.canonicalHash as Hex],
  });
  assert.equal(isRegistered, true, "Snapshot proof is not registered on Arc");
  const proof = await publicClient.readContract({
    address: PROOF_REGISTRY_ADDRESS,
    abi: proofRegistryAbi,
    functionName: "getProof",
    args: [snapshot.canonicalHash as Hex],
  });
  assert.equal(
    proof.responseHash.toLowerCase(),
    snapshot.canonicalHash.toLowerCase(),
    "Snapshot canonical hash differs from Arc proof responseHash",
  );
  const receipt = await publicClient.getTransactionReceipt({ hash: snapshot.arcProofTx as Hex });
  assert.equal(receipt.status, "success", "Snapshot Arc proof transaction reverted");
}

async function runBlockedPath(input: {
  publicClient: ArcPublicClient;
  snapshot: ReputationSnapshot;
  agentId: string;
  buyer: `0x${string}`;
  provider: `0x${string}`;
  endpoint: string;
}): Promise<BlockedPathEvidence> {
  const executableProbe = await evaluateTrustDecision({
    subjectAgentId: input.agentId,
    counterpartyWallet: input.provider,
    action: "x402_payment",
    requestedValueUsdc: 0,
    serviceId: input.endpoint,
    executorWallet: input.buyer,
  }, input.snapshot);
  assert.ok(
    isExecutableTrustDecision(executableProbe.decision),
    `Current real snapshot cannot supply the required executed path: ${executableProbe.decision}`,
  );

  const blockedAmount = executableProbe.policy.maxValueUsdc + 0.000001;
  const dbJobsBefore = await countHostedJobsForBuyer(input.buyer);
  const dbPaymentsBefore = await countPaymentEvents(input.buyer, input.provider, input.endpoint);
  const x402Before = await countX402Settlements(input.buyer, input.provider, input.endpoint);
  const blockBefore = await input.publicClient.getBlockNumber();
  const startedAt = new Date().toISOString();

  const decision = await evaluateTrustDecision({
    subjectAgentId: input.agentId,
    counterpartyWallet: input.provider,
    action: "x402_payment",
    requestedValueUsdc: blockedAmount,
    serviceId: input.endpoint,
    executorWallet: input.buyer,
  }, input.snapshot);
  assert.ok(
    decision.decision === "DENY" || decision.decision === "REVIEW_REQUIRED",
    `Blocked path unexpectedly produced ${decision.decision}`,
  );
  assert.ok(decision.reasons.includes("VALUE_EXCEEDS_TRUST_LIMIT"));
  await saveTrustDecision(decision);

  const candidateClearance = buildClearanceMessage(decision);
  const clearanceBefore = await readClearanceConsumption(input.publicClient, candidateClearance);
  assert.equal(clearanceBefore.consumed, false, "Candidate blocked clearance was already consumed");

  const blockAfter = await waitForNextBlock(input.publicClient, blockBefore);
  const endedAt = new Date().toISOString();
  const [dbJobsAfter, dbPaymentsAfter, x402After, boundedX402, jobCreatedEvents, clearanceAfter] = await Promise.all([
    countHostedJobsForBuyer(input.buyer),
    countPaymentEvents(input.buyer, input.provider, input.endpoint),
    countX402Settlements(input.buyer, input.provider, input.endpoint),
    countX402SettlementsInWindow(input.buyer, input.provider, input.endpoint, startedAt, endedAt),
    queryMatchingJobCreatedEvents({
      publicClient: input.publicClient,
      fromBlockExclusive: blockBefore,
      toBlockInclusive: blockAfter,
      buyer: input.buyer,
      provider: input.provider,
      evaluator: VEYRA_EVALUATOR_ADDRESS,
    }),
    readClearanceConsumption(input.publicClient, candidateClearance),
  ]);

  assert.equal(clearanceAfter.digest, clearanceBefore.digest, "Blocked clearance digest changed");
  assert.equal(clearanceAfter.consumed, false, "Blocked clearance was consumed");
  assert.equal(boundedX402, 0, "A matching x402 settlement exists inside the blocked window");

  return {
    decision,
    dbJobDelta: dbJobsAfter - dbJobsBefore,
    dbPaymentDelta: dbPaymentsAfter - dbPaymentsBefore,
    x402SettlementDelta: x402After - x402Before,
    jobCreatedDelta: jobCreatedEvents.length,
    clearanceConsumptionDelta: Number(clearanceAfter.consumed) - Number(clearanceBefore.consumed),
  };
}

async function extractCreatedJobId(
  receipt: TransactionReceipt,
  buyer: `0x${string}`,
  provider: `0x${string}`,
) {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== COMMERCE_ADDRESS.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: ERC8183_AGENTIC_COMMERCE_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (
        decoded.eventName === "JobCreated"
        && decoded.args.client.toLowerCase() === buyer.toLowerCase()
        && decoded.args.provider.toLowerCase() === provider.toLowerCase()
        && decoded.args.evaluator.toLowerCase() === VEYRA_EVALUATOR_ADDRESS.toLowerCase()
      ) {
        return decoded.args.jobId;
      }
    } catch {
      // Ignore unrelated logs in the receipt.
    }
  }
  throw new Error("Exact ERC-8183 JobCreated event was not found");
}

async function runExecutedPath(input: {
  publicClient: ArcPublicClient;
  snapshot: ReputationSnapshot;
  identity: CanonicalAgentIdentity;
  buyerPrivateKey: Hex;
  providerPrivateKey: Hex;
  trustAttesterPrivateKey: Hex;
  evaluatorAttesterPrivateKey: Hex;
  evaluatorRelayerPrivateKey: Hex;
}) {
  const buyer = privateKeyToAccount(input.buyerPrivateKey);
  const provider = privateKeyToAccount(input.providerPrivateKey);
  const preferredValue = Number(process.env.TRUST_GATE_LIVE_ACCEPTANCE_USDC || "0.01");
  assert.ok(Number.isFinite(preferredValue) && preferredValue > 0, "Live acceptance amount must be positive");

  const limitProbe = await evaluateTrustDecision({
    subjectAgentId: input.identity.agentId,
    counterpartyWallet: provider.address,
    action: "erc8183_job",
    requestedValueUsdc: 0,
    executorWallet: buyer.address,
  }, input.snapshot);
  assert.ok(isExecutableTrustDecision(limitProbe.decision), `Executed path blocked by ${limitProbe.decision}`);
  const requestedUsdc = Math.min(preferredValue, limitProbe.policy.maxValueUsdc);
  assert.ok(requestedUsdc > 0, "Executed path has no positive policy allowance");

  const decision = await evaluateTrustDecision({
    subjectAgentId: input.identity.agentId,
    counterpartyWallet: provider.address,
    action: "erc8183_job",
    requestedValueUsdc: requestedUsdc,
    executorWallet: buyer.address,
  }, input.snapshot);
  assert.ok(isExecutableTrustDecision(decision.decision), `Executed path denied: ${decision.decision}`);
  await saveTrustDecision(decision);

  const { signature, clearanceMessage } = await signTrustClearance(
    decision,
    5042002,
    TRUST_GATE_ADDRESS,
    input.trustAttesterPrivateKey,
  );
  const clearanceBefore = await readClearanceConsumption(input.publicClient, clearanceMessage);
  assert.equal(clearanceBefore.consumed, false, "Executed clearance was already consumed");
  const verification = await verifyTrustClearanceOnchain(
    clearanceMessage,
    signature,
    TRUST_GATE_ADDRESS,
    RPC_URL,
  );
  assert.equal(verification.valid, true, "Executed clearance failed onchain verification");

  const buyerWallet = createWalletClient({ account: buyer, chain: arcTestnet, transport: http(RPC_URL) });
  const providerWallet = createWalletClient({ account: provider, chain: arcTestnet, transport: http(RPC_URL) });
  const consumeTx = await buyerWallet.writeContract({
    address: TRUST_GATE_ADDRESS,
    abi: trustGateAbi,
    functionName: "consumeClearance",
    args: [clearanceMessage, signature],
  });
  const consumeReceipt = await input.publicClient.waitForTransactionReceipt({ hash: consumeTx });
  assert.equal(consumeReceipt.status, "success", "Trust clearance consumption reverted");
  const clearanceAfter = await readClearanceConsumption(input.publicClient, clearanceMessage);
  assert.equal(clearanceAfter.digest, clearanceBefore.digest);
  assert.equal(clearanceAfter.consumed, true, "Executed clearance was not consumed");

  const requestedAtomic = parseUnits(requestedUsdc.toFixed(6), 6);
  const buyerUsdcBalance = await input.publicClient.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [buyer.address],
  });
  assert.ok(
    buyerUsdcBalance >= requestedAtomic,
    `Buyer ${buyer.address} needs at least ${requestedUsdc} ERC-20 USDC on Arc Testnet`,
  );

  const providerGasBefore = await input.publicClient.getBalance({ address: provider.address });
  if (providerGasBefore < parseUnits("0.002", 18)) {
    const buyerGas = await input.publicClient.getBalance({ address: buyer.address });
    const topUpValue = parseUnits("0.005", 18);
    assert.ok(buyerGas > topUpValue, `Buyer ${buyer.address} lacks Arc Testnet gas balance`);
    const topUpTx = await buyerWallet.sendTransaction({ to: provider.address, value: topUpValue });
    const topUpReceipt = await input.publicClient.waitForTransactionReceipt({ hash: topUpTx });
    assert.equal(topUpReceipt.status, "success", "Provider gas top-up reverted");
  }

  const createTx = await buyerWallet.writeContract({
    address: COMMERCE_ADDRESS,
    abi: ERC8183_AGENTIC_COMMERCE_ABI,
    functionName: "createJob",
    args: [
      provider.address,
      VEYRA_EVALUATOR_ADDRESS,
      BigInt(Math.floor(Date.now() / 1000) + 86_400),
      `Veyra P5.4.3 acceptance ${decision.decisionId}`,
      zeroAddress,
    ],
  });
  const createReceipt = await input.publicClient.waitForTransactionReceipt({ hash: createTx });
  assert.equal(createReceipt.status, "success", "ERC-8183 createJob reverted");
  const jobId = await extractCreatedJobId(createReceipt, buyer.address, provider.address);

  const setBudgetTx = await providerWallet.writeContract({
    address: COMMERCE_ADDRESS,
    abi: ERC8183_AGENTIC_COMMERCE_ABI,
    functionName: "setBudget",
    args: [jobId, requestedAtomic, "0x"],
  });
  assert.equal(
    (await input.publicClient.waitForTransactionReceipt({ hash: setBudgetTx })).status,
    "success",
    "ERC-8183 setBudget reverted",
  );

  const currentAllowance = await input.publicClient.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "allowance",
    args: [buyer.address, COMMERCE_ADDRESS],
  });
  if (currentAllowance < requestedAtomic) {
    const approveTx = await buyerWallet.writeContract({
      address: USDC_ADDRESS,
      abi: erc20Abi,
      functionName: "approve",
      args: [COMMERCE_ADDRESS, requestedAtomic],
    });
    assert.equal(
      (await input.publicClient.waitForTransactionReceipt({ hash: approveTx })).status,
      "success",
      "USDC approval reverted",
    );
  }

  const providerUsdcBefore = await input.publicClient.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [provider.address],
  });
  const fundTx = await buyerWallet.writeContract({
    address: COMMERCE_ADDRESS,
    abi: ERC8183_AGENTIC_COMMERCE_ABI,
    functionName: "fund",
    args: [jobId, "0x"],
  });
  assert.equal(
    (await input.publicClient.waitForTransactionReceipt({ hash: fundTx })).status,
    "success",
    "ERC-8183 fund reverted",
  );
  const fundedJob = await fetchOnchainJob(COMMERCE_ADDRESS, jobId, input.publicClient);
  assert.equal(fundedJob.status, "Funded", "ERC-8183 job did not enter Funded state");
  assert.equal(fundedJob.budget, requestedAtomic, "Funded job budget differs from requested value");

  const artifactResponse = await fetch(DELIVERABLE_URI);
  assert.equal(artifactResponse.ok, true, "Canary deliverable could not be fetched");
  const artifactText = await artifactResponse.text();
  const commitment = prepareDeliverableCommitment({
    contentUri: DELIVERABLE_URI,
    contentHash: keccak256(stringToBytes(artifactText)),
    contentType: "application/json",
    schemaId: "veyra://schemas/structured-deliverable-v1",
    policyId: "structured-deliverable-v1",
  });
  const submitTx = await providerWallet.writeContract({
    address: COMMERCE_ADDRESS,
    abi: ERC8183_AGENTIC_COMMERCE_ABI,
    functionName: "submit",
    args: [jobId, commitment.deliverableHash, "0x"],
  });
  assert.equal(
    (await input.publicClient.waitForTransactionReceipt({ hash: submitTx })).status,
    "success",
    "ERC-8183 submit reverted",
  );
  assert.equal(
    (await fetchOnchainJob(COMMERCE_ADDRESS, jobId, input.publicClient)).status,
    "Submitted",
    "ERC-8183 job did not enter Submitted state",
  );

  const evaluation = await executeOffchainJobEvaluation({
    chainId: 5042002,
    agenticCommerce: COMMERCE_ADDRESS,
    jobId: jobId.toString(),
    deliverable: commitment.deliverable,
    evaluatorContract: VEYRA_EVALUATOR_ADDRESS,
    attesterPrivateKey: input.evaluatorAttesterPrivateKey,
    relayerPrivateKey: input.evaluatorRelayerPrivateKey,
    rpcUrl: RPC_URL,
  });
  const evaluationScore = deriveReputationScoreFromEvaluation(evaluation);
  assert.equal(evaluationScore, 100, "Executed evaluator verdict was not Complete");
  assert.ok(evaluation.settlementTxHash, "Evaluator did not return a completion transaction");
  const completionReceipt = await input.publicClient.getTransactionReceipt({
    hash: evaluation.settlementTxHash,
  });
  const completedJob = await fetchOnchainJob(COMMERCE_ADDRESS, jobId, input.publicClient);
  const actualSettledValueUsdc = deriveSettledErc8183ValueUsdc({
    job: completedJob,
    receipt: completionReceipt,
    commerceAddress: COMMERCE_ADDRESS,
  });
  assert.ok(actualSettledValueUsdc > 0, "Actual settled economic value must be positive");
  assert.equal(
    parseUnits(actualSettledValueUsdc.toFixed(6), 6),
    requestedAtomic,
    "Actual settled value differs from the requested job budget",
  );
  const providerUsdcAfter = await input.publicClient.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [provider.address],
  });
  assert.ok(providerUsdcAfter > providerUsdcBefore, "Provider received no ERC-8183 settlement value");

  const persistedEvaluation = await persistTerminalErc8183Evaluation({
    chainId: 5042002,
    agenticCommerce: COMMERCE_ADDRESS,
    evaluatorContract: VEYRA_EVALUATOR_ADDRESS,
    job: completedJob,
    deliverable: commitment.deliverable,
    deliverableHash: commitment.deliverableHash,
    result: evaluation,
    settlementReceipt: completionReceipt,
  });

  await feedbackFromErc8183Completion({
    agentId: input.identity.agentId,
    jobId: jobId.toString(),
    outcome: "completed",
    clientAddress: buyer.address,
    providerAddress: provider.address,
    deliverableHash: commitment.deliverableHash,
    completeTx: evaluation.settlementTxHash,
    economicValueUsdc: actualSettledValueUsdc,
  });
  const evidence = await fetchReputationEvidenceForAgent(input.identity.agentId);
  const createdEvidence = evidence.find(
    (item) => item.sourceId === jobId.toString() && item.sourceHash === commitment.deliverableHash,
  );
  assert.ok(createdEvidence, "ERC-8183 reputation evidence was not persisted");
  assert.equal(createdEvidence.score, evaluationScore, "Persisted evaluation score is not canonical");
  assert.equal(
    createdEvidence.economicValueUsdc,
    actualSettledValueUsdc,
    "Persisted reputation evidence differs from actual settlement",
  );

  const updatedEvidence = await fetchReputationEvidenceForAgent(input.identity.agentId);
  const explanation = computeAgentReputation(input.identity, updatedEvidence);
  const newSnapshot = createReputationSnapshot(input.identity, updatedEvidence, explanation);
  await saveReputationSnapshot(newSnapshot);
  const proofResult = await publishCanonicalSnapshotProof(
    newSnapshot,
    input.identity.owner,
    actualSettledValueUsdc,
    buyer.address,
    provider.address,
    jobId.toString(),
  );
  assert.equal(proofResult.verifiedOnchain, true, "New reputation Arc proof was not verified");
  assert.ok(proofResult.transactionHash, "New reputation Arc proof has no transaction hash");
  const persistedSnapshot = await fetchLatestReputationSnapshot(input.identity.agentId);
  assert.equal(persistedSnapshot?.canonicalHash, newSnapshot.canonicalHash);
  assert.equal(persistedSnapshot?.arcProofTx, proofResult.transactionHash);
  await verifyCanonicalSnapshotProof(input.publicClient, persistedSnapshot!);

  return {
    decision,
    evaluationPublicId: persistedEvaluation.public_id,
    jobId: jobId.toString(),
    jobCreatedTx: createTx,
    evaluatorVerdict: evaluation.decision,
    evaluationScore,
    completeTx: evaluation.settlementTxHash,
    actualSettledValueUsdc,
    providerReceivedAtomic: providerUsdcAfter - providerUsdcBefore,
    snapshot: persistedSnapshot!,
    arcProofTx: proofResult.transactionHash,
  };
}

async function main() {
  assert.notEqual(
    process.env.REPUTATION_ALLOW_MEMORY_STORE,
    "true",
    "REPUTATION_ALLOW_MEMORY_STORE must not be true for live acceptance",
  );
  assert.ok(TRUST_GATE_ADDRESS, "Missing VEYRA_TRUST_GATE_ADDRESS");
  const buyerPrivateKey = requirePrivateKey(process.env.BUYER_PRIVATE_KEY, "BUYER_PRIVATE_KEY");
  const providerPrivateKey = requirePrivateKey(process.env.SELLER_PRIVATE_KEY, "SELLER_PRIVATE_KEY");
  const trustAttesterPrivateKey = requirePrivateKey(
    process.env.VEYRA_TRUST_ATTESTER_PRIVATE_KEY || process.env.ERC8183_EVALUATOR_ATTESTER_PRIVATE_KEY,
    "VEYRA_TRUST_ATTESTER_PRIVATE_KEY",
  );
  const evaluatorAttesterPrivateKey = requirePrivateKey(
    process.env.ERC8183_EVALUATOR_ATTESTER_PRIVATE_KEY,
    "ERC8183_EVALUATOR_ATTESTER_PRIVATE_KEY",
  );
  const evaluatorRelayerPrivateKey = requirePrivateKey(
    process.env.ERC8183_EVALUATOR_RELAYER_PRIVATE_KEY,
    "ERC8183_EVALUATOR_RELAYER_PRIVATE_KEY",
  );

  console.log("=======================================================");
  console.log("Veyra P5.4.3 Trust Gate Economic & Blocked-Path Acceptance");
  console.log("=======================================================\n");

  const publicClient = getArcPublicClient(RPC_URL);
  assert.equal(await publicClient.getChainId(), 5042002, "Live acceptance must run on Arc Testnet");
  const identityRecord = await getCanonicalVeyraAgentIdentity(publicClient);
  assert.ok(identityRecord?.agent_id, "Canonical ERC-8004 identity is missing");
  assert.equal(identityRecord.registry_address.toLowerCase(), ARC_ERC8004_IDENTITY_REGISTRY.toLowerCase());
  const onchainIdentity = await fetchAgentIdentityOnchain(
    BigInt(identityRecord.agent_id),
    ARC_ERC8004_IDENTITY_REGISTRY,
    publicClient,
  );
  assert.equal(onchainIdentity.owner.toLowerCase(), identityRecord.owner_address.toLowerCase());

  const snapshot = await fetchLatestReputationSnapshot(identityRecord.agent_id);
  assert.ok(snapshot, "Production reputation snapshot is missing");
  assert.equal(snapshot.agentId, identityRecord.agent_id, "Snapshot belongs to another agent");
  await verifyCanonicalSnapshotProof(publicClient, snapshot);
  const identity: CanonicalAgentIdentity = {
    agentId: identityRecord.agent_id,
    chainId: 5042002,
    identityRegistry: ARC_ERC8004_IDENTITY_REGISTRY,
    owner: onchainIdentity.owner,
    metadataUri: onchainIdentity.tokenURI,
    verifiedOnchain: true,
  };
  const buyer = privateKeyToAccount(buyerPrivateKey);
  const provider = privateKeyToAccount(providerPrivateKey);

  const blocked = await runBlockedPath({
    publicClient,
    snapshot,
    agentId: identity.agentId,
    buyer: buyer.address,
    provider: provider.address,
    endpoint: BLOCKED_X402_ENDPOINT,
  });

  assert.equal(blocked.dbJobDelta, 0, "DB Job Delta must be zero after blocked preflight");
  console.log("DB Job Delta = 0");
  assert.equal(blocked.dbPaymentDelta, 0, "DB Payment Delta must be zero after blocked preflight");
  console.log("DB Payment Delta = 0");
  assert.equal(blocked.x402SettlementDelta, 0, "x402 Settlement Delta must be zero after blocked preflight");
  console.log("x402 Settlement Delta = 0");
  assert.equal(blocked.jobCreatedDelta, 0, "ERC-8183 JobCreated Delta must be zero after blocked preflight");
  console.log("ERC-8183 JobCreated Delta = 0");
  assert.equal(blocked.clearanceConsumptionDelta, 0, "Clearance Consumption Delta must be zero after blocked preflight");
  console.log("Clearance Consumption Delta = 0");

  const executed = await runExecutedPath({
    publicClient,
    snapshot,
    identity,
    buyerPrivateKey,
    providerPrivateKey,
    trustAttesterPrivateKey,
    evaluatorAttesterPrivateKey,
    evaluatorRelayerPrivateKey,
  });

  console.log("\n=================== P5.4.3 LIVE ACCEPTANCE ===================");
  console.log(`Blocked Decision:                ${blocked.decision.decision}`);
  console.log(`Executed Decision:               ${executed.decision.decision}`);
  console.log(`ERC-8004 Agent ID:               #${identity.agentId}`);
  console.log(`ERC-8183 Job ID:                 ${executed.jobId}`);
  console.log(`JobCreated TX:                   ${executed.jobCreatedTx}`);
  console.log(`Evaluator Verdict / Score:       ${executed.evaluatorVerdict} / ${executed.evaluationScore}`);
  console.log(`Evaluation Public ID:            ${executed.evaluationPublicId}`);
  console.log(`Complete TX:                     ${executed.completeTx}`);
  console.log(`Actual Settled Value:            ${executed.actualSettledValueUsdc} USDC`);
  console.log(`New Snapshot ID:                 ${executed.snapshot.snapshotId}`);
  console.log(`Canonical Snapshot Hash:         ${executed.snapshot.canonicalHash}`);
  console.log(`New Arc Proof TX:                ${executed.arcProofTx}`);
  console.log("===============================================================\n");
  console.log("P5.4.3 LIVE ACCEPTANCE: PASS");
}

main().catch((error) => {
  console.error("P5.4.3 live acceptance failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
