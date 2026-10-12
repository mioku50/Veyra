import { z } from "zod";
import type { Hex } from "viem";
import { parsePurchaseTask, PaymentError, type PurchaseTask } from "./payment.ts";
import { parseMonadUsdc } from "./trust.ts";

export const READINESS_SERVICE_ID = "veyra.monad.readiness.v1";
export const READINESS_DELIVERABLE = "A finalized Monad Testnet readiness snapshot with reproducible checks, sources, blockers and next actions. No payment or production-readiness certification.";
const requestSchema = z.object({
  publicKey: z.string().regex(/^0x[0-9a-fA-F]{128}$/).transform(value => value.toLowerCase() as Hex),
  budgetUsdc: z.string().regex(/^(0|[1-9]\d{0,8})(\.\d{1,6})?$/),
  // Absent in historical V1 requests. Adding the signed V2 selector preserves their hashes.
  accountVersion: z.literal(2).optional(),
}).strict();
export type ReadinessRequest = z.infer<typeof requestSchema>;
export function readinessTask(input: unknown): PurchaseTask {
  const request = requestSchema.safeParse(input);
  if (!request.success) throw new PaymentError("Readiness requires a public P256 key and a decimal USDC budget.");
  parseMonadUsdc(request.data.budgetUsdc);
  return parsePurchaseTask({ serviceId: READINESS_SERVICE_ID, request: JSON.stringify(request.data), deliverable: READINESS_DELIVERABLE });
}
export function parseReadinessTask(input: unknown): { task: PurchaseTask; request: ReadinessRequest } {
  const task = parsePurchaseTask(input);
  let parsed: unknown;
  try { parsed = JSON.parse(task.request); } catch { throw new PaymentError("Unsupported readiness request."); }
  const canonical = readinessTask(parsed);
  if (task.serviceId !== canonical.serviceId || task.deliverable !== canonical.deliverable || task.request !== canonical.request) {
    throw new PaymentError("The task must use the exact readiness service request and deliverable.");
  }
  return { task, request: requestSchema.parse(parsed) };
}
