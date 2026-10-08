import { encodeAbiParameters, encodeFunctionData, erc20Abi, formatUnits, hashTypedData,
  isAddress, keccak256, parseUnits, toBytes, zeroAddress, type Address, type Hex, type LocalAccount } from "viem";
import { computeAgentReputation } from "../reputation/engine.ts";
import { computeCanonicalDecisionHash } from "../trust-gate/canonical.ts";
import { resolvePolicy } from "../trust-gate/policy.ts";
import { EIP712_CLEARANCE_TYPES, getTrustGateEip712Domain } from "../trust-gate/sign.ts";
import { TRUST_DECISION_EXPIRY_SECONDS, TRUST_POLICY_VERSION, type TrustDecision, type TrustRiskCode } from "../trust-gate/types.ts";
import { MONAD_CONTRACTS } from "./config.ts";
import { assertVerifiedMonadEvidence, canonicalMonadHash, deepFreeze, type MonadEvidenceBundle } from "./evidence.ts";

export const METROPOLIS_TRUST_VERSION = `${TRUST_POLICY_VERSION}:metropolis-evidence-v1`;
export const MONAD_APPROVAL_TYPEHASH = keccak256(toBytes(
  "VeyraPasskeyPayment(uint256 chainId,address account,address trustGate,bytes32 clearanceDigest,bytes32 actionHash,uint256 nonce,uint64 deadline)",
));
export type MonadPurchaseIntent = {
  executor: Address; amountUsdc: string; budgetUsdc: string; serviceId: string; requestHash: Hex;
  expectedPayee?: Address;
};
export type MonadTrustDecision = {
  chainId: 10143;
  decision: TrustDecision;
  requestedAmount: bigint;
  maxAmount: bigint;
  requestHash: Hex;
  actionHash: Hex;
  evidenceHash: Hex;
  executable: boolean;
  reasons: readonly string[];
  disclosures: readonly string[];
  canonicalHash: Hex;
};
const issuedDecisions = new WeakMap<object, { expiresAt: bigint }>();

/** No floating-point rounding, extra decimal places, scientific notation or negative payments. */
export function parseMonadUsdc(value: string): bigint {
  if (typeof value !== "string" || value.length > 24 || !/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(value)) throw new Error("USDC amount requires an exact decimal string with at most six decimals");
  const amount = parseUnits(value, 6);
  if (amount <= BigInt(0) || amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("USDC amount is outside the supported range");
  return amount;
}
export function monadPaymentActionHash(counterparty: Address, amount: bigint): Hex {
  if (!isAddress(counterparty) || counterparty === zeroAddress || amount <= BigInt(0)) throw new Error("Invalid exact USDC payment");
  const call = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [counterparty, amount] });
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes" }],
    [MONAD_CONTRACTS[10143].usdc, BigInt(0), call]));
}

