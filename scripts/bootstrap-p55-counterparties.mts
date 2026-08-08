/**
 * Production acceptance bootstrap for three real Arc Testnet counterparties.
 * Every score is derived from verified identity plus actual settled ERC-8183
 * execution. No synthetic evidence or placeholder transaction is accepted.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import assert from "node:assert/strict";
import {
  createWalletClient,
  decodeEventLog,
  erc20Abi,
  http,
  keccak256,
  parseAbi,
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
  recoverAgentIdFromLogs,
} from "../lib/erc8004/client.ts";
import { ERC8183_AGENTIC_COMMERCE_ABI } from "../lib/erc8183/abi.ts";
import { fetchOnchainJob } from "../lib/erc8183/client.ts";
import { prepareDeliverableCommitment } from "../lib/erc8183/deliverable.ts";
import { executeOffchainJobEvaluation } from "../lib/erc8183/evaluator.ts";
import { persistTerminalErc8183Evaluation } from "../lib/erc8183/persist.ts";
import { getByoaClient } from "../lib/byoa/service.ts";
import {
  fetchReputationEvidenceForAgent,
  saveReputationEvidence,
  saveReputationSnapshot,
} from "../lib/reputation/db.ts";
import { computeAgentReputation, createReputationSnapshot } from "../lib/reputation/engine.ts";
import { deriveReputationScoreFromEvaluation, deriveSettledErc8183ValueUsdc } from "../lib/reputation/erc8183-adapter.ts";
import { ingestErc8004IdentityEvidence, ingestErc8183JobOutcomeEvidence } from "../lib/reputation/ingest.ts";
import { publishReputationSnapshotProofToArc } from "../lib/reputation/snapshot.ts";
import type { CanonicalAgentIdentity, ReputationEvidence } from "../lib/reputation/types.ts";

const RPC = process.env.ARC_TESTNET_RPC_URL || "https://rpc.testnet.arc.network";
const COMMERCE = (process.env.NEXT_PUBLIC_ARC_ERC8183_COMMERCE_ADDRESS || "0x0747EEf0706327138c69792bF28Cd525089e4583") as `0x${string}`;
const EVALUATOR = (process.env.NEXT_PUBLIC_VEYRA_ERC8183_EVALUATOR_ADDRESS || "0x0d2c04580e081e222bbe5bf9818af337e2633eb7") as `0x${string}`;
const USDC = "0x3600000000000000000000000000000000000000" as const;
const DELIVERABLE_URI = "https://raw.githubusercontent.com/mioku50/Agent-Commerce/main/public/canary-deliverable.json";
const AMOUNT_USDC = 0.001;

function key(name: string) {
  const value = process.env[name];
  assert.ok(value && /^0x[0-9a-f]{64}$/i.test(value), `${name} is missing or invalid`);
  return value as Hex;
}

const roles = [
  { role: "seller", keyName: "SELLER_PRIVATE_KEY", clientKeyName: "BUYER_PRIVATE_KEY", metadata: "veyra-counterparty-seller.json" },
  { role: "buyer-provider", keyName: "BUYER_PRIVATE_KEY", clientKeyName: "SELLER_PRIVATE_KEY", metadata: "veyra-counterparty-buyer.json" },
  { role: "evaluator-relayer", keyName: "ERC8183_EVALUATOR_RELAYER_PRIVATE_KEY", clientKeyName: "BUYER_PRIVATE_KEY", metadata: "veyra-counterparty-relayer.json" },
] as const;

async function ensureNativeGas(recipient: `0x${string}`) {
  const publicClient = getArcPublicClient(RPC);
  if ((await publicClient.getBalance({ address: recipient })) >= parseUnits("0.01", 18)) return;
  const funder = privateKeyToAccount(key("BUYER_PRIVATE_KEY"));
  const wallet = createWalletClient({ account: funder, chain: arcTestnet, transport: http(RPC) });
  const amount = parseUnits("0.015", 18);
  assert.ok((await publicClient.getBalance({ address: funder.address })) > amount, "Acceptance funder has insufficient Arc Testnet gas token");
  const tx = await wallet.sendTransaction({ account: funder, to: recipient, value: amount, chain: arcTestnet });
  assert.equal((await publicClient.waitForTransactionReceipt({ hash: tx })).status, "success");
}

async function registerIdentity(role: (typeof roles)[number]) {
  const base = (
    process.env.VEYRA_PRODUCTION_URL
    || process.env.VEYRA_BASE_URL
    || process.env.NEXT_PUBLIC_APP_URL
    || "https://agent-commerce-one.vercel.app"
  ).replace(/\/$/, "");
  const metadataUri = `${base}/.well-known/${role.metadata}`;
  const metadataResponse = await fetch(metadataUri, { signal: AbortSignal.timeout(20_000) });
  assert.equal(metadataResponse.ok, true, `Public metadata is unavailable for ${role.role}`);
  const account = privateKeyToAccount(key(role.keyName));
  await ensureNativeGas(account.address);
  const publicClient = getArcPublicClient(RPC);
  let mint = await recoverAgentIdFromLogs(account.address, ARC_ERC8004_IDENTITY_REGISTRY, publicClient);
  if (!mint) {
    const wallet = createWalletClient({ account, chain: arcTestnet, transport: http(RPC) });
    const tx = await wallet.writeContract({
      address: ARC_ERC8004_IDENTITY_REGISTRY,
      abi: parseAbi(["function register(string metadataURI) returns (uint256 tokenId)"]),
      functionName: "register",
      args: [metadataUri],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
    assert.equal(receipt.status, "success", `${role.role} identity registration reverted`);
    mint = await recoverAgentIdFromLogs(account.address, ARC_ERC8004_IDENTITY_REGISTRY, publicClient, { fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber });
    assert.ok(mint && mint.transactionHash === tx, `${role.role} Agent ID could not be recovered`);
  }
  assert.ok(mint);
  const onchain = await fetchAgentIdentityOnchain(BigInt(mint.agentId), ARC_ERC8004_IDENTITY_REGISTRY, publicClient);
  assert.equal(onchain.owner.toLowerCase(), account.address.toLowerCase());
  const registrationReceipt = await publicClient.getTransactionReceipt({ hash: mint.transactionHash });
  assert.equal(registrationReceipt.status, "success");
  const block = await publicClient.getBlock({ blockNumber: registrationReceipt.blockNumber });
  const stored = {
    agent_id: mint.agentId,
    registry_address: ARC_ERC8004_IDENTITY_REGISTRY,
    chain_id: 5_042_002,
    owner_address: account.address,
    metadata_uri: onchain.tokenURI,
    registration_tx: mint.transactionHash,
    created_at: new Date(Number(block.timestamp) * 1_000).toISOString(),
  };
  const persistence = await getByoaClient().from("erc8004_agent_identity").upsert(stored, { onConflict: "agent_id" });
  assert.equal(persistence.error, null, `${role.role} identity persistence failed`);
  return { role: role.role, identity: stored, privateKey: key(role.keyName), clientPrivateKey: key(role.clientKeyName) };
}

function jobIdFromReceipt(receipt: TransactionReceipt, client: string, provider: string) {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== COMMERCE.toLowerCase()) continue;
    try {
      const event = decodeEventLog({ abi: ERC8183_AGENTIC_COMMERCE_ABI, data: log.data, topics: log.topics });
      if (event.eventName === "JobCreated" && event.args.client.toLowerCase() === client.toLowerCase() && event.args.provider.toLowerCase() === provider.toLowerCase()) return event.args.jobId;
    } catch { /* unrelated event */ }
  }
  throw new Error("JobCreated event is missing");
}

