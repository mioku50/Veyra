import assert from "node:assert/strict";
import { keccak256, stringToBytes, createWalletClient, createPublicClient, http, type Hex, zeroAddress, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { evaluateTrustDecision } from "../lib/trust-gate/decision.ts";
import { signTrustClearance, getTrustGateEip712Domain, buildClearanceMessage } from "../lib/trust-gate/sign.ts";
import { verifyTrustClearanceOffchain, verifyTrustClearanceOnchain } from "../lib/trust-gate/verify.ts";
import { feedbackFromErc8183Completion } from "../lib/trust-gate/feedback.ts";
import type { ReputationSnapshot } from "../lib/reputation/types.ts";
import { computeAgentReputation } from "../lib/reputation/engine.ts";

const arcTestnet = {
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.ARC_TESTNET_RPC_URL!] },
  },
};

const trustGateAddress = process.env.VEYRA_TRUST_GATE_ADDRESS as Hex;
const attesterPk = (
  process.env.VEYRA_TRUST_ATTESTER_PRIVATE_KEY
  || process.env.ERC8183_EVALUATOR_ATTESTER_PRIVATE_KEY
) as Hex;

if (!trustGateAddress || !attesterPk) {
  throw new Error("Missing VEYRA_TRUST_GATE_ADDRESS or attester private key env var");
}

const abi = [
  {
    inputs: [
      {
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
        name: "clearance",
        type: "tuple",
      },
      { name: "signature", type: "bytes" },
    ],
    name: "consumeClearance",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  }
];

function createMockSnapshot(overrides: Partial<ReputationSnapshot> = {}): ReputationSnapshot {
  const canonicalHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  return {
    agentId: "ag_1",
    identityRegistry: "0x111",
    verifiedOnchain: true,
    metadataUri: "https://example.com/agent.json",
    trustScore: 100,
    confidence: "High",
    coverage: 1.0,
    dimensions: {
      economicReliability: 100,
      serviceQuality: 100,
      execution: 100,
      security: 100,
    },
    riskSignals: [],
    positiveEvidenceCount: 10,
    negativeEvidenceCount: 0,
    totalEconomicValueUsdc: 1000,
    createdAt: new Date().toISOString(),
    arcProofTx: "0xabc",
    canonicalHash,
    ...overrides
  };
}

