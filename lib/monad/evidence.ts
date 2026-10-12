import {
  decodeEventLog, erc20Abi, formatUnits, hashTypedData, isAddress, keccak256,
  recoverTypedDataAddress, toBytes, zeroAddress, type Address, type Hex,
} from "viem";
import type { ReputationScoringIdentity } from "../reputation/types.ts";
import { getMonadReadClient, MONAD_IDENTITY_ABI, MONAD_REPUTATION_ABI, readMonadAgentIdentity } from "./erc8004.ts";
import { MONAD_CONTRACTS } from "./config.ts";
import type { MonadHistoryEvidence } from "./freshness.ts";

const ZERO_HASH = `0x${"0".repeat(64)}`;
export const MONAD_ASSESSMENT_TYPES = {
  DeliveryAssessment: [
    { name: "agentId", type: "uint256" },
    { name: "buyer", type: "address" },
    { name: "seller", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "paymentTx", type: "bytes32" },
    { name: "requestHash", type: "bytes32" },
    { name: "responseHash", type: "bytes32" },
    { name: "delivered", type: "bool" },
    { name: "score", type: "uint8" },
    { name: "assessedAt", type: "uint64" },
  ],
} as const;

export function monadAssessmentDomain() {
  // Namespaces this offchain assessment to the canonical registry deployment.
  // The registry does not store or verify these operator signatures.
  return { name: "Veyra Monad Delivery Assessment", version: "1", chainId: 10143,
    verifyingContract: MONAD_CONTRACTS[10143].reputationRegistry } as const;
}
export type MonadDeliveryAssessment = {
  agentId: bigint; buyer: Address; seller: Address; amount: bigint; paymentTx: Hex;
  requestHash: Hex; responseHash: Hex; delivered: boolean; score: number; assessedAt: bigint;
};
export type SignedMonadAssessment = { message: MonadDeliveryAssessment; signature: Hex };

/** Operator configuration only. Never accept these lists or assessments as trusted HTTP request data. */
export type MonadEvidencePolicy = {
  feedbackClients?: readonly Address[];
  assessmentReporters?: readonly Address[];
  payments?: readonly { transactionHash: Hex; logIndex: number }[];
  assessments?: readonly SignedMonadAssessment[];
  minPaymentConfirmations?: number;
};
export type MonadEvidenceBundle = {
  identity: ReputationScoringIdentity & { paymentWallet: Address; blockNumber: bigint; commitment: "finalized" };
  securitySnapshot: { blockHash: Hex; observedAt: string };
  evidence: readonly MonadHistoryEvidence[];
  excluded: readonly string[];
  disclosures: readonly string[];
  collectedAt: string;
  evidenceHash: Hex;
};
const verifiedBundles = new WeakSet<object>();