async function realProviderExecution(input: Awaited<ReturnType<typeof registerIdentity>>) {
  const provider = privateKeyToAccount(input.privateKey);
  const client = privateKeyToAccount(input.clientPrivateKey);
  const relayer = privateKeyToAccount(key("ERC8183_EVALUATOR_RELAYER_PRIVATE_KEY"));
  await Promise.all([ensureNativeGas(provider.address), ensureNativeGas(client.address), ensureNativeGas(relayer.address)]);
  assert.notEqual(client.address.toLowerCase(), provider.address.toLowerCase(), "Self-dealing evidence is forbidden");
  const publicClient = getArcPublicClient(RPC);
  const clientWallet = createWalletClient({ account: client, chain: arcTestnet, transport: http(RPC) });
  const providerWallet = createWalletClient({ account: provider, chain: arcTestnet, transport: http(RPC) });
  const amount = parseUnits(AMOUNT_USDC.toFixed(6), 6);
  const balance = await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [client.address] });
  assert.ok(balance >= amount, `${input.role} client lacks ERC-20 USDC`);
  const createTx = await clientWallet.writeContract({ address: COMMERCE, abi: ERC8183_AGENTIC_COMMERCE_ABI, functionName: "createJob", args: [provider.address, EVALUATOR, BigInt(Math.floor(Date.now() / 1_000) + 86_400), `P5.5 real counterparty acceptance: ${input.role}`, zeroAddress] });
  const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createTx });
  assert.equal(createReceipt.status, "success");
  const jobId = jobIdFromReceipt(createReceipt, client.address, provider.address);
  const budgetTx = await providerWallet.writeContract({ address: COMMERCE, abi: ERC8183_AGENTIC_COMMERCE_ABI, functionName: "setBudget", args: [jobId, amount, "0x"] });
  assert.equal((await publicClient.waitForTransactionReceipt({ hash: budgetTx })).status, "success");
  const allowance = await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "allowance", args: [client.address, COMMERCE] });
  if (allowance < amount) {
    const approve = await clientWallet.writeContract({ address: USDC, abi: erc20Abi, functionName: "approve", args: [COMMERCE, amount] });
    assert.equal((await publicClient.waitForTransactionReceipt({ hash: approve })).status, "success");
  }
  const fund = await clientWallet.writeContract({ address: COMMERCE, abi: ERC8183_AGENTIC_COMMERCE_ABI, functionName: "fund", args: [jobId, "0x"] });
  assert.equal((await publicClient.waitForTransactionReceipt({ hash: fund })).status, "success");
  const artifactResponse = await fetch(DELIVERABLE_URI, { signal: AbortSignal.timeout(20_000) });
  assert.equal(artifactResponse.ok, true);
  const artifact = await artifactResponse.text();
  const commitment = prepareDeliverableCommitment({ contentUri: DELIVERABLE_URI, contentHash: keccak256(stringToBytes(artifact)), contentType: "application/json", schemaId: "veyra://schemas/structured-deliverable-v1", policyId: "structured-deliverable-v1" });
  const submit = await providerWallet.writeContract({ address: COMMERCE, abi: ERC8183_AGENTIC_COMMERCE_ABI, functionName: "submit", args: [jobId, commitment.deliverableHash, "0x"] });
  assert.equal((await publicClient.waitForTransactionReceipt({ hash: submit })).status, "success");
  const result = await executeOffchainJobEvaluation({ chainId: 5_042_002, agenticCommerce: COMMERCE, jobId: jobId.toString(), deliverable: commitment.deliverable, evaluatorContract: EVALUATOR, attesterPrivateKey: key("ERC8183_EVALUATOR_ATTESTER_PRIVATE_KEY"), relayerPrivateKey: key("ERC8183_EVALUATOR_RELAYER_PRIVATE_KEY"), rpcUrl: RPC });
  assert.equal(result.status, "completed");
  assert.ok(result.settlementTxHash);
  const settlementReceipt = await publicClient.getTransactionReceipt({ hash: result.settlementTxHash });
  const job = await fetchOnchainJob(COMMERCE, jobId, publicClient);
  const settledValueUsdc = deriveSettledErc8183ValueUsdc({ job, receipt: settlementReceipt, commerceAddress: COMMERCE });
  assert.equal(parseUnits(settledValueUsdc.toFixed(6), 6), amount);
  const evaluation = await persistTerminalErc8183Evaluation({ chainId: 5_042_002, agenticCommerce: COMMERCE, evaluatorContract: EVALUATOR, job, deliverable: commitment.deliverable, deliverableHash: commitment.deliverableHash, result, settlementReceipt });
  await ingestErc8183JobOutcomeEvidence({ agentId: input.identity.agent_id, jobId: jobId.toString(), deliverableHash: commitment.deliverableHash, verdictPassed: true, score: deriveReputationScoreFromEvaluation(result), economicValueUsdc: settledValueUsdc, clientAddress: client.address, arcProofTx: result.settlementTxHash, observedAt: evaluation.settled_at || undefined });
  return { jobId: jobId.toString(), createTx, settlementTx: result.settlementTxHash, client: client.address, provider: provider.address, settledValueUsdc };
}

