import assert from "node:assert/strict";
import { generateKeyPairSync, createHash, sign } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createPublicClient, custom, decodeFunctionData, encodeAbiParameters, encodeEventTopics,
  encodeFunctionResult, erc20Abi, keccak256, toBytes, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { monadDemoTestnet, MONAD_CONTRACTS } from "../../lib/monad/config.ts";
import { getMonadReadClient, MONAD_IDENTITY_ABI, MONAD_REPUTATION_ABI } from "../../lib/monad/erc8004.ts";
import { collectMonadEvidence, MONAD_ASSESSMENT_TYPES, monadAssessmentDomain,
  type MonadDeliveryAssessment, type MonadEvidencePolicy } from "../../lib/monad/evidence.ts";
import { buildMonadClearance, evaluateMonadPurchase, monadApprovalChallenge, parseMonadUsdc, selectMonadPurchase, signMonadClearance } from "../../lib/monad/trust.ts";
import { verifyTrustClearanceOffchain } from "../../lib/trust-gate/verify.ts";
import { METROPOLIS_ORIGIN } from "../../lib/monad/passkey.ts";

// All identities, receipts, feedback and assessments below are synthetic test data.
// No live network is contacted. Signing keys are ephemeral or public unit-test constants.
const now = new Date(1_800_000_000_000);
const hash = (text: string) => keccak256(toBytes(text));
const seller: Address = "0x0000000000000000000000000000000000000222";
const owner: Address = "0x0000000000000000000000000000000000000999";
const buyer: Address = "0x0000000000000000000000000000000000000111";
const executor: Address = "0x000000000000000000000000000000000000F001";
const gate: Address = "0x000000000000000000000000000000000000F002";
const feedbackClient: Address = "0x0000000000000000000000000000000000000444";
const tx = hash("synthetic-payment");
const blockHash = hash("synthetic-block");
const reporter = privateKeyToAccount(generatePrivateKey());
const publicTestAttester = privateKeyToAccount(`0x${"b0b".padStart(64, "0")}`);
const intent = { executor, amountUsdc: "0.012", budgetUsdc: "0.02", serviceId: "synthetic-research-test", requestHash: hash("test-research-request") };
const abi = [...erc20Abi, ...MONAD_IDENTITY_ABI, ...MONAD_REPUTATION_ABI];
let checks = 0;
function check(condition: unknown, message: string) { assert.ok(condition, message); checks++; }

type Scenario = { chainId?: number; code?: Hex; wallet?: Address; owner?: Address; decimals?: number; registry?: Address;
  feedback?: bigint; feedbackDecimals?: number; failedReceipt?: boolean; reorg?: boolean;
  token?: Address; payer?: Address; recipient?: Address; confirmations?: number; age?: number; clock?: number; finalizedBlock?: number };