/** Pure existing scoring and policy, with additional fail-closed Monad provenance checks. */
export function evaluateMonadPurchase(bundle: MonadEvidenceBundle, intent: MonadPurchaseIntent, now = new Date()): MonadTrustDecision {
  assertVerifiedMonadEvidence(bundle);
  if (!isAddress(intent.executor) || intent.executor === zeroAddress
    || !intent.serviceId.trim() || !/^0x[0-9a-fA-F]{64}$/.test(intent.requestHash)
    || BigInt(intent.requestHash) === BigInt(0)) throw new Error("Invalid Monad purchase intent");
  const requestedAmount = parseMonadUsdc(intent.amountUsdc);
  const budget = parseMonadUsdc(intent.budgetUsdc);
  const collectedAtMs = new Date(bundle.collectedAt).getTime();
  if (!Number.isFinite(now.getTime()) || now.getTime() < collectedAtMs) throw new Error("Invalid decision time");
  const explanation = computeAgentReputation(bundle.identity, [...bundle.evidence], now);
  const confidence = explanation.confidence === "Very High" || explanation.confidence === "High" ? 0.9
    : explanation.confidence === "Medium" ? 0.6 : 0.3;
  const coverage = explanation.coverage / 100;
  // A fresh identity RPC read cannot rejuvenate old economic/delivery evidence.
  const sourceTimes = [collectedAtMs, ...bundle.evidence.map(item => new Date(item.observedAt).getTime())];
  const freshnessSeconds = Math.floor((now.getTime() - Math.min(...sourceTimes)) / 1000);
  const riskSignals: TrustRiskCode[] = [];
  if (confidence < 0.5) riskSignals.push("LOW_CONFIDENCE");
  if (coverage < 0.5) riskSignals.push("INSUFFICIENT_COVERAGE");
  if (!bundle.evidence.length) riskSignals.push("NO_REPUTATION_DATA");
  if (freshnessSeconds > 3600) riskSignals.push("STALE_REPUTATION");
  const { tier } = resolvePolicy(explanation.trustScore, confidence, coverage, freshnessSeconds, riskSignals);
  const tierLimit = parseUnits(tier.maxValueUsdc.toString(), 6);
  const maxAmount = tierLimit < budget ? tierLimit : budget;
  const reasons: string[] = [...riskSignals];
  if (tier.level !== "ALLOW" && tier.level !== "ALLOW_WITH_LIMITS") reasons.push("TRUST_TIER_REQUIRES_REVIEW");
  if (!bundle.evidence.some(item => item.type === "usdc_payment_success")) reasons.push("NO_CORROBORATED_PAYMENT_HISTORY");
  if (!bundle.evidence.some(item => item.type === "service_delivery" && item.positive)) reasons.push("NO_VERIFIED_DELIVERY_HISTORY");
  if (bundle.evidence.some(item => item.type === "service_delivery" && !item.positive)) reasons.push("DELIVERY_ASSESSMENT_FAILED");
  if (intent.expectedPayee && intent.expectedPayee.toLowerCase() !== bundle.identity.paymentWallet.toLowerCase()) reasons.push("PAYEE_BINDING_MISMATCH");
  if (intent.executor.toLowerCase() === bundle.identity.paymentWallet.toLowerCase()) reasons.push("SELF_PAYMENT_NOT_ALLOWED");
  if (requestedAmount > budget || (["ALLOW", "ALLOW_WITH_LIMITS"].includes(tier.level) && requestedAmount > maxAmount)) {
    reasons.push("VALUE_EXCEEDS_TRUST_LIMIT"); riskSignals.push("VALUE_EXCEEDS_TRUST_LIMIT");
  }
  if (now.getTime() - collectedAtMs > TRUST_DECISION_EXPIRY_SECONDS * 1000) reasons.push("EVIDENCE_COLLECTION_EXPIRED");
  // Informational low-confidence/staleness risks remain visible; tier thresholds decide their permitted range.
  const blocking = reasons.filter(reason => !["LOW_CONFIDENCE", "INSUFFICIENT_COVERAGE", "STALE_REPUTATION"].includes(reason));
  const executable = blocking.length === 0;
  const issuedAt = new Date(Math.floor(now.getTime() / 1000) * 1000).toISOString();
  const expiresAt = new Date(Math.min(now.getTime() + TRUST_DECISION_EXPIRY_SECONDS * 1000,
    collectedAtMs + TRUST_DECISION_EXPIRY_SECONDS * 1000)).toISOString();
  const binding = { chainId: 10143, executor: intent.executor.toLowerCase(), payee: bundle.identity.paymentWallet.toLowerCase(),
    requestedAmount, maxAmount, serviceId: intent.serviceId, requestHash: intent.requestHash, evidenceHash: bundle.evidenceHash,
    policyVersion: METROPOLIS_TRUST_VERSION, issuedAt, expiresAt };
  const decision: TrustDecision = {
    decisionId: `vmd_${canonicalMonadHash(binding).slice(2)}`,
    decision: executable ? tier.level : blocking.some(reason => ["PAYEE_BINDING_MISMATCH", "SELF_PAYMENT_NOT_ALLOWED", "DELIVERY_ASSESSMENT_FAILED", "VALUE_EXCEEDS_TRUST_LIMIT", "EVIDENCE_COLLECTION_EXPIRED"].includes(reason)) ? "DENY" : "REVIEW_REQUIRED",
    subject: { agentId: bundle.identity.agentId, wallet: bundle.identity.paymentWallet },
    trust: { score: explanation.trustScore, confidence, coverage,
      snapshotHash: bundle.evidenceHash, snapshotAgeSeconds: freshnessSeconds },
    request: { action: "service_purchase", requestedValueUsdc: Number(formatUnits(requestedAmount, 6)),
      counterparty: bundle.identity.paymentWallet, executor: intent.executor,
      serviceId: intent.serviceId, workflowType: `metropolis:${intent.requestHash}` },
    policy: { version: METROPOLIS_TRUST_VERSION, maxValueUsdc: executable ? Number(formatUnits(maxAmount, 6)) : 0,
      evaluatorRequired: !executable },
    reasons: [...riskSignals], riskSignals: [...riskSignals], issuedAt, expiresAt, canonicalHash: "",
  };
  decision.canonicalHash = computeCanonicalDecisionHash(decision);
  const output = deepFreeze({ chainId: 10143 as const, decision, requestedAmount, maxAmount: executable ? maxAmount : BigInt(0),
    requestHash: intent.requestHash, actionHash: monadPaymentActionHash(bundle.identity.paymentWallet, requestedAmount),
    evidenceHash: bundle.evidenceHash, executable, reasons: [...new Set(reasons)],
    disclosures: [...bundle.disclosures, ...bundle.excluded,
      ...explanation.topPositiveEvidence.map(reason => reason.replace("independent counterparties", "distinct client addresses (ownership independence unverified)"))],
    canonicalHash: canonicalMonadHash({ binding, decision, reasons: [...new Set(reasons)], executable }),
  });
  issuedDecisions.set(output, { expiresAt: BigInt(Math.floor(new Date(expiresAt).getTime() / 1000)) });
  return output;
}

