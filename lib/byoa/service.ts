import { createHash, createHmac, randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getAddress, isAddress, type Address } from "viem";
import {
  createHostedWorkflowPlan,
  hostedWorkflowInputMetadata,
  validateHostedWorkflowRequest,
} from "../agent/hosted-workflows.ts";
import { hostedServiceAllowlist } from "../agent/hosted-policy.ts";
import { validateIdempotencyKey } from "../agent/hosted-policy.ts";
import {
  getHostedWorkflowCheckoutConfig,
  priceHostedWorkflow,
} from "../agent/workflow-pricing.ts";
import { getServerSupabaseConfig } from "../supabase/server-env.ts";
import { ARC_TESTNET_USDC_ADDRESS } from "../wallet/arc.ts";
import { serviceRegistry } from "../services/registry.ts";
import { BRAND } from "../brand.ts";
import {
  createApiCredential,
  credentialExpiry,
  hashApiCredential,
  normalizeCredentialScopes,
  normalizeCredentialType,
} from "./auth.ts";
import {
  getByoaConfig,
  isCanaryAgentAllowed,
  isCanaryOwnerAllowed,
} from "./config.ts";
import type {
  ByoaAgentRow,
  ByoaCredentialRow,
  ByoaPassportRow,
  ByoaPolicyRow,
  ByoaQuoteRow,
  ByoaScope,
  ByoaServiceType,
  CredentialType,
  PublicByoaQuote,
} from "./types.ts";