function mockClient(options: Scenario = {}) {
  const client = createPublicClient({ chain: monadDemoTestnet, transport: custom({
    async request({ method, params }) {
      if (method === "eth_chainId") return `0x${(options.chainId ?? 10143).toString(16)}`;
      if (method === "eth_blockNumber") return "0x3e8";
      if (method === "eth_getCode") return options.code ?? "0x6000";
      if (method === "eth_call") {
        const data = (params as [{ data: Hex }])[0].data;
        const { functionName } = decodeFunctionData({ abi, data });
        const value = functionName === "decimals" ? options.decimals ?? 6
          : functionName === "getIdentityRegistry" ? options.registry ?? MONAD_CONTRACTS[10143].identityRegistry
          : functionName === "ownerOf" ? options.owner ?? owner
          : functionName === "getAgentWallet" ? options.wallet ?? seller
          : functionName === "tokenURI" ? "https://metadata.invalid/test-only"
          : [options.feedback === undefined ? 0n : 6n, options.feedback ?? 0n, options.feedbackDecimals ?? 0];
        return encodeFunctionResult({ abi, functionName, result: value } as Parameters<typeof encodeFunctionResult>[0]);
      }
      if (method === "eth_getTransactionReceipt") return {
        transactionHash: tx, blockHash, blockNumber: `0x${(1000 - (options.confirmations ?? 2) + 1).toString(16)}`,
        transactionIndex: "0x0", from: buyer, to: executor, contractAddress: null,
        cumulativeGasUsed: "0x5208", gasUsed: "0x5208", effectiveGasPrice: "0x1", type: "0x0",
        status: options.failedReceipt ? "0x0" : "0x1", logsBloom: `0x${"00".repeat(256)}`,
        logs: [{ address: options.token ?? MONAD_CONTRACTS[10143].usdc,
          blockHash, blockNumber: "0x3e7", transactionHash: tx, transactionIndex: "0x0", logIndex: "0x0", removed: false,
          topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: options.payer ?? buyer, to: options.recipient ?? seller } }),
          data: encodeAbiParameters([{ type: "uint256" }], [12_000n]) }],
      };
      if (method === "eth_getBlockByNumber") return {
        number: (params as string[])[0] === "finalized" ? `0x${(options.finalizedBlock ?? 1000).toString(16)}` : "0x3e7",
        hash: options.reorg ? hash("other-block") : blockHash,
        timestamp: `0x${((options.clock ?? 1_800_000_000) - (options.age ?? 60)).toString(16)}`, transactions: [],
        gasLimit: "0x1", gasUsed: "0x1", size: "0x1", difficulty: "0x0", totalDifficulty: "0x0",
      };
      throw new Error(`Unexpected mock RPC method ${method}`);
    },
  }, { retryCount: 0 }) });
  return client as ReturnType<typeof getMonadReadClient>;
}
async function assessment(overrides: Partial<MonadDeliveryAssessment> = {}, signer = reporter) {
  const message: MonadDeliveryAssessment = { agentId: 1n, buyer, seller, amount: 12_000n, paymentTx: tx,
    requestHash: hash("prior-test-request"), responseHash: hash("test-response"), delivered: true, score: 80,
    assessedAt: 1_799_999_980n, ...overrides };
  return { message, signature: await signer.signTypedData({ domain: monadAssessmentDomain(), types: MONAD_ASSESSMENT_TYPES,
    primaryType: "DeliveryAssessment", message }) };
}
const validAssessment = await assessment();
const policy: MonadEvidencePolicy = { payments: [{ transactionHash: tx, logIndex: 0 }],
  assessmentReporters: [reporter.address], assessments: [validAssessment] };
const identityOnly = await collectMonadEvidence(1n, {}, mockClient(), now);
const insufficient = evaluateMonadPurchase(identityOnly, intent, now);
check(!insufficient.executable && insufficient.decision.decision === "REVIEW_REQUIRED", "Identity alone must require review");
check(insufficient.decision.trust.coverage < 0.3, "Identity coverage remains limited despite a high score");
assert.throws(() => buildMonadClearance(insufficient, gate, now)); checks++;
assert.throws(() => evaluateMonadPurchase({ ...identityOnly }, intent, now), /server/); checks++;

