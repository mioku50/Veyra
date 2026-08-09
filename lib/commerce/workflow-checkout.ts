import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  createPublicClient,
  getAddress,
  http,
  isAddress,
  parseUnits,
  verifyMessage,
  type Address,
  type Hex,
} from "viem";
import {
  getHostedRunnerConfig,
} from "../agent/hosted-policy.ts";
import {
  hostedWorkflowInputMetadata,
  type HostedPlannerSnapshot,
  type HostedWorkflowRequest,
  type HostedWorkflowType,
} from "../agent/hosted-workflows.ts";
import {
  getHostedWorkflowCheckoutConfig,
  priceHostedWorkflow,
} from "../agent/workflow-pricing.ts";
import { getServerSupabaseConfig } from "../supabase/server-env.ts";
import {
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_EXPLORER_URL,
  ARC_TESTNET_RPC_URL,
  arcTestnetChain,
} from "../wallet/arc.ts";
import { BRAND } from "../brand.ts";
import { API_QUALITY_FINALIZER_PRICE_USDC } from "../services/constants.ts";

export const WORKFLOW_CHECKOUT_API_QUALITY_PRICE_USDC = API_QUALITY_FINALIZER_PRICE_USDC;

type CheckoutLaunchReason =
  | "created"
  | "idempotent"
  | "idempotency_conflict"
  | "active_job"
  | "cooldown"
  | "rate_limited";

export type HostedCheckoutPaymentMode = "sponsored" | "paid";
export type HostedCheckoutQuoteStatus =
  | "quoted"
  | "consumed"
  | "completed"
  | "failed"
  | "expired"
  | "credited"
  | "cancelled";

export type HostedWorkflowQuoteRow = {
  id: string;
  idempotency_hash: string;
  request_hash: string;
  requester_fingerprint: string;
  requester_wallet: string;
  workflow_type: HostedWorkflowType | string;
  task: string;
  input_preview: string;
  input_hash: string;
  budget_usdc: string;
  planner_snapshot: HostedPlannerSnapshot & Record<string, unknown>;
  selected_services: HostedPlannerSnapshot["selectedServices"];
  estimated_provider_cost_usdc: string;
  platform_fee_usdc: string;
  list_price_usdc: string;
  payment_mode: HostedCheckoutPaymentMode;
  amount_due_usdc: string;
  treasury_address: string;
  chain_id: number | string;
  asset: "native_usdc";
  status: HostedCheckoutQuoteStatus;
  job_id: string | null;
  user_payment_id: string | null;
  expires_at: string;
  created_at: string;
  consumed_at: string | null;
  byoa_agent_id?: string | null;
  machine_credential_id?: string | null;
  owner_wallet?: string | null;
  seller_service_id?: string | null;
  seller_service_version?: number | null;
  seller_id?: string | null;
  seller_net_amount_usdc?: string | null;
};

export type HostedWorkflowUserPaymentRow = {
  id: string;
  quote_id: string;
  job_id: string | null;
  requester_wallet: string;
  payment_mode: HostedCheckoutPaymentMode;
  status: "sponsored" | "settled" | "credit_issued" | "refund_pending" | "refunded";
  gross_amount_usdc: string;
  estimated_provider_cost_usdc: string;
  provider_cost_usdc: string;
  platform_fee_usdc: string;
  net_revenue_usdc: string;
  credit_amount_usdc: string;
  chain_id: number | string;
  asset: "native_usdc";
  treasury_address: string;
  transaction_hash: string | null;
  block_number: number | string | null;
  settled_at: string | null;
  credited_at: string | null;
  completed_at: string | null;
  failure_reason: string | null;
  sponsorship_source?: "user_quota" | "scheduled_monitoring";
  created_at: string;
};

export class HostedCheckoutPolicyError extends Error {
  constructor(
    public readonly reason:
      | "active_job"
      | "cooldown"
      | "rate_limited"
      | "idempotency_conflict",
    public readonly retryAfterSeconds = 0,
  ) {
    super(reason);
  }
}

export type HostedCheckoutInfrastructureStage =
  | "quote_lookup"
  | "runner_configuration"
  | "checkout_configuration"
  | "policy_lookup"
  | "pricing"
  | "sponsorship_lookup"
  | "quote_persistence";