export function buildMonadClearance(result: MonadTrustDecision, trustGate: Address, now = new Date()) {
  const provenance = issuedDecisions.get(result);
  if (!provenance || !result.executable || !["ALLOW", "ALLOW_WITH_LIMITS"].includes(result.decision.decision)) {
    throw new Error("Only a server-issued executable Monad decision can produce a clearance");
  }
  if (!isAddress(trustGate) || trustGate === zeroAddress || !Number.isFinite(now.getTime())) throw new Error("Invalid TrustGate or clearance time");
  const current = BigInt(Math.floor(now.getTime() / 1000));
  const issuedAt = BigInt(Math.floor(new Date(result.decision.issuedAt).getTime() / 1000));
  if (current < issuedAt || current > provenance.expiresAt) throw new Error("Monad decision is not currently valid");
  const message = {
    decisionId: keccak256(toBytes(result.decision.decisionId)),
    subject: result.decision.subject.wallet as Address, executor: result.decision.request.executor as Address,
    counterparty: result.decision.request.counterparty as Address, actionHash: result.actionHash,
    requestedAmount: result.requestedAmount, maxAmount: result.maxAmount,
    snapshotHash: result.evidenceHash, policyVersion: keccak256(toBytes(METROPOLIS_TRUST_VERSION)),
    evaluator: zeroAddress, issuedAt, expiresAt: provenance.expiresAt,
  };
  const domain = getTrustGateEip712Domain(10143, trustGate);
  return deepFreeze({ message, domain, digest: hashTypedData({ domain, types: EIP712_CLEARANCE_TYPES, primaryType: "TrustClearance", message }) });
}
export async function signMonadClearance(result: MonadTrustDecision, trustGate: Address, signer: LocalAccount, now = new Date()) {
  const clearance = buildMonadClearance(result, trustGate, now);
  const signature = await signer.signTypedData({ domain: clearance.domain, types: EIP712_CLEARANCE_TYPES,
    primaryType: "TrustClearance", message: clearance.message });
  return deepFreeze({ ...clearance, signature, attester: signer.address });
}
export function monadApprovalChallenge(clearance: ReturnType<typeof buildMonadClearance>, nonce: bigint, deadline: bigint): Hex {
  if (nonce < BigInt(0) || deadline < clearance.message.issuedAt || deadline > clearance.message.expiresAt) throw new Error("Invalid passkey approval nonce or deadline");
  return keccak256(encodeAbiParameters([
    { type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "address" },
    { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint64" },
  ], [MONAD_APPROVAL_TYPEHASH, BigInt(10143), clearance.message.executor, clearance.domain.verifyingContract,
    clearance.digest, clearance.message.actionHash, nonce, deadline]));
}

/** All offers share one owner budget, executor and task. A low price cannot override a failed policy. */
export function selectMonadPurchase(
  offers: readonly { evidence: MonadEvidenceBundle; amountUsdc: string }[],
  intent: Omit<MonadPurchaseIntent, "amountUsdc">,
  optimizeFor: "trust" | "cost" = "trust",
  now = new Date(),
) {
  if (offers.length === 0 || offers.length > 32 || !["trust", "cost"].includes(optimizeFor)) throw new Error("Invalid Monad candidate selection");
  const seen = new Set<string>();
  const candidates = offers.map(offer => {
    assertVerifiedMonadEvidence(offer.evidence);
    const id = offer.evidence.identity.agentId;
    if (seen.has(id)) throw new Error("Duplicate agent in candidate selection");
    seen.add(id);
    return { agentId: id, owner: offer.evidence.identity.owner,
      result: evaluateMonadPurchase(offer.evidence, { ...intent, amountUsdc: offer.amountUsdc }, now) };
  });
  const eligible = candidates.filter(candidate => candidate.result.executable);
  const priceOrder = (a: MonadTrustDecision, b: MonadTrustDecision) => a.requestedAmount < b.requestedAmount ? -1
    : a.requestedAmount > b.requestedAmount ? 1 : 0;
  eligible.sort((a, b) => {
    const trustOrder = Number(b.result.decision.decision === "ALLOW") - Number(a.result.decision.decision === "ALLOW")
      || b.result.decision.trust.score - a.result.decision.trust.score;
    return (optimizeFor === "cost" ? priceOrder(a.result, b.result) || trustOrder : trustOrder || priceOrder(a.result, b.result))
      || a.agentId.localeCompare(b.agentId);
  });
  const selected = eligible[0] ?? null;
  const sharedOwnership = new Set(candidates.map(candidate => candidate.owner.toLowerCase())).size < candidates.length;
  return deepFreeze({ candidates, selected, optimizeFor,
    explanation: selected ? `Selected ${selected.agentId} from ${eligible.length} policy-eligible offers, ordered by ${optimizeFor}.`
      : "No candidate has sufficient verified evidence within the owner budget. No clearance can be issued.",
    disclosures: sharedOwnership ? ["Some candidate identities share an onchain owner; these are not independent providers."] : [],
  });
}
