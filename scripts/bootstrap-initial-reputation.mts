/**
 * Creates the first canonical Veyra reputation snapshot exclusively from
 * verified Arc identity and real ERC-8183 economic evidence.
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
import { getArcPublicClient, getCanonicalVeyraAgentIdentity } from "../lib/erc8004/client.ts";
import { ERC8183_AGENTIC_COMMERCE_ABI } from "../lib/erc8183/abi.ts";
import { fetchOnchainJob } from "../lib/erc8183/client.ts";
import { prepareDeliverableCommitment } from "../lib/erc8183/deliverable.ts";
import { executeOffchainJobEvaluation } from "../lib/erc8183/evaluator.ts";
import { persistTerminalErc8183Evaluation } from "../lib/erc8183/persist.ts";
import type { Erc8183EvaluationRecord } from "../lib/erc8183/types.ts";
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
import { ingestErc8004IdentityEvidence, ingestErc8183JobOutcomeEvidence } from "../lib/reputation/ingest.ts";
import { publishReputationSnapshotProofToArc } from "../lib/reputation/snapshot.ts";
import type { CanonicalAgentIdentity } from "../lib/reputation/types.ts";

const RPC_URL = process.env.ARC_TESTNET_RPC_URL || "https://rpc.testnet.arc.network";
const COMMERCE = "0x0747EEf0706327138c69792bF28Cd525089e4583" as const;
const USDC = "0x3600000000000000000000000000000000000000" as const;
const EVALUATOR = (
  process.env.NEXT_PUBLIC_VEYRA_ERC8183_EVALUATOR_ADDRESS ||
  "0x0d2c04580e081e222bbe5bf9818af337e2633eb7"
) as `0x${string}`;
const PROOF_REGISTRY = (
  process.env.AGENT_COMMERCE_PROOF_REGISTRY_ADDRESS ||
  "0x0db0b8ddc03c3c56c0662b547822e4654167b684"
) as `0x${string}`;
const DELIVERABLE_URI =
  "https://raw.githubusercontent.com/mioku50/Agent-Commerce/main/public/canary-deliverable.json";

function requirePrivateKey(value: string | undefined, label: string): Hex {
  assert.ok(value && /^0x[0-9a-f]{64}$/i.test(value), `${label} is missing or invalid`);
  return value as Hex;
}

async function extractJobId(
  receipt: TransactionReceipt,
  buyer: `0x${string}`,
  provider: `0x${string}`,
) {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== COMMERCE.toLowerCase()) continue;
    try {
      const event = decodeEventLog({ abi: ERC8183_AGENTIC_COMMERCE_ABI, data: log.data, topics: log.topics });
      if (
        event.eventName === "JobCreated" &&
        event.args.client.toLowerCase() === buyer.toLowerCase() &&
        event.args.provider.toLowerCase() === provider.toLowerCase() &&
        event.args.evaluator.toLowerCase() === EVALUATOR.toLowerCase()
      ) return event.args.jobId;
    } catch {
      // Ignore unrelated logs.
    }
  }
  throw new Error("Canonical JobCreated event was not found");
}

async function ensureGas(
  publicClient: ReturnType<typeof getArcPublicClient>,
  buyerWallet: ReturnType<typeof createWalletClient>,
  buyer: `0x${string}`,
  recipient: `0x${string}`,
) {
  if (recipient.toLowerCase() === buyer.toLowerCase()) return;
  const balance = await publicClient.getBalance({ address: recipient });
  if (balance >= parseUnits("0.002", 18)) return;
  const topUp = parseUnits("0.005", 18);
  assert.ok((await publicClient.getBalance({ address: buyer })) > topUp, "Buyer lacks Arc Testnet gas for bounded top-up");
  assert.ok(buyerWallet.account, "Buyer wallet client has no local signing account");
  const tx = await buyerWallet.sendTransaction({
    account: buyerWallet.account,
    to: recipient,
    value: topUp,
    chain: arcTestnet,
  });
  assert.equal((await publicClient.waitForTransactionReceipt({ hash: tx })).status, "success");
}

async function createRealEvaluation() {
  const buyerKey = requirePrivateKey(process.env.BUYER_PRIVATE_KEY, "BUYER_PRIVATE_KEY");
  const providerKey = requirePrivateKey(process.env.SELLER_PRIVATE_KEY, "SELLER_PRIVATE_KEY");
  const attesterKey = requirePrivateKey(
    process.env.ERC8183_EVALUATOR_ATTESTER_PRIVATE_KEY,
    "ERC8183_EVALUATOR_ATTESTER_PRIVATE_KEY",
  );
  const relayerKey = requirePrivateKey(
    process.env.ERC8183_EVALUATOR_RELAYER_PRIVATE_KEY,
    "ERC8183_EVALUATOR_RELAYER_PRIVATE_KEY",
  );
  const buyer = privateKeyToAccount(buyerKey);
  const provider = privateKeyToAccount(providerKey);
  const relayer = privateKeyToAccount(relayerKey);
  const publicClient = getArcPublicClient(RPC_URL);
  const buyerWallet = createWalletClient({ account: buyer, chain: arcTestnet, transport: http(RPC_URL) });
  const providerWallet = createWalletClient({ account: provider, chain: arcTestnet, transport: http(RPC_URL) });
  await ensureGas(publicClient, buyerWallet, buyer.address, provider.address);
  await ensureGas(publicClient, buyerWallet, buyer.address, relayer.address);

  const amountUsdc = Number(process.env.REPUTATION_BOOTSTRAP_USDC || "0.01");
  assert.ok(Number.isFinite(amountUsdc) && amountUsdc > 0 && amountUsdc <= 0.05, "Bootstrap amount must be in (0, 0.05] USDC");
  const amountAtomic = parseUnits(amountUsdc.toFixed(6), 6);
  assert.ok(
    (await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [buyer.address] })) >= amountAtomic,
    "Buyer lacks ERC-20 USDC for reputation bootstrap",
  );

  const createTx = await buyerWallet.writeContract({
    address: COMMERCE,
    abi: ERC8183_AGENTIC_COMMERCE_ABI,
    functionName: "createJob",
    args: [provider.address, EVALUATOR, BigInt(Math.floor(Date.now() / 1_000) + 86_400), "Veyra canonical reputation bootstrap", zeroAddress],
  });
  const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createTx });
  assert.equal(createReceipt.status, "success", "ERC-8183 createJob reverted");
  const jobId = await extractJobId(createReceipt, buyer.address, provider.address);

  const budgetTx = await providerWallet.writeContract({
    address: COMMERCE,
    abi: ERC8183_AGENTIC_COMMERCE_ABI,
    functionName: "setBudget",
    args: [jobId, amountAtomic, "0x"],
  });
  assert.equal((await publicClient.waitForTransactionReceipt({ hash: budgetTx })).status, "success");
  const allowance = await publicClient.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "allowance",
    args: [buyer.address, COMMERCE],
  });
  if (allowance < amountAtomic) {
    const approveTx = await buyerWallet.writeContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "approve",
      args: [COMMERCE, amountAtomic],
    });
    assert.equal((await publicClient.waitForTransactionReceipt({ hash: approveTx })).status, "success");
  }
  const fundTx = await buyerWallet.writeContract({
    address: COMMERCE,
    abi: ERC8183_AGENTIC_COMMERCE_ABI,
    functionName: "fund",
    args: [jobId, "0x"],
  });
  assert.equal((await publicClient.waitForTransactionReceipt({ hash: fundTx })).status, "success");

  const artifactResponse = await fetch(DELIVERABLE_URI, { signal: AbortSignal.timeout(20_000) });
  assert.equal(artifactResponse.ok, true, "Canonical bootstrap deliverable is unavailable");
  const artifact = await artifactResponse.text();
  const commitment = prepareDeliverableCommitment({
    contentUri: DELIVERABLE_URI,
    contentHash: keccak256(stringToBytes(artifact)),
    contentType: "application/json",
    schemaId: "veyra://schemas/structured-deliverable-v1",
    policyId: "structured-deliverable-v1",
  });
  const submitTx = await providerWallet.writeContract({
    address: COMMERCE,
    abi: ERC8183_AGENTIC_COMMERCE_ABI,
    functionName: "submit",
    args: [jobId, commitment.deliverableHash, "0x"],
  });
  assert.equal((await publicClient.waitForTransactionReceipt({ hash: submitTx })).status, "success");

  const result = await executeOffchainJobEvaluation({
    chainId: 5042002,
    agenticCommerce: COMMERCE,
    jobId: jobId.toString(),
    deliverable: commitment.deliverable,
    evaluatorContract: EVALUATOR,
    attesterPrivateKey: attesterKey,
    relayerPrivateKey: relayerKey,
    rpcUrl: RPC_URL,
  });
  assert.equal(deriveReputationScoreFromEvaluation(result), 100, "Bootstrap evaluation did not complete");
  assert.ok(result.settlementTxHash, "Bootstrap settlement transaction is missing");
  const settlementReceipt = await publicClient.getTransactionReceipt({ hash: result.settlementTxHash });
  const completedJob = await fetchOnchainJob(COMMERCE, jobId, publicClient);
  const settledValueUsdc = deriveSettledErc8183ValueUsdc({
    job: completedJob,
    receipt: settlementReceipt,
    commerceAddress: COMMERCE,
  });
  assert.equal(parseUnits(settledValueUsdc.toFixed(6), 6), amountAtomic, "Actual settlement differs from bootstrap budget");
  const evaluation = await persistTerminalErc8183Evaluation({
    chainId: 5042002,
    agenticCommerce: COMMERCE,
    evaluatorContract: EVALUATOR,
    job: completedJob,
    deliverable: commitment.deliverable,
    deliverableHash: commitment.deliverableHash,
    result,
    settlementReceipt,
  });
  return { evaluation, job: completedJob, settledValueUsdc, createTx, settlementTx: result.settlementTxHash };
}

async function findExistingRealEvaluation() {
  const { data, error } = await getByoaClient()
    .from("erc8183_evaluations")
    .select("*")
    .eq("chain_id", 5042002)
    .ilike("agentic_commerce", COMMERCE)
    .ilike("evaluator_contract", EVALUATOR)
    .eq("status", "completed")
    .eq("decision", "complete")
    .not("settlement_tx_hash", "is", null)
    .order("settled_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  assert.equal(error, null, "Existing ERC-8183 evaluation lookup failed");
  if (!data) return null;
  const evaluation = data as Erc8183EvaluationRecord;
  const publicClient = getArcPublicClient(RPC_URL);
  const settlementTx = evaluation.settlement_tx_hash as Hex;
  assert.ok(/^0x[0-9a-f]{64}$/i.test(settlementTx));
  const receipt = await publicClient.getTransactionReceipt({ hash: settlementTx });
  assert.equal(receipt.status, "success");
  const job = await fetchOnchainJob(COMMERCE, BigInt(evaluation.job_id), publicClient);
  assert.equal(job.status, "Completed");
  assert.equal(job.client.toLowerCase(), evaluation.client_wallet.toLowerCase());
  assert.equal(job.provider.toLowerCase(), evaluation.provider_wallet.toLowerCase());
  assert.equal(job.deliverableHash?.toLowerCase(), evaluation.deliverable_hash.toLowerCase());
  const settledValueUsdc = deriveSettledErc8183ValueUsdc({ job, receipt, commerceAddress: COMMERCE });
  assert.ok(settledValueUsdc > 0);
  return { evaluation, job, settledValueUsdc, createTx: null, settlementTx };
}

async function verifyProof(snapshot: { canonicalHash: string; arcProofTx?: string }) {
  assert.ok(/^0x[0-9a-f]{64}$/i.test(snapshot.canonicalHash), "Snapshot canonical hash is invalid");
  assert.ok(snapshot.arcProofTx && /^0x[0-9a-f]{64}$/i.test(snapshot.arcProofTx), "Snapshot Arc proof transaction is invalid");
  const publicClient = getArcPublicClient(RPC_URL);
  assert.equal((await publicClient.getTransactionReceipt({ hash: snapshot.arcProofTx as Hex })).status, "success");
  assert.equal(await publicClient.readContract({ address: PROOF_REGISTRY, abi: proofRegistryAbi, functionName: "isRegistered", args: [snapshot.canonicalHash as Hex] }), true);
  const proof = await publicClient.readContract({ address: PROOF_REGISTRY, abi: proofRegistryAbi, functionName: "getProof", args: [snapshot.canonicalHash as Hex] });
  assert.equal(proof.responseHash.toLowerCase(), snapshot.canonicalHash.toLowerCase());
}

async function main() {
  assert.notEqual(process.env.REPUTATION_ALLOW_MEMORY_STORE, "true", "Bootstrap cannot use memory storage");
  const identityRecord = await getCanonicalVeyraAgentIdentity(getArcPublicClient(RPC_URL));
  assert.ok(identityRecord, "Canonical Veyra identity is required before reputation bootstrap");
  const identity: CanonicalAgentIdentity = {
    agentId: identityRecord.agent_id,
    chainId: 5042002,
    identityRegistry: identityRecord.registry_address,
    owner: identityRecord.owner_address,
    metadataUri: identityRecord.metadata_uri,
    verifiedOnchain: true,
  };

  const previous = await fetchLatestReputationSnapshot(identity.agentId);
  if (previous?.arcProofTx && previous.economicEvidenceCount > 0) {
    await verifyProof(previous);
    console.log("REPUTATION_BOOTSTRAP", JSON.stringify({
      reused: true,
      snapshotId: previous.snapshotId,
      canonicalHash: previous.canonicalHash,
      arcProofTx: previous.arcProofTx,
    }));
    return;
  }

  const economic = (await findExistingRealEvaluation()) || (await createRealEvaluation());
  await ingestErc8004IdentityEvidence(identity, identityRecord.registration_tx);
  const score = deriveReputationScoreFromEvaluation({
    status: economic.evaluation.status,
    decision: economic.evaluation.decision,
  });
  await ingestErc8183JobOutcomeEvidence({
    agentId: identity.agentId,
    jobId: economic.evaluation.job_id,
    deliverableHash: economic.evaluation.deliverable_hash,
    verdictPassed: true,
    score,
    economicValueUsdc: economic.settledValueUsdc,
    clientAddress: economic.job.client,
    arcProofTx: economic.settlementTx,
    observedAt: economic.evaluation.settled_at || undefined,
  });
  const evidence = await fetchReputationEvidenceForAgent(identity.agentId);
  const explanation = computeAgentReputation(identity, evidence);
  const snapshot = createReputationSnapshot(identity, evidence, explanation);
  assert.ok(snapshot.canonicalHash !== `0x${"0".repeat(64)}`);
  assert.ok(snapshot.economicEvidenceCount > 0);
  await saveReputationSnapshot(snapshot);
  const proof = await publishReputationSnapshotProofToArc(
    snapshot,
    identity.owner,
    undefined,
    economic.settledValueUsdc,
    {
      buyer: economic.job.client,
      seller: economic.job.provider,
      source: "erc8183_job",
      sourceId: economic.job.jobId.toString(),
    },
  );
  assert.equal(proof.verifiedOnchain, true);
  assert.ok(proof.transactionHash && /^0x[0-9a-f]{64}$/i.test(proof.transactionHash));
  const persisted = await fetchLatestReputationSnapshot(identity.agentId);
  assert.ok(persisted);
  assert.equal(persisted.canonicalHash, snapshot.canonicalHash);
  assert.equal(persisted.arcProofTx, proof.transactionHash);
  await verifyProof(persisted);

  console.log("REPUTATION_BOOTSTRAP", JSON.stringify({
    reused: false,
    jobId: economic.job.jobId.toString(),
    jobCreateTx: economic.createTx,
    settlementTx: economic.settlementTx,
    settledValueUsdc: economic.settledValueUsdc,
    evaluationPublicId: economic.evaluation.public_id,
    snapshotId: persisted.snapshotId,
    canonicalHash: persisted.canonicalHash,
    arcProofTx: persisted.arcProofTx,
  }));
}

main().catch((error) => {
  console.error("Reputation bootstrap failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
