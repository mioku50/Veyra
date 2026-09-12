/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { createWalletClient, http, parseEventLogs } from "viem";
import { arcTestnet } from "viem/chains";
import { getArcPublicClient } from "../../erc8183/client.ts";
import { prepareDeliverableCommitment } from "../../erc8183/deliverable.ts";
import { executeOffchainJobEvaluation } from "../../erc8183/evaluator.ts";
import type { VeyraDeliverableV1 } from "../../erc8183/types.ts";
import {
  ARC_USDC_ADDRESS,
  Erc8183JobLifecycle,
  Erc8183LifecycleError,
  PHASE_EXECUTION_STATE,
  PHASE_NEXT_ACTOR,
  resolveRoleSigners,
  type Erc8183PendingAction,
  type Erc8183Phase,
  type Erc8183StepResult,
} from "./erc8183-lifecycle.ts";
import type { ExecutionRailAdapter, NormalizedRailResult, RailExecutionParams } from "./types.ts";

/**
 * ERC-8183 rail.
 *
 * The adapter authorizes (Trust Gate clearance), opens the job as the client,
 * and then drives the lifecycle only as far as the roles Veyra legitimately
 * holds allow. Phases belonging to the counterparty park the execution and
 * report the exact call the counterparty still owes, rather than Veyra signing
 * both sides of its own trade.
 */

const VEYRA_TRUST_GATE_ABI = [
  {
    name: "consumeClearance",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "clearance",
        type: "tuple",
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
      },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    name: "verifyClearance",
    type: "function",
    stateMutability: "view",
    inputs: [
      {
        name: "clearance",
        type: "tuple",
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
      },
      { name: "signature", type: "bytes" },
    ],
    outputs: [
      { name: "valid", type: "bool" },
      { name: "signer", type: "address" },
    ],
  },
  {
    name: "consumedClearances",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "digest", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const USDC_TRANSFER_ABI = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { indexed: true, name: "from", type: "address" },
      { indexed: true, name: "to", type: "address" },
      { indexed: false, name: "value", type: "uint256" },
    ],
  },
] as const;

/** Raw deliverable content, before it is wrapped in a commitment envelope. */
export interface Erc8183Deliverable {
  contentUri: string;
  contentHash: `0x${string}`;
  contentType?: "application/json";
}

/** Everything the rail observed, carried back to the executor unchanged. */
export interface Erc8183RailTrace {
  jobId: string | null;
  phase: Erc8183Phase | null;
  executionState: string | null;
  steps: Erc8183StepResult[];
  pendingAction: Erc8183PendingAction | null;
  providerSimulated: boolean;
}

function fail(
  params: RailExecutionParams,
  failureCode: string,
  extra: Partial<NormalizedRailResult> = {},
): NormalizedRailResult {
  return {
    executionId: params.executionId,
    rail: "erc8183",
    success: false,
    failureCode,
    economicCommitted: false,
    economicSettled: false,
    actualSettledAmountUsdc: 0,
    serviceSucceeded: false,
    evidenceType: "erc8183_job_rejected",
    ...extra,
  };
}

export class Erc8183ExecutionAdapter implements ExecutionRailAdapter {
  readonly rail = "erc8183" as const;

  async prepare(params: RailExecutionParams): Promise<any> {
    const lifecycle = this.tryLifecycle(params);
    return {
      rail: "erc8183",
      jobContract: lifecycle?.commerce ?? process.env.NEXT_PUBLIC_ERC8183_CONTRACT_ADDRESS ?? null,
      providerWallet: params.counterpartyWallet,
      evaluatorAddress: lifecycle?.evaluatorContract
        ?? params.evaluatorAddress
        ?? process.env.NEXT_PUBLIC_VEYRA_ERC8183_EVALUATOR_ADDRESS
        ?? null,
      clientWallet: lifecycle?.signers.client.address ?? null,
      maxAmountUsdc: params.amountUsdc,
      selectionHash: params.selectionHash,
      clearanceDigest: params.clearanceDigest,
      lifecycle: [
        "client:createJob",
        "provider:setBudget",
        "client:approve+fund",
        "provider:submit",
        "evaluator:executeVerdict",
      ],
    };
  }

