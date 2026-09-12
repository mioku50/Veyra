/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createWalletClient,
  erc20Abi,
  http,
  parseEventLogs,
  parseUnits,
  type Account,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { ERC8183_AGENTIC_COMMERCE_ABI } from "../../erc8183/abi.ts";
import { fetchOnchainJob, getArcPublicClient } from "../../erc8183/client.ts";
import { computeDeliverableHash } from "../../erc8183/deliverable.ts";
import type { Erc8183Job, VeyraDeliverableV1 } from "../../erc8183/types.ts";

/**
 * ERC-8183 job lifecycle as a role-separated state machine.
 *
 * Veyra does not "execute an ERC-8183 job". Three independent parties do, and
 * Veyra orchestrates the transitions between them:
 *
 *   client    createJob          -> CREATED_AWAITING_BUDGET
 *   provider  setBudget          -> BUDGETED_AWAITING_FUNDING
 *   client    approve + fund     -> FUNDED_AWAITING_SUBMISSION
 *   provider  submit             -> SUBMITTED_AWAITING_EVALUATION
 *   evaluator executeVerdict     -> COMPLETED | REJECTED
 *
 * Each step is bound to exactly one role's signer and guarded by the phase read
 * back from the contract. Veyra owns the client and evaluator roles. The
 * provider is a counterparty: signing for it is an explicitly enabled testnet
 * simulation, never a default, and every step it produces is flagged as such.
 */

export const ARC_CHAIN_ID = 5_042_002;
export const ARC_USDC_ADDRESS = "0x3600000000000000000000000000000000000000" as const;

export const DEFAULT_AGENTIC_COMMERCE = "0x0747EEf0706327138c69792bF28Cd525089e4583" as const;
export const DEFAULT_EVALUATOR_CONTRACT = "0x0d2c04580e081e222bbe5bf9818af337e2633eb7" as const;

/** Phase of the onchain job. Always derived from the contract, never cached. */
export type Erc8183Phase =
  | "CREATED_AWAITING_BUDGET"
  | "BUDGETED_AWAITING_FUNDING"
  | "FUNDED_AWAITING_SUBMISSION"
  | "SUBMITTED_AWAITING_EVALUATION"
  | "COMPLETED"
  | "REJECTED"
  | "EXPIRED";

export type Erc8183Role = "client" | "provider" | "evaluator";

/** Who is expected to act next in each phase. `null` means the job is terminal. */
export const PHASE_NEXT_ACTOR: Record<Erc8183Phase, Erc8183Role | null> = {
  CREATED_AWAITING_BUDGET: "provider",
  BUDGETED_AWAITING_FUNDING: "client",
  FUNDED_AWAITING_SUBMISSION: "provider",
  SUBMITTED_AWAITING_EVALUATION: "evaluator",
  COMPLETED: null,
  REJECTED: null,
  EXPIRED: null,
};

/** Execution-attempt state each phase maps to, for the outer state machine. */
export const PHASE_EXECUTION_STATE = {
  CREATED_AWAITING_BUDGET: "WAITING_FOR_PROVIDER",
  BUDGETED_AWAITING_FUNDING: "EXECUTING",
  FUNDED_AWAITING_SUBMISSION: "WAITING_FOR_PROVIDER",
  SUBMITTED_AWAITING_EVALUATION: "EVALUATING",
  COMPLETED: "COMPLETED",
  REJECTED: "EVALUATION_REJECTED",
  EXPIRED: "EXPIRED",
} as const satisfies Record<Erc8183Phase, string>;

export interface Erc8183StepResult {
  role: Erc8183Role;
  action: string;
  actor: `0x${string}`;
  txHash: Hex | null;
  phaseBefore: Erc8183Phase;
  phaseAfter: Erc8183Phase;
  gasUsed: string | null;
  /** True when Veyra signed for a role it does not legitimately own. */
  simulated: boolean;
}

/** What an independent counterparty must do for the job to advance. */
export interface Erc8183PendingAction {
  role: Erc8183Role;
  phase: Erc8183Phase;
  chainId: number;
  contract: `0x${string}`;
  functionName: string;
  args: string[];
  expectedSigner: `0x${string}`;
  reason: string;
}