const paymentOnly = await collectMonadEvidence(1n, { payments: policy.payments }, mockClient(), now);
check(!evaluateMonadPurchase(paymentOnly, intent, now).executable, "Payment alone cannot prove delivery");
const full = await collectMonadEvidence(1n, policy, mockClient(), now);
const allowed = evaluateMonadPurchase(full, intent, now);
check(allowed.executable && allowed.decision.decision === "ALLOW", "Corroborated synthetic payment and signed delivery pass existing policy");
check(full.evidence.every(item => !item.arcProofVerified), "Monad evidence must never claim an Arc proof");
check(Object.isFrozen(allowed.decision.trust) && Object.isFrozen(full.identity), "Nested server facts and decisions are immutable");
assert.throws(() => buildMonadClearance({ ...allowed }, gate, now), /server-issued/); checks++;
assert.throws(() => buildMonadClearance(allowed, gate, new Date(now.getTime() + 301_000)), /valid/); checks++;
check(evaluateMonadPurchase(full, { ...intent, expectedPayee: buyer }, now).decision.decision === "DENY", "Payee mismatch denies");
check(evaluateMonadPurchase(full, { ...intent, amountUsdc: "0.020001" }, now).decision.decision === "DENY", "Owner budget cannot be exceeded by one atomic unit");
check(evaluateMonadPurchase(full, { ...intent, amountUsdc: "101", budgetUsdc: "200" }, now).decision.decision === "DENY", "Trust tier cap still applies");
check(!evaluateMonadPurchase(full, intent, new Date(now.getTime() + 301_000)).executable, "Old collection cannot issue a fresh authorization");
const limitedBundle = await collectMonadEvidence(1n, { ...policy, feedbackClients: [feedbackClient] }, mockClient({ feedback: 30n }), now);
const limited = evaluateMonadPurchase(limitedBundle, { ...intent, budgetUsdc: "50" }, now);
check(limited.executable && limited.decision.decision === "ALLOW_WITH_LIMITS" && limited.maxAmount === 25_000_000n, "Mixed feedback uses existing limited tier");
const failed = await collectMonadEvidence(1n, { ...policy, assessments: [await assessment({ delivered: false })] }, mockClient(), now);
check(evaluateMonadPurchase(failed, intent, now).decision.decision === "DENY", "Failed delivery cannot pass because money moved");
const stale = await collectMonadEvidence(1n, { ...policy, assessments: [await assessment({ assessedAt: 1_799_999_980n - 20_000n })] }, mockClient({ age: 20_060 }), now);
check(!evaluateMonadPurchase(stale, intent, now).executable, "Refreshing identity cannot rejuvenate stale delivery evidence");
const self = await collectMonadEvidence(1n, { payments: policy.payments, feedbackClients: [owner, seller] }, mockClient({ payer: owner }), now);
check(self.evidence.length === 0 && self.excluded.length === 3, "Provider feedback and self-transfers are excluded");
const duplicate = await collectMonadEvidence(1n, { ...policy, payments: [...policy.payments!, ...policy.payments!], assessments: [validAssessment, validAssessment] }, mockClient(), now);
check(duplicate.evidence.length === full.evidence.length, "Duplicated transactions and assessments do not create evidence");
const malformedFeedback = await collectMonadEvidence(1n, { feedbackClients: [feedbackClient] }, mockClient({ feedback: 1000n, feedbackDecimals: 2 }), now);
check(malformedFeedback.evidence.length === 0, "Arbitrary ERC-8004 metrics are not scores");

for (const scenario of [ { chainId: 143 }, { code: "0x" as Hex }, { decimals: 18 },
  { registry: seller }, { wallet: "0x0000000000000000000000000000000000000000" as Address },
  { failedReceipt: true }, { reorg: true }, { token: seller }, { recipient: buyer }, { confirmations: 1 }, { finalizedBlock: 998 } ]) {
  await assert.rejects(() => collectMonadEvidence(1n, policy, mockClient(scenario), now)); checks++;
}
await assert.rejects(() => collectMonadEvidence(1n, { feedbackClients: [feedbackClient, feedbackClient] }, mockClient(), now)); checks++;
await assert.rejects(() => collectMonadEvidence(1n, { ...policy, assessmentReporters: [] }, mockClient(), now), /signer/); checks++;
await assert.rejects(() => collectMonadEvidence(1n, policy, mockClient({ owner: reporter.address }), now), /signer/); checks++;
await assert.rejects(() => collectMonadEvidence(1n, { ...policy, assessments: [{ ...validAssessment, message: { ...validAssessment.message, delivered: "false" as unknown as boolean } }] }, mockClient(), now), /binding/); checks++;
await assert.rejects(async () => collectMonadEvidence(1n, { ...policy, assessments: [await assessment({ amount: 13_000n })] }, mockClient(), now), /verified payment/); checks++;
await assert.rejects(async () => collectMonadEvidence(1n, { ...policy, assessments: [await assessment({ assessedAt: 1_800_000_001n })] }, mockClient(), now), /timestamp/); checks++;
await assert.rejects(async () => collectMonadEvidence(1n, { ...policy, assessments: [validAssessment, await assessment({ responseHash: hash("conflicting-response") })] }, mockClient(), now), /Conflicting/); checks++;
for (const amount of ["0", "-1", "1e-3", "0.0000001", "1.0000000", "01", "NaN", "Infinity"]) { assert.throws(() => parseMonadUsdc(amount)); checks++; }
check(parseMonadUsdc("0.000001") === 1n && parseMonadUsdc("0.012") === 12_000n, "Exact six-decimal atomic conversion");
const second = await collectMonadEvidence(2n, { ...policy, assessments: [await assessment({ agentId: 2n })] }, mockClient(), now);
const selection = selectMonadPurchase([{ evidence: identityOnly, amountUsdc: "0.001" }, { evidence: second, amountUsdc: "0.012" }], intent, "cost", now);
check(selection.selected?.agentId === second.identity.agentId && selection.disclosures.length === 1, "A cheap identity-only offer cannot displace corroborated evidence; shared ownership is disclosed");
const emptySelection = selectMonadPurchase([{ evidence: identityOnly, amountUsdc: "0.001" }], intent, "trust", now);
check(emptySelection.selected === null, "No eligible candidates means no selected provider or clearance");
assert.throws(() => selectMonadPurchase([{ evidence: full, amountUsdc: "0.01" }, { evidence: full, amountUsdc: "0.012" }], intent, "trust", now), /Duplicate/); checks++;
const signed = await signMonadClearance(allowed, gate, publicTestAttester, now);
// Existing verifier checks its expiry against the real clock, so test signing below uses a fresh decision.
const freshNow = new Date();
const clock = Math.floor(freshNow.getTime() / 1000);
const freshBundle = await collectMonadEvidence(1n, { ...policy, assessments: [await assessment({ assessedAt: BigInt(clock - 20) })] }, mockClient({ clock }), freshNow);
const freshSigned = await signMonadClearance(evaluateMonadPurchase(freshBundle, intent, freshNow), gate, publicTestAttester, freshNow);
const verified = await verifyTrustClearanceOffchain(freshSigned.message, freshSigned.signature, freshSigned.domain, publicTestAttester.address);
check(verified.valid, "Existing EIP-712 verifier accepts Monad clearance schema/domain");
const challenge = monadApprovalChallenge(signed, 0n, 1_800_000_120n);
check(challenge !== monadApprovalChallenge(signed, 1n, 1_800_000_120n), "Nonce changes the approval challenge");
assert.throws(() => monadApprovalChallenge(signed, 0n, 1_800_000_301n)); checks++;