  async execute(params: RailExecutionParams): Promise<NormalizedRailResult> {
    if (!params.clearancePayload?.message || !params.clearancePayload?.signature) {
      return fail(params, "CLEARANCE_REQUIRED");
    }
    if (!params.counterpartyWallet || /^0x0{40}$/i.test(params.counterpartyWallet)) {
      return fail(params, "INVALID_COUNTERPARTY_WALLET");
    }

    if (process.env.NODE_ENV === "test" && process.env.EXECUTION_ALLOW_TEST_FALLBACK === "true") {
      return this.testHarnessResult(params);
    }

    let lifecycle: Erc8183JobLifecycle;
    try {
      lifecycle = new Erc8183JobLifecycle({
        evaluatorContract: (params.evaluatorAddress as `0x${string}`) || undefined,
        signers: resolveRoleSigners(),
      });
    } catch (err: any) {
      return fail(params, err instanceof Erc8183LifecycleError ? err.code : "ERC8183_KEYS_OR_RPC_UNAVAILABLE");
    }

    const trace: Erc8183RailTrace = {
      jobId: null,
      phase: null,
      executionState: null,
      steps: [],
      pendingAction: null,
      providerSimulated: lifecycle.signers.providerSimulated,
    };

    try {
      const clearanceFailure = await this.consumeClearance(params, lifecycle);
      if (clearanceFailure) return fail(params, clearanceFailure, { rawResult: trace });

      const created = await lifecycle.createJob({
        provider: params.counterpartyWallet,
        description: `Veyra Job ${params.executionId} (${params.capability})`,
      });
      trace.jobId = created.jobId;
      trace.steps.push(created);

      return await this.advance(params, lifecycle, created.jobId, trace);
    } catch (err: any) {
      const code = err instanceof Erc8183LifecycleError ? err.code : "ERC8183_LIVE_EXECUTION_ERROR";
      return fail(params, `${code}${err?.message && code === "ERC8183_LIVE_EXECUTION_ERROR" ? `: ${err.message}` : ""}`, {
        economicCommitted: trace.steps.some((s) => s.action === "fund"),
        externalReference: trace.jobId,
        rawResult: trace,
      });
    }
  }

  /**
   * Advances the job through every phase Veyra is entitled to act in, stopping
   * at the first phase that belongs to someone else. Re-entrant: call it again
   * once the counterparty has acted.
   */
  async advance(
    params: RailExecutionParams,
    lifecycle: Erc8183JobLifecycle,
    jobId: string,
    trace: Erc8183RailTrace = {
      jobId, phase: null, executionState: null, steps: [],
      pendingAction: null, providerSimulated: lifecycle.signers.providerSimulated,
    },
    deliverable?: Erc8183Deliverable,
  ): Promise<NormalizedRailResult> {
    // Bounded: five phases, and every iteration either advances the phase or stops.
    for (let guard = 0; guard < 6; guard += 1) {
      const { phase, job } = await lifecycle.readPhase(jobId);
      trace.phase = phase;
      trace.executionState = PHASE_EXECUTION_STATE[phase];

      const actor = PHASE_NEXT_ACTOR[phase];
      if (!actor) break;

      if (actor === "provider" && !lifecycle.signers.provider) {
        trace.pendingAction = lifecycle.describePendingAction(
          phase, job,
          "Veyra holds no key for the provider; the counterparty must sign this step.",
        );
        break;
      }

      if (phase === "CREATED_AWAITING_BUDGET") {
        trace.steps.push(await lifecycle.setBudget({ jobId, amountUsdc: params.amountUsdc }));
        continue;
      }

      if (phase === "BUDGETED_AWAITING_FUNDING") {
        // The clearance amount is the ceiling: whatever the provider priced the
        // job at, Veyra escrows nothing above what it authorized.
        trace.steps.push(await lifecycle.fundEscrow({
          jobId, authorizedAmountUsdc: params.amountUsdc,
        }));
        continue;
      }

      if (phase === "FUNDED_AWAITING_SUBMISSION") {
        if (!deliverable) {
          trace.pendingAction = lifecycle.describePendingAction(
            phase, job, "No deliverable has been produced for this job yet.",
          );
          break;
        }
        trace.steps.push(await lifecycle.submitDeliverable({
          jobId, deliverable: this.envelope(deliverable),
        }));
        continue;
      }

      if (phase === "SUBMITTED_AWAITING_EVALUATION") {
        if (!deliverable) {
          trace.pendingAction = lifecycle.describePendingAction(
            phase, job, "The deliverable content is required to evaluate the submission.",
          );
          break;
        }
        return await this.evaluate(params, lifecycle, jobId, deliverable, trace);
      }
    }

    return this.resultForPhase(params, lifecycle, jobId, trace);
  }

