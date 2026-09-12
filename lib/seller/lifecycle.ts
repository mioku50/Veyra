/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from "node:crypto";
import type { Address } from "viem";
import type { ApiService } from "../services/registry.ts";
import { decryptSellerEndpointSecret } from "./endpoint-secret.ts";
import {
  ensureSellerAccount,
  getSellerMarketplaceClient,
  getSellerServiceRowById,
  getSellerServiceVersion,
  type SellerMarketplaceServiceRow,
  type SellerServiceVersionRow,
} from "./marketplace.ts";
import { prepareExternalSellerRequest } from "./proxy.ts";

type ProbeResult = {
  healthy: boolean;
  latencyMs: number;
  errorCode: string | null;
  checks: Record<string, boolean | number | string>;
};

function executionService(
  service: SellerMarketplaceServiceRow,
  version: SellerServiceVersionRow,
): ApiService {
  const price = Number(version.price_usdc);
  return {
    id: service.public_id,
    slug: service.slug,
    name: version.name,
    shortDescription: version.short_description,
    longDescription: version.long_description,
    category: version.category,
    method: version.method,
    endpoint: service.public_id,
    priceLabel: `${price.toFixed(6)} USDC`,
    priceUsd: price,
    status: "live",
    sourceType: "external_seller",
    isPaid: price > 0,
    inputSchema: version.input_schema,
    outputSchema: version.output_schema,
    exampleRequest: version.health_check_input,
    exampleResponse: {},
    exampleUseCase: version.short_description,
    agentReasoningHint: "Availability preflight for an immutable external seller version.",
    fulfillmentUrl: version.fulfillment_url,
    sellerWallet: service.seller_wallet,
    expectedNetwork: version.expected_network,
    expectedAsset: version.expected_asset,
    maxTimeoutMs: Math.min(version.max_timeout_ms, 10_000),
    maxResponseSizeBytes: Math.min(version.max_response_size_bytes, 65_536),
  };
}

function errorCode(error: unknown) {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (message.includes("ssrf") || message.includes("private") || message.includes("redirect")) return "endpoint_security_rejected";
  if (message.includes("timed out") || message.includes("timeout") || message.includes("abort")) return "endpoint_timeout";
  if (message.includes("challenge") || message.includes("payment-required") || message.includes("402")) return "x402_challenge_invalid";
  if (message.includes("dns") || message.includes("connect") || message.includes("fetch")) return "endpoint_unreachable";
  return "endpoint_unhealthy";
}

async function serviceSnapshot(serviceId: string, sellerId?: string) {
  const service = await getSellerServiceRowById(serviceId);
  if (!service || (sellerId && service.seller_id !== sellerId)) return null;
  const version = await getSellerServiceVersion(service.id, service.service_version);
  if (!version || version.seller_id !== service.seller_id) return null;
  return { service, version };
}

async function probeSellerService(
  service: SellerMarketplaceServiceRow,
  version: SellerServiceVersionRow,
): Promise<ProbeResult> {
  const startedAt = Date.now();
  try {
    const prepared = await prepareExternalSellerRequest({
      service: executionService(service, version),
      method: version.method,
      body: version.method === "POST" ? version.health_check_input : undefined,
      headers: { "x-agent-commerce-request-id": `seller-health-${randomUUID()}` },
      trustedAuthorization: version.endpoint_auth_ciphertext
        ? `Bearer ${decryptSellerEndpointSecret(version.endpoint_auth_ciphertext)}`
        : undefined,
    });
    if (prepared.kind !== "payment-required") {
      throw new Error("Paid seller review requires an exact x402 challenge.");
    }
    return {
      healthy: true,
      latencyMs: Math.min(60_000, Date.now() - startedAt),
      errorCode: null,
      checks: {
        httpsEndpoint: true,
        ssrfSafe: true,
        exactX402: true,
        arcTestnet: true,
        registeredWallet: true,
        immutablePrice: true,
      },
    };
  } catch (error) {
    const code = errorCode(error);
    return {
      healthy: false,
      latencyMs: Math.min(60_000, Date.now() - startedAt),
      errorCode: code,
      checks: {
        httpsEndpoint: true,
        preflightPassed: false,
        errorCode: code,
      },
    };
  }
}

