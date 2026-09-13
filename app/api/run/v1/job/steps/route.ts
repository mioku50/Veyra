/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse, type NextRequest } from "next/server";
import { isAddress } from "viem";
import { BRAND } from "@/lib/brand";
import { authenticateSelectionRequest } from "@/lib/counterparty-selection/auth";
import { getExecutionAttempt } from "@/lib/execution/db";
import {
  encodeApproveUsdc,
  encodeCreateJob,
  encodeFundEscrow,
  readJob,
  readUsdcAllowance,
  type WalletTransaction,
} from "@/lib/erc8183/client-transactions";

export const dynamic = "force-dynamic";

/**
 * The next ERC-8183 transaction the buyer's own wallet must send.
 *
 * Veyra prepares and Veyra attests; it does not spend. Every call here returns
 * unsigned calldata for the buyer to sign in their wallet, so the escrow is
 * funded from the buyer's USDC and the job's client is the buyer's address —
 * not a Veyra key standing in for them.
 *
 * Called once with no jobId to get the creation step, then again with the jobId
 * that creation emitted to get the funding steps.
 */
export async function POST(request: NextRequest) {
  const auth = await authenticateSelectionRequest(request, "runs:create");
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: { code: "invalid_body" } }, { status: 400 });
  }

  const executionId = typeof body.executionId === "string" ? body.executionId.trim() : "";
  if (!executionId) {
    return NextResponse.json(
      { error: { code: "execution_required", message: "executionId is required." } },
      { status: 400 },
    );
  }

  const attempt = await getExecutionAttempt(executionId);
  if (!attempt) {
    return NextResponse.json(
      { error: { code: "execution_not_found", message: "No such prepared execution." } },
      { status: 404 },
    );
  }
  if (attempt.rail !== "erc8183") {
    return NextResponse.json(
      { error: { code: "wrong_rail", message: "This execution does not settle as an ERC-8183 job." } },
      { status: 422 },
    );
  }

  const buyer = typeof body.buyerWallet === "string" ? body.buyerWallet : "";
  if (!isAddress(buyer)) {
    return NextResponse.json(
      { error: { code: "buyer_wallet_required", message: "A connected wallet address is required." } },
      { status: 400 },
    );
  }

  const jobId = typeof body.jobId === "string" && /^\d+$/.test(body.jobId) ? body.jobId : null;

  // Phase one: the job does not exist yet.
  if (!jobId) {
    return NextResponse.json({
      phase: "create",
      executionId,
      steps: [encodeCreateJob({
        provider: attempt.counterpartyWallet,
        description: `${BRAND.name} ${attempt.capability} · ${executionId}`,
      })],
      note: "Send this from your wallet. It registers the job and emits the id the next call needs.",
    }, { headers: { "Cache-Control": "no-store" } });
  }

  // Phase two: the job exists, so the budget is onchain and can be read rather
  // than taken from the browser.
  const job = await readJob(jobId);
  if (!job) {
    return NextResponse.json(
      { error: { code: "job_not_found", message: `Job ${jobId} could not be read from Arc.` } },
      { status: 404 },
    );
  }
  if (job.client.toLowerCase() !== buyer.toLowerCase()) {
    return NextResponse.json(
      { error: { code: "not_job_client", message: "That job belongs to a different wallet." } },
      { status: 403 },
    );
  }
  if (job.budgetAtomic === "0") {
    return NextResponse.json({
      phase: "awaiting_budget",
      executionId,
      job,
      steps: [] as WalletTransaction[],
      note: "The provider has not set a budget yet. Escrow cannot be funded until it does, and that signature is theirs, not yours.",
    }, { headers: { "Cache-Control": "no-store" } });
  }

  const budget = BigInt(job.budgetAtomic);
  const allowance = await readUsdcAllowance(buyer as `0x${string}`);
  const steps: WalletTransaction[] = [];
  if (allowance < budget) steps.push(encodeApproveUsdc(budget));
  steps.push(encodeFundEscrow(jobId));

  return NextResponse.json({
    phase: "fund",
    executionId,
    job,
    // Stated so the reader can check it against what their wallet shows.
    budgetUsdc: job.budgetUsdc,
    allowanceUsdc: Number(allowance) / 1e6,
    steps,
    note: "Escrow is released to the provider only on a passing evaluator verdict, and refunded to you otherwise.",
  }, { headers: { "Cache-Control": "no-store" } });
}
