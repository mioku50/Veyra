/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import { originValidationResponse, type CallToolResult } from "@modelcontextprotocol/server";
import { createMcpHandler } from "mcp-handler";
import { z } from "zod-mcp";
import { BRAND } from "../../../lib/brand.ts";
import { VEYRA_ORIGIN } from "../../../lib/erc8004/veyra-registration.ts";
import { ARC_MAINNET_NETWORK, ARC_MAINNET_USDC_ADDRESS } from "../../../lib/wallet/arc.ts";
import { recordAdoptionEvent } from "../../../lib/x402/trust-api/adoption-metrics.ts";
import { ARC_TRUST_API } from "../../../lib/x402/trust-api/arc-mainnet.ts";
import { buildTrustApiCatalog } from "../../../lib/x402/trust-api/catalog.ts";
import { publicVerdict, trustApiError } from "../../../lib/x402/trust-api/http.ts";
import { loadEndpointObservations } from "../../../lib/x402/trust-api/observations.ts";
import { callerKey, consumeFreeCall } from "../../../lib/x402/trust-api/rate-limit.ts";
import { normalizeResourceUrl, resourceKeyFor } from "../../../lib/x402/trust-api/resource.ts";
import { computeTrustApiVerdict, TRUST_API_MAX_BUDGET_USDC } from "../../../lib/x402/trust-api/verdict.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const resource = z.string().trim().min(1).max(2048).describe("HTTPS x402 resource URL.");
const method = z.enum(["GET", "POST"]);
const maxHistorySample = 10;
const originHost = new URL(VEYRA_ORIGIN).hostname;

function result(data: Record<string, unknown>, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
    ...(isError ? { isError: true } : {}),
  };
}

async function freeTool(caller: string, action: () => Promise<Record<string, unknown>>): Promise<CallToolResult> {
  const limit = consumeFreeCall(caller);
  if (!limit.allowed) {
    return result({ error: { code: "rate_limited", retryAfterSeconds: limit.retryAfterSeconds } }, true);
  }
  try {
    return result(await action());
  } catch (error) {
    return result(await trustApiError(error).json(), true);
  }
}

function handle(request: Request): Promise<Response> | Response {
  const refused = originValidationResponse(request, [originHost]);
  if (refused) return refused;

  const caller = callerKey(request);
  return createMcpHandler((server) => {
    server.registerTool("veyra_check_endpoint", {
      description: "Check the live USDC offer for an x402 endpoint on Arc mainnet before paying. Returns an unsigned verdict, evidence, and deterministic preflight (`pass` means no blocking fact was found, not an endorsement).",
      inputSchema: z.strictObject({
        resource,
        method: method.optional().describe("If omitted, use the live offer or catalogue method."),
        budgetUsdc: z.number().positive().max(TRUST_API_MAX_BUDGET_USDC).optional(),
        capability: z.string().max(64).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    }, (input) => freeTool(caller, async () => {
      const verdict = publicVerdict(await computeTrustApiVerdict({
        ...input,
        budgetUsdc: input.budgetUsdc ?? 1,
        publicArc: true,
      }));
      recordAdoptionEvent(request.headers, "mcp_verdict");
      return { ...verdict, signed: false, clearance: null };
    }));

    server.registerTool("veyra_endpoint_history", {
      description: "Preview the recency and coverage of stored Arc USDC observations. Full history and change details are sold separately.",
      inputSchema: z.strictObject({ resource, method: method.default("POST") }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    }, (input) => freeTool(caller, async () => {
      const url = normalizeResourceUrl(input.resource);
      const rows = await loadEndpointObservations(resourceKeyFor(input.method, url), maxHistorySample, {
        network: ARC_MAINNET_NETWORK,
        asset: ARC_MAINNET_USDC_ADDRESS,
      });
      return {
        resource: url,
        method: input.method,
        network: ARC_MAINNET_NETWORK,
        observationSampleSize: rows.length,
        sampleLimit: maxHistorySample,
        lastObservedAt: rows[0]?.probed_at ?? null,
        fullHistoryEndpoint: new URL(ARC_TRUST_API.history.path, VEYRA_ORIGIN).href,
      };
    }));

    server.registerTool("veyra_list_resources", {
      description: "List Veyra's published free and paid x402 API resources and their HTTP methods.",
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
    }, () => freeTool(caller, () => buildTrustApiCatalog(VEYRA_ORIGIN)));
  }, {
    serverInfo: { name: BRAND.name, version: "1.1.0" },
    maxSubscriptions: 0,
    telemetry: false,
  })(request);
}

export { handle as GET, handle as POST };