async function addRealSellerHealthEvidence(agentId: string, sellerWallet: string) {
  const service = await getByoaClient().from("store_services").select("id,public_id").ilike("seller_wallet", sellerWallet).eq("status", "active").limit(1).maybeSingle();
  if (service.error || !service.data) return null;
  const health = await getByoaClient().from("seller_service_health_checks").select("id,status,latency_ms,checked_at").eq("service_id", service.data.id).order("checked_at", { ascending: false }).limit(1).maybeSingle();
  if (health.error || !health.data) return null;
  const canonicalHash = keccak256(stringToBytes(JSON.stringify({ source: "seller_service_health_check", id: health.data.id, serviceId: service.data.public_id, status: health.data.status, latencyMs: health.data.latency_ms, checkedAt: health.data.checked_at })));
  const evidence: ReputationEvidence = {
    evidenceId: `ev_health_${canonicalHash.slice(2, 18)}`,
    agentId,
    type: "api_quality",
    tier: 2,
    sourceId: `seller_health:${health.data.id}`,
    score: health.data.status === "healthy" ? 100 : 0,
    positive: health.data.status === "healthy",
    confidence: 0.9,
    verifiedOnchain: false,
    arcProofVerified: false,
    sybilRisk: "none",
    observedAt: health.data.checked_at,
    canonicalHash,
  };
  await saveReputationEvidence(evidence);
  return { serviceId: service.data.public_id, healthCheckId: health.data.id, status: health.data.status };
}