export function assertVerifiedMonadEvidence(bundle: MonadEvidenceBundle): void {
  if (!verifiedBundles.has(bundle)) throw new Error("Monad evidence must be collected and verified on the server");
}
export function canonicalMonadHash(value: unknown): Hex {
  // Inputs are explicitly constructed and ordered; BigInt must not lose precision.
  return keccak256(toBytes(JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item)));
}
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
function validHash(value: string) { return /^0x[0-9a-fA-F]{64}$/.test(value) && value.toLowerCase() !== ZERO_HASH; }
function addresses(values: readonly Address[]): Address[] {
  if (values.some(value => !isAddress(value) || value === zeroAddress)
    || new Set(values.map(value => value.toLowerCase())).size !== values.length) {
    throw new Error("Evidence provenance addresses must be valid, nonzero and distinct");
  }
  return [...values].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

/** Read-only verification. No provider metadata URLs are fetched, and no wallet client is used. */
export async function collectMonadEvidence(
  agentId: bigint,
  policy: MonadEvidencePolicy = {},
  client = getMonadReadClient(),
  now?: Date,
): Promise<MonadEvidenceBundle> {
  if (client.chain.id !== 10143) throw new Error("Metropolis trust execution supports Monad Testnet only");
  if ([policy.feedbackClients, policy.assessmentReporters, policy.payments, policy.assessments].some(items => (items?.length ?? 0) > 32)) {
    throw new Error("An evidence collection supports at most 32 entries per source");
  }
  // Explicit clocks are for reproducible operator/fork tests. Live reads use the
  // completion time, so RPC latency does not make a legitimate block future-dated.
  const fixedTime = now === undefined ? undefined : new Date(now.getTime());
  const readTime = () => fixedTime ?? new Date();
  const seconds = () => Math.floor(readTime().getTime() / 1000);
  if (!Number.isSafeInteger(seconds()) || seconds() < 0) throw new Error("Invalid evidence collection time");
  // Monad's "latest" is a proposed block, not a finality commitment.
  const record = await readMonadAgentIdentity(agentId, client, "finalized");
  const securityBlock = await client.getBlock({ blockNumber: record.blockNumber });
  if (securityBlock.number !== record.blockNumber || !securityBlock.hash || !validHash(securityBlock.hash)
    || securityBlock.timestamp < BigInt(0) || securityBlock.timestamp > BigInt(seconds())) {
    throw new Error("Invalid finalized security snapshot block or timestamp");
  }
  const securitySnapshot = { blockHash: securityBlock.hash,
    observedAt: new Date(Number(securityBlock.timestamp) * 1000).toISOString() };
  const identity: MonadEvidenceBundle["identity"] = {
    agentId: `eip155:10143:${record.registry.toLowerCase()}:${agentId}`,
    chainId: 10143, identityRegistry: record.registry, owner: record.owner,
    metadataUri: record.tokenURI, verifiedOnchain: true,
    paymentWallet: record.paymentWallet, blockNumber: record.blockNumber, commitment: "finalized",
  };
  const providerAddresses = new Set([record.owner, record.paymentWallet].map(value => value.toLowerCase()));
  const excluded: string[] = [];
  const disclosures = [
    "ERC-8004 registration proves identity, not provider quality.",
    "Different client addresses do not establish independent ownership.",
    "A successful USDC transfer does not prove successful delivery.",
    "Delivery assessments are signed operator judgments; they are not independent onchain verdicts.",
    "Veyra confidence reflects evidence-category coverage, not a calibrated probability of success.",
    "Security snapshot freshness is separate from original payment and assessment event times.",
  ];
  const evidence: MonadHistoryEvidence[] = [];
  const append = (item: Omit<MonadHistoryEvidence, "agentId" | "evidenceId" | "canonicalHash" | "arcProofVerified">) => {
    const canonicalHash = canonicalMonadHash({ chainId: 10143, agentId: identity.agentId, ...item });
    evidence.push({ ...item, agentId: identity.agentId, evidenceId: `mve_${canonicalHash.slice(2, 18)}`,
      canonicalHash, arcProofVerified: false });
  };
  const clients = addresses(policy.feedbackClients ?? []).filter(address => {
    if (!providerAddresses.has(address.toLowerCase())) return true;
    excluded.push("Provider-owned wallet excluded from ERC-8004 feedback provenance.");
    return false;
  });
  if (clients.length) {
    // Only this explicitly documented 0..100 feedback convention can enter scoring.
    const [count, value, decimals] = await client.readContract({
      address: MONAD_CONTRACTS[10143].reputationRegistry, abi: MONAD_REPUTATION_ABI,
      functionName: "getSummary", args: [agentId, clients, "veyra.delivery", "score100"], blockNumber: record.blockNumber,
    });
    if (count > BigInt(0)) {
      if (decimals !== 0 || value < BigInt(0) || value > BigInt(100)) {
        excluded.push("Feedback values do not match the declared score100 convention.");
      } else {
        append({ type: "erc8004_feedback", tier: 1,
          sourceId: MONAD_CONTRACTS[10143].reputationRegistry,
          sourceHash: canonicalMonadHash({ blockNumber: record.blockNumber, clients, count, value, decimals }),
          score: Number(value), positive: value >= BigInt(80), confidence: 0.5,
          verifiedOnchain: true, sybilRisk: "low", observedAt: readTime().toISOString(),
          historyAnchorAt: null,
          reason: "Registry aggregate from explicit operator-selected clients; ownership and feedback age are unverified.",
        });
      }
    }
  }

  const confirmations = policy.minPaymentConfirmations ?? 2;
  if (!Number.isSafeInteger(confirmations) || confirmations < 2) throw new Error("At least two payment confirmations are required");
  const payments = new Map<string, { buyer: Address; amount: bigint; observedAt: string; blockNumber: bigint }>();
  const specs = [...(policy.payments ?? [])].sort((a, b) => a.transactionHash.localeCompare(b.transactionHash) || a.logIndex - b.logIndex);
  for (const spec of specs) {
    if (!validHash(spec.transactionHash) || !Number.isSafeInteger(spec.logIndex) || spec.logIndex < 0) throw new Error("Invalid payment evidence reference");
    const receipt = await client.getTransactionReceipt({ hash: spec.transactionHash });
    if (receipt.status !== "success" || receipt.transactionHash.toLowerCase() !== spec.transactionHash.toLowerCase()
      || receipt.blockNumber > record.blockNumber
      || record.blockNumber - receipt.blockNumber + BigInt(1) < BigInt(confirmations)) {
      throw new Error("Payment receipt failed or is not sufficiently confirmed");
    }
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    if (block.number !== receipt.blockNumber || block.hash !== receipt.blockHash || block.timestamp < BigInt(0)
      || block.timestamp > securityBlock.timestamp) throw new Error("Payment receipt is not in the canonical historical block");
    const [historicalOwner, historicalWallet] = await Promise.all([
      client.readContract({ address: record.registry, abi: MONAD_IDENTITY_ABI, functionName: "ownerOf",
        args: [agentId], blockNumber: receipt.blockNumber }),
      client.readContract({ address: record.registry, abi: MONAD_IDENTITY_ABI, functionName: "getAgentWallet",
        args: [agentId], blockNumber: receipt.blockNumber }),
    ]);
    if (historicalOwner.toLowerCase() !== record.owner.toLowerCase()
      || historicalWallet.toLowerCase() !== record.paymentWallet.toLowerCase()) {
      throw new Error("Payment history belongs to a different provider owner or payment wallet");
    }
    const log = receipt.logs.find(item => item.logIndex === spec.logIndex);
    if (!log || log.removed || log.address.toLowerCase() !== MONAD_CONTRACTS[10143].usdc.toLowerCase()
      || log.blockHash !== receipt.blockHash || log.blockNumber !== receipt.blockNumber
      || log.transactionHash.toLowerCase() !== receipt.transactionHash.toLowerCase()) {
      throw new Error("Payment evidence must reference a canonical USDC Transfer log");
    }
    const { args } = decodeEventLog({ abi: erc20Abi, eventName: "Transfer", data: log.data, topics: log.topics });
    if (args.to.toLowerCase() !== record.paymentWallet.toLowerCase() || args.from === zeroAddress || args.value <= BigInt(0)) {
      throw new Error("USDC payment does not match the agent's canonical payment wallet");
    }
    if (providerAddresses.has(args.from.toLowerCase())) {
      excluded.push("Provider self-transfer excluded from economic evidence.");
      continue;
    }
    const key = `${spec.transactionHash.toLowerCase()}:${spec.logIndex}`;
    if (payments.has(key)) continue;
    // Bound conversion before passing numeric USDC values to the existing score engine.
    if (args.value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Economic evidence amount is too large");
    const observedAt = new Date(Number(block.timestamp) * 1000).toISOString();
    payments.set(key, { buyer: args.from, amount: args.value, observedAt, blockNumber: receipt.blockNumber });
    append({ type: "usdc_payment_success", tier: 3, sourceId: key, sourceHash: receipt.blockHash,
      score: 100, positive: true, confidence: 1, economicValueUsdc: Number(formatUnits(args.value, 6)),
      counterpartyAddress: args.from, verifiedOnchain: true, sybilRisk: "none", observedAt,
      historyAnchorAt: observedAt,
      reason: "Confirmed canonical USDC transfer; delivery is assessed separately.",
    });
  }

  const reporters = addresses(policy.assessmentReporters ?? []);
  const seenAssessments = new Set<string>();
  const assessedPayments = new Set<string>();
  for (const assessment of policy.assessments ?? []) {
    const message = assessment.message;
    if (typeof message.delivered !== "boolean" || message.agentId !== agentId || message.seller.toLowerCase() !== record.paymentWallet.toLowerCase()
      || !validHash(message.paymentTx) || !validHash(message.requestHash) || !validHash(message.responseHash)
      || !Number.isInteger(message.score) || message.score < 0 || message.score > 100
      || message.assessedAt < BigInt(0) || message.assessedAt > BigInt(seconds())) {
      throw new Error("Invalid delivery assessment binding or timestamp");
    }
    const matching = [...payments.entries()].filter(([key, payment]) => key.startsWith(`${message.paymentTx.toLowerCase()}:`)
      && payment.buyer.toLowerCase() === message.buyer.toLowerCase() && payment.amount === message.amount);
    if (matching.length !== 1) throw new Error("Delivery assessment needs one unambiguous verified payment");
    const [paymentKey, payment] = matching[0];
    if (message.assessedAt < BigInt(Math.floor(new Date(payment.observedAt).getTime() / 1000))) {
      throw new Error("Delivery assessment predates the verified payment");
    }
    const reporter = await recoverTypedDataAddress({ domain: monadAssessmentDomain(), types: MONAD_ASSESSMENT_TYPES,
      primaryType: "DeliveryAssessment", message, signature: assessment.signature });
    if (!reporters.some(address => address.toLowerCase() === reporter.toLowerCase()) || providerAddresses.has(reporter.toLowerCase())) {
      throw new Error("Delivery assessment signer is not an allowed non-provider reporter");
    }
    const digest = hashTypedData({ domain: monadAssessmentDomain(), types: MONAD_ASSESSMENT_TYPES,
      primaryType: "DeliveryAssessment", message });
    if (seenAssessments.has(digest)) continue;
    if (assessedPayments.has(paymentKey)) throw new Error("Conflicting assessments for one payment require review");
    seenAssessments.add(digest);
    assessedPayments.add(paymentKey);
    const passed = message.delivered && message.score >= 80;
    const common = { tier: 2 as const, sourceId: digest, sourceHash: message.responseHash,
      score: passed ? message.score : Math.min(message.score, 49), positive: passed, confidence: 0.9,
      counterpartyAddress: payment.buyer, verifiedOnchain: false, sybilRisk: "none" as const,
      observedAt: new Date(Number(message.assessedAt) * 1000).toISOString(),
      historyAnchorAt: payment.observedAt,
      reason: `Operator assessment signed by ${reporter}; payment ${paymentKey}; request ${message.requestHash}.`,
    };
    // One report describes two separate dimensions, not two independent validators.
    append({ ...common, type: "service_delivery" });
    append({ ...common, type: "api_quality" });
  }
  if (!evidence.length) disclosures.push("No corroborated payment, delivery or configured feedback history is available.");
  evidence.sort((a, b) => a.canonicalHash.localeCompare(b.canonicalHash));
  const collectedAt = readTime().toISOString();
  const bundle = deepFreeze({ identity, securitySnapshot, evidence, excluded, disclosures, collectedAt,
    evidenceHash: canonicalMonadHash({ identity, securitySnapshot, evidence, excluded, disclosures, collectedAt }) });
  verifiedBundles.add(bundle);
  return bundle;
}
