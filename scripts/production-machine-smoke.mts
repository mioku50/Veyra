/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from "node:crypto";
import type { Address } from "viem";
import {
  createAgentCredential,
  getByoaClient,
  revokeAgentCredential,
} from "../lib/byoa/service.ts";
import { hashApiCredential } from "../lib/byoa/auth.ts";
import { MACHINE_API_SCOPES, type ByoaCredentialRow } from "../lib/byoa/types.ts";

const PRODUCTION_CONFIRMATION = "--confirm-production";
const DEFAULT_TIMEOUT_MS = 120_000;
type CredentialHandle = {
  agentId: string;
  credentialId: string;
  ownerWallet: Address;
  token: string;
};

type JsonResponse = {
  status: number;
  body: Record<string, any>;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function endpoint(baseUrl: URL, path: string) {
  return new URL(path, baseUrl).toString();
}

async function requestJson(
  baseUrl: URL,
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<JsonResponse> {
  const response = await fetch(endpoint(baseUrl, path), {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, any>;
  return { status: response.status, body };
}

async function issueCredential(
  ownerWallet: Address,
  agentId: string,
  label: string,
): Promise<CredentialHandle> {
  const created = await createAgentCredential(ownerWallet, agentId, {
    credentialType: "machine_api",
    label,
    scopes: [...MACHINE_API_SCOPES],
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  });
  return {
    agentId,
    credentialId: created.credential.id,
    ownerWallet,
    token: created.token,
  };
}

function hasExactMachineScopes(scopes: string[]) {
  return scopes.length === MACHINE_API_SCOPES.length &&
    MACHINE_API_SCOPES.every((scope) => scopes.includes(scope));
}

async function validateProvidedCredential(token: string, label: string): Promise<CredentialHandle> {
  const client = getByoaClient();
  const credentialResult = await client
    .from("byoa_agent_credentials")
    .select("*")
    .eq("credential_hash", hashApiCredential(token))
    .maybeSingle();
  assert(!credentialResult.error, `${label} could not be validated.`);
  assert(credentialResult.data, `${label} is not a known production credential.`);
  const credential = credentialResult.data as ByoaCredentialRow;
  assert(credential.credential_type === "machine_api", `${label} is not a Machine API credential.`);
  assert(!credential.revoked_at, `${label} is revoked.`);
  assert(Date.parse(credential.expires_at) > Date.now(), `${label} is expired.`);
  assert(hasExactMachineScopes(credential.scopes), `${label} does not have the exact Machine API scope set.`);

  const agentResult = await client
    .from("byoa_agents")
    .select("id,owner_wallet,status,agent_wallet_status")
    .eq("id", credential.agent_id)
    .maybeSingle();
  assert(!agentResult.error && agentResult.data, `${label} is not linked to an agent.`);
  assert(agentResult.data.status === "active", `${label}'s agent is not active.`);
  assert(agentResult.data.agent_wallet_status === "verified", `${label}'s agent wallet is not verified.`);
  assert(
    String(agentResult.data.owner_wallet).toLowerCase() === credential.owner_wallet.toLowerCase(),
    `${label}'s owner relation is invalid.`,
  );

  return {
    agentId: credential.agent_id,
    credentialId: credential.id,
    ownerWallet: credential.owner_wallet as Address,
    token,
  };
}

async function revokeCredential(handle: CredentialHandle | null) {
  if (!handle) return;
  await revokeAgentCredential(
    handle.ownerWallet,
    handle.agentId,
    handle.credentialId,
  );
}

async function findEligibleAgents() {
  const client = getByoaClient();
  const agents = await client
    .from("byoa_agents")
    .select("id,owner_wallet,status,agent_wallet_status")
    .eq("status", "active")
    .eq("agent_wallet_status", "verified");
  assert(!agents.error, "Unable to load eligible production agents.");

  const ids = (agents.data ?? []).map((agent) => agent.id as string);
  if (ids.length === 0) return [];

  const policies = await client
    .from("byoa_agent_policies")
    .select("agent_id,status,allowed_workflows")
    .in("agent_id", ids)
    .eq("status", "active");
  assert(!policies.error, "Unable to load eligible production policies.");

  const allowedAgentIds = new Set(
    (policies.data ?? [])
      .filter(
        (policy) =>
          Array.isArray(policy.allowed_workflows) &&
          policy.allowed_workflows.includes("sentiment_tone"),
      )
      .map((policy) => policy.agent_id as string),
  );

  return (agents.data ?? [])
    .filter((agent) => allowedAgentIds.has(agent.id as string))
    .map((agent) => ({
      id: agent.id as string,
      ownerWallet: agent.owner_wallet as Address,
    }));
}

async function runSmoke(baseUrl: URL) {
  let credentialA: CredentialHandle | null = null;
  let credentialB: CredentialHandle | null = null;
  let tokenA = process.env.MACHINE_API_SMOKE_TOKEN_A?.trim() || "";
  let tokenB = process.env.MACHINE_API_SMOKE_TOKEN_B?.trim() || "";
  assert(
    Boolean(tokenA) === Boolean(tokenB),
    "Provide both MACHINE_API_SMOKE_TOKEN_A and MACHINE_API_SMOKE_TOKEN_B, or neither.",
  );

  try {
    let quote: Record<string, any> | null = null;

    const createSmokeQuote = async () => {
      const workflows = await requestJson(
        baseUrl,
        "/api/agent/v1/workflows",
        tokenA,
      );
      assert(workflows.status === 200, "Credential A could not list workflows.");
      assert(
        Array.isArray(workflows.body.workflows) &&
          workflows.body.workflows.some(
            (workflow: Record<string, unknown>) =>
              workflow.id === "sentiment_tone",
          ),
        "The smoke workflow is missing from Credential A's manifest.",
      );

      const quoteResponse = await requestJson(
        baseUrl,
        "/api/agent/v1/quotes",
        tokenA,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": `production-gate-quote-${randomUUID()}`,
          },
          body: JSON.stringify({
            workflow: "sentiment_tone",
            input: {
              text: "Production deployment gate: concise non-sensitive workflow smoke input.",
            },
          }),
        },
      );
      assert(
        quoteResponse.status === 200 || quoteResponse.status === 201,
        `Credential A quote failed with HTTP ${quoteResponse.status}.`,
      );
      return quoteResponse.body;
    };

    if (tokenA && tokenB) {
      const [providedA, providedB] = await Promise.all([
        validateProvidedCredential(tokenA, "Credential A"),
        validateProvidedCredential(tokenB, "Credential B"),
      ]);
      assert(providedA.credentialId !== providedB.credentialId, "Credentials A and B must be different credentials.");
      assert(providedA.agentId !== providedB.agentId, "Credentials A and B must belong to different agents.");
      console.log(
        "[production-machine-smoke] using caller-provided credentials; tokens will not be logged or revoked",
      );
      quote = await createSmokeQuote();
    } else {
      const eligibleAgents = await findEligibleAgents();
      assert(
        eligibleAgents.length >= 2,
        "At least two different active verified production agents must permit the smoke workflow.",
      );
      console.log(
        `[production-machine-smoke] eligible agents=${eligibleAgents.length}`,
      );

      for (const candidate of eligibleAgents) {
        const isolationCandidate = eligibleAgents.find((agent) => agent.id !== candidate.id);
        assert(isolationCandidate, "A second eligible production agent is required.");
        const marker = randomUUID().slice(0, 8);
        credentialA = await issueCredential(
          candidate.ownerWallet,
          candidate.id,
          `Production gate A ${marker}`,
        );
        tokenA = credentialA.token;
        const candidateQuote = await createSmokeQuote();

        if (candidateQuote.sponsored === true) {
          credentialB = await issueCredential(
            isolationCandidate.ownerWallet,
            isolationCandidate.id,
            `Production gate B ${marker}`,
          );
          tokenB = credentialB.token;
          quote = candidateQuote;
          break;
        }

        await revokeCredential(credentialA);
        credentialA = null;
        tokenA = "";
      }
    }

    assert(
      quote?.quoteId && tokenA && tokenB,
      "No eligible production agent has sponsored quota for a safe smoke run.",
    );
    assert(
      quote.sponsored === true,
      "Production smoke requires sponsored quota; it will not send a payment.",
    );
    console.log("[production-machine-smoke] Credential A quote=ok sponsored=true");

    const runRequest = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `production-gate-run-${randomUUID()}`,
      },
      body: JSON.stringify({ quoteId: quote.quoteId }),
    } satisfies RequestInit;
    const run = await requestJson(
      baseUrl,
      "/api/agent/v1/runs",
      tokenA,
      runRequest,
    );
    assert(
      run.status === 200 || run.status === 201,
      `Credential A run launch failed with HTTP ${run.status}.`,
    );
    assert(typeof run.body.runId === "string", "Run launch returned no runId.");
    const runId = run.body.runId as string;
    console.log("[production-machine-smoke] Credential A run launch=ok");

    const replay = await requestJson(baseUrl, "/api/agent/v1/runs", tokenA, runRequest);
    assert(
      (replay.status === 200 || replay.status === 201) && replay.body.runId === runId,
      "Credential A idempotent run replay did not return the original run.",
    );
    console.log("[production-machine-smoke] Credential A idempotent replay=same run");

    const crossRun = await requestJson(
      baseUrl,
      `/api/agent/v1/runs/${encodeURIComponent(runId)}`,
      tokenB,
    );
    assert(
      crossRun.status === 404 &&
        crossRun.body.error?.code === "run_not_found",
      "Credential B was not isolated from Credential A's run.",
    );
    console.log("[production-machine-smoke] Credential B run isolation=404");

    const crossReport = await requestJson(
      baseUrl,
      `/api/agent/v1/reports/${encodeURIComponent(runId)}`,
      tokenB,
    );
    assert(
      crossReport.status === 404 &&
        crossReport.body.error?.code === "report_not_found",
      "Credential B was not isolated from Credential A's report.",
    );
    console.log("[production-machine-smoke] Credential B report isolation=404");

    const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
    let finalStatus = "";
    while (Date.now() < deadline) {
      const status = await requestJson(
        baseUrl,
        `/api/agent/v1/runs/${encodeURIComponent(runId)}`,
        tokenA,
      );
      assert(status.status === 200, "Credential A could not read its own run.");
      finalStatus = String(status.body.status ?? "");
      if (
        finalStatus === "completed" ||
        finalStatus === "completed_with_warnings" ||
        finalStatus === "failed"
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }

    assert(
      finalStatus === "completed" ||
        finalStatus === "completed_with_warnings",
      `Credential A run did not complete successfully (status=${finalStatus || "timeout"}).`,
    );
    console.log(
      `[production-machine-smoke] Credential A run status=${finalStatus}`,
    );

    const report = await requestJson(
      baseUrl,
      `/api/agent/v1/reports/${encodeURIComponent(runId)}`,
      tokenA,
    );
    assert(report.status === 200, "Credential A could not read its own report.");
    assert(
      report.body.reportId === runId,
      "Credential A report response did not match the completed run.",
    );
    console.log("[production-machine-smoke] Credential A report=ok");
  } finally {
    const cleanup = await Promise.allSettled([
      revokeCredential(credentialB),
      revokeCredential(credentialA),
    ]);
    const cleanupFailures = cleanup.filter(
      (result) => result.status === "rejected",
    ).length;
    assert(
      cleanupFailures === 0,
      "Smoke credentials could not be fully revoked.",
    );
    if (credentialA || credentialB) {
      console.log("[production-machine-smoke] temporary credentials revoked");
    }
  }
}

const confirmation = process.argv[2];
const baseUrlArg = process.argv[3];
assert(
  confirmation === PRODUCTION_CONFIRMATION,
  `Pass ${PRODUCTION_CONFIRMATION} to authorize the production smoke.`,
);
assert(baseUrlArg, "Pass the production base URL.");

const baseUrl = new URL(baseUrlArg);
assert(
  baseUrl.protocol === "https:",
  "Production smoke requires an HTTPS base URL.",
);

runSmoke(baseUrl).catch((error) => {
  console.error(
    `[production-machine-smoke] FAILED: ${error instanceof Error ? error.message : "Unknown error"}`,
  );
  process.exitCode = 1;
});