  /* ---- evaluator role ---- */

  private async evaluate(
    params: RailExecutionParams,
    lifecycle: Erc8183JobLifecycle,
    jobId: string,
    deliverable: Erc8183Deliverable,
    trace: Erc8183RailTrace,
  ): Promise<NormalizedRailResult> {
    const evalResult = await executeOffchainJobEvaluation({
      chainId: 5042002,
      agenticCommerce: lifecycle.commerce,
      jobId,
      deliverable: this.envelope(deliverable),
      evaluatorContract: lifecycle.evaluatorContract,
      attesterPrivateKey: lifecycle.signers.evaluatorAttesterKey,
      relayerPrivateKey: lifecycle.signers.evaluatorRelayerKey,
      rpcUrl: lifecycle.rpcUrl,
    });

    const settled = evalResult.status === "completed" && evalResult.decision === "complete";
    const { phase } = await lifecycle.readPhase(jobId);
    trace.phase = phase;
    trace.executionState = PHASE_EXECUTION_STATE[phase];

    return {
      executionId: params.executionId,
      rail: "erc8183",
      success: settled,
      failureCode: settled ? null : evalResult.failureCategory || "EVALUATION_REJECTED",
      economicCommitted: true,
      economicSettled: settled,
      actualSettledAmountUsdc: await this.settledAmount(
        lifecycle, evalResult.settlementTxHash, params.counterpartyWallet,
      ),
      serviceSucceeded: settled,
      externalReference: jobId,
      createTx: trace.steps.find((s) => s.action === "createJob")?.txHash ?? null,
      completeTx: evalResult.settlementTxHash || null,
      evaluationId: evalResult.reportHash || null,
      evaluationVerdict: settled ? "Complete" : "Reject",
      evidenceType: settled ? "erc8183_job_completed" : "erc8183_job_rejected",
      rawResult: { ...trace, evaluation: evalResult },
    };
  }

  /* ---- helpers ---- */

  /** One envelope for both the onchain commitment and the evaluation. */
  private envelope(deliverable: Erc8183Deliverable): VeyraDeliverableV1 {
    return prepareDeliverableCommitment({
      contentUri: deliverable.contentUri,
      contentHash: deliverable.contentHash,
      contentType: deliverable.contentType,
    }).deliverable;
  }

  private tryLifecycle(params: RailExecutionParams): Erc8183JobLifecycle | null {
    try {
      return new Erc8183JobLifecycle({
        evaluatorContract: (params.evaluatorAddress as `0x${string}`) || undefined,
      });
    } catch {
      return null;
    }
  }