export class ByoaError extends Error {
  constructor(
    message: string,
    public readonly reason: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

let byoaClient: SupabaseClient | null = null;

export function setByoaClientForTesting(client: SupabaseClient | null) {
  byoaClient = client;
}

export function getByoaClient() {
  if (!byoaClient) {
    const config = getServerSupabaseConfig();
    byoaClient = createClient(config.url, config.key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return byoaClient;
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function keyedDigest(purpose: string, value: string) {
  return createHmac("sha256", getByoaConfig().credentialPepper)
    .update(`${purpose}\n${value}`)
    .digest("hex");
}

export function byoaIdempotencyHash(agentId: string, idempotencyKey: string) {
  return keyedDigest("byoa-idempotency-v1", `${agentId}\n${idempotencyKey}`);
}

export function byoaRequestHash(
  agentId: string,
  request: ReturnType<typeof validateHostedWorkflowRequest>,
) {
  return keyedDigest(
    "byoa-request-v1",
    [
      agentId,
      request.workflowType,
      hostedWorkflowInputMetadata(request.inputText).sha256,
      request.task,
      request.marketSymbol ?? "none",
      request.budgetUsdc.toFixed(6),
    ].join("\n"),
  );
}

function validUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function requireUuid(value: string, label: string) {
  if (!validUuid(value)) throw new ByoaError(`${label} is invalid.`, "invalid_id");
  return value;
}

export function safeByoaError(error: unknown) {
  if (error instanceof ByoaError) return error.message;
  if (error instanceof Error && /not configured|missing|required/i.test(error.message)) {
    return "BYOA is not configured for this deployment.";
  }
  return "Unable to complete the BYOA request.";
}

function displayName(value: unknown) {
  if (typeof value !== "string") throw new ByoaError("Agent name must be a string.", "invalid_name");
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 80) {
    throw new ByoaError("Agent name must contain 2-80 characters.", "invalid_name");
  }
  return name;
}

function credentialLabel(value: unknown) {
  if (typeof value !== "string") throw new ByoaError("Credential label must be a string.", "invalid_label");
  const label = value.trim().replace(/\s+/g, " ");
  if (label.length < 2 || label.length > 80) {
    throw new ByoaError("Credential label must contain 2-80 characters.", "invalid_label");
  }
  return label;
}

function validatedCredentialType(value: unknown) {
  try {
    return normalizeCredentialType(value);
  } catch (error) {
    throw new ByoaError(
      error instanceof Error ? error.message : "Credential type is invalid.",
      "invalid_credential_type",
    );
  }
}

function validatedCredentialScopes(value: unknown, credentialType: CredentialType) {
  try {
    return normalizeCredentialScopes(value, credentialType);
  } catch (error) {
    throw new ByoaError(
      error instanceof Error ? error.message : "Credential scopes are invalid.",
      "invalid_scopes",
    );
  }
}

function validatedCredentialExpiry(value: unknown) {
  try {
    return credentialExpiry(value);
  } catch (error) {
    throw new ByoaError(
      error instanceof Error ? error.message : "Credential expiry is invalid.",
      "invalid_expiry",
    );
  }
}

function validatedByoaIdempotencyKey(value: string) {
  try {
    return validateIdempotencyKey(value);
  } catch (error) {
    throw new ByoaError(
      error instanceof Error ? error.message : "Idempotency-Key is invalid.",
      "invalid_idempotency_key",
    );
  }
}

export function validateByoaWorkflowRequest(input: Record<string, unknown>) {
  try {
    return validateHostedWorkflowRequest(input);
  } catch (error) {
    throw new ByoaError(
      error instanceof Error ? error.message : "Workflow request is invalid.",
      "invalid_workflow_request",
    );
  }
}

function asAddress(value: unknown, label: string) {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new ByoaError(`${label} must be a valid EVM address.`, "invalid_wallet");
  }
  return getAddress(value);
}

function publicAgent(agent: ByoaAgentRow) {
  return {
    publicId: agent.public_id,
    displayName: agent.display_name,
    agentWallet: agent.agent_wallet ? getAddress(agent.agent_wallet) : null,
    walletStatus: agent.agent_wallet_status,
    status: agent.status,
    walletVerifiedAt: agent.wallet_verified_at,
    createdAt: agent.created_at,
  };
}

function managementAgent(agent: ByoaAgentRow) {
  return {
    ...publicAgent(agent),
    id: agent.id,
    ownerWallet: getAddress(agent.owner_wallet),
    canaryEnabled: agent.canary_enabled,
    updatedAt: agent.updated_at,
  };
}

export function safeCredential(row: ByoaCredentialRow) {
  return {
    id: row.id,
    agentId: row.agent_id,
    ownerWallet: getAddress(row.owner_wallet),
    credentialType: row.credential_type,
    label: row.label,
    prefix: row.token_prefix,
    scopes: row.scopes,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
    rotatedFromId: row.rotated_from_id,
    createdAt: row.created_at,
  };
}

export function safePolicy(row: ByoaPolicyRow) {
  return {
    allowedWorkflows: row.allowed_workflows,
    allowedServiceTypes: row.allowed_service_types,
    maxPricePerRunUsdc: row.max_price_per_run_usdc,
    dailySpendLimitUsdc: row.daily_spend_limit_usdc,
    maxDailyCalls: row.max_daily_calls,
    status: row.status,
    updatedAt: row.updated_at,
  };
}

export async function listOwnerAgents(ownerWallet: Address) {
  const { data, error } = await getByoaClient()
    .from("byoa_agents")
    .select("*")
    .ilike("owner_wallet", ownerWallet)
    .order("created_at", { ascending: false });
  if (error) throw new ByoaError("Unable to load registered agents.", "database_unavailable", 503);
  return (data ?? []).map((row) => managementAgent(row as ByoaAgentRow));
}

export async function getOwnerAgent(ownerWallet: Address, agentId: string) {
  requireUuid(agentId, "Agent ID");
  const { data, error } = await getByoaClient()
    .from("byoa_agents")
    .select("*")
    .eq("id", agentId)
    .ilike("owner_wallet", ownerWallet)
    .maybeSingle();
  if (error) throw new ByoaError("Unable to load registered agent.", "database_unavailable", 503);
  if (!data) throw new ByoaError("Registered agent was not found.", "not_found", 404);
  return data as ByoaAgentRow;
}

export async function createRegisteredAgent(input: {
  ownerWallet: Address;
  displayName: unknown;
  agentWallet: unknown;
}) {
  if (!isCanaryOwnerAllowed(input.ownerWallet)) {
    throw new ByoaError("Agent registration is restricted to the private access list.", "registration_closed", 403);
  }
  const agentWallet = asAddress(input.agentWallet, "Agent wallet");
  if (!isCanaryAgentAllowed(agentWallet)) {
    throw new ByoaError("Agent wallet is not on the private access list.", "agent_not_allowlisted", 403);
  }
  const publicId = `agt_${randomBytes(10).toString("hex")}`;
  const client = getByoaClient();
  const { data, error } = await client.rpc("create_byoa_agent_v1", {
    p_public_id: publicId,
    p_display_name: displayName(input.displayName),
    p_owner_wallet: getAddress(input.ownerWallet),
    p_agent_wallet: agentWallet,
  });
  if (error) {
    const duplicate = /duplicate|unique/i.test(error.message);
    throw new ByoaError(
      duplicate ? "This agent wallet is already registered." : "Unable to create registered agent.",
      duplicate ? "wallet_already_registered" : "database_unavailable",
      duplicate ? 409 : 503,
    );
  }
  const agentId = (data as Array<{ agent_id: string }> | null)?.[0]?.agent_id;
  if (!agentId) throw new ByoaError("Agent registration returned no result.", "database_unavailable", 503);
  const { data: agentData, error: agentError } = await client
    .from("byoa_agents")
    .select("*")
    .eq("id", agentId)
    .single();
  if (agentError || !agentData) throw new ByoaError("Unable to load the registered agent.", "database_unavailable", 503);
  const agent = agentData as ByoaAgentRow;
  return managementAgent(agent);
}

type ChallengeRow = {
  id: string;
  wallet: string;
  action: "owner_session" | "bind_agent_wallet";
  origin: string;
  chain_id: number | string;
  agent_id: string | null;
  nonce_hash: string;
  message_hash: string;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
};

export function buildByoaChallengeMessage(input: {
  action: ChallengeRow["action"];
  origin: string;
  wallet: Address;
  agentPublicId?: string | null;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}) {
  return [
    `${BRAND.name} BYOA wallet challenge`,
    "Version: 1",
    `Action: ${input.action}`,
    `Origin: ${input.origin}`,
    "Chain ID: 5042002",
    `Wallet: ${input.wallet}`,
    `Agent: ${input.agentPublicId ?? "none"}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt}`,
    `Expires At: ${input.expiresAt}`,
    "This signature does not authorize a payment or transfer custody.",
  ].join("\n");
}

async function insertChallenge(input: {
  wallet: Address;
  action: ChallengeRow["action"];
  origin: string;
  agentId?: string | null;
  agentPublicId?: string | null;
}) {
  const config = getByoaConfig();
  const recent = await getByoaClient()
    .from("byoa_wallet_challenges")
    .select("id", { count: "exact", head: true })
    .ilike("wallet", input.wallet)
    .eq("action", input.action)
    .gte("created_at", new Date(Date.now() - 10 * 60 * 1_000).toISOString());
  if (recent.error) throw new ByoaError("Unable to enforce challenge rate limits.", "database_unavailable", 503);
  if ((recent.count ?? 0) >= 5) {
    throw new ByoaError("Too many wallet challenges. Try again later.", "challenge_rate_limited", 429);
  }
  const nonce = randomBytes(24).toString("hex");
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + config.challengeTtlSeconds * 1_000).toISOString();
  const message = buildByoaChallengeMessage({ ...input, nonce, issuedAt, expiresAt });
  const { data, error } = await getByoaClient()
    .from("byoa_wallet_challenges")
    .insert({
      wallet: input.wallet,
      action: input.action,
      origin: input.origin,
      chain_id: 5_042_002,
      agent_id: input.agentId ?? null,
      nonce_hash: digest(nonce),
      message_hash: digest(message),
      expires_at: expiresAt,
    })
    .select("id,expires_at")
    .single();
  if (error) throw new ByoaError("Unable to create wallet challenge.", "database_unavailable", 503);
  return { id: data.id as string, message, expiresAt: data.expires_at as string };
}

export async function createOwnerSessionChallenge(walletValue: unknown, origin: string) {
  const wallet = asAddress(walletValue, "Owner wallet");
  if (!isCanaryOwnerAllowed(wallet)) {
    throw new ByoaError("Agent management is restricted to the private access list.", "registration_closed", 403);
  }
  return insertChallenge({ wallet, action: "owner_session", origin });
}

export async function createAgentBindingChallenge(ownerWallet: Address, agentId: string, origin: string) {
  const agent = await getOwnerAgent(ownerWallet, agentId);
  if (!agent.agent_wallet || !isAddress(agent.agent_wallet)) {
    throw new ByoaError("Agent wallet is not configured.", "wallet_missing");
  }
  const wallet = getAddress(agent.agent_wallet);
  if (!isCanaryAgentAllowed(wallet)) {
    throw new ByoaError("Agent wallet is not on the private access list.", "agent_not_allowlisted", 403);
  }
  return insertChallenge({
    wallet,
    action: "bind_agent_wallet",
    origin,
    agentId: agent.id,
    agentPublicId: agent.public_id,
  });
}

export async function getWalletChallenge(challengeId: string) {
  requireUuid(challengeId, "Challenge ID");
  const { data, error } = await getByoaClient()
    .from("byoa_wallet_challenges")
    .select("*")
    .eq("id", challengeId)
    .maybeSingle();
  if (error) throw new ByoaError("Unable to load wallet challenge.", "database_unavailable", 503);
  if (!data) throw new ByoaError("Wallet challenge was not found.", "challenge_not_found", 404);
  return data as ChallengeRow;
}

export async function consumeWalletChallenge(input: {
  row: ChallengeRow;
  message: string;
  origin: string;
}) {
  if (digest(input.message) !== input.row.message_hash) {
    throw new ByoaError("Wallet challenge message does not match.", "challenge_mismatch", 401);
  }
  const { data, error } = await getByoaClient().rpc("consume_byoa_wallet_challenge_v1", {
    p_challenge_id: input.row.id,
    p_wallet: input.row.wallet,
    p_action: input.row.action,
    p_origin: input.origin,
    p_message_hash: input.row.message_hash,
  });
  if (error) throw new ByoaError("Unable to consume wallet challenge.", "database_unavailable", 503);
  if (data !== true) throw new ByoaError("Wallet challenge is expired or already used.", "challenge_replayed", 409);
  return true;
}

export async function activateAgentWallet(ownerWallet: Address, agentId: string) {
  const agent = await getOwnerAgent(ownerWallet, agentId);
  if (!agent.agent_wallet || !isAddress(agent.agent_wallet) || !isCanaryAgentAllowed(getAddress(agent.agent_wallet))) {
    throw new ByoaError("Agent wallet is not eligible for private-access activation.", "agent_not_allowlisted", 403);
  }
  const { data, error } = await getByoaClient()
    .from("byoa_agents")
    .update({
      agent_wallet_status: "verified",
      status: "active",
      canary_enabled: true,
      wallet_verified_at: new Date().toISOString(),
    })
    .eq("id", agent.id)
    .ilike("owner_wallet", ownerWallet)
    .select("*")
    .single();
  if (error) throw new ByoaError("Unable to activate agent wallet.", "database_unavailable", 503);
  return managementAgent(data as ByoaAgentRow);
}

export async function updateAgentStatus(ownerWallet: Address, agentId: string, status: "active" | "suspended" | "revoked") {
  const agent = await getOwnerAgent(ownerWallet, agentId);
  if (!["active", "suspended", "revoked"].includes(status)) {
    throw new ByoaError("Invalid agent status.", "invalid_status");
  }
  const { data, error } = await getByoaClient()
    .from("byoa_agents")
    .update({ status })
    .eq("id", agent.id)
    .ilike("owner_wallet", ownerWallet)
    .select("*")
    .single();
  if (error) throw new ByoaError("Unable to update agent status.", "database_unavailable", 503);
  return managementAgent(data as ByoaAgentRow);
}


const allowedWorkflowValues = [
  "github_due_diligence",
  "agent_trust_report",
  "sentiment_tone",
  "builder_update",
  "market_context",
  "custom_task",
  "*",
  "seller:*",
] as const;
const allowedServiceTypeValues = ["internal_deterministic", "live_provider", "seller_created", "external_seller"] as const;

function policyArray<T extends string>(value: unknown, allowed: readonly T[], label: string) {
  if (!Array.isArray(value)) throw new ByoaError(`${label} must be an array.`, "invalid_policy");
  const entries = [...new Set(value.map((entry) => String(entry).trim()))];
  if (entries.length === 0 || entries.some((entry) => !allowed.includes(entry as T))) {
    throw new ByoaError(`${label} contains an unsupported value.`, "invalid_policy");
  }
  return entries as T[];
}

function workflowPolicyArray(value: unknown) {
  if (!Array.isArray(value)) throw new ByoaError("Allowed workflows must be an array.", "invalid_policy");
  const entries = [...new Set(value.map((entry) => String(entry).trim()))];
  if (
    entries.length === 0 || entries.length > 12 ||
    entries.some((entry) =>
      !allowedWorkflowValues.includes(entry as (typeof allowedWorkflowValues)[number]) &&
      !/^seller_[a-z0-9_]{3,80}$/.test(entry)
    )
  ) {
    throw new ByoaError("Allowed workflows contains an unsupported value.", "invalid_policy");
  }
  return entries;
}

function policyUsdc(value: unknown, minimum: number, maximum: number, label: string) {
  const amount = typeof value === "string" ? Number(value) : value;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < minimum || amount > maximum) {
    throw new ByoaError(`${label} must be between ${minimum} and ${maximum} USDC.`, "invalid_policy");
  }
  const atomic = Math.round(amount * 1_000_000);
  if (Math.abs(amount * 1_000_000 - atomic) > 0.000001) {
    throw new ByoaError(`${label} supports at most 6 decimals.`, "invalid_policy");
  }
  return atomic / 1_000_000;
}

export async function updateAgentPolicy(ownerWallet: Address, agentId: string, input: Record<string, unknown>) {
  const agent = await getOwnerAgent(ownerWallet, agentId);
  const maxDailyCalls = Number(input.maxDailyCalls);
  if (!Number.isInteger(maxDailyCalls) || maxDailyCalls < 1 || maxDailyCalls > 100) {
    throw new ByoaError("Daily call limit must be an integer from 1 to 100.", "invalid_policy");
  }
  const payload = {
    allowed_workflows: workflowPolicyArray(input.allowedWorkflows),
    allowed_service_types: policyArray(input.allowedServiceTypes, allowedServiceTypeValues, "Allowed service types"),
    max_price_per_run_usdc: policyUsdc(input.maxPricePerRunUsdc, 0.001, 0.005, "Maximum run price"),
    daily_spend_limit_usdc: policyUsdc(input.dailySpendLimitUsdc, 0.001, 1, "Daily spend limit"),
    max_daily_calls: maxDailyCalls,
    status: input.status === "paused" ? "paused" : "active",
  };
  const { data, error } = await getByoaClient()
    .from("byoa_agent_policies")
    .update(payload)
    .eq("agent_id", agent.id)
    .select("*")
    .single();
  if (error) throw new ByoaError("Unable to update agent policy.", "database_unavailable", 503);
  return safePolicy(data as ByoaPolicyRow);
}

export async function createAgentCredential(ownerWallet: Address, agentId: string, input: Record<string, unknown>) {
  const agent = await getOwnerAgent(ownerWallet, agentId);
  if (agent.status !== "active" || agent.agent_wallet_status !== "verified") {
    throw new ByoaError("Verify the agent wallet before creating credentials.", "agent_inactive", 409);
  }
  const credentialType = validatedCredentialType(input.credentialType);
  const generated = createApiCredential(agent.public_id);
  const { data, error } = await getByoaClient()
    .from("byoa_agent_credentials")
    .insert({
      agent_id: agent.id,
      owner_wallet: ownerWallet,
      credential_type: credentialType,
      label: credentialLabel(input.label),
      token_prefix: generated.prefix,
      credential_hash: generated.hash,
      scopes: validatedCredentialScopes(input.scopes, credentialType),
      expires_at: validatedCredentialExpiry(input.expiresAt),
    })
    .select("*")
    .single();
  if (error) throw new ByoaError("Unable to create API credential.", "database_unavailable", 503);
  return { credential: safeCredential(data as ByoaCredentialRow), token: generated.token };
}

export async function revokeAgentCredential(ownerWallet: Address, agentId: string, credentialId: string) {
  const agent = await getOwnerAgent(ownerWallet, agentId);
  requireUuid(credentialId, "Credential ID");
  const { data, error } = await getByoaClient()
    .from("byoa_agent_credentials")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", credentialId)
    .eq("agent_id", agent.id)
    .is("revoked_at", null)
    .select("*")
    .maybeSingle();
  if (error) throw new ByoaError("Unable to revoke API credential.", "database_unavailable", 503);
  if (!data) throw new ByoaError("Credential was not found or is already revoked.", "not_found", 404);
  return safeCredential(data as ByoaCredentialRow);
}

export async function listAgentCredentials(ownerWallet: Address, agentId: string) {
  const agent = await getOwnerAgent(ownerWallet, agentId);
  const { data, error } = await getByoaClient()
    .from("byoa_agent_credentials")
    .select("*")
    .eq("agent_id", agent.id)
    .order("created_at", { ascending: false });
  if (error) throw new ByoaError("Unable to load API credentials.", "database_unavailable", 503);
  return (data ?? []).map((row) => safeCredential(row as ByoaCredentialRow));
}

export async function rotateAgentCredential(ownerWallet: Address, agentId: string, credentialId: string, input: Record<string, unknown>) {
  const agent = await getOwnerAgent(ownerWallet, agentId);
  requireUuid(credentialId, "Credential ID");
  const client = getByoaClient();
  const existing = await client
    .from("byoa_agent_credentials")
    .select("*")
    .eq("id", credentialId)
    .eq("agent_id", agent.id)
    .is("revoked_at", null)
    .maybeSingle();
  if (existing.error) throw new ByoaError("Unable to load API credential.", "database_unavailable", 503);
  if (!existing.data) throw new ByoaError("Credential was not found or is already revoked.", "not_found", 404);
  const previous = existing.data as ByoaCredentialRow;
  const generated = createApiCredential(agent.public_id);
  const scopes = input.scopes === undefined
    ? previous.scopes
    : validatedCredentialScopes(input.scopes, previous.credential_type);
  const expiresAt = input.expiresAt === undefined ? previous.expires_at : validatedCredentialExpiry(input.expiresAt);
  const rotated = await client.rpc("rotate_byoa_credential_v1", {
    p_owner_wallet: ownerWallet,
    p_agent_id: agent.id,
    p_previous_credential_id: previous.id,
    p_label: input.label === undefined ? previous.label : credentialLabel(input.label),
    p_token_prefix: generated.prefix,
    p_credential_hash: generated.hash,
    p_scopes: scopes,
    p_expires_at: expiresAt,
  });
  if (rotated.error) throw new ByoaError("Unable to rotate API credential.", "database_unavailable", 503);
  const row = (rotated.data as Array<{ credential_id: string | null; reason: string }> | null)?.[0];
  if (!row?.credential_id) {
    throw new ByoaError("Credential was not found or is already revoked.", row?.reason ?? "not_found", 404);
  }
  const inserted = await client
    .from("byoa_agent_credentials")
    .select("*")
    .eq("id", row.credential_id)
    .single();
  if (inserted.error || !inserted.data) throw new ByoaError("Unable to load rotated credential.", "database_unavailable", 503);
  return { credential: safeCredential(inserted.data as ByoaCredentialRow), token: generated.token };
}

export async function getAgentManagementDetail(ownerWallet: Address, agentId: string) {
  const agent = await getOwnerAgent(ownerWallet, agentId);
  const client = getByoaClient();
  const [policy, credentials, passport, jobs, payments] = await Promise.all([
    client.from("byoa_agent_policies").select("*").eq("agent_id", agent.id).maybeSingle(),
    client.from("byoa_agent_credentials").select("*").eq("agent_id", agent.id).order("created_at", { ascending: false }),
    client.from("byoa_agent_passports").select("*").eq("agent_id", agent.id).maybeSingle(),
    client.from("hosted_agent_jobs").select("id,status,progress_stage,workflow_type,spent_usdc,agent_run_id,receipt_ids,proof_transaction_hashes,created_at,completed_at").eq("byoa_agent_id", agent.id).order("created_at", { ascending: false }).limit(25),
    client.from("byoa_workflow_payments").select("id,quote_id,job_id,payment_event_id,payer_wallet,amount_usdc,gateway_transaction,status,downstream_spent_usdc,receipt_count,verified_proof_count,failure_reason,settled_at,completed_at").eq("agent_id", agent.id).order("created_at", { ascending: false }).limit(25),
  ]);
  if (policy.error || credentials.error || passport.error || jobs.error || payments.error) {
    throw new ByoaError("Unable to load agent management data.", "database_unavailable", 503);
  }
  const paymentEventIds = (payments.data ?? [])
    .map((row) => row.payment_event_id as string | null)
    .filter((value): value is string => Boolean(value));
  const paymentEvents = paymentEventIds.length > 0
    ? await client
      .from("payment_events")
      .select("id,onchain_status,onchain_tx_hash,onchain_block_number,onchain_contract_address,onchain_verified_at")
      .in("id", paymentEventIds)
    : { data: [], error: null };
  if (paymentEvents.error) {
    throw new ByoaError("Unable to load aggregate payment proofs.", "database_unavailable", 503);
  }
  const proofByPaymentEvent = new Map(
    (paymentEvents.data ?? []).map((row) => [row.id as string, row]),
  );
  return {
    agent: managementAgent(agent),
    policy: policy.data ? safePolicy(policy.data as ByoaPolicyRow) : null,
    credentials: (credentials.data ?? []).map((row) => safeCredential(row as ByoaCredentialRow)),
    passport: (passport.data as ByoaPassportRow | null) ?? null,
    jobs: jobs.data ?? [],
    payments: (payments.data ?? []).map((payment) => ({
      ...payment,
      aggregate_proof: proofByPaymentEvent.get(payment.payment_event_id as string) ?? null,
    })),
  };
}

export type AuthenticatedByoaAgent = {
  agent: ByoaAgentRow;
  credential: ByoaCredentialRow;
  policy: ByoaPolicyRow;
};

export async function authenticateAgentCredential(token: string, requiredScope: ByoaScope): Promise<AuthenticatedByoaAgent> {
  const client = getByoaClient();
  const result = await client
    .from("byoa_agent_credentials")
    .select("*")
    .eq("credential_hash", hashApiCredential(token))
    .maybeSingle();
  if (result.error) throw new ByoaError("Unable to authenticate BYOA credential.", "database_unavailable", 503);
  if (!result.data) throw new ByoaError("BYOA credential is invalid.", "credential_invalid", 401);
  const credential = result.data as ByoaCredentialRow;
  if (credential.credential_type !== "byoa_workflow") {
    throw new ByoaError("BYOA credential is invalid.", "credential_invalid", 401);
  }
  try {
    normalizeCredentialScopes(credential.scopes, "byoa_workflow");
  } catch {
    throw new ByoaError("BYOA credential scope set is invalid.", "scope_denied", 403);
  }
  if (credential.revoked_at || Date.parse(credential.expires_at) <= Date.now()) {
    throw new ByoaError("BYOA credential is expired or revoked.", "credential_inactive", 401);
  }
  if (!credential.scopes.includes(requiredScope)) {
    throw new ByoaError(`BYOA credential lacks ${requiredScope}.`, "scope_denied", 403);
  }
  const [agentResult, policyResult] = await Promise.all([
    client.from("byoa_agents").select("*").eq("id", credential.agent_id).maybeSingle(),
    client.from("byoa_agent_policies").select("*").eq("agent_id", credential.agent_id).maybeSingle(),
  ]);
  if (agentResult.error || policyResult.error) throw new ByoaError("Unable to load BYOA authorization policy.", "database_unavailable", 503);
  if (!agentResult.data || !policyResult.data) throw new ByoaError("BYOA agent authorization is incomplete.", "agent_inactive", 403);
  const agent = agentResult.data as ByoaAgentRow;
  const policy = policyResult.data as ByoaPolicyRow;
  if (credential.owner_wallet.toLowerCase() !== agent.owner_wallet.toLowerCase()) {
    throw new ByoaError("BYOA credential is invalid.", "credential_invalid", 401);
  }
  if (agent.status !== "active" || agent.agent_wallet_status !== "verified" || !agent.canary_enabled || policy.status !== "active") {
    throw new ByoaError("BYOA agent or policy is not active.", "agent_inactive", 403);
  }
  return { agent, credential, policy };
}

function previewByoaWorkflow(request: ReturnType<typeof validateHostedWorkflowRequest>) {
  return createHostedWorkflowPlan({
    request,
    services: serviceRegistry,
    allowlist: hostedServiceAllowlist(),
  });
}

function serviceTypesForPlan(plan: ReturnType<typeof previewByoaWorkflow>) {
  const types = plan.selectedServices.map((service) => {
    const providerType = service.presentation.providerType;
    if (providerType === "live_provider") return "live_provider";
    if (providerType === "seller_mock") return "seller_created";
    if (providerType === "external_seller") return "external_seller";
    if (providerType === "internal_deterministic") return "internal_deterministic";
    throw new ByoaError("Planner selected a service type that BYOA cannot execute.", "service_type_denied", 409);
  });
  return [...new Set(types)] as ByoaServiceType[];
}

export async function reserveWorkflowQuote(input: {
  auth: AuthenticatedByoaAgent;
  idempotencyKey: string;
  requestBody: Record<string, unknown>;
  baseUrl: string;
}) {
  const idempotencyKey = validatedByoaIdempotencyKey(input.idempotencyKey);
  const request = validateByoaWorkflowRequest(input.requestBody);
  const plan = previewByoaWorkflow(request);
  if (plan.selectedServices.length === 0) {
    throw new ByoaError("No allowlisted paid service matched this workflow.", "empty_plan", 409);
  }
  const serviceTypes = serviceTypesForPlan(plan);
  const pricing = priceHostedWorkflow(plan, getHostedWorkflowCheckoutConfig());
  const seller = process.env.SELLER_ADDRESS?.trim();
  if (!seller || !isAddress(seller)) throw new ByoaError("BYOA x402 recipient is not configured.", "not_configured", 503);
  const inputMetadata = hostedWorkflowInputMetadata(request.inputText);
  const idempotencyHash = byoaIdempotencyHash(input.auth.agent.id, idempotencyKey);
  const requestHash = byoaRequestHash(input.auth.agent.id, request);
  const expiresAt = new Date(
    Date.now() + getHostedWorkflowCheckoutConfig().quoteExpirySeconds * 1_000,
  ).toISOString();
  const amountAtomic = Math.round(pricing.listPriceUsdc * 1_000_000);
  const { data, error } = await getByoaClient().rpc("reserve_byoa_workflow_quote_v1", {
    p_agent_id: input.auth.agent.id,
    p_credential_id: input.auth.credential.id,
    p_idempotency_hash: idempotencyHash,
    p_request_hash: requestHash,
    p_requester_fingerprint: keyedDigest("byoa-agent-fingerprint-v1", input.auth.agent.id),
    p_workflow_type: request.workflowType,
    p_task: request.task,
    p_input_preview: inputMetadata.preview,
    p_input_hash: inputMetadata.sha256,
    p_budget_usdc: request.budgetUsdc,
    p_planner_snapshot: plan,
    p_selected_services: plan.selectedServices,
    p_service_types: serviceTypes,
    p_price_usdc: pricing.listPriceUsdc,
    p_amount_atomic: amountAtomic,
    p_pay_to: getAddress(seller),
    p_expires_at: expiresAt,
  });
  if (error) throw new ByoaError("Unable to reserve immutable BYOA quote.", "database_unavailable", 503);
  const row = (data as Array<{ quote_id: string | null; created: boolean; reason: string }> | null)?.[0];
  if (!row?.quote_id) {
    const status = row?.reason === "idempotency_conflict" ? 409 : row?.reason?.startsWith("daily_") ? 429 : 403;
    throw new ByoaError(`BYOA quote was denied: ${row?.reason ?? "unknown"}.`, row?.reason ?? "quote_denied", status);
  }
  const quote = await getQuoteForAgent(input.auth.agent.id, row.quote_id);
  return { quote: publicQuote(quote, input.auth.agent.public_id, input.baseUrl), created: row.created, reason: row.reason };
}

export function validateQuoteExecutionRequest(input: {
  auth: AuthenticatedByoaAgent;
  quote: ByoaQuoteRow;
  idempotencyKey: string;
  requestBody: Record<string, unknown>;
}) {
  const idempotencyKey = validatedByoaIdempotencyKey(input.idempotencyKey);
  const expectedIdempotencyHash = byoaIdempotencyHash(input.auth.agent.id, idempotencyKey);
  const request = validateByoaWorkflowRequest(input.requestBody);
  const inputMetadata = hostedWorkflowInputMetadata(request.inputText);
  const expectedRequestHash = byoaRequestHash(input.auth.agent.id, request);
  if (
    input.quote.idempotency_hash !== expectedIdempotencyHash ||
    input.quote.request_hash !== expectedRequestHash ||
    input.quote.input_hash !== inputMetadata.sha256
  ) {
    throw new ByoaError(
      "Execute payload or Idempotency-Key does not match the immutable quote.",
      "quote_integrity_mismatch",
      409,
    );
  }
  return request;
}

export function validateQuoteRuntimeConfiguration(quote: ByoaQuoteRow) {
  const seller = process.env.SELLER_ADDRESS?.trim();
  const amountAtomic = Math.round(Number(quote.price_usdc) * 1_000_000);
  if (
    !seller ||
    !isAddress(seller) ||
    getAddress(seller) !== getAddress(quote.pay_to) ||
    quote.network !== "eip155:5042002" ||
    getAddress(quote.asset) !== getAddress(ARC_TESTNET_USDC_ADDRESS) ||
    String(amountAtomic) !== String(quote.amount_atomic)
  ) {
    throw new ByoaError(
      "Immutable quote no longer matches the Arc Testnet payment configuration.",
      "quote_runtime_mismatch",
      409,
    );
  }
}

export async function assertHostedExecutionSlotAvailable() {
  const { data, error } = await getByoaClient()
    .from("hosted_agent_jobs")
    .select("id")
    .in("status", ["queued", "running"])
    .limit(1);
  if (error) throw new ByoaError("Unable to check hosted execution capacity.", "database_unavailable", 503);
  if ((data ?? []).length > 0) {
    throw new ByoaError(
      "The project-owned downstream payer is busy. No workflow payment was requested.",
      "hosted_payer_busy",
      409,
    );
  }
}

export async function getQuoteForAgent(agentId: string, quoteId: string) {
  requireUuid(quoteId, "Quote ID");
  const { data, error } = await getByoaClient()
    .from("byoa_workflow_quotes")
    .select("*")
    .eq("id", quoteId)
    .eq("agent_id", agentId)
    .maybeSingle();
  if (error) throw new ByoaError("Unable to load BYOA quote.", "database_unavailable", 503);
  if (!data) throw new ByoaError("BYOA quote was not found.", "not_found", 404);
  return data as ByoaQuoteRow;
}

export function publicQuote(row: ByoaQuoteRow, agentPublicId: string, baseUrl: string): PublicByoaQuote {
  return {
    id: row.id,
    agentPublicId,
    workflowType: row.workflow_type,
    inputPreview: row.input_preview,
    inputSha256: row.input_hash,
    plan: row.planner_snapshot,
    serviceTypes: row.service_types,
    priceUsdc: Number(row.price_usdc).toFixed(6),
    amountAtomic: String(row.amount_atomic),
    payTo: getAddress(row.pay_to),
    network: row.network,
    asset: getAddress(row.asset),
    resourceUrl: `${baseUrl.replace(/\/$/, "")}${row.resource_path}`,
    status: row.status,
    expiresAt: row.expires_at,
    jobId: row.job_id,
  };
}

export async function claimQuoteSettlement(auth: AuthenticatedByoaAgent, quoteId: string) {
  const quote = await getQuoteForAgent(auth.agent.id, quoteId);
  const { data, error } = await getByoaClient().rpc("claim_byoa_quote_settlement_v1", {
    p_quote_id: quote.id,
    p_credential_id: auth.credential.id,
  });
  if (error) throw new ByoaError("Unable to claim BYOA settlement.", "database_unavailable", 503);
  const row = (data as Array<{ claim_token: string | null; reason: string; job_id: string | null }> | null)?.[0];
  if (!row) throw new ByoaError("BYOA settlement claim returned no result.", "database_unavailable", 503);
  return { quote, claimToken: row.claim_token, reason: row.reason, jobId: row.job_id };
}

export async function releaseQuoteSettlement(quoteId: string, claimToken: string) {
  if (!validUuid(claimToken)) return false;
  const { data } = await getByoaClient().rpc("release_byoa_quote_settlement_v1", {
    p_quote_id: quoteId,
    p_claim_token: claimToken,
  });
  return data === true;
}

export async function findAggregatePaymentEvent(quote: ByoaQuoteRow) {
  const { data, error } = await getByoaClient()
    .from("payment_events")
    .select("id,endpoint,payer,amount_usdc,network,gateway_tx,onchain_seller,created_at")
    .eq("endpoint", quote.resource_path)
    .order("created_at", { ascending: false })
    .limit(2);
  if (error) throw new ByoaError("Unable to locate aggregate x402 settlement.", "database_unavailable", 503);
  const rows = data ?? [];
  if (rows.length !== 1) {
    throw new ByoaError("Aggregate x402 settlement is missing or ambiguous.", "payment_event_ambiguous", 409);
  }
  return rows[0] as { id: string; payer: string; amount_usdc: string; gateway_tx: string | null };
}

export async function maybeFindAggregatePaymentEvent(quote: ByoaQuoteRow) {
  const { data, error } = await getByoaClient()
    .from("payment_events")
    .select("id,endpoint,payer,amount_usdc,network,gateway_tx,onchain_seller,created_at")
    .eq("endpoint", quote.resource_path)
    .order("created_at", { ascending: false })
    .limit(2);
  if (error) throw new ByoaError("Unable to locate aggregate x402 settlement.", "database_unavailable", 503);
  const rows = data ?? [];
  if (rows.length > 1) {
    throw new ByoaError("Aggregate x402 settlement is ambiguous.", "payment_event_ambiguous", 409);
  }
  return rows[0] as { id: string; payer: string; amount_usdc: string; gateway_tx: string | null } | undefined;
}

export async function consumeSettledQuote(input: {
  quote: ByoaQuoteRow;
  claimToken: string;
  paymentEventId: string;
}) {
  const { data, error } = await getByoaClient().rpc("consume_byoa_quote_v1", {
    p_quote_id: input.quote.id,
    p_claim_token: input.claimToken,
    p_payment_event_id: input.paymentEventId,
  });
  if (error) throw new ByoaError("Unable to persist BYOA workflow settlement.", "database_unavailable", 503);
  const row = (data as Array<{ job_id: string | null; payment_id: string | null; created: boolean; reason: string }> | null)?.[0];
  if (!row) throw new ByoaError("BYOA settlement returned no result.", "database_unavailable", 503);
  return { jobId: row.job_id, paymentId: row.payment_id, created: row.created, reason: row.reason };
}

export async function finalizeByoaWorkflow(input: {
  jobId: string;
  succeeded: boolean;
  downstreamSpentUsdc: number;
  receiptCount: number;
  verifiedProofCount: number;
  failureReason?: string | null;
}) {
  const { data, error } = await getByoaClient().rpc("finalize_byoa_workflow_v1", {
    p_job_id: input.jobId,
    p_succeeded: input.succeeded,
    p_downstream_spent_usdc: input.downstreamSpentUsdc,
    p_receipt_count: input.receiptCount,
    p_verified_proof_count: input.verifiedProofCount,
    p_failure_reason: input.failureReason ?? null,
  });
  if (error) throw new ByoaError("Unable to finalize BYOA accounting.", "database_unavailable", 503);
  return data === true;
}

export async function linkByoaAgentRun(jobId: string, agentId: string, runId: string | null) {
  if (!runId) return;
  const { error } = await getByoaClient()
    .from("agent_runs")
    .update({ byoa_agent_id: agentId })
    .eq("id", runId);
  if (error) throw new ByoaError("Unable to link Agent Run to registered agent.", "database_unavailable", 503);
  const jobUpdate = await getByoaClient()
    .from("hosted_agent_jobs")
    .update({ byoa_agent_id: agentId })
    .eq("id", jobId);
  if (jobUpdate.error) throw new ByoaError("Unable to link hosted job to registered agent.", "database_unavailable", 503);
}

export async function getPublicAgentPassport(publicId: string) {
  if (!/^agt_[a-z0-9]{20}$/.test(publicId)) throw new ByoaError("Agent public ID is invalid.", "invalid_id");
  const client = getByoaClient();
  const agentResult = await client.from("byoa_agents").select("*").eq("public_id", publicId).maybeSingle();
  if (agentResult.error) throw new ByoaError("Unable to load public Agent Passport.", "database_unavailable", 503);
  if (!agentResult.data) throw new ByoaError("Agent Passport was not found.", "not_found", 404);
  const agent = agentResult.data as ByoaAgentRow;
  if (agent.status === "revoked" || agent.agent_wallet_status !== "verified") {
    throw new ByoaError("Agent Passport was not found.", "not_found", 404);
  }
  const [passport, jobs, payments] = await Promise.all([
    client.from("byoa_agent_passports").select("*").eq("agent_id", agent.id).maybeSingle(),
    client.from("hosted_agent_jobs").select("id,status,workflow_type,agent_run_id,spent_usdc,created_at,completed_at").eq("byoa_agent_id", agent.id).order("created_at", { ascending: false }).limit(10),
    client.from("byoa_workflow_payments").select("job_id,amount_usdc,status,receipt_count,verified_proof_count,settled_at").eq("agent_id", agent.id).order("created_at", { ascending: false }).limit(10),
  ]);
  if (passport.error || jobs.error || payments.error) throw new ByoaError("Unable to load public Agent Passport.", "database_unavailable", 503);
  return {
    agent: publicAgent(agent),
    passport: (passport.data as ByoaPassportRow | null) ?? {
      total_workflows: 0,
      completed_reports: 0,
      successful_calls: 0,
      verified_proofs: 0,
      workflow_spent_usdc: "0",
      downstream_spent_usdc: "0",
      success_rate: "0",
      last_run_at: null,
    },
    recentRuns: jobs.data ?? [],
    recentPayments: payments.data ?? [],
  };
}

export async function isByoaHostedJob(jobId: string) {
  if (!validUuid(jobId)) return false;
  const { data, error } = await getByoaClient()
    .from("hosted_agent_jobs")
    .select("byoa_agent_id")
    .eq("id", jobId)
    .maybeSingle();
  if (error) throw new ByoaError("Unable to check hosted job ownership.", "database_unavailable", 503);
  return Boolean((data as { byoa_agent_id?: string | null } | null)?.byoa_agent_id);
}

export function byoaManifest(
  baseUrl: string,
  sellerWorkflows: unknown[] = [],
  verifiedErc8004AgentId: string | null = null,
) {
  const config = getByoaConfig();
  return {
    name: `${BRAND.name} Bring Your Own Agent`,
    version: "1.0",
    network: "Arc Testnet",
    chainId: config.chainId,
    custody: "none",
    publicRegistrationEnabled: config.publicRegistrationEnabled,
    canaryOnly: !config.publicRegistrationEnabled,
    auth: {
      management: "owner_wallet_signed_session",
      agent: "bearer_credential_hmac_sha256_at_rest",
      seller: "owner_wallet_signed_session",
    },
    workflowPayment: {
      protocol: "x402",
      scheme: "exact",
      asset: ARC_TESTNET_USDC_ADDRESS,
      payer: "verified_external_agent_wallet",
    },
    downstreamPayment: {
      protocol: "x402",
      payer: "project_owned_hosted_wallet",
    },
    endpoints: {
      manifest: `${baseUrl}/api/byoa/manifest`,
      quotes: `${baseUrl}/api/byoa/v1/quotes`,
      execute: `${baseUrl}/api/byoa/v1/quotes/{quoteId}/execute`,
      results: `${baseUrl}/api/byoa/v1/results/{jobId}`,
      passport: `${baseUrl}/api/byoa/agents/{publicId}/passport`,
      discoverCounterparties: `${baseUrl}/api/trust/v1/counterparties/discover`,
      selectCounterparty: `${baseUrl}/api/trust/v1/counterparties/select`,
      getCounterpartySelection: `${baseUrl}/api/trust/v1/selections/{selectionId}`,
      getCounterpartyEvidence: `${baseUrl}/api/trust/v1/selections/{selectionId}/evidence`,
      issueCounterpartyClearance: `${baseUrl}/api/trust/v1/selections/{selectionId}/clearance`,
      publishCounterpartySelectionProof: `${baseUrl}/api/trust/v1/selections/{selectionId}/proof`,
    },
    sellerWorkflows,
    standards: {
      erc8004: {
        supported: true,
        agentId: verifiedErc8004AgentId,
        verifiedOnchain: Boolean(verifiedErc8004AgentId),
        identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
        reputationRegistry: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
        validationRegistry: "0x8004Cb1BF31DAf7788923b405b754f57acEB4272",
      },
      erc8183: {
        supported: true,
        role: "evaluator",
      },
      x402: {
        supported: true,
      },
      trust_decisions: {
        evaluate: `${baseUrl}/api/trust/v1/decisions`,
        get: `${baseUrl}/api/trust/v1/decisions/{decisionId}`,
        verify: `${baseUrl}/api/trust/v1/verify`,
        limits: `${baseUrl}/api/trust/v1/agents/{agentId}/limits`
      },
      counterparty_selection: {
        supported: true,
        engine: "veyra-counterparty-selection-v1",
        network: "eip155:5042002",
        chainId: 5042002,
        identityStandard: "ERC-8004",
        erc8183EvidenceSupported: true,
        x402EvidenceSupported: true,
        trustGateAddress: process.env.VEYRA_TRUST_GATE_ADDRESS || null,
        selectionCreatesPayment: false,
        selectionCreatesJob: false,
        proofPublication: "explicit_only",
        clearance: "winner_bound_eip712",
        endpoints: {
          discover: `${baseUrl}/api/trust/v1/counterparties/discover`,
          select: `${baseUrl}/api/trust/v1/counterparties/select`,
          getSelection: `${baseUrl}/api/trust/v1/selections/{selectionId}`,
          getEvidence: `${baseUrl}/api/trust/v1/selections/{selectionId}/evidence`,
          issueClearance: `${baseUrl}/api/trust/v1/selections/{selectionId}/clearance`,
          publishProof: `${baseUrl}/api/trust/v1/selections/{selectionId}/proof`,
        },
      }
    },
    erc8004Identity: {
      capability: "erc8004_identity",
      standard: "ERC-8004",
      network: "Arc Testnet",
      chainId: 5042002,
      agentId: verifiedErc8004AgentId,
      verifiedOnchain: Boolean(verifiedErc8004AgentId),
      identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      reputationRegistry: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
      validationRegistry: "0x8004Cb1BF31DAf7788923b405b754f57acEB4272",
      metadataUri: `${baseUrl}/.well-known/veyra-agent.json`,
      endpoints: {
        agent: `${baseUrl}/api/erc8004/v1/agent`,
        reputation: `${baseUrl}/api/erc8004/v1/reputation`,
        validations: `${baseUrl}/api/erc8004/v1/validations`,
      },
    },
    erc8183Evaluation: {
      capability: "erc8183_evaluation",
      standard: "ERC-8183",
      network: "Arc Testnet",
      chainId: 5042002,
      evaluator: process.env.NEXT_PUBLIC_VEYRA_ERC8183_EVALUATOR_ADDRESS || "0x0d2c04580e081e222bbe5bf9818af337e2633eb7",
      commerce: process.env.NEXT_PUBLIC_ARC_ERC8183_COMMERCE_ADDRESS || "0x0747EEf0706327138c69792bF28Cd525089e4583",
      policy: "structured-deliverable-v1",
      endpoints: {
        evaluator: `${baseUrl}/api/erc8183/v1/evaluator`,
        prepare: `${baseUrl}/api/erc8183/v1/deliverables/prepare`,
        evaluate: `${baseUrl}/api/erc8183/v1/evaluations`,
        getEvaluation: `${baseUrl}/api/erc8183/v1/evaluations/{evaluationId}`,
      },
    },
    agentReputation: {
      capability: "agent_reputation",
      standard: "ERC-8004",
      network: "Arc Testnet",
      chainId: 5042002,
      endpoints: {
        getAgent: `${baseUrl}/api/reputation/v1/agents/{agentId}`,
        getHistory: `${baseUrl}/api/reputation/v1/agents/{agentId}/history`,
        getEvidence: `${baseUrl}/api/reputation/v1/agents/{agentId}/evidence`,
      },
    },
    counterpartySelection: {
      capabilities: ["counterparty_discovery", "counterparty_selection", "trust_clearance"],
      rankingVersion: "veyra-counterparty-selection-v1",
      network: "Arc Testnet",
      chainId: 5042002,
      erc8004: true,
      erc8183Evidence: true,
      x402Evidence: true,
      trustGateAddress: process.env.VEYRA_TRUST_GATE_ADDRESS || null,
      paymentOnSelection: false,
      jobOnSelection: false,
    },
    scopes: [
      "manifest:read", "workflows:read", "quotes:create", "workflows:execute",
      "runs:create", "results:read",
    ],
  };
}