async function persistHealth(
  service: SellerMarketplaceServiceRow,
  result: ProbeResult,
) {
  const recorded = await getSellerMarketplaceClient().rpc("record_seller_health_check_v1", {
    p_seller_id: service.seller_id,
    p_service_id: service.id,
    p_service_version: service.service_version,
    p_healthy: result.healthy,
    p_latency_ms: result.latencyMs,
    p_error_code: result.errorCode,
  });
  if (recorded.error || typeof recorded.data !== "string") {
    throw new Error("Unable to record seller availability check.");
  }
  return recorded.data as "healthy" | "degraded" | "unavailable";
}

export async function submitSellerServiceReview(
  ownerWallet: Address,
  serviceId: string,
) {
  const seller = await ensureSellerAccount(ownerWallet);
  if (seller.status !== "active" || seller.onboarding_status !== "active") {
    throw new Error("Complete seller onboarding before submitting a service for review.");
  }
  const snapshot = await serviceSnapshot(serviceId, seller.id);
  if (!snapshot || snapshot.service.archived_at) return null;
  const { service, version } = snapshot;

  const pending = await getSellerMarketplaceClient().from("store_services").update({
    review_status: "pending",
    review_submitted_at: new Date().toISOString(),
    review_reason: null,
    status: "draft",
  }).eq("id", service.id).eq("seller_id", seller.id).eq("service_version", service.service_version);
  if (pending.error) throw new Error("Unable to submit seller service review.");

  const probe = await probeSellerService(service, version);
  const finalized = await getSellerMarketplaceClient().rpc("finalize_seller_service_review_v1", {
    p_seller_id: seller.id,
    p_service_id: service.id,
    p_service_version: service.service_version,
    p_approved: probe.healthy,
    p_checks: probe.checks,
    p_reason: probe.healthy ? null : probe.errorCode,
  });
  if (finalized.error || finalized.data !== true) {
    throw new Error("Unable to finalize seller service review.");
  }
  return {
    serviceId: service.id,
    serviceVersion: service.service_version,
    reviewStatus: probe.healthy ? "approved" as const : "changes_requested" as const,
    availabilityStatus: probe.healthy ? "healthy" as const : "unknown" as const,
    checks: probe.checks,
    reason: probe.errorCode,
  };
}

export async function checkOwnedSellerServiceAvailability(
  ownerWallet: Address,
  serviceId: string,
) {
  const seller = await ensureSellerAccount(ownerWallet);
  const snapshot = await serviceSnapshot(serviceId, seller.id);
  if (!snapshot || snapshot.service.archived_at) return null;
  if (snapshot.service.review_status !== "approved") {
    throw new Error("Only an approved service can run availability checks.");
  }
  const probe = await probeSellerService(snapshot.service, snapshot.version);
  const availabilityStatus = await persistHealth(snapshot.service, probe);
  return {
    serviceId: snapshot.service.id,
    serviceVersion: snapshot.service.service_version,
    availabilityStatus,
    healthy: probe.healthy,
    latencyMs: probe.latencyMs,
    errorCode: probe.errorCode,
  };
}

export async function monitorDueSellerServices(limit = 20) {
  const dueBefore = new Date(Date.now() - 6 * 60 * 60_000).toISOString();
  const result = await getSellerMarketplaceClient().from("store_services")
    .select("id")
    .eq("source_type", "external_seller")
    .eq("review_status", "approved")
    .is("archived_at", null)
    .or(`last_health_check_at.is.null,last_health_check_at.lt.${dueBefore}`)
    .order("last_health_check_at", { ascending: true, nullsFirst: true })
    .limit(Math.max(1, Math.min(limit, 50)));
  if (result.error) throw new Error("Unable to load due seller availability checks.");

  let healthy = 0;
  let unhealthy = 0;
  for (const row of result.data ?? []) {
    const snapshot = await serviceSnapshot(String(row.id));
    if (!snapshot) continue;
    const probe = await probeSellerService(snapshot.service, snapshot.version);
    await persistHealth(snapshot.service, probe);
    if (probe.healthy) healthy += 1;
    else unhealthy += 1;
  }
  return { checked: healthy + unhealthy, healthy, unhealthy };
}
