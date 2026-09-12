/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { privateKeyToAccount } from "viem/accounts";
import { createBrowserProject360Quote } from "../lib/project-360/service.ts";
import { HostedCheckoutInfrastructureError } from "../lib/commerce/workflow-checkout.ts";
import { tryGetServerSupabaseConfig } from "../lib/supabase/server-env.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  assert(
    process.argv.includes("--confirm-production"),
    "Pass --confirm-production to run the quote-only diagnostic.",
  );
  const privateKey =
    process.env.PHASE26_CHECKOUT_PRIVATE_KEY?.trim() ??
    process.env.BUYER_PRIVATE_KEY?.trim();
  assert(privateKey, "Acceptance buyer is not configured.");
  const ownerWallet = privateKeyToAccount(privateKey as `0x${string}`).address;
  const config = tryGetServerSupabaseConfig();
  assert(config, "Production service-role configuration is required.");
  const server = createClient(config.url, config.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const discovery = await server
    .from("project_360_discoveries")
    .select("id,public_id,revision")
    .ilike("owner_wallet", ownerWallet)
    .eq("status", "ready")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  assert(!discovery.error && discovery.data, "No ready acceptance discovery exists.");
  const candidates = await server
    .from("project_360_candidates")
    .select("public_id,module,source_type")
    .eq("discovery_id", discovery.data.id)
    .eq("validation_status", "valid");
  assert(!candidates.error && candidates.data, "Acceptance candidates could not be loaded.");
  const sourceTypes = [
    "github_repository",
    "project_wallet",
    "public_api_endpoint",
    "arc_contract",
  ];
  const selected = sourceTypes.map((sourceType) =>
    candidates.data.find((candidate) => candidate.source_type === sourceType),
  );
  assert(selected.every(Boolean), "The latest discovery lacks the four diagnostic sources.");

  try {
    const result = await createBrowserProject360Quote({
      ownerWallet,
      publicDiscoveryId: discovery.data.public_id,
      discoveryRevision: discovery.data.revision,
      selectedCandidateIds: selected.map((candidate) => candidate!.public_id),
      modules: selected.map((candidate) => candidate!.module),
      idempotencyKey: `p421-diagnostic-${randomUUID()}`,
      forwardedFor: "198.51.100.42",
      userAgent: "Veyra-P421-Quote-Diagnostic/1.0",
    });
    console.log(JSON.stringify({
      status: "quote_created",
      paymentMode: result.quote.paymentMode,
      amountDueUsdc: result.quote.pricing.amountDueUsdc,
      selectedModules: result.project360.selectedModules.length,
      selectedServices: result.quote.plan.selectedServices.length,
    }));
  } catch (error) {
    const safe = error as Error & { code?: string; status?: number; retryable?: boolean };
    const infrastructureStage = safe.cause instanceof HostedCheckoutInfrastructureError
      ? safe.cause.stage
      : null;
    console.error(JSON.stringify({
      status: "quote_failed",
      name: safe.name,
      code: safe.code ?? null,
      httpStatus: safe.status ?? null,
      retryable: safe.retryable ?? false,
      infrastructureStage,
      message: safe.message.slice(0, 300),
    }));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    status: "diagnostic_failed",
    message: error instanceof Error ? error.message.slice(0, 300) : "Unknown failure",
  }));
  process.exitCode = 1;
});
