/** Real Production P5.5 acceptance. Never prints credentials or private keys. */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import assert from "node:assert/strict";
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { proofRegistryAbi } from "../lib/commerce/onchain-proof.ts";
import { getCanonicalAgentIdentity } from "../lib/erc8004/client.ts";
import { getByoaClient } from "../lib/byoa/service.ts";
import { fetchLatestReputationSnapshot, fetchReputationEvidenceForAgent } from "../lib/reputation/db.ts";

const BASE_URL = (process.env.VEYRA_PRODUCTION_URL || process.env.NEXT_PUBLIC_APP_URL || "https://agent-commerce-one.vercel.app").replace(/\/$/, "");
const RPC = process.env.ARC_TESTNET_RPC_URL || "https://rpc.testnet.arc.network";
const GATE = process.env.VEYRA_TRUST_GATE_ADDRESS as Address;
const PROOF_REGISTRY = process.env.AGENT_COMMERCE_PROOF_REGISTRY_ADDRESS as Address;

const clearanceAbi = [
  {
    type: "function", name: "verifyClearance", stateMutability: "view",
    inputs: [{ name: "clearance", type: "tuple", components: [
      { name: "decisionId", type: "bytes32" }, { name: "subject", type: "address" },
      { name: "executor", type: "address" }, { name: "counterparty", type: "address" },
      { name: "actionHash", type: "bytes32" }, { name: "requestedAmount", type: "uint256" },
      { name: "maxAmount", type: "uint256" }, { name: "snapshotHash", type: "bytes32" },
      { name: "policyVersion", type: "bytes32" }, { name: "evaluator", type: "address" },
      { name: "issuedAt", type: "uint64" }, { name: "expiresAt", type: "uint64" },
    ] }, { name: "signature", type: "bytes" }],
    outputs: [{ name: "valid", type: "bool" }, { name: "signer", type: "address" }],
  },
  {
    type: "function", name: "consumeClearance", stateMutability: "nonpayable",
    inputs: [{ name: "clearance", type: "tuple", components: [
      { name: "decisionId", type: "bytes32" }, { name: "subject", type: "address" },
      { name: "executor", type: "address" }, { name: "counterparty", type: "address" },
      { name: "actionHash", type: "bytes32" }, { name: "requestedAmount", type: "uint256" },
      { name: "maxAmount", type: "uint256" }, { name: "snapshotHash", type: "bytes32" },
      { name: "policyVersion", type: "bytes32" }, { name: "evaluator", type: "address" },
      { name: "issuedAt", type: "uint64" }, { name: "expiresAt", type: "uint64" },
    ] }, { name: "signature", type: "bytes" }], outputs: [],
  },
] as const;

function requiredKey(name: string) {
  const value = process.env[name];
  assert.ok(value && /^0x[0-9a-f]{64}$/i.test(value), `${name} is missing or invalid`);
  return value as Hex;
}

async function session(privateKey: Hex) {
  const account = privateKeyToAccount(privateKey);
  const challengeResponse = await fetch(`${BASE_URL}/api/byoa/management/challenges`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: BASE_URL },
    body: JSON.stringify({ wallet: account.address }),
  });
  assert.equal(challengeResponse.status, 201, "Owner challenge failed");
  const challenge = (await challengeResponse.json()).challenge as { id: string; message: string };
  const signature = await account.signMessage({ message: challenge.message });
  const response = await fetch(`${BASE_URL}/api/byoa/management/session`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: BASE_URL },
    body: JSON.stringify({ challengeId: challenge.id, message: challenge.message, signature }),
  });
  assert.equal(response.status, 200, "Owner session verification failed");
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie?.startsWith("byoa_owner_session="), "Owner session cookie is missing");
  return { account, cookie };
}