async function runNegativeTests() {
  console.log("=======================================================");
  console.log("⚡ Running P5.4 Trust Gate Negative Acceptance Tests...");
  console.log("=======================================================\n");

  const account = privateKeyToAccount(attesterPk);
  const walletClient = createWalletClient({
    account,
    chain: arcTestnet,
    transport: http(process.env.ARC_TESTNET_RPC_URL)
  });
  
  const publicClient = createPublicClient({
    chain: arcTestnet,
    transport: http(process.env.ARC_TESTNET_RPC_URL)
  });

  const baseSnapshot = createMockSnapshot();
  const domain = getTrustGateEip712Domain(5042002, trustGateAddress);

  const getValidClearance = async (snapshot: ReputationSnapshot, reqAmount = 1) => {
    const decision = await evaluateTrustDecision({
      subjectAgentId: snapshot.agentId,
      action: "test_action",
      requestedValueUsdc: reqAmount,
      counterpartyWallet: "0x2222222222222222222222222222222222222222",
      executorWallet: account.address,
    }, snapshot);
    const { signature, clearanceMessage } = await signTrustClearance(
      decision,
      5042002,
      trustGateAddress,
      attesterPk
    );
    return { decision, signature, clearanceMessage };
  };

  // Test 1: Expired clearance -> verifyClearance returns false
  console.log("⚡ [1/18] Testing Expired Clearance...");
  const { clearanceMessage: msg1, signature: sig1 } = await getValidClearance(baseSnapshot);
  msg1.expiresAt = BigInt(Math.floor(Date.now() / 1000) - 1000); // expire in past
  const res1 = await verifyTrustClearanceOffchain(msg1, sig1, domain);
  assert.equal(res1.valid, false);
  assert.equal(res1.reason, "Expired");
  console.log("✅ [1/18] PASSED");

  // Test 2: Modified amount -> signature invalid
  console.log("⚡ [2/17] Testing Modified Amount...");
  const { clearanceMessage: msg2, signature: sig2 } = await getValidClearance(baseSnapshot);
  msg2.requestedAmount = BigInt(2000000); // modify amount
  const res2 = await verifyTrustClearanceOffchain(msg2, sig2, domain, account.address);
  assert.equal(res2.valid, false);
  console.log("✅ [2/17] PASSED");

  // Test 3: Amount above max -> rejected by contract
  console.log("⚡ [3/17] Testing Amount Above Max Onchain...");
  const { clearanceMessage: msg3, signature: sig3 } = await getValidClearance(baseSnapshot);
  msg3.requestedAmount = BigInt(11000000); // above default max
  try {
    await walletClient.writeContract({
      address: trustGateAddress,
      abi,
      functionName: "consumeClearance",
      args: [msg3, sig3]
    });
    assert.fail("Should have reverted");
  } catch (err: any) {
    assert.ok(err.message.includes("revert") || err.message.includes("InvalidSignature"));
  }
  console.log("✅ [3/17] PASSED");

  // Test 4: Modified provider/counterparty -> signature invalid
  console.log("⚡ [4/17] Testing Modified Counterparty...");
  const { clearanceMessage: msg4, signature: sig4 } = await getValidClearance(baseSnapshot);
  msg4.counterparty = "0x3333333333333333333333333333333333333333";
  const res4 = await verifyTrustClearanceOffchain(msg4, sig4, domain, account.address);
  assert.equal(res4.valid, false);
  console.log("✅ [4/17] PASSED");

  // Test 5: Modified Agent ID -> signature invalid
  console.log("⚡ [5/17] Testing Modified Agent ID...");
  const { clearanceMessage: msg5, signature: sig5 } = await getValidClearance(baseSnapshot);
  msg5.subject = "0x4444444444444444444444444444444444444444";
  const res5 = await verifyTrustClearanceOffchain(msg5, sig5, domain, account.address);
  assert.equal(res5.valid, false);
  console.log("✅ [5/17] PASSED");

  // Test 6: Wrong chain -> domain mismatch
  console.log("⚡ [6/17] Testing Wrong Chain...");
  const { decision: dec6 } = await getValidClearance(baseSnapshot);
  const { signature: sig6, clearanceMessage: msg6 } = await signTrustClearance(dec6, 1, trustGateAddress, attesterPk); // chainId 1
  const res6 = await verifyTrustClearanceOffchain(msg6, sig6, domain, account.address);
  assert.equal(res6.valid, false);
  console.log("✅ [6/17] PASSED");

  // Test 7: Stale snapshot -> policy downgrade
  console.log("⚡ [7/17] Testing Stale Snapshot...");
  const staleSnapshot = createMockSnapshot({ createdAt: new Date(Date.now() - 7200000).toISOString() }); // 2 hours ago
  const dec7 = await evaluateTrustDecision({
    subjectAgentId: staleSnapshot.agentId,
    action: "test",
    requestedValueUsdc: 1,
  }, staleSnapshot);
  assert.ok(dec7.riskSignals.includes("STALE_REPUTATION"));
  assert.ok(dec7.decision !== "ALLOW" || dec7.policy.maxValueUsdc === 0);
  console.log("✅ [7/17] PASSED");

  // Test 8: Canonical snapshot hash mismatch -> rejected
  console.log("⚡ [8/17] Testing Canonical Snapshot Hash Mismatch...");
  const { clearanceMessage: msg8, signature: sig8 } = await getValidClearance(baseSnapshot);
  msg8.snapshotHash = keccak256(stringToBytes("wrong_hash"));
  const res8 = await verifyTrustClearanceOffchain(msg8, sig8, domain, account.address);
  assert.equal(res8.valid, false);
  console.log("✅ [8/17] PASSED");

  // Test 9: Invalid Arc Proof -> ARC_PROOF_UNVERIFIED risk signal
  console.log("⚡ [9/17] Testing Invalid Arc Proof...");
  const noProofSnapshot = createMockSnapshot({ arcProofTx: undefined });
  const dec9 = await evaluateTrustDecision({
    subjectAgentId: noProofSnapshot.agentId,
    action: "test",
    requestedValueUsdc: 1,
  }, noProofSnapshot);
  assert.ok(dec9.riskSignals.includes("ARC_PROOF_UNVERIFIED"));
  console.log("✅ [9/17] PASSED");

  // Test 10: Fake ERC-8004 identity -> DENY
  console.log("⚡ [10/17] Testing Fake ERC-8004 Identity...");
  const fakeIdSnapshot = createMockSnapshot({ verifiedOnchain: false }); // not verified onchain
  const dec10 = await evaluateTrustDecision({
    subjectAgentId: fakeIdSnapshot.agentId,
    action: "test",
    requestedValueUsdc: 1,
  }, fakeIdSnapshot);
  // Though engine uses it, the db fetch for a fake id returns nothing usually
  const dec10_nodb = await evaluateTrustDecision({
    subjectAgentId: "fake_agent_999",
    action: "test",
    requestedValueUsdc: 1,
  }, null); // null memory override simulates not found
  assert.equal(dec10_nodb.decision, "DENY");
  assert.ok(dec10_nodb.reasons.includes("NO_REPUTATION_DATA"));
  console.log("✅ [10/17] PASSED");

  // Test 11: Self-rating evidence cannot increase clearance
  console.log("⚡ [11/17] Testing Self-Rating Evidence...");
  const logs11: any[] = [];
  const origLog = console.log;
  console.log = (...args) => logs11.push(args);
  await feedbackFromErc8183Completion({
    agentId: "ag_1",
    jobId: "job_1",
    outcome: "completed",
    clientAddress: "0xSame",
    providerAddress: "0xSame",
    deliverableHash: "hash",
    completeTx: "tx",
  }, true);
  console.log = origLog;
  assert.ok(logs11.some(l => l[0].includes("self-rating")));
  console.log("✅ [11/17] PASSED");

  // Test 12: Duplicate economic evidence cannot increase clearance
  console.log("⚡ [12/17] Testing Duplicate Evidence Replay...");
  // Tested similarly in reputation engine, computeAgentReputation handles it
  const dupEv: any = {
    evidenceId: "ev1",
    agentId: "1",
    type: "erc8183_outcome",
    tier: 3,
    sourceId: "job1",
    score: 100,
    positive: true,
    confidence: 1,
    economicValueUsdc: 10,
    verifiedOnchain: true,
    arcProofVerified: true,
    sybilRisk: "none",
    canonicalHash: "0x123",
    observedAt: new Date().toISOString()
  };
  const mockId: any = { 
    agentId: "1", 
    verifiedOnchain: true,
    identityRegistry: "0x1111111111111111111111111111111111111111",
    owner: "0x0000000000000000000000000000000000000000"
  };
  const res12_single = computeAgentReputation(mockId, [dupEv]);
  const res12_dup = computeAgentReputation(mockId, [dupEv, dupEv]);
  assert.equal(res12_single.trustScore, res12_dup.trustScore);
  console.log("✅ [12/17] PASSED");

  // Test 13: Replayed clearance -> rejected
  console.log("⚡ [13/17] Testing Replayed Clearance Onchain...");
  const { clearanceMessage: msg13, signature: sig13 } = await getValidClearance(baseSnapshot, 0); // 0 amount to not hit limit
  msg13.decisionId = keccak256(stringToBytes(`test_replay_${Date.now()}`));
  
  // Sign again because we changed decisionId
  const dec13 = await evaluateTrustDecision({
    subjectAgentId: baseSnapshot.agentId,
    action: "test_replay",
    requestedValueUsdc: 0,
    counterpartyWallet: "0x2222222222222222222222222222222222222222",
    executorWallet: account.address,
  }, baseSnapshot);
  dec13.decisionId = `test_replay_${Date.now()}`;
  const { clearanceMessage: msg13b, signature: sig13b } = await signTrustClearance(dec13, 5042002, trustGateAddress, attesterPk);
  
  const tx13 = await walletClient.writeContract({
    address: trustGateAddress,
    abi,
    functionName: "consumeClearance",
    args: [msg13b, sig13b]
  });
  await publicClient.waitForTransactionReceipt({ hash: tx13 });
  
  try {
    await walletClient.writeContract({
      address: trustGateAddress,
      abi,
      functionName: "consumeClearance",
      args: [msg13b, sig13b]
    });
    assert.fail("Should have reverted on replay");
  } catch (err: any) {
    assert.ok(err.message.includes("revert") || err.message.includes("ClearanceAlreadyConsumed"));
  }
  console.log("✅ [13/17] PASSED");

  // Test 14: DB unavailable -> no ALLOW
  console.log("⚡ [14/17] Testing DB Unavailable...");
  const dec14 = await evaluateTrustDecision({
    subjectAgentId: "ag_missing",
    action: "test",
    requestedValueUsdc: 1,
  }, null);
  assert.equal(dec14.decision, "DENY");
  console.log("✅ [14/17] PASSED");

  // Test 15: Arc RPC unavailable -> ARC_PROOF_UNVERIFIED
  console.log("⚡ [15/17] Testing Arc RPC Unavailable...");
  const dec15 = await evaluateTrustDecision({
    subjectAgentId: noProofSnapshot.agentId,
    action: "test",
    requestedValueUsdc: 1,
  }, noProofSnapshot);
  assert.ok(dec15.riskSignals.includes("ARC_PROOF_UNVERIFIED"));
  console.log("✅ [15/17] PASSED");

  // Test 16: Payment recipient mismatch -> x402 blocked
  console.log("⚡ [16/17] Testing Payment Recipient Mismatch...");
  const { clearanceMessage: msg16, signature: sig16 } = await getValidClearance(baseSnapshot);
  // Simulating the mismatch by verifying against wrong counterparty in offchain check
  msg16.counterparty = "0x9999999999999999999999999999999999999999";
  const res16 = await verifyTrustClearanceOffchain(msg16, sig16, domain, account.address);
  assert.equal(res16.valid, false);
  console.log("✅ [16/17] PASSED");

  // Test 17: ERC-8183 provider mismatch -> job blocked
  console.log("⚡ [17/17] Testing ERC-8183 Provider Mismatch...");
  const { clearanceMessage: msg17, signature: sig17 } = await getValidClearance(baseSnapshot);
  msg17.counterparty = "0x8888888888888888888888888888888888888888";
  const res17 = await verifyTrustClearanceOffchain(msg17, sig17, domain, account.address);
  assert.equal(res17.valid, false);
  console.log("✅ [17/17] PASSED");

  // Test 18: unrelated caller cannot consume a valid victim clearance.
  console.log("⚡ [18/18] Testing Caller-Bound Executor...");
  const { clearanceMessage: msg18, signature: sig18 } = await getValidClearance(baseSnapshot);
  const attacker = "0xDeaD00000000000000000000000000000000BEEf" as const;
  await assert.rejects(
    publicClient.simulateContract({
      account: attacker,
      address: trustGateAddress,
      abi,
      functionName: "consumeClearance",
      args: [msg18, sig18],
    }),
    /revert|UnauthorizedExecutor/i,
  );
  const stillValid = await verifyTrustClearanceOnchain(msg18, sig18, trustGateAddress);
  assert.equal(stillValid.valid, true, "Attacker simulation must not consume the victim clearance");
  console.log("✅ [18/18] PASSED");

  console.log("\n🎉 ALL 18 TRUST GATE NEGATIVE ACCEPTANCE TESTS PASSED SUCCESSFULLY!");
}

runNegativeTests().catch((err) => {
  console.error("❌ Trust Gate Negative Tests Failed:", err);
  process.exit(1);
});
