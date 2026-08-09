/**
 * Copyright 2026 Circle Internet Group, Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server.js";
import { createMachineErrorResponse } from "./machine-errors.ts";
import { getByoaClient } from "../byoa/service.ts";
import { hashApiCredential } from "../byoa/auth.ts";
import type {
  ByoaAgentRow,
  ByoaCredentialRow,
  ByoaPolicyRow,
} from "../byoa/types.ts";
import {
  MACHINE_API_AVAILABLE_SCOPES,
  MACHINE_API_SCOPES,
} from "../byoa/types.ts";

export interface MachineAuthContext {
  credential: ByoaCredentialRow;
  agentId: string;
  ownerWallet: string;
  spendingPolicy: ByoaPolicyRow;
  allowedWorkflows: string[];
}

export type AuthenticateMachineResult =
  | { ok: true; context: MachineAuthContext }
  | { ok: false; response: NextResponse };

export async function authenticateMachineRequest(
  req: Request,
  requiredScope: string,
): Promise<AuthenticateMachineResult> {
  const authHeader =
    req.headers.get("authorization") || req.headers.get("Authorization");

  if (!authHeader) {
    return {
      ok: false,
      response: createMachineErrorResponse(
        "credential_missing",
        "Bearer token authorization header is missing or malformed.",
        401,
      ),
    };
  }

  const match = authHeader.match(/^Bearer\s+([^\s]{20,500})$/i);
  if (!match || !match[1]) {
    return {
      ok: false,
      response: createMachineErrorResponse(
        "credential_missing",
        "Bearer token authorization header is missing or malformed.",
        401,
      ),
    };
  }

  const token = match[1].trim();
  const computedHash = hashApiCredential(token);
  const client = getByoaClient();

  const { data: credData, error: credError } = await client
    .from("byoa_agent_credentials")
    .select("*")
    .eq("credential_hash", computedHash)
    .maybeSingle();

  if (credError) {
    return {
      ok: false,
      response: createMachineErrorResponse(
        "internal_error",
        "Database authentication check failed.",
        500,
      ),
    };
  }

  if (!credData) {
    return {
      ok: false,
      response: createMachineErrorResponse(
        "credential_missing",
        "Invalid API credential token.",
        401,
      ),
    };
  }

  const credential = credData as ByoaCredentialRow;

  if (credential.credential_type !== "machine_api") {
    return {
      ok: false,
      response: createMachineErrorResponse(
        "credential_missing",
        "Invalid API credential token.",
        401,
      ),
    };
  }

  // Constant-time hash verification
  const hashBuffer = Buffer.from(computedHash, "hex");
  const dbHashBuffer = Buffer.from(credential.credential_hash, "hex");
  if (
    hashBuffer.length !== dbHashBuffer.length ||
    !timingSafeEqual(hashBuffer, dbHashBuffer)
  ) {
    return {
      ok: false,
      response: createMachineErrorResponse(
        "credential_missing",
        "Invalid API credential token.",
        401,
      ),
    };
  }

  // Check Revocation & Expiration
  if (credential.revoked_at) {
    return {
      ok: false,
      response: createMachineErrorResponse(
        "credential_revoked",
        "API credential has been revoked.",
        401,
      ),
    };
  }

  if (Date.parse(credential.expires_at) <= Date.now()) {
    return {
      ok: false,
      response: createMachineErrorResponse(
        "credential_revoked",
        "API credential has expired.",
        401,
      ),
    };
  }

  // Check Scope
  const grantedScopes = new Set<string>(credential.scopes || []);
  const hasClosedMachineScopeSet =
    MACHINE_API_SCOPES.every((scope) => grantedScopes.has(scope)) &&
    [...grantedScopes].every((scope) =>
      MACHINE_API_AVAILABLE_SCOPES.includes(
        scope as (typeof MACHINE_API_AVAILABLE_SCOPES)[number],
      ),
    );
  const hasScope = hasClosedMachineScopeSet && grantedScopes.has(requiredScope);

  if (!hasScope) {
    return {
      ok: false,
      response: createMachineErrorResponse(
        "scope_denied",
        `Credential lacks the required scope '${requiredScope}'.`,
        403,
      ),
    };
  }

  // Load Agent Profile & Policy
  const [agentRes, policyRes] = await Promise.all([
    client
      .from("byoa_agents")
      .select("*")
      .eq("id", credential.agent_id)
      .maybeSingle(),
    client
      .from("byoa_agent_policies")
      .select("*")
      .eq("agent_id", credential.agent_id)
      .maybeSingle(),
  ]);

  if (agentRes.error || policyRes.error) {
    return {
      ok: false,
      response: createMachineErrorResponse(
        "internal_error",
        "Failed to load agent profile or spending policy.",
        500,
      ),
    };
  }

  if (!agentRes.data || !policyRes.data) {
    return {
      ok: false,
      response: createMachineErrorResponse(
        "workflow_disabled",
        "Agent profile or policy configuration is incomplete.",
        403,
      ),
    };
  }

  const agent = agentRes.data as ByoaAgentRow;
  const policy = policyRes.data as ByoaPolicyRow;

  if (credential.owner_wallet.toLowerCase() !== agent.owner_wallet.toLowerCase()) {
    return {
      ok: false,
      response: createMachineErrorResponse(
        "credential_missing",
        "Invalid API credential token.",
        401,
      ),
    };
  }

  if (agent.status !== "active" || policy.status !== "active") {
    return {
      ok: false,
      response: createMachineErrorResponse(
        "workflow_disabled",
        "Agent profile or policy is not active.",
        403,
      ),
    };
  }

  // Check Allowed Workflows
  const allowedWorkflows = policy.allowed_workflows || [];
  if (allowedWorkflows.length === 0) {
    return {
      ok: false,
      response: createMachineErrorResponse(
        "workflow_disabled",
        "No workflows are enabled for this credential policy.",
        403,
      ),
    };
  }

  // Touch last_used_at asynchronously
  client
    .from("byoa_agent_credentials")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", credential.id)
    .then(
      () => {},
      () => {},
    );

  return {
    ok: true,
    context: {
      credential,
      agentId: agent.id,
      ownerWallet: agent.owner_wallet,
      spendingPolicy: policy,
      allowedWorkflows,
    },
  };
}

export async function enforceQuoteCreationPolicy(
  context: MachineAuthContext,
): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  const client = getByoaClient();
  const todayStartIso =
    new Date().toISOString().slice(0, 10) + "T00:00:00.000Z";
  const { count: dailyCallCount, error: countError } = await client
    .from("hosted_workflow_quotes")
    .select("id", { count: "exact", head: true })
    .eq("byoa_agent_id", context.agentId)
    .gte("created_at", todayStartIso);

  if (countError) {
    return {
      ok: false,
      response: createMachineErrorResponse(
        "internal_error",
        "The quote policy could not be safely evaluated right now.",
        503,
        true,
      ),
    };
  }

  if (
    dailyCallCount !== null &&
    dailyCallCount >= context.spendingPolicy.max_daily_calls
  ) {
    return {
      ok: false,
      response: createMachineErrorResponse(
        "spending_limit_exceeded",
        `Daily API call limit of ${context.spendingPolicy.max_daily_calls} calls exceeded for this credential policy.`,
        429,
      ),
    };
  }

  return { ok: true };
}

export async function enforceQuoteSpendingPolicy(
  context: MachineAuthContext,
  estimatedProviderCostUsdc: number,
): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  const maxPerRun = Number(context.spendingPolicy.max_price_per_run_usdc);
  const dailyLimit = Number(context.spendingPolicy.daily_spend_limit_usdc);

  if (
    !Number.isFinite(estimatedProviderCostUsdc) ||
    !Number.isFinite(maxPerRun) ||
    !Number.isFinite(dailyLimit)
  ) {
    return {
      ok: false,
      response: createMachineErrorResponse(
        "internal_error",
        "The quote spending policy is invalid.",
        503,
        true,
      ),
    };
  }

  if (estimatedProviderCostUsdc > maxPerRun + Number.EPSILON) {
    return {
      ok: false,
      response: createMachineErrorResponse(
        "spending_limit_exceeded",
        `Estimated provider cost exceeds the ${maxPerRun.toFixed(6)} USDC per-run policy limit.`,
        429,
      ),
    };
  }

  const todayStartIso =
    new Date().toISOString().slice(0, 10) + "T00:00:00.000Z";
  const { data, error } = await getByoaClient()
    .from("hosted_workflow_quotes")
    .select("estimated_provider_cost_usdc,status")
    .eq("byoa_agent_id", context.agentId)
    .gte("created_at", todayStartIso);

  if (error) {
    return {
      ok: false,
      response: createMachineErrorResponse(
        "internal_error",
        "The daily spending policy could not be safely evaluated right now.",
        503,
        true,
      ),
    };
  }

  const reservedToday = (data ?? [])
    .filter(
      (row) =>
        row.status !== "expired" &&
        row.status !== "cancelled" &&
        row.status !== "credited",
    )
    .reduce(
      (total, row) =>
        total + Number(row.estimated_provider_cost_usdc || 0),
      0,
    );

  if (reservedToday + estimatedProviderCostUsdc > dailyLimit + Number.EPSILON) {
    return {
      ok: false,
      response: createMachineErrorResponse(
        "spending_limit_exceeded",
        `Daily provider spending limit of ${dailyLimit.toFixed(6)} USDC would be exceeded.`,
        429,
      ),
    };
  }

  return { ok: true };
}

export async function enforceRunCreationPolicy(
  context: MachineAuthContext,
): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  const client = getByoaClient();
  const todayStartIso =
    new Date().toISOString().slice(0, 10) + "T00:00:00.000Z";
  const { count: dailyCallCount, error: countError } = await client
    .from("hosted_agent_jobs")
    .select("id", { count: "exact", head: true })
    .eq("byoa_agent_id", context.agentId)
    .gte("created_at", todayStartIso);

  if (countError) {
    return {
      ok: false,
      response: createMachineErrorResponse(
        "internal_error",
        "The run policy could not be safely evaluated right now.",
        503,
        true,
      ),
    };
  }

  if (
    dailyCallCount !== null &&
    dailyCallCount >= context.spendingPolicy.max_daily_calls
  ) {
    return {
      ok: false,
      response: createMachineErrorResponse(
        "spending_limit_exceeded",
        `Daily API call limit of ${context.spendingPolicy.max_daily_calls} calls exceeded for this credential policy.`,
        429,
      ),
    };
  }

  return { ok: true };
}

const readRateLimitStore = new Map<string, { count: number; windowStart: number }>();

export async function enforceReadRateLimit(
  context: MachineAuthContext,
  maxPerMinute = 120,
): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  if (process.env.NODE_ENV !== "test") {
    const { data, error } = await getByoaClient().rpc(
      "consume_machine_api_read_limit_v1",
      {
        p_credential_id: context.credential.id,
        p_route: "machine_api_results_read",
        p_max_per_minute: maxPerMinute,
      },
    );
    if (error) {
      return {
        ok: false,
        response: createMachineErrorResponse(
          "internal_error",
          "The read rate limit could not be safely evaluated right now.",
          503,
          true,
        ),
      };
    }
    const row = (data as Array<{
      allowed?: boolean;
      retry_after_seconds?: number;
    }> | null)?.[0];
    if (!row?.allowed) {
      return {
        ok: false,
        response: createMachineErrorResponse(
          "rate_limited",
          "Read rate limit exceeded. Please retry shortly.",
          429,
          true,
        ),
      };
    }
    return { ok: true };
  }

  const now = Date.now();
  const key = context.credential.id;
  if (readRateLimitStore.size >= 1000) {
    for (const [storedKey, stored] of readRateLimitStore) {
      if (now - stored.windowStart > 60_000) readRateLimitStore.delete(storedKey);
    }
    if (readRateLimitStore.size >= 1000) {
      const oldestKey = readRateLimitStore.keys().next().value;
      if (oldestKey) readRateLimitStore.delete(oldestKey);
    }
  }
  const entry = readRateLimitStore.get(key);

  if (!entry || now - entry.windowStart > 60000) {
    readRateLimitStore.set(key, { count: 1, windowStart: now });
    return { ok: true };
  }

  if (entry.count >= maxPerMinute) {
    return {
      ok: false,
      response: createMachineErrorResponse(
        "rate_limited",
        "Read rate limit exceeded. Please retry after 1 minute.",
        429,
        true,
      ),
    };
  }

  entry.count += 1;
  return { ok: true };
}