async function api(path: string, cookie: string, init: RequestInit = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { Cookie: cookie, Origin: BASE_URL, ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function economicCounts() {
  const client = getByoaClient();
  const [payments, jobs] = await Promise.all([
    client.from("payment_events").select("id", { head: true, count: "exact" }),
    client.from("hosted_agent_jobs").select("id", { head: true, count: "exact" }),
  ]);
  assert.equal(payments.error, null); assert.equal(jobs.error, null);
  return { payments: payments.count || 0, jobs: jobs.count || 0 };
}

function clearanceMessage(value: Record<string, string>) {
  return {
    decisionId: value.decisionId as Hex, subject: getAddress(value.subject), executor: getAddress(value.executor),
    counterparty: getAddress(value.counterparty), actionHash: value.actionHash as Hex,
    requestedAmount: BigInt(value.requestedAmount), maxAmount: BigInt(value.maxAmount),
    snapshotHash: value.snapshotHash as Hex, policyVersion: value.policyVersion as Hex,
    evaluator: getAddress(value.evaluator), issuedAt: BigInt(value.issuedAt), expiresAt: BigInt(value.expiresAt),
  };
}

async function main() {
  assert.ok(/^https:\/\//.test(BASE_URL), "Production URL must be HTTPS");
  assert.ok(GATE && PROOF_REGISTRY, "Arc contract configuration is required");
  const publicClient = createPublicClient({ chain: arcTestnet, transport: http(RPC) });
  assert.equal(await publicClient.getChainId(), 5_042_002);

  const identities = await getByoaClient().from("erc8004_agent_identity")
    .select("agent_id,owner_address,metadata_uri")
    .like("metadata_uri", "%/.well-known/veyra-counterparty-%.json")
    .order("agent_id", { ascending: true });
  assert.equal(identities.error, null);
  assert.ok((identities.data || []).length >= 3, "At least three bootstrapped real counterparties are required");
  const candidates = (identities.data || []).slice(0, 3).map((row) => ({ agentId: String(row.agent_id), wallet: getAddress(row.owner_address), metadataUri: row.metadata_uri }));

  const evidenceSummary = [];
  for (const candidate of candidates) {
    const identity = await getCanonicalAgentIdentity(candidate.agentId);
    assert.ok(identity && identity.owner_address.toLowerCase() === candidate.wallet.toLowerCase() && identity.metadata_uri === candidate.metadataUri, `Agent ${candidate.agentId} identity mismatch`);
    const snapshot = await fetchLatestReputationSnapshot(candidate.agentId);
    const evidence = await fetchReputationEvidenceForAgent(candidate.agentId);
    assert.ok(snapshot?.arcProofTx && Date.now() - Date.parse(snapshot.createdAt) < 3_600_000, `Agent ${candidate.agentId} needs a fresh proven snapshot`);
    const execution = evidence.filter((item) => item.type === "erc8183_job_completed" && item.positive && item.verifiedOnchain && item.arcProofVerified && (item.economicValueUsdc || 0) > 0);
    assert.ok(execution.length > 0, `Agent ${candidate.agentId} has no real settled execution evidence`);
    assert.ok(execution.every((item) => item.counterpartyAddress?.toLowerCase() !== candidate.wallet.toLowerCase()), "Self-dealing evidence is forbidden");
    assert.equal(await publicClient.readContract({ address: PROOF_REGISTRY, abi: proofRegistryAbi, functionName: "isRegistered", args: [snapshot.canonicalHash as Hex] }), true);
    const proof = await publicClient.readContract({ address: PROOF_REGISTRY, abi: proofRegistryAbi, functionName: "getProof", args: [snapshot.canonicalHash as Hex] });
    assert.equal(proof[5].toLowerCase(), snapshot.canonicalHash.toLowerCase());
    evidenceSummary.push({ agentId: candidate.agentId, wallet: candidate.wallet, evidenceCount: evidence.length, executionEvidenceCount: execution.length, snapshotId: snapshot.snapshotId, snapshotHash: snapshot.canonicalHash, snapshotProofTx: snapshot.arcProofTx, trustScore: snapshot.trustScore, confidence: snapshot.confidence, coverage: snapshot.coverage });
  }

  const requester = await session(requiredKey("ERC8183_EVALUATOR_ATTESTER_PRIVATE_KEY"));
  assert.ok(candidates.every((item) => item.wallet.toLowerCase() !== requester.account.address.toLowerCase()), "Requester must be independent from candidates");
  const before = await economicCounts();
  const selectionInput = { capability: "erc8183_delivery", task: "Select a proven Arc Testnet provider before any job or payment", budgetUsdc: 1, candidates: candidates.map((item) => ({ agentId: item.agentId })), network: "eip155:5042002", visibility: "public" };
  const idempotencyKey = `p55-live-${Date.now()}`;
  const created = await api("/api/trust/v1/counterparties/select", requester.cookie, { method: "POST", headers: { "Idempotency-Key": idempotencyKey }, body: JSON.stringify(selectionInput) });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  const selection = created.body.selection;
  assert.equal(created.body.paymentCreated, false); assert.equal(created.body.jobCreated, false); assert.equal(created.body.proofPublished, false);
  assert.ok(/^vcs_[0-9a-f]{16}$/.test(selection.selectionId));
  assert.ok(/^0x[0-9a-f]{64}$/i.test(selection.canonicalHash));
  assert.equal(selection.candidates.length, 3);
  assert.ok(candidates.some((item) => item.agentId === selection.recommendedAgentId));

  const replay = await api("/api/trust/v1/counterparties/select", requester.cookie, { method: "POST", headers: { "Idempotency-Key": idempotencyKey }, body: JSON.stringify(selectionInput) });
  assert.equal(replay.response.status, 200); assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.selection.selectionId, selection.selectionId); assert.equal(replay.body.selection.canonicalHash, selection.canonicalHash);
  const conflict = await api("/api/trust/v1/counterparties/select", requester.cookie, { method: "POST", headers: { "Idempotency-Key": idempotencyKey }, body: JSON.stringify({ ...selectionInput, task: "Changed payload" }) });
  assert.equal(conflict.response.status, 409); assert.equal(conflict.body.error.code, "idempotency_conflict");

  const deterministic = await api("/api/trust/v1/counterparties/select", requester.cookie, { method: "POST", headers: { "Idempotency-Key": `${idempotencyKey}-deterministic` }, body: JSON.stringify({ ...selectionInput, candidates: [...selectionInput.candidates].reverse(), visibility: "private" }) });
  assert.equal(deterministic.response.status, 201);
  assert.equal(deterministic.body.selection.recommendedAgentId, selection.recommendedAgentId);
  assert.deepEqual(deterministic.body.selection.candidates.map((item: any) => [item.identity?.agentId, item.rank, item.eligibility, item.trustScore, item.rankingScore, item.confidence]), selection.candidates.map((item: any) => [item.identity?.agentId, item.rank, item.eligibility, item.trustScore, item.rankingScore, item.confidence]));

  const foreign = await session(requiredKey("SELLER_PRIVATE_KEY"));
  const foreignRead = await api(`/api/trust/v1/selections/${selection.selectionId}`, foreign.cookie);
  assert.equal(foreignRead.response.status, 404, "Cross-tenant selection read must be a safe 404");

  const sellerService = await getByoaClient().from("store_services").select("public_id,seller_wallet,price_usdc").eq("status", "active").eq("review_status", "approved").limit(1).single();
  assert.equal(sellerService.error, null);
  const sellerCandidate = candidates.find((item) => item.wallet.toLowerCase() === sellerService.data.seller_wallet.toLowerCase());
  assert.ok(sellerCandidate, "Active seller must resolve to a bootstrapped Agent ID");
  const constrainedBudget = Number(sellerService.data.price_usdc) / 2;
  const negativeInput = { ...selectionInput, capability: "project_update_intelligence", budgetUsdc: constrainedBudget, candidates: [{ agentId: sellerCandidate.agentId, serviceId: sellerService.data.public_id }, ...candidates.filter((item) => item.agentId !== sellerCandidate.agentId).map((item) => ({ agentId: item.agentId }))], visibility: "private" };
  const negative = await api("/api/trust/v1/counterparties/select", requester.cookie, { method: "POST", headers: { "Idempotency-Key": `${idempotencyKey}-negative` }, body: JSON.stringify(negativeInput) });
  assert.equal(negative.response.status, 201, JSON.stringify(negative.body));
  const excluded = negative.body.selection.candidates.find((item: any) => item.identity?.agentId === sellerCandidate.agentId);
  assert.equal(excluded.eligibility, "INELIGIBLE"); assert.equal(excluded.rejectionReason, "budget_exceeded");
  assert.notEqual(negative.body.selection.recommendedAgentId, sellerCandidate.agentId, "Budget-excluded candidate became winner");
  const winnerRow = negative.body.selection.candidates.find((item: any) => item.identity?.agentId === negative.body.selection.recommendedAgentId);
  assert.ok(excluded.rankingScore >= winnerRow.rankingScore, "Live negative candidate must have equal or higher raw ranking score");

  const proofResponse = await api(`/api/trust/v1/selections/${selection.selectionId}/proof`, requester.cookie, { method: "POST" });
  assert.equal(proofResponse.response.status, 200, JSON.stringify(proofResponse.body));
  const selectionProof = await publicClient.readContract({ address: PROOF_REGISTRY, abi: proofRegistryAbi, functionName: "getProof", args: [selection.canonicalHash] });
  assert.ok(selectionProof[3] > BigInt(0)); assert.equal(selectionProof[5].toLowerCase(), selection.canonicalHash.toLowerCase());
  assert.equal(proofResponse.body.chargedUsdc, 0); assert.equal(proofResponse.body.jobCreated, false); assert.equal(proofResponse.body.evidenceReused, true);
  assert.equal(selectionProof[3], parseUnits(proofResponse.body.proof.evidenceAmountUsdc.toFixed(6), 6));

  const clearanceResponse = await api(`/api/trust/v1/selections/${selection.selectionId}/clearance`, requester.cookie, { method: "POST" });
  assert.equal(clearanceResponse.response.status, 200, JSON.stringify(clearanceResponse.body));
  assert.equal(clearanceResponse.body.onchainVerified, true);
  const clearance = clearanceResponse.body.clearance;
  const message = clearanceMessage(clearance.clearance);
  assert.equal(message.counterparty.toLowerCase(), selection.recommendedWallet.toLowerCase());
  assert.equal(message.executor.toLowerCase(), requester.account.address.toLowerCase());
  assert.equal(message.snapshotHash.toLowerCase(), selection.canonicalHash.toLowerCase());
  assert.equal(message.requestedAmount, parseUnits(selection.requestedBudgetUsdc.toFixed(6), 6));
  assert.equal(message.maxAmount, parseUnits(selection.recommendedMaxExposureUsdc.toFixed(6), 6));
  const verification = await publicClient.readContract({ address: GATE, abi: clearanceAbi, functionName: "verifyClearance", args: [message, clearance.signature] });
  assert.equal(verification[0], true);
  const wrongCandidate = { ...message, counterparty: candidates.find((item) => item.wallet.toLowerCase() !== selection.recommendedWallet.toLowerCase())!.wallet };
  assert.equal((await publicClient.readContract({ address: GATE, abi: clearanceAbi, functionName: "verifyClearance", args: [wrongCandidate, clearance.signature] }))[0], false);
  const wrongExecutorMessage = { ...message, executor: foreign.account.address };
  assert.equal((await publicClient.readContract({ address: GATE, abi: clearanceAbi, functionName: "verifyClearance", args: [wrongExecutorMessage, clearance.signature] }))[0], false);
  await assert.rejects(() => publicClient.simulateContract({ account: foreign.account, address: GATE, abi: clearanceAbi, functionName: "consumeClearance", args: [message, clearance.signature] }), /revert|UnauthorizedExecutor/i);
  const walletClient = createWalletClient({ account: requester.account, chain: arcTestnet, transport: http(RPC) });
  const simulated = await publicClient.simulateContract({ account: requester.account, address: GATE, abi: clearanceAbi, functionName: "consumeClearance", args: [message, clearance.signature] });
  const consumeTx = await walletClient.writeContract(simulated.request);
  assert.equal((await publicClient.waitForTransactionReceipt({ hash: consumeTx })).status, "success");
  assert.equal((await publicClient.readContract({ address: GATE, abi: clearanceAbi, functionName: "verifyClearance", args: [message, clearance.signature] }))[0], false, "Consumed clearance remained valid");
  await assert.rejects(() => publicClient.simulateContract({ account: requester.account, address: GATE, abi: clearanceAbi, functionName: "consumeClearance", args: [message, clearance.signature] }), /revert|ClearanceAlreadyConsumed/i);

  const after = await economicCounts();
  assert.deepEqual(after, before, "Selection, proof, or clearance created an application payment/job");
  const publicReceipt = await fetch(`${BASE_URL}/trust/selections/${selection.publicId}`);
  assert.equal(publicReceipt.status, 200);

  console.log("P55_LIVE_ACCEPTANCE", JSON.stringify({
    productionUrl: BASE_URL,
    selectionId: selection.selectionId,
    publicReportUrl: `${BASE_URL}/trust/selections/${selection.publicId}`,
    requesterIdentity: requester.account.address,
    candidates: selection.candidates.map((item: any) => ({ agentId: item.identity?.agentId || null, wallet: item.identity?.ownerAddress || null, eligibility: item.eligibility, rank: item.rank, trustScore: item.trustScore, rankingScore: item.rankingScore, confidence: item.confidence, reason: item.rejectionReason || item.topReasons?.[0] || null })),
    winnerAgentId: selection.recommendedAgentId,
    winnerWallet: selection.recommendedWallet,
    trustGateDecision: selection.decision,
    requestedAmountUsdc: selection.requestedBudgetUsdc,
    maxExposureUsdc: selection.recommendedMaxExposureUsdc,
    trustScore: selection.trustScore,
    rankingScore: selection.rankingScore,
    confidence: selection.confidence,
    policyVersion: selection.policyVersion,
    rankingVersion: selection.rankingVersion,
    canonicalHash: selection.canonicalHash,
    selectionProofTx: proofResponse.body.proof.proofTx,
    clearanceId: clearance.clearanceId,
    clearanceDigest: clearance.clearanceDigest,
    clearanceConsumeTx: consumeTx,
    scenarioB: { excludedAgentId: sellerCandidate.agentId, excludedRawRankingScore: excluded.rankingScore, winnerAgentId: negative.body.selection.recommendedAgentId, winnerRankingScore: winnerRow.rankingScore, reason: excluded.rejectionReason },
    evidence: evidenceSummary,
    idempotentReplay: "passed",
    crossTenant404: "passed",
    wrongCandidate: "rejected",
    wrongExecutor: "rejected",
    clearanceReplay: "rejected",
    paymentAndJobCountsUnchanged: true,
  }));
}

main().catch((error) => { console.error("P5.5 live acceptance failed:", error instanceof Error ? error.message : String(error)); process.exit(1); });
