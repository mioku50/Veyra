/**
 * Copyright 2026 Circle Internet Group, Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server.js";
import { getAddress } from "viem";
import { createApiCredential, hashApiCredential } from "../lib/byoa/auth.ts";
import { setByoaClientForTesting } from "../lib/byoa/service.ts";
import {
  inspectMachineIdempotency,
  resolveMachineIdempotency,
  releaseMachineIdempotency,
  saveMachineIdempotency,
  clearMachineIdempotencyStore,
  computeCanonicalRequestHash,
  setMachineIdempotencyClientForTesting,
} from "../lib/api/machine-idempotency.ts";
import { hashHostedWorkflowInput } from "../lib/agent/hosted-workflows.ts";
import { handleMachineInternalError } from "../lib/api/machine-errors.ts";
import { GET as workflowsGET } from "../app/api/agent/v1/workflows/route.ts";
import { POST as quotesPOST } from "../app/api/agent/v1/quotes/route.ts";
import { POST as runsPOST } from "../app/api/agent/v1/runs/route.ts";
import { GET as runByIdGET } from "../app/api/agent/v1/runs/[runId]/route.ts";
import { GET as reportByIdGET } from "../app/api/agent/v1/reports/[reportId]/route.ts";

console.log("[machine-api-tests] Running Machine API v1 tests...");

// Environment overrides for test isolation
process.env.NODE_ENV = "test";
process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
process.env.HOSTED_WORKFLOW_TREASURY_ADDRESS = "0x2222222222222222222222222222222222222222";
process.env.SELLER_ADDRESS = "0x2222222222222222222222222222222222222222";
process.env.RATE_LIMIT_SECRET = "test-rate-limit-secret-12345";
process.env.HOSTED_AGENT_RATE_LIMIT_SECRET = "test-rate-limit-secret-12345";
process.env.HOSTED_AGENT_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
process.env.HOSTED_AGENT_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
process.env.HOSTED_AGENT_BASE_URL = "http://localhost:3000";
process.env.BYOA_MANAGEMENT_SESSION_SECRET = "test-session-secret-32-chars-long-0000000000";
process.env.BYOA_CREDENTIAL_PEPPER = "test-credential-pepper-32-chars-long-0000000000";

// --- Section 1: Unit Tests for Machine Idempotency Helper ---
async function testMachineIdempotencyUnit() {
  console.log("-> Testing Machine Idempotency Helper & Canonical Hashing...");

  // Test canonical request hash sorting
  const payload1 = { b: 2, a: 1, nested: { y: "hello", x: "world" } };
  const payload2 = { a: 1, nested: { x: "world", y: "hello" }, b: 2 };
  const payloadDiff = { a: 1, nested: { x: "world", y: "different" }, b: 2 };

  const hash1 = computeCanonicalRequestHash(payload1);
  const hash2 = computeCanonicalRequestHash(payload2);
  const hashDiff = computeCanonicalRequestHash(payloadDiff);

  assert.equal(hash1, hash2, "Canonical request hashes must match regardless of object key order");
  assert.notEqual(hash1, hashDiff, "Different payloads must yield different canonical request hashes");

  // In-memory store fallback test
  clearMachineIdempotencyStore();
  setMachineIdempotencyClientForTesting(null);

  const credId = "test-cred-123";
  const idempotencyKey = "key-alpha-1";
  const payloadA = { workflow: "github_due_diligence", repository: "circlefin/agent-commerce" };
  const payloadB = { workflow: "github_due_diligence", repository: "owner/other-repo" };
  const mockResult = {
    quoteId: "quote-111",
    workflow: "github_due_diligence",
    totalUsdc: 0.002,
    sponsored: true,
  };

  // Read-only inspection must not reserve a previously unseen key.
  const inspection1 = await inspectMachineIdempotency(
    idempotencyKey,
    credId,
    payloadA,
  );
  const inspection2 = await inspectMachineIdempotency(
    idempotencyKey,
    credId,
    payloadA,
  );
  assert.equal(inspection1.ok, true);
  assert.equal(inspection1.cached, false);
  assert.equal(inspection2.ok, true);
  assert.equal(inspection2.pending, undefined);

  // Initial check should be uncached and non-conflicting
  const check1 = await resolveMachineIdempotency(idempotencyKey, credId, payloadA);
  assert.equal(check1.cached, false);
  assert.equal(check1.conflict, false);
  assert.equal(check1.ok, true);
  assert.ok(check1.reservationToken);

  await releaseMachineIdempotency(
    idempotencyKey,
    credId,
    payloadA,
    "/api/agent/v1",
    "00000000-0000-4000-8000-000000000000",
  );
  const wrongOwnerRelease = await resolveMachineIdempotency(idempotencyKey, credId, payloadA);
  assert.equal(wrongOwnerRelease.pending, true, "A different lease owner must not release the reservation");

  await releaseMachineIdempotency(
    idempotencyKey,
    credId,
    payloadA,
    "/api/agent/v1",
    check1.reservationToken,
  );
  const releasedCheck = await resolveMachineIdempotency(idempotencyKey, credId, payloadB);
  assert.equal(releasedCheck.ok, true, "A failed mutation must be able to release its pending lease");
  await releaseMachineIdempotency(
    idempotencyKey,
    credId,
    payloadB,
    "/api/agent/v1",
    releasedCheck.reservationToken,
  );
  const restoredCheck = await resolveMachineIdempotency(idempotencyKey, credId, payloadA);
  assert.equal(restoredCheck.ok, true);
  assert.equal(check1.result, undefined);

  // A concurrent replay before the first response is finalized must not execute.
  const pendingCheck = await resolveMachineIdempotency(
    idempotencyKey,
    credId,
    payloadA,
  );
  assert.equal(pendingCheck.ok, false);
  assert.equal(pendingCheck.pending, true);
  assert.equal(pendingCheck.conflict, false);

  // Save record
  await saveMachineIdempotency(idempotencyKey, credId, payloadA, mockResult, {
    reservationToken: restoredCheck.reservationToken,
  });

  // Re-check with identical payload -> should return cached result
  const check2 = await resolveMachineIdempotency(idempotencyKey, credId, payloadA);
  assert.equal(check2.cached, true);
  assert.equal(check2.conflict, false);
  assert.equal(check2.ok, true);
  assert.deepEqual(check2.result, mockResult);

  // Check with different payload -> should signal conflict
  const check3 = await resolveMachineIdempotency(idempotencyKey, credId, payloadB);
  assert.equal(check3.cached, false);
  assert.equal(check3.conflict, true);
  assert.equal(check3.ok, false);

  // Clear store
  clearMachineIdempotencyStore();
  const check4 = await resolveMachineIdempotency(idempotencyKey, credId, payloadA);
  assert.equal(check4.cached, false);
  assert.equal(check4.conflict, false);
  assert.equal(check4.ok, true);

  console.log("✔ Machine Idempotency Helper unit tests passed.");
}

// --- Section 2: Mock Database Client Setup ---
console.log("-> Setting up Mock Supabase Client for Machine API testing...");

const fullCred = createApiCredential("agt_test_full");
const readOnlyCred = createApiCredential("agt_test_readonly");
const revokedCred = createApiCredential("agt_test_revoked");
const credB = createApiCredential("agt_test_agentB");
const credSameAgent2 = createApiCredential("agt_test_credA2");
const credSameOwnerAgent2 = createApiCredential("agt_test_sameowner2");
const byoaNamespaceCred = createApiCredential("agt_test_byoa");
const machineScopes = ["workflows:read", "quotes:create", "runs:create", "results:read"];
const mockOwnerWallet = getAddress("0x1111111111111111111111111111111111111111");

const mockCredentials: Record<string, any> = {
  [fullCred.hash]: {
    id: "cred-full-1",
    agent_id: "agent-1",
    owner_wallet: mockOwnerWallet,
    credential_type: "machine_api",
    label: "Full Access Token",
    token_prefix: fullCred.prefix,
    credential_hash: fullCred.hash,
    scopes: [...machineScopes],
    expires_at: "2099-01-01T00:00:00.000Z",
    revoked_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
  },
  [credSameAgent2.hash]: {
    id: "cred-full-2",
    agent_id: "agent-1",
    owner_wallet: mockOwnerWallet,
    credential_type: "machine_api",
    label: "Second Token Same Agent",
    token_prefix: credSameAgent2.prefix,
    credential_hash: credSameAgent2.hash,
    scopes: [...machineScopes],
    expires_at: "2099-01-01T00:00:00.000Z",
    revoked_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
  },
  [credSameOwnerAgent2.hash]: {
    id: "cred-agent2-1",
    agent_id: "agent-2-same-owner",
    owner_wallet: mockOwnerWallet,
    credential_type: "machine_api",
    label: "Agent 2 Token Same Owner",
    token_prefix: credSameOwnerAgent2.prefix,
    credential_hash: credSameOwnerAgent2.hash,
    scopes: [...machineScopes],
    expires_at: "2099-01-01T00:00:00.000Z",
    revoked_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
  },
  [readOnlyCred.hash]: {
    id: "cred-readonly-1",
    agent_id: "agent-1",
    owner_wallet: mockOwnerWallet,
    credential_type: "machine_api",
    label: "Read Only Token",
    token_prefix: readOnlyCred.prefix,
    credential_hash: readOnlyCred.hash,
    scopes: ["results:read"],
    expires_at: "2099-01-01T00:00:00.000Z",
    revoked_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
  },
  [revokedCred.hash]: {
    id: "cred-revoked-1",
    agent_id: "agent-1",
    owner_wallet: mockOwnerWallet,
    credential_type: "machine_api",
    label: "Revoked Token",
    token_prefix: revokedCred.prefix,
    credential_hash: revokedCred.hash,
    scopes: [...machineScopes],
    expires_at: "2099-01-01T00:00:00.000Z",
    revoked_at: "2026-01-01T12:00:00.000Z",
    created_at: "2026-01-01T00:00:00.000Z",
  },
  [credB.hash]: {
    id: "cred-agentB-1",
    agent_id: "agent-2",
    owner_wallet: mockOwnerWallet,
    credential_type: "machine_api",
    label: "Agent B Token",
    token_prefix: credB.prefix,
    credential_hash: credB.hash,
    scopes: [...machineScopes],
    expires_at: "2099-01-01T00:00:00.000Z",
    revoked_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
  },
  [byoaNamespaceCred.hash]: {
    id: "cred-byoa-1",
    agent_id: "agent-1",
    owner_wallet: mockOwnerWallet,
    credential_type: "byoa_workflow",
    label: "BYOA Workflow Token",
    token_prefix: byoaNamespaceCred.prefix,
    credential_hash: byoaNamespaceCred.hash,
    scopes: ["manifest:read", "quotes:create", "workflows:execute", "results:read"],
    expires_at: "2099-01-01T00:00:00.000Z",
    revoked_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
  },
};

const mockAgent = {
  id: "agent-1",
  public_id: "agt_test_full",
  display_name: "Test Agent",
  owner_wallet: mockOwnerWallet,
  agent_wallet: getAddress("0x3333333333333333333333333333333333333333"),
  agent_wallet_status: "verified",
  status: "active",
  canary_enabled: true,
  wallet_verified_at: "2026-01-01T00:00:00.000Z",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

const mockAgentsStore = new Map<string, any>([
  ["agent-1", mockAgent],
  [
    "agent-2-same-owner",
    {
      id: "agent-2-same-owner",
      public_id: "agt_test_agent2",
      display_name: "Test Agent 2 Same Owner",
      owner_wallet: mockAgent.owner_wallet,
      agent_wallet: getAddress("0x4444444444444444444444444444444444444444"),
      agent_wallet_status: "verified",
      status: "active",
      canary_enabled: true,
      wallet_verified_at: "2026-01-01T00:00:00.000Z",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
  ],
]);

const mockPolicy = {
  agent_id: "agent-1",
  allowed_workflows: ["github_due_diligence", "sentiment_tone"],
  allowed_service_types: ["internal_deterministic", "live_provider"],
  max_price_per_run_usdc: "0.005",
  daily_spend_limit_usdc: "1.0",
  max_daily_calls: 50,
  status: "active",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

const mockQuotesStore = new Map<string, any>();
const mockJobsStore = new Map<string, any>();

// Seed Fixture Quotes
const fixtureSponsoredQuote = {
  id: "quote-sponsored-1",
  byoa_agent_id: "agent-1",
  machine_credential_id: "cred-full-1",
  idempotency_hash: "idempotency_hash_sponsored_1",
  request_hash: "request_hash_sponsored_1",
  requester_fingerprint: "fingerprint_1",
  requester_wallet: mockAgent.owner_wallet,
  workflow_type: "github_due_diligence",
  task: "Run GitHub due diligence on circlefin/agent-commerce",
  input_preview: "circlefin/agent-commerce",
  input_hash: hashHostedWorkflowInput("https://github.com/circlefin/agent-commerce"),
  budget_usdc: "0.002",
  planner_snapshot: {
    workflowType: "github_due_diligence",
    repository: {
      owner: "circlefin",
      name: "agent-commerce",
      fullName: "circlefin/agent-commerce",
      canonicalUrl: "https://github.com/circlefin/agent-commerce",
    },
    selectedServices: [
      { slug: "github_repo_info", priceUsdc: "0.001" },
      { slug: "github_activity", priceUsdc: "0.001" },
    ],
    metadata: {
      byoa_agent_id: "agent-1",
      machine_credential_id: "cred-full-1",
      owner_wallet: mockAgent.owner_wallet,
    },
  },
  selected_services: [
    { slug: "github_repo_info", priceUsdc: "0.001" },
    { slug: "github_activity", priceUsdc: "0.001" },
  ],
  payment_mode: "sponsored",
  amount_due_usdc: "0",
  status: "quoted",
  expires_at: "2099-01-01T00:00:00.000Z",
  created_at: "2026-01-01T00:00:00.000Z",
};

const fixturePaidQuote = {
  ...fixtureSponsoredQuote,
  id: "quote-paid-1",
  idempotency_hash: "idempotency_hash_paid_1",
  request_hash: "request_hash_paid_1",
  payment_mode: "paid",
  amount_due_usdc: "0.002",
};

const fixtureExpiredQuote = {
  ...fixtureSponsoredQuote,
  id: "quote-expired-1",
  idempotency_hash: "idempotency_hash_expired_1",
  request_hash: "request_hash_expired_1",
  status: "expired",
  expires_at: "2020-01-01T00:00:00.000Z",
};

const fixtureConsumedQuote = {
  ...fixtureSponsoredQuote,
  id: "quote-consumed-1",
  idempotency_hash: "idempotency_hash_consumed_1",
  request_hash: "request_hash_consumed_1",
  status: "consumed",
  job_id: "job-existing-1",
};

mockQuotesStore.set("quote-sponsored-1", fixtureSponsoredQuote);
mockQuotesStore.set("quote-paid-1", fixturePaidQuote);
mockQuotesStore.set("quote-expired-1", fixtureExpiredQuote);
mockQuotesStore.set("quote-consumed-1", fixtureConsumedQuote);
mockQuotesStore.set("idempotency_hash_sponsored_1", fixtureSponsoredQuote);
mockQuotesStore.set("idempotency_hash_paid_1", fixturePaidQuote);
mockQuotesStore.set("idempotency_hash_expired_1", fixtureExpiredQuote);
mockQuotesStore.set("idempotency_hash_consumed_1", fixtureConsumedQuote);

// Seed Fixture Jobs
const fixtureCompletedJob = {
  id: "job-existing-1",
  agent_run_id: "run-existing-1",
  byoa_agent_id: "agent-1",
  machine_credential_id: "cred-full-1",
  requester_wallet: mockAgent.owner_wallet,
  workflow_type: "github_due_diligence",
  task: "Run GitHub due diligence",
  input_preview: "circlefin/agent-commerce",
  input_hash: hashHostedWorkflowInput("https://github.com/circlefin/agent-commerce"),
  budget_usdc: "0.002",
  status: "completed",
  progress_stage: "completed",
  spent_usdc: "0.002",
  planner_snapshot: {
    selectedServices: [
      { slug: "github_repo_info" },
      { slug: "github_activity" },
    ],
  },
  selected_services: [
    { slug: "github_repo_info", priceUsdc: "0.001" },
    { slug: "github_activity", priceUsdc: "0.001" },
  ],
  receipt_ids: ["rcpt-1", "rcpt-2"],
  proof_transaction_hashes: [
    "0x1111111111111111111111111111111111111111111111111111111111111111",
    "0x2222222222222222222222222222222222222222222222222222222222222222",
  ],
  structured_result: {
    summary: "High quality repository with clear structure.",
    completedWithWarnings: false,
  },
  created_at: "2026-01-01T00:00:00.000Z",
  completed_at: "2026-01-01T00:01:00.000Z",
};

const fixtureOtherAgentJob = {
  ...fixtureCompletedJob,
  id: "job-other-agent",
  byoa_agent_id: "agent-other-99",
  requester_wallet: getAddress("0x9999999999999999999999999999999999999999"),
};

const fixtureRunningJob = {
  ...fixtureCompletedJob,
  id: "job-running-1",
  status: "running",
  progress_stage: "purchasing",
  completed_at: null,
  structured_result: null,
};

mockJobsStore.set("job-existing-1", fixtureCompletedJob);
mockJobsStore.set("job-other-agent", fixtureOtherAgentJob);
mockJobsStore.set("job-running-1", fixtureRunningJob);

const mockIdempotencyDbStore = new Map<string, any>();
let mockDailyCallCount = 0;
let mockReservationSequence = 0;

function createMockSupabaseClient(): any {
  return {
    rpc(fnName: string, args: any) {
      if (fnName === "reserve_machine_api_idempotency_v1") {
        const compositeKey =
          `${args.p_credential_id}:${args.p_route}:${args.p_idempotency_key_hash}`;
        const existing = mockIdempotencyDbStore.get(compositeKey);

        if (!existing || Date.parse(existing.expires_at) <= Date.now()) {
          mockReservationSequence += 1;
          const reservationToken = `00000000-0000-4000-8000-${String(mockReservationSequence).padStart(12, "0")}`;
          mockIdempotencyDbStore.set(compositeKey, {
            credential_id: args.p_credential_id,
            agent_id: args.p_agent_id,
            route: args.p_route,
            idempotency_key_hash: args.p_idempotency_key_hash,
            request_hash: args.p_request_hash,
            response_status: null,
            response_body: null,
            reservation_token: reservationToken,
            created_at: new Date().toISOString(),
            expires_at: args.p_expires_at,
          });
          return Promise.resolve({
            data: [{
              reservation_outcome: "reserved",
              cached_status: null,
              cached_body: null,
              reservation_token: reservationToken,
            }],
            error: null,
          });
        }

        if (existing.request_hash !== args.p_request_hash) {
          return Promise.resolve({
            data: [{
              reservation_outcome: "conflict",
              cached_status: null,
              cached_body: null,
            }],
            error: null,
          });
        }

        if (
          existing.response_status !== null &&
          existing.response_status !== undefined
        ) {
          return Promise.resolve({
            data: [{
              reservation_outcome: "cached",
              cached_status: existing.response_status,
              cached_body: existing.response_body,
            }],
            error: null,
          });
        }

        return Promise.resolve({
          data: [{
            reservation_outcome: "pending",
            cached_status: null,
            cached_body: null,
          }],
          error: null,
        });
      }

      if (fnName === "complete_machine_api_idempotency_v1") {
        const compositeKey =
          `${args.p_credential_id}:${args.p_route}:${args.p_idempotency_key_hash}`;
        const existing = mockIdempotencyDbStore.get(compositeKey);
        if (
          !existing ||
          existing.request_hash !== args.p_request_hash ||
          existing.reservation_token !== args.p_reservation_token ||
          existing.response_status !== null
        ) {
          return Promise.resolve({ data: false, error: null });
        }
        mockIdempotencyDbStore.set(compositeKey, {
          ...existing,
          response_status: args.p_response_status,
          response_body: args.p_response_body,
          resource_type: args.p_resource_type,
          resource_id: args.p_resource_id,
          expires_at: args.p_expires_at,
        });
        return Promise.resolve({ data: true, error: null });
      }

      if (fnName === "release_machine_api_idempotency_v1") {
        const compositeKey =
          `${args.p_credential_id}:${args.p_route}:${args.p_idempotency_key_hash}`;
        const existing = mockIdempotencyDbStore.get(compositeKey);
        if (
          !existing ||
          existing.request_hash !== args.p_request_hash ||
          existing.reservation_token !== args.p_reservation_token ||
          existing.response_status !== null
        ) {
          return Promise.resolve({ data: false, error: null });
        }
        mockIdempotencyDbStore.delete(compositeKey);
        return Promise.resolve({ data: true, error: null });
      }

      if (fnName === "launch_hosted_workflow_checkout_v1") {
        const quote = mockQuotesStore.get(args.p_quote_id);
        if (!quote) {
          return Promise.resolve({
            data: [{ job_id: null, user_payment_id: null, created: false, reason: "quote_not_found", retry_after_seconds: 0 }],
            error: null,
          });
        }
        if (quote.status === "expired" || Date.parse(quote.expires_at) <= Date.now()) {
          return Promise.resolve({
            data: [{ job_id: null, user_payment_id: null, created: false, reason: "quote_expired", retry_after_seconds: 0 }],
            error: null,
          });
        }
        if (quote.status === "consumed" || quote.job_id != null) {
          return Promise.resolve({
            data: [{ job_id: quote.job_id, user_payment_id: "pay-existing", created: false, reason: "idempotent", retry_after_seconds: 0 }],
            error: null,
          });
        }

        const newJobId = `job-new-${Date.now()}`;
        const newJob = {
          id: newJobId,
          byoa_agent_id: "agent-1",
          requester_wallet: quote.requester_wallet,
          workflow_type: quote.workflow_type,
          task: quote.task,
          input_preview: quote.input_preview,
          input_hash: quote.input_hash,
          budget_usdc: quote.budget_usdc,
          planner_snapshot: quote.planner_snapshot,
          selected_services: quote.selected_services,
          status: "queued",
          progress_stage: "queued",
          spent_usdc: "0",
          created_at: new Date().toISOString(),
          workflow_quote_id: quote.id,
          payment_mode: quote.payment_mode,
        };

        mockJobsStore.set(newJobId, newJob);
        quote.status = "consumed";
        quote.job_id = newJobId;

        return Promise.resolve({
          data: [{ job_id: newJobId, user_payment_id: `pay-${newJobId}`, created: true, reason: "created", retry_after_seconds: 0 }],
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    },

    from(tableName: string) {
      let filterEqField: string | null = null;
      let filterEqVal: any = null;
      const filters: Record<string, any> = {};

      const chain: any = {
        select(fields?: string, opts?: any) {
          if (opts?.count === "exact" && opts?.head === true) {
            return {
              count: mockDailyCallCount,
              error: null,
              eq() { return this; },
              gte() { return this; },
              ilike() { return this; },
            };
          }
          return chain;
        },
        eq(field: string, val: any) {
          filterEqField = field;
          filterEqVal = val;
          filters[field] = val;
          return chain;
        },
        gte() { return chain; },
        in() { return chain; },
        ilike() { return chain; },
        is() { return chain; },
        order() { return chain; },
        limit() {
          return Promise.resolve({ data: [], error: null });
        },
        then(onfulfilled?: (value: any) => any) {
          let res = { data: [] as any[], error: null };
          if (tableName === "agent_runs") {
            res = { data: [{ agent_wallet: mockAgent.agent_wallet }] as any, error: null };
          } else if (tableName === "agent_purchase_steps") {
            res = {
              data: [
                { id: "rcpt-1", service_slug: "github_repo_info", service_name: "GitHub Repository Info", price_usdc: "0.001", status: "paid", reasoning: "", payment_event_id: "evt-1", response_preview: null, error: null },
                { id: "rcpt-2", service_slug: "github_activity", service_name: "GitHub Activity", price_usdc: "0.001", status: "paid", reasoning: "", payment_event_id: "evt-2", response_preview: null, error: null },
              ] as any,
              error: null,
            };
          } else if (tableName === "payment_events") {
            res = {
              data: [
                {
                  id: "evt-1",
                  receipt_hash: "0x1111111111111111111111111111111111111111111111111111111111111111",
                  service_hash: "0x2222222222222222222222222222222222222222222222222222222222222222",
                  request_hash: "0x3333333333333333333333333333333333333333333333333333333333333333",
                  response_hash: "0x4444444444444444444444444444444444444444444444444444444444444444",
                  onchain_contract_address: "0x2222222222222222222222222222222222222222",
                  onchain_chain_id: 5042002,
                  onchain_tx_hash: "0x1111111111111111111111111111111111111111111111111111111111111111",
                  onchain_status: "verified",
                  onchain_block_number: 100,
                  onchain_proof_id: "0x1111111111111111111111111111111111111111111111111111111111111111",
                  onchain_attester: "0x2222222222222222222222222222222222222222",
                  onchain_verified_at: "2026-01-01T00:00:00.000Z",
                  onchain_last_attempt_at: null,
                  onchain_attempt_count: 1,
                  onchain_error: null,
                },
                {
                  id: "evt-2",
                  receipt_hash: "0x5555555555555555555555555555555555555555555555555555555555555555",
                  service_hash: "0x6666666666666666666666666666666666666666666666666666666666666666",
                  request_hash: "0x7777777777777777777777777777777777777777777777777777777777777777",
                  response_hash: "0x8888888888888888888888888888888888888888888888888888888888888888",
                  onchain_contract_address: "0x2222222222222222222222222222222222222222",
                  onchain_chain_id: 5042002,
                  onchain_tx_hash: "0x2222222222222222222222222222222222222222222222222222222222222222",
                  onchain_status: "verified",
                  onchain_block_number: 101,
                  onchain_proof_id: "0x5555555555555555555555555555555555555555555555555555555555555555",
                  onchain_attester: "0x2222222222222222222222222222222222222222",
                  onchain_verified_at: "2026-01-01T00:00:00.000Z",
                  onchain_last_attempt_at: null,
                  onchain_attempt_count: 1,
                  onchain_error: null,
                },
              ] as any,
              error: null,
            };
          }
          return Promise.resolve(res).then(onfulfilled);
        },
        async maybeSingle() {
          if (tableName === "byoa_agent_credentials") {
            const row = mockCredentials[filterEqVal];
            return { data: row || null, error: null };
          }
          if (tableName === "byoa_agents") {
            const row = mockAgentsStore.get(filterEqVal) || mockAgent;
            return { data: row, error: null };
          }
          if (tableName === "byoa_agent_policies") {
            return { data: mockPolicy, error: null };
          }
          if (tableName === "hosted_workflow_quotes") {
            const row = mockQuotesStore.get(filterEqVal);
            return { data: row || null, error: null };
          }
          if (tableName === "hosted_agent_jobs") {
            const row = mockJobsStore.get(filterEqVal);
            return { data: row || null, error: null };
          }
          if (tableName === "machine_api_idempotency") {
            const compositeKey = `${filters.credential_id}:${filters.route}:${filters.idempotency_key_hash}`;
            const row = mockIdempotencyDbStore.get(compositeKey);
            return { data: row || null, error: null };
          }
          if (tableName === "agent_runs") {
            return { data: { agent_wallet: mockAgent.agent_wallet }, error: null };
          }
          return { data: null, error: null };
        },
        async single() {
          return chain.maybeSingle();
        },
        update(updateVal: any) {
          if (tableName === "hosted_agent_jobs" && filterEqVal) {
            const existing = mockJobsStore.get(filterEqVal);
            if (existing) {
              mockJobsStore.set(filterEqVal, { ...existing, ...updateVal });
            }
          }
          return {
            eq(f: string, v: any) {
              if (tableName === "hosted_agent_jobs" && v) {
                const existing = mockJobsStore.get(v);
                if (existing) {
                  mockJobsStore.set(v, { ...existing, ...updateVal });
                }
              }
              return Promise.resolve({ data: null, error: null });
            },
          };
        },
        upsert(row: any) {
          if (tableName === "machine_api_idempotency") {
            const compositeKey = `${row.credential_id}:${row.route}:${row.idempotency_key_hash}`;
            const existing = mockIdempotencyDbStore.get(compositeKey);
            const merged = { ...existing, ...row };
            mockIdempotencyDbStore.set(compositeKey, merged);
            return Promise.resolve({ data: merged, error: null });
          }
          return Promise.resolve({ data: row, error: null });
        },
        insert(row: any) {
          if (tableName === "machine_api_idempotency") {
            const compositeKey = `${row.credential_id}:${row.route}:${row.idempotency_key_hash}`;
            if (mockIdempotencyDbStore.has(compositeKey)) {
              return Promise.resolve({
                data: null,
                error: { code: "23505", message: "duplicate key value violates unique constraint" },
              });
            }
            mockIdempotencyDbStore.set(compositeKey, row);
            return Promise.resolve({ data: row, error: null });
          }
          if (tableName === "hosted_workflow_quotes") {
            const id = row.id ?? `quote_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const storedRow = {
              ...row,
              id,
              created_at: new Date().toISOString(),
            };
            mockQuotesStore.set(row.idempotency_hash, storedRow);
            mockQuotesStore.set(id, storedRow);
            const res = { data: storedRow, error: null };
            return {
              ...res,
              select() {
                return {
                  single() {
                    return Promise.resolve(res);
                  },
                };
              },
            };
          }
          const res = { data: row, error: null };
          return {
            ...res,
            select() {
              return {
                single() {
                  return Promise.resolve(res);
                },
              };
            },
          };
        },
      };
      return chain;
    },
  };
}

import { setCheckoutClientForTesting } from "../lib/commerce/workflow-checkout.ts";
import { setHostedClientForTesting } from "../lib/agent/hosted-jobs.ts";

const mockClient = createMockSupabaseClient();
setByoaClientForTesting(mockClient);
setCheckoutClientForTesting(mockClient);
setHostedClientForTesting(mockClient);
setMachineIdempotencyClientForTesting(mockClient);

function createFailingMachineIdempotencyMockClient(baseClient: any): any {
  return {
    ...baseClient,
    rpc(fnName: string, args: any) {
      if (fnName === "reserve_machine_api_idempotency_v1") {
        return Promise.resolve({
          data: null,
          error: { code: "50000", message: "Database reservation failed" },
        });
      }
      return baseClient.rpc(fnName, args);
    },
    from(tableName: string) {
      if (tableName === "machine_api_idempotency") {
        return {
          select() {
            return {
              eq() { return this; },
              maybeSingle() {
                return Promise.resolve({ data: null, error: { code: "50000", message: "Database connection lost" } });
              },
            };
          },
          insert() {
            return Promise.resolve({ data: null, error: { code: "50000", message: "Database write failed" } });
          },
          upsert() {
            return Promise.resolve({ data: null, error: { code: "50000", message: "Database write failed" } });
          },
        };
      }
      return baseClient.from(tableName);
    },
  };
}

async function testFailClosedProductionIdempotency() {
  console.log("-> Testing Fail-Closed Production Idempotency & Fallback Rules...");

  const origEnv = process.env.NODE_ENV;
  const origAllowOptIn = process.env.MACHINE_API_ALLOW_MEMORY_IDEMPOTENCY;

  try {
    delete process.env.MACHINE_API_ALLOW_MEMORY_IDEMPOTENCY;
    process.env.NODE_ENV = "production";

    const failingClient = createFailingMachineIdempotencyMockClient(mockClient);

    // 1. Missing Supabase Client in production mode -> unavailable: true
    setMachineIdempotencyClientForTesting(null);
    clearMachineIdempotencyStore();
    const resProdNoClient = await resolveMachineIdempotency("ik-prod-1", "cred-full-1", { text: "hello" });
    assert.equal(resProdNoClient.ok, false);
    assert.equal(resProdNoClient.unavailable, true);

    // 2. Failing Supabase DB in production mode -> unavailable: true
    setMachineIdempotencyClientForTesting(failingClient);
    const resProdDbFail = await resolveMachineIdempotency("ik-prod-2", "cred-full-1", { text: "hello" });
    assert.equal(resProdDbFail.ok, false);
    assert.equal(resProdDbFail.unavailable, true);

    // 3. HTTP POST /api/agent/v1/quotes in production mode under DB failure -> 503 idempotency_store_unavailable
    {
      const quoteRowsBefore = mockQuotesStore.size;
      const jobRowsBefore = mockJobsStore.size;
      const req = new NextRequest("http://localhost:3000/api/agent/v1/quotes", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${fullCred.token}`,
          "Idempotency-Key": `ik-prod-quote-${Date.now()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          workflow: "github_due_diligence",
          input: { repository: "circlefin/agent-commerce" },
        }),
      });
      const res = await quotesPOST(req);
      assert.equal(res.status, 503, "Production quote request under DB failure must return HTTP 503");
      const json = await res.json();
      assert.equal(json.error.code, "idempotency_store_unavailable");
      assert.equal(json.error.retryable, true);
      assert.equal(
        mockQuotesStore.size,
        quoteRowsBefore,
        "Unavailable idempotency storage must not create a quote",
      );
      assert.equal(
        mockJobsStore.size,
        jobRowsBefore,
        "Unavailable idempotency storage must not create a job",
      );
    }

    // 4. HTTP POST /api/agent/v1/runs in production mode under DB failure -> 503 idempotency_store_unavailable
    {
      const quoteRowsBefore = mockQuotesStore.size;
      const jobRowsBefore = mockJobsStore.size;
      const req = new NextRequest("http://localhost:3000/api/agent/v1/runs", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${fullCred.token}`,
          "Idempotency-Key": `ik-prod-run-${Date.now()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          quoteId: "quote-sponsored-1",
        }),
      });
      const res = await runsPOST(req);
      assert.equal(res.status, 503, "Production run request under DB failure must return HTTP 503");
      const json = await res.json();
      assert.equal(json.error.code, "idempotency_store_unavailable");
      assert.equal(json.error.retryable, true);
      assert.equal(
        mockQuotesStore.size,
        quoteRowsBefore,
        "Unavailable idempotency storage must not create a quote",
      );
      assert.equal(
        mockJobsStore.size,
        jobRowsBefore,
        "Unavailable idempotency storage must not create a job",
      );
    }

    // 5. Test mode (NODE_ENV=test) allows in-memory fallback
    process.env.NODE_ENV = "test";
    setMachineIdempotencyClientForTesting(null);
    clearMachineIdempotencyStore();
    const resTestMode = await resolveMachineIdempotency("ik-test-1", "cred-full-1", { text: "hello" });
    assert.equal(resTestMode.ok, true);
    assert.equal(resTestMode.unavailable, undefined);

  } finally {
    process.env.NODE_ENV = origEnv;
    if (origAllowOptIn !== undefined) {
      process.env.MACHINE_API_ALLOW_MEMORY_IDEMPOTENCY = origAllowOptIn;
    } else {
      delete process.env.MACHINE_API_ALLOW_MEMORY_IDEMPOTENCY;
    }
    setMachineIdempotencyClientForTesting(mockClient);
    clearMachineIdempotencyStore();
  }

  console.log("✔ Fail-Closed Production Idempotency unit & endpoint tests passed.");
}

// --- Section 3: Endpoint Tests for GET /api/agent/v1/workflows ---
console.log("-> Testing GET /api/agent/v1/workflows...");

async function testWorkflowsEndpoint() {
  // Test 1: Missing Authorization header -> 401
  {
    const req = new NextRequest("http://localhost:3000/api/agent/v1/workflows", {
      method: "GET",
    });
    const res = await workflowsGET(req);
    assert.equal(res.status, 401);
    const json = await res.json();
    assert.equal(json.error.code, "credential_missing");
  }

  // Test 2: Invalid Bearer Token -> 401
  {
    const req = new NextRequest("http://localhost:3000/api/agent/v1/workflows", {
      method: "GET",
      headers: { Authorization: "Bearer aac_invalid.token.12345" },
    });
    const res = await workflowsGET(req);
    assert.equal(res.status, 401);
    const json = await res.json();
    assert.equal(json.error.code, "credential_missing");
  }

  // Test 3: Revoked Credential -> 401
  {
    const req = new NextRequest("http://localhost:3000/api/agent/v1/workflows", {
      method: "GET",
      headers: { Authorization: `Bearer ${revokedCred.token}` },
    });
    const res = await workflowsGET(req);
    assert.equal(res.status, 401);
    const json = await res.json();
    assert.equal(json.error.code, "credential_revoked");
  }

  // Test 4: Scope Denied (Read-Only Token without workflows:read scope) -> 403
  {
    const req = new NextRequest("http://localhost:3000/api/agent/v1/workflows", {
      method: "GET",
      headers: { Authorization: `Bearer ${readOnlyCred.token}` },
    });
    const res = await workflowsGET(req);
    assert.equal(res.status, 403);
    const json = await res.json();
    assert.equal(json.error.code, "scope_denied");
  }

  // Test 5: BYOA Workflow credentials never authenticate in the Machine API namespace.
  {
    const req = new NextRequest("http://localhost:3000/api/agent/v1/workflows", {
      method: "GET",
      headers: { Authorization: `Bearer ${byoaNamespaceCred.token}` },
    });
    const res = await workflowsGET(req);
    assert.equal(res.status, 401);
    const json = await res.json();
    assert.equal(json.error.code, "credential_missing");
  }

  // Test 6: Successful Workflows Listing -> 200
  {
    const req = new NextRequest("http://localhost:3000/api/agent/v1/workflows", {
      method: "GET",
      headers: { Authorization: `Bearer ${fullCred.token}` },
    });
    const res = await workflowsGET(req);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.version, "1");
    assert(Array.isArray(json.workflows), "workflows should be an array");

    const ghWf = json.workflows.find((w: any) => w.id === "github_due_diligence");
    assert(ghWf, "github_due_diligence workflow template missing");
    assert.equal(ghWf.name, "GitHub Project Due Diligence");
    assert.equal(ghWf.arc.chainId, 5042002);
    assert.equal(ghWf.arc.network, "arc-testnet");
    assert.equal(ghWf.arc.asset, "USDC");
    assert.deepEqual(ghWf.inputSchema.required, ["repository"]);
    assert.equal(
      json.workflows.some((workflow: any) => workflow.id === "custom_task"),
      false,
      "Machine discovery must expose curated workflows only",
    );
    assert.equal(
      json.workflows.some((workflow: any) => String(workflow.id).startsWith("seller:")),
      false,
      "Seller workflows must remain outside the core Machine API catalog",
    );
  }

  console.log("✔ GET /api/agent/v1/workflows tests passed.");
}

// --- Section 4: Endpoint Tests for POST /api/agent/v1/quotes ---
console.log("-> Testing POST /api/agent/v1/quotes...");

async function testQuotesEndpoint() {
  // Test 1: Missing Idempotency-Key Header -> 400 idempotency_key_missing
  {
    const req = new NextRequest("http://localhost:3000/api/agent/v1/quotes", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fullCred.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workflow: "github_due_diligence",
        input: { repository: "circlefin/agent-commerce" },
      }),
    });
    const res = await quotesPOST(req);
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.error.code, "idempotency_key_missing");
    assert.equal(json.error.message, "Missing required Idempotency-Key header.");
  }

  // Test 2: Invalid Repository Input -> 400 invalid_repository. The same key
  // remains usable because validation failures must not create a reservation.
  const reusableInvalidKey = `ik-inv-${Date.now()}`;
  {
    const req = new NextRequest("http://localhost:3000/api/agent/v1/quotes", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fullCred.token}`,
        "Idempotency-Key": reusableInvalidKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workflow: "github_due_diligence",
        input: { repository: "invalid repository name!" },
      }),
    });
    const res = await quotesPOST(req);
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.error.code, "invalid_repository");
  }

  // Hidden legacy custom execution is not part of the curated Machine API.
  {
    const req = new NextRequest("http://localhost:3000/api/agent/v1/quotes", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fullCred.token}`,
        "Idempotency-Key": `ik-custom-${Date.now()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workflow: "custom_task",
        input: { text: "A sufficiently long custom workflow request." },
      }),
    });
    const res = await quotesPOST(req);
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.error.code, "workflow_disabled");
  }

  {
    const req = new NextRequest("http://localhost:3000/api/agent/v1/quotes", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fullCred.token}`,
        "Idempotency-Key": reusableInvalidKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workflow: "github_due_diligence",
        input: { repository: "circlefin/agent-commerce" },
      }),
    });
    const res = await quotesPOST(req);
    assert(
      [200, 201].includes(res.status),
      "A key used by an invalid request must remain available",
    );
  }

  // Test 3: Successful Quote Creation -> 201/200
  let createdQuoteId = "";
  const testIK = `ik-valid-${Date.now()}`;
  const validBody = {
    workflow: "github_due_diligence",
    input: { repository: "circlefin/agent-commerce" },
  };

  {
    const req = new NextRequest("http://localhost:3000/api/agent/v1/quotes", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fullCred.token}`,
        "Idempotency-Key": testIK,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(validBody),
    });
    const res = await quotesPOST(req);
    const json = await res.json();
    assert([200, 201].includes(res.status), `Expected status 200/201, got ${res.status}`);

    assert(json.quoteId, "Response must include quoteId");
    createdQuoteId = json.quoteId;
    assert.equal(json.workflow, "github_due_diligence");
    assert.equal(json.repository.fullName, "circlefin/agent-commerce");
    assert.equal(json.repository.canonicalUrl, "https://github.com/circlefin/agent-commerce");
    assert.equal(typeof json.totalUsdc, "number");
    assert.equal(typeof json.sponsored, "boolean");
    assert(json.checkout, "Response must include checkout object");
    assert.equal(json.checkout.mode, "sponsored");
    assert.equal(json.checkout.asset, "USDC");
    assert.equal(json.checkout.network, "arc-testnet");
    assert.equal(json.downstreamSettlement, "server_side_x402");
    assert(json.expiresAt, "expiresAt must be set");
    assert.equal(json.requiredPayment.network, "arc-testnet");
    assert.equal(json.requiredPayment.asset, "USDC");

    const storedQuote = mockQuotesStore.get(createdQuoteId);
    assert(storedQuote, "Quote row must exist in mockQuotesStore");
    assert.equal(storedQuote.byoa_agent_id, "agent-1");
    assert.equal(storedQuote.machine_credential_id, "cred-full-1");
    assert.equal(storedQuote.owner_wallet, mockAgent.owner_wallet);
  }

  // Test 4: Idempotency Deduplication (Identical key & payload returns cached quote)
  {
    const req = new NextRequest("http://localhost:3000/api/agent/v1/quotes", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fullCred.token}`,
        "Idempotency-Key": testIK,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(validBody),
    });
    const res = await quotesPOST(req);
    assert([200, 201].includes(res.status), `Expected 200/201 status, got ${res.status}`);
    const json = await res.json();
    assert.equal(json.quoteId, createdQuoteId, "Idempotent replay must return identical quoteId");
  }

  // Test 5: Idempotency Conflict (Same key, different payload -> 409)
  {
    const req = new NextRequest("http://localhost:3000/api/agent/v1/quotes", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fullCred.token}`,
        "Idempotency-Key": testIK,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workflow: "github_due_diligence",
        input: { repository: "owner/different-repo" },
      }),
    });
    const res = await quotesPOST(req);
    assert.equal(res.status, 409);
    const json = await res.json();
    assert.equal(json.error.code, "idempotency_conflict");
    assert.match(json.error.message, /different workflow input/i);
  }

  console.log("✔ POST /api/agent/v1/quotes tests passed.");
}

// --- Section 5: Endpoint Tests for POST /api/agent/v1/runs ---
console.log("-> Testing POST /api/agent/v1/runs...");

async function testRunsPostEndpoint() {
  // Test 1: Missing Idempotency-Key Header -> 400 idempotency_key_missing
  {
    const req = new NextRequest("http://localhost:3000/api/agent/v1/runs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fullCred.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ quoteId: "quote-sponsored-1" }),
    });
    const res = await runsPOST(req);
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.error.code, "idempotency_key_missing");
  }

  // Test 2: Non-existent Quote -> 404 quote_not_found
  {
    const req = new NextRequest("http://localhost:3000/api/agent/v1/runs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fullCred.token}`,
        "Idempotency-Key": `ik-run-nonexist-${Date.now()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ quoteId: "quote-non-existent-999" }),
    });
    const res = await runsPOST(req);
    assert.equal(res.status, 404);
    const json = await res.json();
    assert.equal(json.error.code, "quote_not_found");
    assert.equal(json.error.message, "The specified workflow quote could not be found.");
  }

  // Test 2b: Credential B attempting to execute Credential A's quote -> 404 quote_not_found
  {
    const req = new NextRequest("http://localhost:3000/api/agent/v1/runs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credB.token}`,
        "Idempotency-Key": `ik-run-credb-${Date.now()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ quoteId: "quote-sponsored-1" }),
    });
    const res = await runsPOST(req);
    assert.equal(res.status, 404);
    const json = await res.json();
    assert.equal(json.error.code, "quote_not_found");
    assert.equal(json.error.message, "The specified workflow quote could not be found.");
  }

  // Test 3: Expired Quote -> 404 quote_expired
  {
    const req = new NextRequest("http://localhost:3000/api/agent/v1/runs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fullCred.token}`,
        "Idempotency-Key": `ik-run-exp-${Date.now()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ quoteId: "quote-expired-1" }),
    });
    const res = await runsPOST(req);
    assert.equal(res.status, 404);
    const json = await res.json();
    assert.equal(json.error.code, "quote_expired");
  }

  // Test 4: Quote Already Consumed -> 409 quote_already_used
  {
    const req = new NextRequest("http://localhost:3000/api/agent/v1/runs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fullCred.token}`,
        "Idempotency-Key": `ik-run-cons-${Date.now()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ quoteId: "quote-consumed-1" }),
    });
    const res = await runsPOST(req);
    assert.equal(res.status, 409);
    const json = await res.json();
    assert.equal(json.error.code, "quote_already_used");
  }

  // Test 5: Paid Quote without paymentAuthorization -> 402 payment_required
  {
    const req = new NextRequest("http://localhost:3000/api/agent/v1/runs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fullCred.token}`,
        "Idempotency-Key": `ik-run-nopay-${Date.now()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ quoteId: "quote-paid-1" }),
    });
    const res = await runsPOST(req);
    assert.equal(res.status, 402);
    const json = await res.json();
    assert.equal(json.error.code, "payment_required");
  }

  // Test 6: Paid Quote with invalid paymentAuthorization format -> 400 payment_invalid
  {
    const req = new NextRequest("http://localhost:3000/api/agent/v1/runs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fullCred.token}`,
        "Idempotency-Key": `ik-run-badpay-${Date.now()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        quoteId: "quote-paid-1",
        paymentAuthorization: { type: "arc_transaction", payload: "invalid-hash-format" },
      }),
    });
    const res = await runsPOST(req);
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.error.code, "payment_invalid");
  }

  // Test 7: Successful Sponsored Run Launch -> 201
  let createdRunId = "";
  const runIK = `ik-run-spons-${Date.now()}`;
  const runBody = { quoteId: "quote-sponsored-1" };

  {
    const req = new NextRequest("http://localhost:3000/api/agent/v1/runs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fullCred.token}`,
        "Idempotency-Key": runIK,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(runBody),
    });
    const res = await runsPOST(req);
    assert.equal(res.status, 201);
    const json = await res.json();
    assert(json.runId, "Response must include runId");
    createdRunId = json.runId;
    assert.equal(json.status, "queued");
    assert.equal(json.pollAfterMs, 2000);

    // Verify job row persisted machine_credential_id
    const storedJob = mockJobsStore.get(createdRunId);
    assert(storedJob, "Job row must exist in mockJobsStore");
    assert.equal(storedJob.machine_credential_id, "cred-full-1", "Job creation must persist machine_credential_id");
  }

  // Test 8: Idempotency Deduplication (Identical run request returns cached response)
  {
    const req = new NextRequest("http://localhost:3000/api/agent/v1/runs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fullCred.token}`,
        "Idempotency-Key": runIK,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(runBody),
    });
    const res = await runsPOST(req);
    assert([200, 201].includes(res.status), `Expected 200/201 status, got ${res.status}`);
    const json = await res.json();
    assert.equal(json.runId, createdRunId);
    assert.equal(json.status, "queued");
  }

  console.log("✔ POST /api/agent/v1/runs tests passed.");
}

// --- Section 6: Endpoint Tests for GET /api/agent/v1/runs/[runId] ---
console.log("-> Testing GET /api/agent/v1/runs/[runId]...");

async function testRunByIdGetEndpoint() {
  // Test 1: Missing / Non-existent runId -> 404 run_not_found
  {
    const req = new NextRequest("http://localhost:3000/api/agent/v1/runs/job-non-existent-99", {
      method: "GET",
      headers: { Authorization: `Bearer ${fullCred.token}` },
    });
    const params = Promise.resolve({ runId: "job-non-existent-99" });
    const res = await runByIdGET(req, { params });
    assert.equal(res.status, 404);
    const json = await res.json();
    assert.equal(json.error.code, "run_not_found");
  }

  // Test 2: Polling Status for Completed Run Owned by Credential -> 200
  {
    const req = new NextRequest("http://localhost:3000/api/agent/v1/runs/job-existing-1", {
      method: "GET",
      headers: { Authorization: `Bearer ${fullCred.token}` },
    });
    const params = Promise.resolve({ runId: "job-existing-1" });
    const res = await runByIdGET(req, { params });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.runId, "job-existing-1");
    assert.equal(json.status, "completed");
    assert.equal(json.progress, 1.0);
    assert.equal(json.stage, "completed");
    assert.equal(json.pollAfterMs, 0);
    assert.equal(json.reportId, "job-existing-1");
    assert.deepEqual(json.verification, {
      status: "verified",
      verifiedSteps: 2,
      requiredSteps: 2,
    });
  }

  // Test 3: Cross-Credential Isolation (Reading another agent's run returns 404 run_not_found)
  {
    const req = new NextRequest("http://localhost:3000/api/agent/v1/runs/job-other-agent", {
      method: "GET",
      headers: { Authorization: `Bearer ${fullCred.token}` },
    });
    const params = Promise.resolve({ runId: "job-other-agent" });
    const res = await runByIdGET(req, { params });
    assert.equal(res.status, 404);
    const json = await res.json();
    assert.equal(json.error.code, "run_not_found");
    assert.equal(json.error.message, "The requested run was not found.");
  }

  // Test 4: Verification Integrity - Receipts without verified Arc proof records evaluate to verification_pending (never verified)
  {
    const jobNoProofs = {
      ...fixtureCompletedJob,
      id: "job-no-proofs-1",
      agent_run_id: null,
      // Deliberately retain denormalized hashes: they must never be treated as
      // verified without corresponding verified proof records.
      proof_transaction_hashes: [...fixtureCompletedJob.proof_transaction_hashes],
    };
    mockJobsStore.set("job-no-proofs-1", jobNoProofs);

    const req = new NextRequest("http://localhost:3000/api/agent/v1/runs/job-no-proofs-1", {
      method: "GET",
      headers: { Authorization: `Bearer ${fullCred.token}` },
    });
    const params = Promise.resolve({ runId: "job-no-proofs-1" });
    const res = await runByIdGET(req, { params });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.runId, "job-no-proofs-1");
    assert.equal(json.status, "completed");
    assert.equal(
      json.verification.status,
      "verification_pending",
      "Receipts without verified proof records must evaluate to verification_pending",
    );
    assert.notEqual(
      json.verification.status,
      "verified",
      "Receipts without verified proof records must NEVER evaluate to verified",
    );
    assert.equal(json.verification.verifiedSteps, 0);
    assert.equal(json.verification.requiredSteps, 2);

    const reportReq = new NextRequest(
      "http://localhost:3000/api/agent/v1/reports/job-no-proofs-1",
      {
        method: "GET",
        headers: { Authorization: `Bearer ${fullCred.token}` },
      },
    );
    const reportRes = await reportByIdGET(reportReq, {
      params: Promise.resolve({ reportId: "job-no-proofs-1" }),
    });
    assert.equal(reportRes.status, 200);
    const reportJson = await reportRes.json();
    assert.equal(reportJson.verification.status, "verification_pending");
    assert.equal(reportJson.verification.verifiedSteps, 0);
    assert.deepEqual(
      reportJson.verification.proofs,
      [],
      "Denormalized job hashes must not be exposed as verified Arc proofs",
    );
  }

  console.log("✔ GET /api/agent/v1/runs/[runId] tests passed.");
}

// --- Section 7: Endpoint Tests for GET /api/agent/v1/reports/[reportId] ---
console.log("-> Testing GET /api/agent/v1/reports/[reportId]...");

async function testReportByIdGetEndpoint() {
  // Test 1: Retrieving structured JSON report (default Accept header)
  {
    const req = new NextRequest("http://localhost:3000/api/agent/v1/reports/job-existing-1", {
      method: "GET",
      headers: { Authorization: `Bearer ${fullCred.token}` },
    });
    const params = Promise.resolve({ reportId: "job-existing-1" });
    const res = await reportByIdGET(req, { params });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "application/json");

    const json = await res.json();
    assert.equal(json.reportId, "job-existing-1");
    assert.equal(json.workflow, "github_due_diligence");
    assert.equal(json.status, "completed");
    assert.equal(json.repository.fullName, "circlefin/agent-commerce");
    assert.equal(json.repository.canonicalUrl, "https://github.com/circlefin/agent-commerce");
    assert.equal(typeof json.executiveSummary, "string");

    // Verify all 15 evidence sections are present
    const sections = [
      "projectPurpose",
      "architectureAndTechnology",
      "developmentActivity",
      "contributors",
      "automationAccounts",
      "engineeringQuality",
      "documentationAndGovernance",
      "releasesAndMaintenance",
      "strengths",
      "risks",
      "questionsBeforeAdoption",
      "evidenceAndFreshness",
      "limitations",
      "categoryConfidence",
      "verification",
    ];

    for (const section of sections) {
      assert(json[section] !== undefined, `Report response must contain evidence section '${section}'`);
    }

    // Verify structure of specific evidence sections & numeric metric format
    assert.equal(typeof json.projectPurpose.summary, "string");
    assert.equal(typeof json.architectureAndTechnology.primaryLanguage, "string");
    assert.equal(typeof json.architectureAndTechnology.workflowCount.value, "number");
    assert(["high", "medium", "low"].includes(json.architectureAndTechnology.workflowCount.confidence));

    assert.equal(typeof json.developmentActivity.commitCount30d.value, "number");
    assert(["high", "medium", "low"].includes(json.developmentActivity.commitCount30d.confidence));

    assert.equal(typeof json.contributors.sampledCount.value, "number");
    assert.equal(typeof json.automationAccounts.botCount.value, "number");

    assert(json.engineeringQuality.testing && typeof json.engineeringQuality.testing === "object");
    assert(json.engineeringQuality.operationalMaturity && typeof json.engineeringQuality.operationalMaturity === "object");

    assert.equal(typeof json.documentationAndGovernance.hasReadme, "boolean");
    assert.equal(typeof json.releasesAndMaintenance.totalReleases.value, "number");

    assert(Array.isArray(json.strengths));
    assert(Array.isArray(json.risks));
    assert(Array.isArray(json.questionsBeforeAdoption));

    assert.equal(typeof json.evidenceAndFreshness.dataProvider, "string");
    assert.equal(typeof json.limitations.disclaimer, "string");
    assert(json.categoryConfidence && typeof json.categoryConfidence === "object");

    assert.equal(json.verification.status, "verified");
    assert.equal(json.verification.network, "arc-testnet");
    assert(Array.isArray(json.verification.proofs));
    assert(json.generatedAt, "generatedAt must be set");
  }

  // Test 2: Retrieving markdown report with Accept: text/markdown
  {
    const req = new NextRequest("http://localhost:3000/api/agent/v1/reports/job-existing-1", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${fullCred.token}`,
        Accept: "text/markdown",
      },
    });
    const params = Promise.resolve({ reportId: "job-existing-1" });
    const res = await reportByIdGET(req, { params });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("Content-Type") || "", /text\/markdown/);

    const markdown = await res.text();
    assert(markdown.includes("# GitHub Due Diligence Report:"), "Markdown should contain title header");
    assert(markdown.includes("## Executive Summary"), "Markdown should contain Executive Summary section");
    assert(markdown.includes("## Verification & Arc Proofs"), "Markdown should contain Verification section");
  }

  // Test 3: Attempting to read another credential's report returns 404 report_not_found
  {
    const req = new NextRequest("http://localhost:3000/api/agent/v1/reports/job-other-agent", {
      method: "GET",
      headers: { Authorization: `Bearer ${fullCred.token}` },
    });
    const params = Promise.resolve({ reportId: "job-other-agent" });
    const res = await reportByIdGET(req, { params });
    assert.equal(res.status, 404);
    const json = await res.json();
    assert.equal(json.error.code, "report_not_found");
  }

  // Test 4: Requesting report before completion returns 400 report_not_ready
  {
    const req = new NextRequest("http://localhost:3000/api/agent/v1/reports/job-running-1", {
      method: "GET",
      headers: { Authorization: `Bearer ${fullCred.token}` },
    });
    const params = Promise.resolve({ reportId: "job-running-1" });
    const res = await reportByIdGET(req, { params });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.error.code, "report_not_ready");
  }

  console.log("✔ GET /api/agent/v1/reports/[reportId] tests passed.");
}

// --- Section 7b: Multi-Layer Credential Isolation Tests ---
async function testMultiLayerCredentialIsolation() {
  console.log("-> Testing Multi-Layer Credential Isolation for Runs & Reports...");

  // 1. Agent 2 sharing the same owner wallet receives 404 run_not_found when querying Agent 1's resource
  {
    const req = new NextRequest("http://localhost:3000/api/agent/v1/runs/job-existing-1", {
      method: "GET",
      headers: { Authorization: `Bearer ${credSameOwnerAgent2.token}` },
    });
    const params = Promise.resolve({ runId: "job-existing-1" });
    const res = await runByIdGET(req, { params });
    assert.equal(res.status, 404);
    const json = await res.json();
    assert.equal(json.error.code, "run_not_found");
    assert.equal(json.error.message, "The requested run was not found.");
  }

  // 2. Agent 2 sharing the same owner wallet receives 404 report_not_found when querying Agent 1's report
  {
    const req = new NextRequest("http://localhost:3000/api/agent/v1/reports/job-existing-1", {
      method: "GET",
      headers: { Authorization: `Bearer ${credSameOwnerAgent2.token}` },
    });
    const params = Promise.resolve({ reportId: "job-existing-1" });
    const res = await reportByIdGET(req, { params });
    assert.equal(res.status, 404);
    const json = await res.json();
    assert.equal(json.error.code, "report_not_found");
    assert.equal(json.error.message, "The requested report was not found.");
  }

  // 3. Credential 2 under the same agent receives 404 run_not_found when querying resources created by Credential 1
  {
    const req = new NextRequest("http://localhost:3000/api/agent/v1/runs/job-existing-1", {
      method: "GET",
      headers: { Authorization: `Bearer ${credSameAgent2.token}` },
    });
    const params = Promise.resolve({ runId: "job-existing-1" });
    const res = await runByIdGET(req, { params });
    assert.equal(res.status, 404);
    const json = await res.json();
    assert.equal(json.error.code, "run_not_found");
    assert.equal(json.error.message, "The requested run was not found.");
  }

  // 4. Credential 2 under the same agent receives 404 report_not_found when querying resources created by Credential 1
  {
    const req = new NextRequest("http://localhost:3000/api/agent/v1/reports/job-existing-1", {
      method: "GET",
      headers: { Authorization: `Bearer ${credSameAgent2.token}` },
    });
    const params = Promise.resolve({ reportId: "job-existing-1" });
    const res = await reportByIdGET(req, { params });
    assert.equal(res.status, 404);
    const json = await res.json();
    assert.equal(json.error.code, "report_not_found");
    assert.equal(json.error.message, "The requested report was not found.");
  }

  // 5. Original Credential 1 receives 200 and full response for run
  {
    const req = new NextRequest("http://localhost:3000/api/agent/v1/runs/job-existing-1", {
      method: "GET",
      headers: { Authorization: `Bearer ${fullCred.token}` },
    });
    const params = Promise.resolve({ runId: "job-existing-1" });
    const res = await runByIdGET(req, { params });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.runId, "job-existing-1");
    assert.equal(json.status, "completed");
  }

  // 6. Original Credential 1 receives 200 and full response for report
  {
    const req = new NextRequest("http://localhost:3000/api/agent/v1/reports/job-existing-1", {
      method: "GET",
      headers: { Authorization: `Bearer ${fullCred.token}` },
    });
    const params = Promise.resolve({ reportId: "job-existing-1" });
    const res = await reportByIdGET(req, { params });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.reportId, "job-existing-1");
    assert.equal(json.status, "completed");
  }

  console.log("✔ Multi-Layer Credential Isolation tests passed.");
}

// --- Section 8: Spending Limit & Rate Policy Test ---
console.log("-> Testing Spending Limit & Rate Policy...");

async function testSpendingLimit() {
  // Exceed daily creation call limit
  mockDailyCallCount = 100;
  try {
    // 1. Read operations MUST NOT be blocked by exhausted creation limit
    const wfReq = new NextRequest("http://localhost:3000/api/agent/v1/workflows", {
      method: "GET",
      headers: { Authorization: `Bearer ${fullCred.token}` },
    });
    const wfRes = await workflowsGET(wfReq);
    assert.equal(wfRes.status, 200, "GET /workflows must NOT be blocked by daily creation limit");

    const runPollReq = new NextRequest("http://localhost:3000/api/agent/v1/runs/job-existing-1", {
      method: "GET",
      headers: { Authorization: `Bearer ${fullCred.token}` },
    });
    const params = Promise.resolve({ runId: "job-existing-1" });
    const runPollRes = await runByIdGET(runPollReq, { params });
    assert.equal(runPollRes.status, 200, "Polling GET /runs/[runId] must NOT be blocked by daily creation limit");

    // 2. Mutation / creation operations MUST be blocked by daily limit
    const quoteReq = new NextRequest("http://localhost:3000/api/agent/v1/quotes", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fullCred.token}`,
        "Idempotency-Key": `ik-limit-${Date.now()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workflow: "github_due_diligence",
        input: { repository: "circlefin/agent-commerce" },
      }),
    });
    const quoteRes = await quotesPOST(quoteReq);
    assert.equal(quoteRes.status, 429);
    const quoteJson = await quoteRes.json();
    assert.equal(quoteJson.error.code, "spending_limit_exceeded");
    assert.match(quoteJson.error.message, /Daily API call limit/i);

    const runReq = new NextRequest("http://localhost:3000/api/agent/v1/runs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fullCred.token}`,
        "Idempotency-Key": `ik-limit-run-${Date.now()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ quoteId: "quote-sponsored-1" }),
    });
    const runRes = await runsPOST(runReq);
    assert.equal(runRes.status, 429);
    const runJson = await runRes.json();
    assert.equal(runJson.error.code, "spending_limit_exceeded");
  } finally {
    mockDailyCallCount = 0;
  }

  console.log("✔ Spending Limit & Rate Policy tests passed.");
}

// --- Section 9: Production 500 Error Sanitization Test ---
console.log("-> Testing Production 500 Error Sanitization...");

async function testSanitizedInternalError() {
  const sensitiveError = new Error("FATAL: postgres password leak at secret_db_host:5432 / var/lib/db.key");
  const response = handleMachineInternalError(
    sensitiveError,
    "/api/agent/v1/quotes",
    "agent-1",
    "req_test_123",
  );

  assert.equal(response.status, 500);
  assert.equal(response.headers.get("X-Request-Id"), "req_test_123");

  const text = await response.text();
  const json = JSON.parse(text);

  assert.equal(json.error.code, "internal_error");
  assert.equal(json.error.message, "The request could not be completed.");
  assert.equal(json.error.retryable, true);
  assert.equal(json.error.requestId, "req_test_123");

  assert(!text.includes("postgres"), "Response body must not leak 'postgres'");
  assert(!text.includes("secret_db_host"), "Response body must not leak host sensitive info");
  assert(!text.includes("db.key"), "Response body must not leak key path info");

  console.log("✔ Production 500 Error Sanitization tests passed.");
}

// --- Section 10: OpenAPI 3.0.3 Spec Validation ---
console.log("-> Testing OpenAPI 3.0.3 Spec Validation...");

async function testOpenApiSchema() {
  const specPath = path.join(process.cwd(), "public", "openapi", "agent-commerce-v1.json");
  assert(fs.existsSync(specPath), "OpenAPI spec file public/openapi/agent-commerce-v1.json missing");

  const raw = fs.readFileSync(specPath, "utf8");
  const spec = JSON.parse(raw);

  assert.equal(spec.openapi, "3.0.3", "OpenAPI version must be 3.0.3");
  assert.equal(typeof spec.info.title, "string", "Spec info.title missing");
  assert.equal(typeof spec.info.version, "string", "Spec info.version missing");

  const requiredPaths = [
    "/api/agent/v1/workflows",
    "/api/agent/v1/quotes",
    "/api/agent/v1/runs",
    "/api/agent/v1/runs/{runId}",
    "/api/agent/v1/reports/{reportId}",
  ];

  for (const pathKey of requiredPaths) {
    assert(spec.paths[pathKey], `OpenAPI spec missing path ${pathKey}`);
  }

  assert(spec.components?.schemas?.WorkflowTemplate, "Missing WorkflowTemplate schema");
  assert(spec.components?.schemas?.WorkflowQuoteResponse, "Missing WorkflowQuoteResponse schema");
  assert(spec.components?.schemas?.RunLaunchResponse, "Missing RunLaunchResponse schema");
  assert(spec.components?.schemas?.RunStatusResponse, "Missing RunStatusResponse schema");
  assert(spec.components?.schemas?.StructuredReportResponse, "Missing StructuredReportResponse schema");
  assert(spec.components?.schemas?.MachineError, "Missing MachineError schema");

  console.log("✔ OpenAPI 3.0.3 Spec validation tests passed.");
}

async function runSuite() {
  await testMachineIdempotencyUnit();
  await testFailClosedProductionIdempotency();
  await testWorkflowsEndpoint();
  await testQuotesEndpoint();
  await testRunsPostEndpoint();
  await testRunByIdGetEndpoint();
  await testReportByIdGetEndpoint();
  await testMultiLayerCredentialIsolation();
  await testSpendingLimit();
  await testSanitizedInternalError();
  await testOpenApiSchema();
  console.log("✅ All Machine API v1 tests passed successfully!");
}

runSuite().catch((err) => {
  console.error("❌ Machine API test failure:", err);
  process.exit(1);
});