if (process.argv.includes("--write-contract-fixture")) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const coordinate = (value: string) => `0x${Buffer.from(value, "base64url").toString("hex")}` as Hex;
  const qx = coordinate(jwk.x!); const qy = coordinate(jwk.y!);
  const clientDataJSON = JSON.stringify({ type: "webauthn.get", challenge: Buffer.from(challenge.slice(2), "hex").toString("base64url"),
    origin: METROPOLIS_ORIGIN, crossOrigin: false });
  const authenticatorData = Buffer.concat([createHash("sha256").update(new URL(METROPOLIS_ORIGIN).hostname).digest(), Buffer.from([5]), Buffer.alloc(4)]);
  const payload = Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]);
  const signature = sign("sha256", payload, { key: privateKey, dsaEncoding: "ieee-p1363" });
  const order = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  let s = BigInt(`0x${signature.subarray(32).toString("hex")}`); if (s > order / 2n) s = order - s;
  const auth = { r: `0x${signature.subarray(0, 32).toString("hex")}` as Hex, s: `0x${s.toString(16).padStart(64, "0")}` as Hex,
    challengeIndex: BigInt(clientDataJSON.indexOf('"challenge"')), typeIndex: BigInt(clientDataJSON.indexOf('"type"')),
    authenticatorData: `0x${authenticatorData.toString("hex")}` as Hex, clientDataJSON };
  const clearanceTuple = [{ type: "tuple", components: Object.values((await import("../../lib/trust-gate/sign.ts")).EIP712_CLEARANCE_TYPES)[0] }] as const;
  const authTuple = [{ type: "tuple", components: [{ name: "r", type: "bytes32" }, { name: "s", type: "bytes32" },
    { name: "challengeIndex", type: "uint256" }, { name: "typeIndex", type: "uint256" }, { name: "authenticatorData", type: "bytes" }, { name: "clientDataJSON", type: "string" }] }] as const;
  writeFileSync(new URL("../../contracts/monad/test/fixtures/backend-clearance.json", import.meta.url), JSON.stringify({
    description: "Synthetic RPC evidence passed the real Veyra engine and Monad builder; software P256 signature. No live history, private keys or transactions.",
    qx, qy, challenge, digest: signed.digest, signature: signed.signature,
    encodedClearance: encodeAbiParameters(clearanceTuple, [signed.message]), assertion: encodeAbiParameters(authTuple, [auth]),
  }, null, 2) + "\n");
}
console.log(`Metropolis trust tests PASS: ${checks} authorization/provenance checks with synthetic RPC fixtures; no transaction sent.`);