async function snapshotWithProof(input: Awaited<ReturnType<typeof registerIdentity>>, economic: Awaited<ReturnType<typeof realProviderExecution>>) {
  const identity: CanonicalAgentIdentity = { agentId: input.identity.agent_id, chainId: 5_042_002, identityRegistry: input.identity.registry_address, owner: input.identity.owner_address, metadataUri: input.identity.metadata_uri, verifiedOnchain: true };
  await ingestErc8004IdentityEvidence(identity, input.identity.registration_tx);
  const sellerHealth = input.role === "seller" ? await addRealSellerHealthEvidence(identity.agentId, identity.owner) : null;
  const evidence = await fetchReputationEvidenceForAgent(identity.agentId);
  const explanation = computeAgentReputation(identity, evidence);
  const snapshot = createReputationSnapshot(identity, evidence, explanation);
  await saveReputationSnapshot(snapshot);
  const proof = await publishReputationSnapshotProofToArc(snapshot, identity.owner, undefined, economic.settledValueUsdc, { buyer: economic.client, seller: economic.provider, source: "erc8183_job", sourceId: economic.jobId });
  assert.equal(proof.verifiedOnchain, true);
  assert.ok(proof.transactionHash && /^0x[0-9a-f]{64}$/i.test(proof.transactionHash));
  return { snapshot, proofTx: proof.transactionHash, sellerHealth };
}

async function main() {
  assert.notEqual(process.env.REPUTATION_ALLOW_MEMORY_STORE, "true");
  const results = [];
  for (const role of roles) {
    const registered = await registerIdentity(role);
    const economic = await realProviderExecution(registered);
    const reputation = await snapshotWithProof(registered, economic);
    results.push({ role: registered.role, agentId: registered.identity.agent_id, wallet: registered.identity.owner_address, registrationTx: registered.identity.registration_tx, jobId: economic.jobId, settlementTx: economic.settlementTx, settledValueUsdc: economic.settledValueUsdc, snapshotId: reputation.snapshot.snapshotId, trustScore: reputation.snapshot.trustScore, confidence: reputation.snapshot.confidence, coverage: reputation.snapshot.coverage, canonicalHash: reputation.snapshot.canonicalHash, proofTx: reputation.proofTx, sellerHealth: reputation.sellerHealth });
  }
  console.log("P55_REAL_COUNTERPARTIES", JSON.stringify({ candidates: results }));
}

main().catch((error) => { console.error("P5.5 counterparty bootstrap failed:", error instanceof Error ? error.message : String(error)); process.exit(1); });
