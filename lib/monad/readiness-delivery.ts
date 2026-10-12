import { getAddress, isAddress, keccak256, toHex, zeroAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import { deepFreeze, MONAD_ASSESSMENT_TYPES, monadAssessmentDomain } from "./evidence.ts";
import { getMonadReadClient } from "./erc8004.ts";
import { PaymentError, parsePaymentApproval, purchaseRequestHash } from "./payment.ts";
import { verifyPaymentReceipt } from "./payment-receipt.ts";
import { generateReadinessReport, parseReadinessTask, readinessResponseHash } from "./readiness.ts";
import { readRegisteredReadinessAgent, readinessAgentUri } from "./readiness-registration.ts";
import { metropolisAccountProfile } from "./account.ts";

type Client = ReturnType<typeof getMonadReadClient>;
const deliveries = new WeakSet<object>();
async function paidReadinessContext(value: unknown, hash: Hex, client: Client) {
  const approval = parsePaymentApproval(value), { task, request } = parseReadinessTask(approval.quote.task);
  if (!approval.quote.provider.demonstration || request.publicKey !== approval.quote.publicKey
    || request.budgetUsdc !== approval.quote.budgetUsdc
    || (request.accountVersion ?? 1) !== metropolisAccountProfile(approval.quote.factory).accountVersion) {
    throw new PaymentError("Readiness delivery must match this demonstration purchase, passkey, account version and budget.");
  }
  const payment = await verifyPaymentReceipt(approval, hash, client);
  const identity = await readRegisteredReadinessAgent(BigInt(payment.provider.agentId), BigInt(payment.finalizedBlock), client);
  if (identity.wallet !== payment.provider.payee || identity.tokenURI !== readinessAgentUri()) {
    throw new PaymentError("This provider does not currently identify the Veyra readiness demonstration.");
  }
  return { payment, identity, task };
}

/** Run the actual local service after payment. A blocked readiness finding can still be a useful delivered result. */
export async function fulfillReadinessPurchase(value: unknown, hash: Hex, client: Client = getMonadReadClient()) {
  const { payment, identity, task } = await paidReadinessContext(value, hash, client);
  const report = await generateReadinessReport(task, client);
  if (report.account.address !== payment.account) throw new PaymentError("The delivered report must describe the account that paid for it.");
  if (BigInt(report.observation.blockNumber) <= BigInt(payment.blockNumber)) throw new PaymentError("The result must observe a finalized block after the payment.");
  const delivery = deepFreeze({
    kind: "veyra.metropolis.readiness-delivery" as const, version: 1 as const, chainId: 10143 as const,
    payment, providerOwner: identity.owner, task, requestHash: purchaseRequestHash(task), responseHash: readinessResponseHash(report), report,
    result: "available" as const, assessment: "not_signed" as const,
    disclosures: ["Veyra-created, operator-run demonstration; provider and evaluator are not claimed to be independent organizations.",
      "Payment is verified separately from result correctness. Human usefulness scoring is still required.",
      "No favorable ERC-8004 feedback or independent provider attestation was produced."],
  });
  deliveries.add(delivery);
  return delivery;
}
export type ReadinessDelivery = Awaited<ReturnType<typeof fulfillReadinessPurchase>>;
const deliverySchema = z.object({
  kind: z.literal("veyra.metropolis.readiness-delivery"), version: z.literal(1), chainId: z.literal(10143),
  payment: z.unknown(), providerOwner: z.string(), task: z.unknown(), requestHash: z.string(), responseHash: z.string(), report: z.unknown(),
  result: z.literal("available"), assessment: z.literal("not_signed"), disclosures: z.array(z.string()),
}).strict();

/** Reverify a persisted artifact through chain reads; deserialization alone carries no delivery provenance. */
export async function verifyReadinessDelivery(value: unknown, approval: unknown, hash: Hex, client: Client = getMonadReadClient()) {
  const candidate = deliverySchema.safeParse(value);
  if (!candidate.success) throw new PaymentError("Invalid readiness delivery artifact.");
  const data = candidate.data;
  const { payment, identity, task } = await paidReadinessContext(approval, hash, client);
  const observation = z.object({ observation: z.object({ blockNumber: z.string().regex(/^[1-9]\d{0,19}$/) }).passthrough() }).passthrough().safeParse(data.report);
  if (!observation.success) throw new PaymentError("The result has no valid snapshot block.");
  const reportBlock = BigInt(observation.data.observation.blockNumber);
  if (reportBlock <= BigInt(payment.blockNumber)) throw new PaymentError("A preview created before payment is not paid delivery evidence.");
  const report = await generateReadinessReport(task, client, reportBlock);
  if (report.account.address !== payment.account) throw new PaymentError("The saved report must describe the account that paid for it.");
  const persistedPayment = data.payment as Record<string, unknown> | null;
  const { finalizedBlock: _, ...currentPayment } = payment;
  const { finalizedBlock: oldHeight, ...originalPayment } = persistedPayment && typeof persistedPayment === "object" ? persistedPayment : {};
  if (data.responseHash !== readinessResponseHash(report) || data.requestHash !== purchaseRequestHash(task)
    || keccak256(toHex(JSON.stringify(data.report))) !== readinessResponseHash(report)
    || JSON.stringify(data.task) !== JSON.stringify(task) || data.providerOwner !== identity.owner
    || JSON.stringify(originalPayment) !== JSON.stringify(currentPayment)
    || typeof oldHeight !== "string" || !/^[1-9]\d{0,19}$/.test(oldHeight) || BigInt(oldHeight) < BigInt(payment.blockNumber) + BigInt(1)
    || BigInt(oldHeight) > BigInt(payment.finalizedBlock)) throw new PaymentError("The saved result or receipt does not match the paid request and canonical snapshot.");
  const delivery = deepFreeze({ ...data, payment, providerOwner: identity.owner, task, report,
    requestHash: purchaseRequestHash(task), responseHash: readinessResponseHash(report), disclosures: [
      "Veyra-created, operator-run demonstration; provider and evaluator are not claimed to be independent organizations.",
      "Payment is verified separately from result correctness. Human usefulness scoring is still required.",
      "No favorable ERC-8004 feedback or independent provider attestation was produced.",
    ] });
  deliveries.add(delivery);
  return delivery;
}

/** Human chooses usefulness score. This unsigned message cannot enter trust scoring before a real non-provider signature. */
export function planReadinessAssessment(delivery: ReadinessDelivery, reporter: Address, usefulnessScore: number, now = new Date()) {
  if (!deliveries.has(delivery)) throw new PaymentError("Reverify the payment and report before preparing an assessment.");
  if (!isAddress(reporter) || reporter === zeroAddress || [delivery.providerOwner, delivery.payment.provider.payee].some(address => address.toLowerCase() === reporter.toLowerCase())) {
    throw new PaymentError("The assessment requires an explicitly selected non-provider reporter.");
  }
  if (!Number.isInteger(usefulnessScore) || usefulnessScore < 0 || usefulnessScore > 100) throw new PaymentError("Select a usefulness score between zero and 100.");
  const assessedAt = Math.floor(now.getTime() / 1000);
  if (!Number.isSafeInteger(assessedAt) || BigInt(assessedAt) < BigInt(delivery.report.observation.timestamp)) throw new PaymentError("The assessment time must follow the observed result.");
  const message = { agentId: delivery.payment.provider.agentId, buyer: delivery.payment.account, seller: delivery.payment.provider.payee,
    amount: delivery.payment.amountUnits, paymentTx: delivery.payment.transactionHash, requestHash: delivery.requestHash,
    responseHash: delivery.responseHash, delivered: true, score: usefulnessScore, assessedAt: assessedAt.toString() };
  return deepFreeze({ kind: "veyra.metropolis.readiness-assessment-plan", version: 1, reporter: getAddress(reporter),
    typedData: { domain: monadAssessmentDomain(), types: MONAD_ASSESSMENT_TYPES, primaryType: "DeliveryAssessment", message },
    paymentReference: { transactionHash: delivery.payment.transactionHash, logIndex: delivery.payment.usdcTransferLogIndex },
    unsigned: true, broadcast: false,
    disclosures: ["The score is a human operator judgment, not a correctness probability or an independent onchain verdict.",
      "A non-provider address does not establish independent organizational ownership.",
      "This plan is not a signed assessment or an ERC-8004 review and cannot authorize any spend."],
  });
}