export class HostedCheckoutInfrastructureError extends Error {
  constructor(public readonly stage: HostedCheckoutInfrastructureStage) {
    super(`Hosted checkout infrastructure is unavailable at ${stage}.`);
    this.name = "HostedCheckoutInfrastructureError";
  }
}

let checkoutClient: SupabaseClient | null = null;

export function setCheckoutClientForTesting(client: SupabaseClient | null) {
  checkoutClient = client;
}

function getCheckoutClient() {
  if (!checkoutClient) {
    const config = getServerSupabaseConfig();
    checkoutClient = createClient(config.url, config.key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return checkoutClient;
}

function rpcClient() {
  const rpcUrl = process.env.ARC_TESTNET_RPC_URL?.trim() || ARC_TESTNET_RPC_URL;
  return createPublicClient({ chain: arcTestnetChain, transport: http(rpcUrl) });
}

function secondsUntil(value: string) {
  return Math.max(1, Math.ceil((Date.parse(value) - Date.now()) / 1_000));
}

function publicQuote(row: HostedWorkflowQuoteRow) {
  const meta = (row.planner_snapshot as any)?.metadata as Record<string, any> | undefined;
  const sellerSnapshot = row.seller_service_id && row.seller_service_version && row.seller_id
    ? {
        serviceId: String(meta?.seller_service_public_id ?? ""),
        serviceVersion: Number(row.seller_service_version),
      }
    : null;
  const publicPlan = sellerSnapshot
    ? {
        version: row.planner_snapshot.version,
        workflowType: row.workflow_type,
        workflowLabel: row.planner_snapshot.workflowLabel,
        inputPreview: row.planner_snapshot.inputPreview,
        inputSha256: row.planner_snapshot.inputSha256,
        estimatedSpendUsdc: row.planner_snapshot.estimatedSpendUsdc,
        selectedServices: [{
          serviceId: sellerSnapshot.serviceId,
          serviceVersion: sellerSnapshot.serviceVersion,
          name: (row.selected_services?.[0] as { name?: string } | undefined)?.name ?? "External Service",
          priceUsdc: Number(row.estimated_provider_cost_usdc),
          providerType: "external_seller",
        }],
      }
    : {
        ...row.planner_snapshot,
        metadata: meta
          ? {
              ...(meta.agentTrustInput
                ? { agentTrustInput: meta.agentTrustInput }
                : {}),
              ...(meta.requestedSources
                ? { requestedSources: meta.requestedSources }
                : {}),
            }
          : undefined,
      };
  return {
    id: row.id,
    requesterWallet: getAddress(row.requester_wallet),
    workflowType: row.workflow_type,
    inputPreview: row.input_preview,
    inputSha256: row.input_hash,
    plan: publicPlan,
    pricing: sellerSnapshot
      ? {
          estimatedProviderCostUsdc: Number(row.estimated_provider_cost_usdc),
          listPriceUsdc: Number(row.list_price_usdc),
          amountDueUsdc: Number(row.amount_due_usdc),
        }
      : {
          estimatedProviderCostUsdc: Number(row.estimated_provider_cost_usdc),
          platformFeeUsdc: Number(row.platform_fee_usdc),
          listPriceUsdc: Number(row.list_price_usdc),
          amountDueUsdc: Number(row.amount_due_usdc),
        },
    paymentMode: row.payment_mode,
    treasuryAddress: getAddress(row.treasury_address),
    chainId: Number(row.chain_id),
    asset: row.asset,
    status: row.status,
    expiresAt: row.expires_at,
    jobId: row.job_id,
    userPaymentId: row.user_payment_id,
    byoaAgentId: row.byoa_agent_id || meta?.byoa_agent_id || null,
    machineCredentialId: row.machine_credential_id || meta?.machine_credential_id || null,
    ownerWallet: row.owner_wallet || meta?.owner_wallet || null,
    sellerSnapshot,
  };
}

export type PublicHostedWorkflowQuote = ReturnType<typeof publicQuote>;

export function toPublicHostedWorkflowQuote(row: HostedWorkflowQuoteRow) {
  return publicQuote(row);
}

export function plannerSnapshotForHostedQuote(
  plan: HostedPlannerSnapshot,
  metadata: Record<string, unknown>,
): HostedPlannerSnapshot {
  return {
    ...plan,
    metadata: {
      ...(plan.metadata ?? {}),
      ...metadata,
    },
  };
}

export function sponsoredWorkflowAuthorizationMessage(
  quote: Pick<
    PublicHostedWorkflowQuote,
    "id" | "requesterWallet" | "inputSha256" | "expiresAt"
  >,
) {
  return [
    `${BRAND.name} sponsored workflow authorization`,
    `Quote: ${quote.id}`,
    `Requester: ${quote.requesterWallet}`,
    `Input SHA-256: ${quote.inputSha256}`,
    `Expires: ${quote.expiresAt}`,
    "No USDC payment is authorized by this signature.",
  ].join("\n");
}

async function currentPolicyState(
  requesterFingerprint: string,
  config: ReturnType<typeof getHostedRunnerConfig>,
) {
  const client = getCheckoutClient();
  const [{ data: active, error: activeError }, { data: latest, error: latestError }, rate] =
    await Promise.all([
      client.from("hosted_agent_jobs").select("id").in("status", ["queued", "running"]).limit(1),
      client
        .from("hosted_agent_jobs")
        .select("created_at")
        .eq("requester_fingerprint", requesterFingerprint)
        .order("created_at", { ascending: false })
        .limit(1),
      client
        .from("hosted_agent_jobs")
        .select("created_at", { count: "exact" })
        .eq("requester_fingerprint", requesterFingerprint)
        .gte(
          "created_at",
          new Date(Date.now() - config.rateLimitWindowSeconds * 1_000).toISOString(),
        )
        .order("created_at", { ascending: true }),
    ]);
  if (activeError || latestError || rate.error) {
    throw new Error("Unable to evaluate hosted checkout policy.");
  }
  if ((active ?? []).length > 0) {
    throw new HostedCheckoutPolicyError("active_job", 5);
  }
  const latestCreated = (latest?.[0] as { created_at?: string } | undefined)?.created_at;
  if (latestCreated) {
    const cooldownEnd = new Date(
      Date.parse(latestCreated) + config.cooldownSeconds * 1_000,
    ).toISOString();
    if (Date.parse(cooldownEnd) > Date.now()) {
      throw new HostedCheckoutPolicyError("cooldown", secondsUntil(cooldownEnd));
    }
  }
  if ((rate.count ?? 0) >= config.rateLimitMaxRuns) {
    const oldest = (rate.data?.[0] as { created_at?: string } | undefined)?.created_at;
    const retryAt = oldest
      ? new Date(
          Date.parse(oldest) + config.rateLimitWindowSeconds * 1_000,
        ).toISOString()
      : new Date(Date.now() + config.rateLimitWindowSeconds * 1_000).toISOString();
    throw new HostedCheckoutPolicyError("rate_limited", secondsUntil(retryAt));
  }
}

export async function createHostedWorkflowQuote(input: {
  idempotencyHash: string;
  requestHash: string;
  requesterFingerprint: string;
  requesterWallet: Address;
  request: HostedWorkflowRequest;
  plan: HostedPlannerSnapshot;
  byoaAgentId?: string;
  machineCredentialId?: string;
  ownerWallet?: string;
  metadata?: Record<string, unknown>;
  allowSponsored?: boolean;
  sponsorship?: "regular" | "scheduled_monitoring";
  sellerSnapshot?: {
    serviceId: string;
    servicePublicId: string;
    serviceVersion: number;
    sellerId: string;
    sellerPublicId: string;
    sellerNetAmountUsdc: number;
  };
}) {
  const client = getCheckoutClient();
  const existing = await client
    .from("hosted_workflow_quotes")
    .select("*")
    .eq("idempotency_hash", input.idempotencyHash)
    .maybeSingle();
  if (existing.error) throw new HostedCheckoutInfrastructureError("quote_lookup");
  if (existing.data) {
    const row = existing.data as HostedWorkflowQuoteRow;
    if (row.request_hash !== input.requestHash) {
      throw new HostedCheckoutPolicyError("idempotency_conflict");
    }
    return { quote: publicQuote(row), created: false };
  }

  let hostedConfig: ReturnType<typeof getHostedRunnerConfig>;
  try {
    hostedConfig = getHostedRunnerConfig();
  } catch {
    throw new HostedCheckoutInfrastructureError("runner_configuration");
  }
  let checkoutConfig: ReturnType<typeof getHostedWorkflowCheckoutConfig>;
  try {
    checkoutConfig = getHostedWorkflowCheckoutConfig();
  } catch {
    throw new HostedCheckoutInfrastructureError("checkout_configuration");
  }
  try {
    await currentPolicyState(input.requesterFingerprint, hostedConfig);
  } catch (error) {
    if (error instanceof HostedCheckoutPolicyError) throw error;
    throw new HostedCheckoutInfrastructureError("policy_lookup");
  }
  let pricing: ReturnType<typeof priceHostedWorkflow>;
  try {
    pricing = priceHostedWorkflow(input.plan, checkoutConfig);
  } catch {
    throw new HostedCheckoutInfrastructureError("pricing");
  }
  const inputMetadata = hostedWorkflowInputMetadata(input.request.inputText);
  const scheduledMonitoring = input.sponsorship === "scheduled_monitoring";
  if (
    scheduledMonitoring &&
    (
      typeof input.metadata?.monitoringWatchlistId !== "string" ||
      typeof input.metadata?.monitoringRecheckId !== "string"
    )
  ) {
    throw new Error("Scheduled monitoring sponsorship requires a persisted watchlist and recheck.");
  }
  const sponsored = scheduledMonitoring || input.allowSponsored === false
    ? { count: checkoutConfig.sponsoredQuota, error: null }
    : await client
      .from("hosted_workflow_user_payments")
      .select("id", { count: "exact", head: true })
      .eq("payment_mode", "sponsored")
      .ilike("requester_wallet", input.requesterWallet);
  if (sponsored.error) {
    throw new HostedCheckoutInfrastructureError("sponsorship_lookup");
  }
  const paymentMode: HostedCheckoutPaymentMode =
    scheduledMonitoring ||
    (sponsored.count ?? 0) < checkoutConfig.sponsoredQuota
      ? "sponsored"
      : "paid";
  const expiresAt = new Date(
    Date.now() + checkoutConfig.quoteExpirySeconds * 1_000,
  ).toISOString();

  const quoteMeta = {
    byoa_agent_id: input.byoaAgentId || null,
    machine_credential_id: input.machineCredentialId || null,
    owner_wallet: input.ownerWallet || null,
    seller_service_public_id: input.sellerSnapshot?.servicePublicId ?? null,
    seller_public_id: input.sellerSnapshot?.sellerPublicId ?? null,
    ...input.metadata,
  };

  const row = {
    idempotency_hash: input.idempotencyHash,
    request_hash: input.requestHash,
    requester_fingerprint: input.requesterFingerprint,
    requester_wallet: input.requesterWallet,
    workflow_type: input.request.workflowType,
    task: input.request.task,
    input_preview: inputMetadata.preview,
    input_hash: inputMetadata.sha256,
    budget_usdc: input.request.budgetUsdc,
    planner_snapshot: plannerSnapshotForHostedQuote(input.plan, quoteMeta),
    selected_services: input.plan.selectedServices,
    estimated_provider_cost_usdc: pricing.estimatedProviderCostUsdc,
    platform_fee_usdc: pricing.platformFeeUsdc,
    list_price_usdc: pricing.listPriceUsdc,
    payment_mode: paymentMode,
    amount_due_usdc: paymentMode === "sponsored" ? 0 : pricing.listPriceUsdc,
    treasury_address: checkoutConfig.treasuryAddress,
    chain_id: checkoutConfig.chainId,
    asset: checkoutConfig.asset,
    byoa_agent_id: input.byoaAgentId || null,
    machine_credential_id: input.machineCredentialId || null,
    owner_wallet: input.ownerWallet || null,
    seller_service_id: input.sellerSnapshot?.serviceId ?? null,
    seller_service_version: input.sellerSnapshot?.serviceVersion ?? null,
    seller_id: input.sellerSnapshot?.sellerId ?? null,
    seller_net_amount_usdc: input.sellerSnapshot?.sellerNetAmountUsdc ?? null,
    status: "quoted",
    expires_at: expiresAt,
  };
  const inserted = await client
    .from("hosted_workflow_quotes")
    .insert(row)
    .select("*")
    .single();
  if (inserted.error) {
    console.error("[hosted-checkout] quote insert failed", {
      code: inserted.error.code,
      message: inserted.error.message,
      details: inserted.error.details,
      hint: inserted.error.hint,
      workflowType: input.request.workflowType,
    });
    const replay = await client
      .from("hosted_workflow_quotes")
      .select("*")
      .eq("idempotency_hash", input.idempotencyHash)
      .maybeSingle();
    if (replay.data && (replay.data as HostedWorkflowQuoteRow).request_hash === input.requestHash) {
      return { quote: publicQuote(replay.data as HostedWorkflowQuoteRow), created: false };
    }
    if (inserted.error.message.includes("machine_quote_spending_limit_exceeded")) {
      throw new HostedCheckoutPolicyError("rate_limited");
    }
    throw new HostedCheckoutInfrastructureError("quote_persistence");
  }
  return {
    quote: publicQuote(inserted.data as HostedWorkflowQuoteRow),
    created: true,
  };
}

export async function getHostedWorkflowQuote(quoteId: string) {
  const { data, error } = await getCheckoutClient()
    .from("hosted_workflow_quotes")
    .select("*")
    .eq("id", quoteId)
    .maybeSingle();
  if (error) throw new Error("Unable to load hosted workflow quote.");
  if (!data) return null;
  const row = data as HostedWorkflowQuoteRow;
  const meta = (row.planner_snapshot as any)?.metadata as Record<string, any> | undefined;
  return {
    ...row,
    byoa_agent_id: row.byoa_agent_id || meta?.byoa_agent_id || null,
    machine_credential_id: row.machine_credential_id || meta?.machine_credential_id || null,
    owner_wallet: row.owner_wallet || meta?.owner_wallet || null,
  };
}

export function validateHostedWorkflowPaymentEvidence(input: {
  quote: Pick<
    HostedWorkflowQuoteRow,
    | "amount_due_usdc"
    | "requester_wallet"
    | "treasury_address"
    | "created_at"
    | "expires_at"
  >;
  transaction: {
    chainId?: number;
    from: string;
    to: string | null;
    value: bigint;
    input?: string;
  };
  receiptStatus: "success" | "reverted";
  settledAt: string;
}) {
  if (input.receiptStatus !== "success") {
    throw new Error("Workflow payment transaction reverted.");
  }
  // PostgREST may decode NUMERIC as either a string or a number depending on
  // the project/runtime version. viem requires a decimal string.
  const expectedAmount = parseUnits(String(input.quote.amount_due_usdc), 18);
  const transaction = input.transaction;
  const settledAt = Date.parse(input.settledAt);
  if (
    transaction.chainId !== ARC_TESTNET_CHAIN_ID ||
    !transaction.to ||
    transaction.from.toLowerCase() !== input.quote.requester_wallet.toLowerCase() ||
    transaction.to.toLowerCase() !== input.quote.treasury_address.toLowerCase() ||
    transaction.value !== expectedAmount ||
    (transaction.input !== "0x" && transaction.input !== undefined) ||
    !Number.isFinite(settledAt) ||
    settledAt < Date.parse(input.quote.created_at) - 30_000 ||
    settledAt > Date.parse(input.quote.expires_at) + 60_000
  ) {
    throw new Error("Workflow payment does not match the immutable quote.");
  }
}

async function verifyPaidTransaction(
  quote: HostedWorkflowQuoteRow,
  transactionHash: Hex,
) {
  const client = rpcClient();
  const receipt = await client.waitForTransactionReceipt({
    hash: transactionHash,
    confirmations: 1,
    timeout: 30_000,
  });
  const [transaction, block] = await Promise.all([
    client.getTransaction({ hash: transactionHash }),
    client.getBlock({ blockNumber: receipt.blockNumber }),
  ]);
  const settledAt = new Date(Number(block.timestamp) * 1_000).toISOString();
  validateHostedWorkflowPaymentEvidence({
    quote,
    transaction,
    receiptStatus: receipt.status,
    settledAt,
  });
  return {
    transactionHash,
    blockNumber: Number(receipt.blockNumber),
    settledAt,
  };
}

export async function confirmHostedWorkflowQuoteInput(input: {
  quoteId: string;
  idempotencyHash: string;
  requestHash: string;
  inputText: string;
  transactionHash?: string | null;
  signature?: string | null;
}) {
  const quote = await getHostedWorkflowQuote(input.quoteId);
  if (!quote) throw new Error("Hosted workflow quote was not found.");
  if (
    quote.idempotency_hash !== input.idempotencyHash ||
    quote.request_hash !== input.requestHash ||
    quote.input_hash !== hostedWorkflowInputMetadata(input.inputText).sha256
  ) {
    throw new HostedCheckoutPolicyError("idempotency_conflict");
  }

  let payment:
    | { transactionHash: Hex; blockNumber: number; settledAt: string }
    | { transactionHash: null; blockNumber: null; settledAt: null };
  if (quote.payment_mode === "paid") {
    if (!input.transactionHash || !/^0x[0-9a-fA-F]{64}$/.test(input.transactionHash)) {
      throw new Error("A valid Arc workflow payment transaction is required.");
    }
    payment = await verifyPaidTransaction(quote, input.transactionHash as Hex);
  } else {
    if (!input.signature || !/^0x[0-9a-fA-F]+$/.test(input.signature)) {
      throw new Error("A requester signature is required for a sponsored workflow.");
    }
    const safe = publicQuote(quote);
    const valid = await verifyMessage({
      address: getAddress(quote.requester_wallet),
      message: sponsoredWorkflowAuthorizationMessage(safe),
      signature: input.signature as Hex,
    });
    if (!valid) throw new Error("Sponsored workflow authorization is invalid.");
    payment = { transactionHash: null, blockNumber: null, settledAt: null };
  }

  const checkoutConfig = getHostedWorkflowCheckoutConfig();
  const { data, error } = await getCheckoutClient().rpc(
    "launch_hosted_workflow_checkout_v1",
    {
      p_quote_id: quote.id,
      p_idempotency_hash: input.idempotencyHash,
      p_request_hash: input.requestHash,
      p_payment_mode: quote.payment_mode,
      p_transaction_hash: payment.transactionHash,
      p_block_number: payment.blockNumber,
      p_settled_at: payment.settledAt,
      p_sponsored_quota: checkoutConfig.sponsoredQuota,
    },
  );
  if (error) throw new Error("Unable to finalize hosted workflow checkout.");
  const row = (data as Array<{
    job_id: string | null;
    user_payment_id: string | null;
    created: boolean;
    reason: CheckoutLaunchReason | "credit_issued" | "quote_expired" | "quote_not_found" | "payment_invalid" | "payment_reused" | "payment_mode_conflict" | "sponsored_quota_exhausted";
    retry_after_seconds: number;
  }> | null)?.[0];
  if (!row) throw new Error("Hosted workflow checkout returned no result.");
  if (row.job_id && (quote.machine_credential_id || quote.byoa_agent_id)) {
    await getCheckoutClient()
      .from("hosted_agent_jobs")
      .update({
        ...(quote.machine_credential_id ? { machine_credential_id: quote.machine_credential_id } : {}),
        ...(quote.byoa_agent_id ? { byoa_agent_id: quote.byoa_agent_id } : {}),
      })
      .eq("id", row.job_id);
  }
  return {
    jobId: row.job_id,
    userPaymentId: row.user_payment_id,
    created: row.created,
    reason: row.reason,
    retryAfterSeconds: row.retry_after_seconds,
  };
}

export async function confirmHostedWorkflowQuote(input: {
  quoteId: string;
  idempotencyHash: string;
  requestHash: string;
  request: HostedWorkflowRequest;
  transactionHash?: string | null;
  signature?: string | null;
}) {
  return confirmHostedWorkflowQuoteInput({
    quoteId: input.quoteId,
    idempotencyHash: input.idempotencyHash,
    requestHash: input.requestHash,
    inputText: input.request.inputText,
    transactionHash: input.transactionHash,
    signature: input.signature,
  });
}

export async function finalizeHostedWorkflowUserPayment(input: {
  jobId: string;
  providerCostUsdc: number;
  succeeded: boolean;
  failureReason?: string | null;
}) {
  const { data, error } = await getCheckoutClient().rpc(
    "finalize_hosted_workflow_user_payment_v1",
    {
      p_job_id: input.jobId,
      p_provider_cost_usdc: input.providerCostUsdc,
      p_succeeded: input.succeeded,
      p_failure_reason: input.failureReason ?? null,
    },
  );
  if (error) throw new Error("Unable to finalize hosted workflow user payment.");
  return data === true;
}

export async function getHostedWorkflowUserPaymentForJob(jobId: string) {
  const { data, error } = await getCheckoutClient()
    .from("hosted_workflow_user_payments")
    .select("*")
    .eq("job_id", jobId)
    .maybeSingle();
  if (error) throw new Error("Unable to load hosted workflow user payment.");
  if (!data) return null;
  const row = data as HostedWorkflowUserPaymentRow;
  return {
    id: row.id,
    quoteId: row.quote_id,
    paymentMode: row.payment_mode,
    status: row.status,
    requesterWallet: isAddress(row.requester_wallet)
      ? getAddress(row.requester_wallet)
      : row.requester_wallet,
    grossAmountUsdc: row.gross_amount_usdc,
    estimatedProviderCostUsdc: row.estimated_provider_cost_usdc,
    providerCostUsdc: row.provider_cost_usdc,
    platformFeeUsdc: row.platform_fee_usdc,
    netRevenueUsdc: row.net_revenue_usdc,
    creditAmountUsdc: row.credit_amount_usdc,
    transactionHash: row.transaction_hash,
    blockNumber: row.block_number === null ? null : Number(row.block_number),
    treasuryAddress: row.treasury_address,
    chainId: Number(row.chain_id),
    asset: row.asset,
    settledAt: row.settled_at,
    creditedAt: row.credited_at,
    completedAt: row.completed_at,
    failureReason: row.failure_reason,
    sponsorshipSource: row.sponsorship_source ?? "user_quota",
    transactionUrl: row.transaction_hash
      ? `${ARC_TESTNET_EXPLORER_URL}/tx/${row.transaction_hash}`
      : null,
  };
}

export type PublicHostedWorkflowUserPayment = NonNullable<
  Awaited<ReturnType<typeof getHostedWorkflowUserPaymentForJob>>
>;

export async function getHostedWorkflowCheckoutAnalytics() {
  const { data, error } = await getCheckoutClient()
    .from("hosted_workflow_user_payments")
    .select("payment_mode,status,gross_amount_usdc,provider_cost_usdc,platform_fee_usdc,net_revenue_usdc,credit_amount_usdc")
    .order("created_at", { ascending: false })
    .limit(1_000);
  if (error) throw new Error("Unable to load hosted workflow checkout analytics.");
  const rows = (data ?? []) as Array<Pick<
    HostedWorkflowUserPaymentRow,
    | "payment_mode"
    | "status"
    | "gross_amount_usdc"
    | "provider_cost_usdc"
    | "platform_fee_usdc"
    | "net_revenue_usdc"
    | "credit_amount_usdc"
  >>;
  const total = (field: keyof typeof rows[number]) =>
    rows.reduce((sum, row) => sum + Number(row[field] ?? 0), 0).toFixed(6);
  return {
    checkoutCount: rows.length,
    sponsoredCount: rows.filter((row) => row.payment_mode === "sponsored").length,
    paidCount: rows.filter((row) => row.payment_mode === "paid").length,
    creditedCount: rows.filter((row) => row.status === "credit_issued").length,
    userPaymentUsdc: total("gross_amount_usdc"),
    providerCostUsdc: total("provider_cost_usdc"),
    quotedPlatformFeeUsdc: total("platform_fee_usdc"),
    netRevenueUsdc: total("net_revenue_usdc"),
    creditAmountUsdc: total("credit_amount_usdc"),
  };
}