export class Erc8183LifecycleError extends Error {
  constructor(
    public readonly code: string,
    message?: string,
  ) {
    super(message || code);
    this.name = "Erc8183LifecycleError";
  }
}

/* -------------------------------------------------------------------------- */
/* Role signers                                                               */
/* -------------------------------------------------------------------------- */

export interface Erc8183RoleSigners {
  /** Veyra acting as the buying agent that opens and funds the job. */
  client: Account;
  /** The counterparty. Present only under explicit testnet simulation. */
  provider: Account | null;
  /** Signs the EIP-712 verdict. */
  evaluatorAttester: Account;
  /** Submits the verdict to the evaluator contract. */
  evaluatorRelayer: Account;
  /**
   * Raw evaluator key material. The offchain evaluation service signs and
   * relays on its own, so it needs the keys rather than the derived accounts.
   */
  evaluatorAttesterKey: `0x${string}`;
  evaluatorRelayerKey: `0x${string}`;
  /** True when `provider` is a locally held key rather than a real counterparty. */
  providerSimulated: boolean;
}

function readKey(...names: string[]): `0x${string}` | null {
  for (const name of names) {
    const raw = process.env[name]?.trim();
    if (raw) return (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;
  }
  return null;
}

/**
 * Resolves one signer per role. Fails closed: a missing client or evaluator key
 * is an error rather than a silent fallback to some other role's key.
 */
export function resolveRoleSigners(): Erc8183RoleSigners {
  const clientKey = readKey("ERC8183_CLIENT_PRIVATE_KEY", "BUYER_PRIVATE_KEY");
  if (!clientKey) throw new Erc8183LifecycleError("ERC8183_CLIENT_KEY_UNAVAILABLE");

  const attesterKey = readKey(
    "ERC8183_EVALUATOR_ATTESTER_PRIVATE_KEY",
    "VEYRA_TRUST_ATTESTER_PRIVATE_KEY",
  );
  if (!attesterKey) throw new Erc8183LifecycleError("ERC8183_ATTESTER_KEY_UNAVAILABLE");

  const relayerKey = readKey("ERC8183_EVALUATOR_RELAYER_PRIVATE_KEY");
  if (!relayerKey) throw new Erc8183LifecycleError("ERC8183_RELAYER_KEY_UNAVAILABLE");

  // The provider is a counterparty. Holding its key is a testnet convenience for
  // end-to-end acceptance runs and must be asked for by name.
  const simulationEnabled = process.env.ERC8183_ALLOW_PROVIDER_SIMULATION === "true";
  const providerKey = simulationEnabled
    ? readKey("ERC8183_PROVIDER_PRIVATE_KEY", "SELLER_PRIVATE_KEY")
    : null;

  const client = privateKeyToAccount(clientKey);
  const provider = providerKey ? privateKeyToAccount(providerKey) : null;

  if (provider && provider.address.toLowerCase() === client.address.toLowerCase()) {
    throw new Erc8183LifecycleError(
      "ERC8183_CLIENT_PROVIDER_COLLISION",
      "Client and provider resolve to the same address; a job cannot have one party on both sides.",
    );
  }

  return {
    client,
    provider,
    evaluatorAttester: privateKeyToAccount(attesterKey),
    evaluatorRelayer: privateKeyToAccount(relayerKey),
    evaluatorAttesterKey: attesterKey,
    evaluatorRelayerKey: relayerKey,
    providerSimulated: Boolean(provider),
  };
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

/** Which phases a step may be attempted from, and which role owns it. */
const STEP_GUARDS = {
  setBudget: { from: ["CREATED_AWAITING_BUDGET"], role: "provider" },
  fund: { from: ["BUDGETED_AWAITING_FUNDING"], role: "client" },
  submit: { from: ["FUNDED_AWAITING_SUBMISSION"], role: "provider" },
  evaluate: { from: ["SUBMITTED_AWAITING_EVALUATION"], role: "evaluator" },
} as const satisfies Record<string, { from: readonly Erc8183Phase[]; role: Erc8183Role }>;

export function derivePhase(job: Erc8183Job): Erc8183Phase {
  switch (job.status) {
    case "Open":
      // The contract keeps a job Open until it is funded; the budget is what
      // separates "created" from "priced".
      return job.budget > BigInt(0) ? "BUDGETED_AWAITING_FUNDING" : "CREATED_AWAITING_BUDGET";
    case "Funded":
      return "FUNDED_AWAITING_SUBMISSION";
    case "Submitted":
      return "SUBMITTED_AWAITING_EVALUATION";
    case "Completed":
      return "COMPLETED";
    case "Rejected":
      return "REJECTED";
    case "Expired":
      return "EXPIRED";
  }
}

export interface Erc8183LifecycleOptions {
  commerce?: `0x${string}`;
  evaluatorContract?: `0x${string}`;
  rpcUrl?: string;
  signers?: Erc8183RoleSigners;
}

export class Erc8183JobLifecycle {
  readonly commerce: `0x${string}`;
  readonly evaluatorContract: `0x${string}`;
  readonly rpcUrl: string;
  readonly signers: Erc8183RoleSigners;

  private readonly publicClient: ReturnType<typeof getArcPublicClient>;

  constructor(options: Erc8183LifecycleOptions = {}) {
    this.commerce = (options.commerce
      || process.env.NEXT_PUBLIC_ERC8183_CONTRACT_ADDRESS
      || DEFAULT_AGENTIC_COMMERCE) as `0x${string}`;
    this.evaluatorContract = (options.evaluatorContract
      || process.env.NEXT_PUBLIC_VEYRA_ERC8183_EVALUATOR_ADDRESS
      || DEFAULT_EVALUATOR_CONTRACT) as `0x${string}`;

    const rpcUrl = options.rpcUrl || process.env.ARC_TESTNET_RPC_URL;
    if (!rpcUrl) throw new Erc8183LifecycleError("ERC8183_RPC_UNAVAILABLE");
    this.rpcUrl = rpcUrl;

    this.signers = options.signers || resolveRoleSigners();
    this.publicClient = getArcPublicClient(rpcUrl);
  }

  /* ---- reads ---- */

  async readJob(jobId: bigint | string): Promise<Erc8183Job> {
    return fetchOnchainJob(this.commerce, BigInt(jobId), this.publicClient);
  }

  async readPhase(jobId: bigint | string): Promise<{ phase: Erc8183Phase; job: Erc8183Job }> {
    const job = await this.readJob(jobId);
    return { phase: derivePhase(job), job };
  }

  /* ---- role plumbing ---- */

  private walletFor(role: Erc8183Role): { account: Account; simulated: boolean } {
    if (role === "client") return { account: this.signers.client, simulated: false };
    if (role === "evaluator") return { account: this.signers.evaluatorRelayer, simulated: false };
    if (!this.signers.provider) {
      throw new Erc8183LifecycleError(
        "ERC8183_PROVIDER_SIGNER_UNAVAILABLE",
        "The provider is an independent counterparty and Veyra holds no key for it.",
      );
    }
    return { account: this.signers.provider, simulated: this.signers.providerSimulated };
  }

  private async send(
    role: Erc8183Role,
    action: string,
    phaseBefore: Erc8183Phase,
    request: Parameters<ReturnType<typeof createWalletClient>["writeContract"]>[0],
  ): Promise<Omit<Erc8183StepResult, "phaseAfter">> {
    const { account, simulated } = this.walletFor(role);
    const wallet = createWalletClient({ account, chain: arcTestnet, transport: http(this.rpcUrl) });

    const txHash = await wallet.writeContract({ ...(request as any), account, chain: arcTestnet });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      throw new Erc8183LifecycleError(
        `ERC8183_${action.toUpperCase()}_REVERTED`,
        `${action} reverted in ${txHash}`,
      );
    }

    return {
      role,
      action,
      actor: account.address,
      txHash,
      phaseBefore,
      gasUsed: receipt.gasUsed.toString(),
      simulated,
    };
  }

  private async guard(step: keyof typeof STEP_GUARDS, jobId: bigint) {
    const { phase, job } = await this.readPhase(jobId);
    const guard = STEP_GUARDS[step];
    if (!(guard.from as readonly Erc8183Phase[]).includes(phase)) {
      throw new Erc8183LifecycleError(
        "ERC8183_PHASE_VIOLATION",
        `${step} requires phase ${guard.from.join("|")}, job ${jobId} is ${phase}.`,
      );
    }
    return { phase, job };
  }

  /* ---- CLIENT: create ---- */

  async createJob(input: {
    provider: `0x${string}`;
    description: string;
    expiresInSeconds?: number;
  }): Promise<Erc8183StepResult & { jobId: string }> {
    const expiredAt = BigInt(Math.floor(Date.now() / 1000) + (input.expiresInSeconds ?? 3600));

    const { account } = this.walletFor("client");
    const wallet = createWalletClient({ account, chain: arcTestnet, transport: http(this.rpcUrl) });

    const txHash = await wallet.writeContract({
      address: this.commerce,
      abi: ERC8183_AGENTIC_COMMERCE_ABI,
      functionName: "createJob",
      args: [
        input.provider,
        this.evaluatorContract,
        expiredAt,
        input.description,
        "0x0000000000000000000000000000000000000000",
      ],
      account,
      chain: arcTestnet,
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      throw new Erc8183LifecycleError("ERC8183_CREATE_JOB_REVERTED", `createJob reverted in ${txHash}`);
    }

    const [created] = parseEventLogs({
      abi: ERC8183_AGENTIC_COMMERCE_ABI,
      eventName: "JobCreated",
      logs: receipt.logs,
    });
    if (!created) throw new Erc8183LifecycleError("ERC8183_JOB_ID_NOT_FOUND");

    // The event is the only authority on who the contract recorded as the parties.
    if (created.args.client.toLowerCase() !== account.address.toLowerCase()) {
      throw new Erc8183LifecycleError("ERC8183_CLIENT_MISMATCH");
    }
    if (created.args.provider.toLowerCase() !== input.provider.toLowerCase()) {
      throw new Erc8183LifecycleError("ERC8183_PROVIDER_MISMATCH");
    }
    if (created.args.evaluator.toLowerCase() !== this.evaluatorContract.toLowerCase()) {
      throw new Erc8183LifecycleError("ERC8183_EVALUATOR_MISMATCH");
    }

    const jobId = created.args.jobId;
    const { phase } = await this.readPhase(jobId);

    return {
      role: "client",
      action: "createJob",
      actor: account.address,
      txHash,
      phaseBefore: "CREATED_AWAITING_BUDGET",
      phaseAfter: phase,
      gasUsed: receipt.gasUsed.toString(),
      simulated: false,
      jobId: jobId.toString(),
    };
  }

  /* ---- PROVIDER: price the job ---- */

  async setBudget(input: { jobId: bigint | string; amountUsdc: number }): Promise<Erc8183StepResult> {
    const jobId = BigInt(input.jobId);
    const { phase } = await this.guard("setBudget", jobId);
    const amount = parseUnits(input.amountUsdc.toFixed(6), 6);

    const step = await this.send("provider", "setBudget", phase, {
      address: this.commerce,
      abi: ERC8183_AGENTIC_COMMERCE_ABI,
      functionName: "setBudget",
      args: [jobId, amount, "0x"],
    } as any);

    const { phase: phaseAfter, job } = await this.readPhase(jobId);
    if (job.budget !== amount) {
      throw new Erc8183LifecycleError(
        "ERC8183_BUDGET_MISMATCH",
        `Job ${jobId} priced at ${job.budget} base units, expected ${amount}.`,
      );
    }
    return { ...step, phaseAfter };
  }

  /* ---- CLIENT: escrow ---- */

  /**
   * Approve then fund. This is the step that actually moves USDC into escrow and
   * the one the previous adapter never performed, which is why no job it opened
   * could ever pay out.
   */
  async fundEscrow(input: {
    jobId: bigint | string;
    /** Ceiling from the clearance. The provider prices the job independently, so
     *  the budget it set is untrusted input until it is checked against this. */
    authorizedAmountUsdc: number;
  }): Promise<Erc8183StepResult & { escrowedUsdc: number }> {
    const jobId = BigInt(input.jobId);
    const { phase, job } = await this.guard("fund", jobId);

    if (job.budget <= BigInt(0)) throw new Erc8183LifecycleError("ERC8183_BUDGET_NOT_SET");

    const authorized = parseUnits(input.authorizedAmountUsdc.toFixed(6), 6);
    if (job.budget > authorized) {
      throw new Erc8183LifecycleError(
        "ERC8183_BUDGET_MISMATCH",
        `Job ${jobId} demands ${job.budget} base units, authorized ceiling is ${authorized}.`,
      );
    }

    const { account } = this.walletFor("client");
    if (job.client.toLowerCase() !== account.address.toLowerCase()) {
      throw new Erc8183LifecycleError(
        "ERC8183_NOT_JOB_CLIENT",
        `Job ${jobId} belongs to ${job.client}; this lifecycle signs as ${account.address}.`,
      );
    }

    const allowance = await this.publicClient.readContract({
      address: ARC_USDC_ADDRESS,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account.address, this.commerce],
    });

    if (allowance < job.budget) {
      await this.send("client", "approve", phase, {
        address: ARC_USDC_ADDRESS,
        abi: erc20Abi,
        functionName: "approve",
        args: [this.commerce, job.budget],
      } as any);
    }

    const step = await this.send("client", "fund", phase, {
      address: this.commerce,
      abi: ERC8183_AGENTIC_COMMERCE_ABI,
      functionName: "fund",
      args: [jobId, "0x"],
    } as any);

    const { phase: phaseAfter } = await this.readPhase(jobId);
    if (phaseAfter !== "FUNDED_AWAITING_SUBMISSION") {
      throw new Erc8183LifecycleError(
        "ERC8183_ESCROW_NOT_CONFIRMED",
        `fund() succeeded but job ${jobId} reads as ${phaseAfter}.`,
      );
    }

    return { ...step, phaseAfter, escrowedUsdc: Number(job.budget) / 1e6 };
  }

  /* ---- PROVIDER: deliver ---- */

  /**
   * Commits the deliverable envelope, not the raw content hash. The evaluator
   * recomputes `computeDeliverableHash` and fails the job closed on mismatch, so
   * both sides must derive the commitment from the same function.
   */
  async submitDeliverable(input: {
    jobId: bigint | string;
    deliverable: VeyraDeliverableV1;
  }): Promise<Erc8183StepResult & { deliverableHash: `0x${string}` }> {
    const jobId = BigInt(input.jobId);
    const { phase } = await this.guard("submit", jobId);
    const deliverableHash = computeDeliverableHash(input.deliverable);

    const step = await this.send("provider", "submit", phase, {
      address: this.commerce,
      abi: ERC8183_AGENTIC_COMMERCE_ABI,
      functionName: "submit",
      args: [jobId, deliverableHash, "0x"],
    } as any);

    const { phase: phaseAfter } = await this.readPhase(jobId);
    return { ...step, phaseAfter, deliverableHash };
  }

  /* ---- pending counterparty action ---- */

  /**
   * Describes the call an independent party must make for the job to advance,
   * for phases Veyra cannot or should not act in itself.
   */
  describePendingAction(phase: Erc8183Phase, job: Erc8183Job, reason: string): Erc8183PendingAction | null {
    const role = PHASE_NEXT_ACTOR[phase];
    if (!role) return null;

    const shape: Record<string, { functionName: string; args: string[]; signer: `0x${string}` }> = {
      CREATED_AWAITING_BUDGET: {
        functionName: "setBudget(uint256,uint256,bytes)",
        args: [job.jobId.toString(), "<amount in USDC base units>", "0x"],
        signer: job.provider,
      },
      BUDGETED_AWAITING_FUNDING: {
        functionName: "fund(uint256,bytes)",
        args: [job.jobId.toString(), "0x"],
        signer: job.client,
      },
      FUNDED_AWAITING_SUBMISSION: {
        functionName: "submit(uint256,bytes32,bytes)",
        args: [job.jobId.toString(), "<deliverable hash>", "0x"],
        signer: job.provider,
      },
      SUBMITTED_AWAITING_EVALUATION: {
        functionName: "executeVerdict((address,uint256,bytes32,bytes32,bytes32,uint8,uint64,uint64,uint256),bytes)",
        args: ["<signed verdict>", "<attester signature>"],
        signer: job.evaluator,
      },
    };

    const entry = shape[phase];
    if (!entry) return null;

    return {
      role,
      phase,
      chainId: ARC_CHAIN_ID,
      contract: phase === "SUBMITTED_AWAITING_EVALUATION" ? this.evaluatorContract : this.commerce,
      functionName: entry.functionName,
      args: entry.args,
      expectedSigner: entry.signer,
      reason,
    };
  }
}