  /**
   * The Trust Gate binds a clearance to one executor address and rejects anyone
   * else, so the signer is chosen by the clearance rather than by convention.
   */
  private async consumeClearance(
    params: RailExecutionParams,
    lifecycle: Erc8183JobLifecycle,
  ): Promise<string | null> {
    const trustGate = (process.env.NEXT_PUBLIC_VEYRA_TRUST_GATE_ADDRESS
      || process.env.VEYRA_TRUST_GATE_ADDRESS
      || "0x1cD66BCd4FCB73a079c05635840Fde029Ce6BEbB") as `0x${string}`;

    const message = params.clearancePayload!.message;
    const signature = params.clearancePayload!.signature;
    const publicClient = getArcPublicClient(lifecycle.rpcUrl);

    const [valid] = await publicClient.readContract({
      address: trustGate,
      abi: VEYRA_TRUST_GATE_ABI,
      functionName: "verifyClearance",
      args: [message, signature],
    });
    if (!valid) return "INVALID_CLEARANCE_ONCHAIN";

    const executor = String(message.executor || "").toLowerCase();
    const candidates = [
      lifecycle.signers.client,
      lifecycle.signers.evaluatorRelayer,
      ...(lifecycle.signers.provider ? [lifecycle.signers.provider] : []),
    ];
    const account = candidates.find((a) => a.address.toLowerCase() === executor);
    if (!account) return "CLEARANCE_EXECUTOR_UNAVAILABLE";

    const wallet = createWalletClient({ account, chain: arcTestnet, transport: http(lifecycle.rpcUrl) });
    const txHash = await wallet.writeContract({
      address: trustGate,
      abi: VEYRA_TRUST_GATE_ABI,
      functionName: "consumeClearance",
      args: [message, signature],
      account,
      chain: arcTestnet,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    return receipt.status === "success" ? null : "CLEARANCE_CONSUMPTION_REVERTED";
  }

  private async settledAmount(
    lifecycle: Erc8183JobLifecycle,
    settlementTxHash: string | null | undefined,
    provider: `0x${string}`,
  ): Promise<number> {
    if (!settlementTxHash) return 0;
    const publicClient = getArcPublicClient(lifecycle.rpcUrl);
    const receipt = await publicClient.getTransactionReceipt({
      hash: settlementTxHash as `0x${string}`,
    });
    // Arc mirrors every USDC movement twice: once on the 18-decimal native
    // pseudo-token and once on the 6-decimal ERC-20 interface. They are the same
    // balance, so only the ERC-20 view may be read as an amount - matching the
    // native log and dividing by 1e6 overstates settlement by a factor of 1e12.
    const transfers = parseEventLogs({
      abi: USDC_TRANSFER_ABI,
      eventName: "Transfer",
      logs: receipt.logs,
    });
    const paid = transfers.find(
      (log) =>
        log.address.toLowerCase() === ARC_USDC_ADDRESS.toLowerCase()
        && log.args.to?.toLowerCase() === provider.toLowerCase(),
    );
    return paid ? Number(paid.args.value) / 1e6 : 0;
  }

  /** Non-terminal phases are not failures: the job is open and owed an action. */
  private async resultForPhase(
    params: RailExecutionParams,
    lifecycle: Erc8183JobLifecycle,
    jobId: string,
    trace: Erc8183RailTrace,
  ): Promise<NormalizedRailResult> {
    const { phase } = await lifecycle.readPhase(jobId);
    const escrowed = trace.steps.some((s) => s.action === "fund")
      || ["FUNDED_AWAITING_SUBMISSION", "SUBMITTED_AWAITING_EVALUATION", "COMPLETED", "REJECTED"].includes(phase);

    return {
      executionId: params.executionId,
      rail: "erc8183",
      success: phase === "COMPLETED",
      failureCode: phase === "REJECTED" ? "EVALUATION_REJECTED" : phase === "EXPIRED" ? "ERC8183_JOB_EXPIRED" : null,
      economicCommitted: escrowed,
      economicSettled: phase === "COMPLETED",
      actualSettledAmountUsdc: 0,
      serviceSucceeded: phase === "COMPLETED",
      externalReference: jobId,
      createTx: trace.steps.find((s) => s.action === "createJob")?.txHash ?? null,
      evidenceType:
        phase === "COMPLETED" ? "erc8183_job_completed"
          : phase === "REJECTED" ? "erc8183_job_rejected"
            : "erc8183_job_created",
      rawResult: trace,
    };
  }

  private testHarnessResult(params: RailExecutionParams): NormalizedRailResult {
    const mockTx = `0x${Buffer.from(`tx_erc8183_${params.executionId}`).toString("hex").padEnd(64, "0")}` as `0x${string}`;
    const mockJobId = `job_test_${params.executionId.slice(0, 8)}`;
    return {
      executionId: params.executionId,
      rail: "erc8183",
      success: true,
      economicCommitted: true,
      economicSettled: true,
      actualSettledAmountUsdc: params.amountUsdc,
      serviceSucceeded: true,
      externalReference: mockJobId,
      createTx: mockTx,
      completeTx: mockTx,
      evaluationId: `eval_${params.executionId}`,
      evaluationVerdict: "Complete",
      evidenceType: "erc8183_job_completed",
      rawResult: { status: "completed", decision: "complete", jobId: mockJobId, amountUsdc: params.amountUsdc },
    };
  }
}
