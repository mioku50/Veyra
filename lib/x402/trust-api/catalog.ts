/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { BRAND } from "../../brand.ts";
import { VEYRA_AGENT_REGISTRY, VEYRA_ARC_AGENT_ID } from "../../erc8004/veyra-registration.ts";
import { ARC_OPENAPI_PATH, ARC_TRUST_API, VEYRA_ARC_PAY_TO, type ArcTrustApiProduct } from "./arc-mainnet.ts";
import { arcTrustApiOpenApi } from "./arc-openapi.ts";
import { buildTrustApiRequirements, type TrustApiRail, type TrustApiRequirement } from "./seller.ts";
import { TRUST_API_PRICING } from "./pricing.ts";

/** Last date pricing, payment terms, or endpoint schemas changed. */
export const TRUST_API_CATALOG_UPDATED_AT = "2026-11-24T00:00:00.000Z";

/**
 * Veyra published in the same shape as the catalog it polices.
 *
 * This is the strongest claim the product can make: the trust layer is itself
 * an x402 resource, discoverable and payable by exactly the machinery it spends
 * its time verifying. An agent can probe Veyra the way Veyra probes everyone
 * else, and should — the items below carry a published output schema precisely
 * so that the response can be held to it.
 */

const CAPABILITIES = {
  verdict: ["trust_verification", "counterparty_risk", "x402_verification"],
  history: ["endpoint_reliability", "historical_observations", "api_quality"],
  select: ["counterparty_selection", "service_discovery", "trust_verification"],
} as const;

/* Schemas live in pricing.ts, where the seller reads them to build its 402
   challenge. Keeping a second copy here is how the catalog and the challenge
   drift apart, and a buyer that trusts the catalog then builds a request the
   endpoint refuses. */

type CatalogEntry = {
  path: string;
  method: "GET" | "POST";
  priceUsdc: number;
  description: string;
  schema?: { input: unknown; output: unknown };
};

function openApiPaidMethod(
  paths: ReturnType<typeof arcTrustApiOpenApi>["paths"],
  routePath: string,
): "GET" | "POST" {
  const pathItem = paths[routePath as keyof typeof paths] as Record<string, Record<string, unknown>> | undefined;
  if (pathItem) {
    for (const candidate of ["post", "get"] as const) {
      if (pathItem[candidate] && "x-payment-info" in pathItem[candidate]) {
        return candidate.toUpperCase() as "GET" | "POST";
      }
    }
    if (pathItem.post) return "POST";
    if (pathItem.get) return "GET";
  }
  return "POST";
}

export async function buildTrustApiCatalog(origin: string, lastUpdated = TRUST_API_CATALOG_UPDATED_AT) {
  const openApiPaths = arcTrustApiOpenApi().paths;
  const listed = async (entry: CatalogEntry, tags: readonly string[], rail: TrustApiRail) => {
    const accepts: TrustApiRequirement[] = entry.priceUsdc > 0
      ? await buildTrustApiRequirements(entry.priceUsdc, entry.schema, rail).catch(() => [])
      : [];
    return catalogItem(origin, lastUpdated, entry, accepts, tags);
  };
  const items = await Promise.all([
    listed({ ...TRUST_API_PRICING.verdict, method: "POST" }, CAPABILITIES.verdict, "arc"),
    /* Listed once Veyra has a wallet to be paid to on Arc, and not before: an
       item nobody can pay is what Veyra marks others down for. */
    ...(VEYRA_ARC_PAY_TO === null ? [] : (Object.keys(ARC_TRUST_API) as ArcTrustApiProduct[])
      .map((product) => {
        const entry = ARC_TRUST_API[product];
        return listed(
          { ...entry, method: openApiPaidMethod(openApiPaths, entry.path) },
          CAPABILITIES[product],
          "arc",
        );
      })),
  ]);

  return {
    x402Version: 2,
    provider: BRAND.name,
    description: "Verify before your agent pays.",
    /* The identity that declares this catalogue, named back, as CRA's does. */
    ...(VEYRA_ARC_AGENT_ID === null ? {} : { erc8004: { agentId: VEYRA_ARC_AGENT_ID, agentRegistry: VEYRA_AGENT_REGISTRY } }),
    economics: {
      free: [TRUST_API_PRICING.verdict.path],
    },
    items,
    total: items.length,
  };
}

function catalogItem(
  origin: string,
  lastUpdated: string,
  entry: CatalogEntry,
  accepts: TrustApiRequirement[],
  tags: readonly string[],
) {
  const schema = entry.schema;
  return {
    resource: new URL(entry.path, origin).toString(),
    type: "http" as const,
    x402Version: 2,
    lastUpdated,
    accepts,
    metadata: {
      method: entry.method,
      path: entry.path,
      description: entry.description,
      mimeType: "application/json",
      priceUsdc: entry.priceUsdc,
      free: entry.priceUsdc === 0,
      siwx: false,
      supportsVanillax402: false,
      supportsCircleGateway: true,
      /* Both directions, in the field names Circle's catalog uses. Publishing
         only `output` is exactly the gap that made Veyra guess at Serper's
         request shape and pay for an HTTP 400: a reader of this catalog
         could not have built a valid call either. */
      input: schema ? { body: schema.input } : undefined,
      output: schema ? schema.output : undefined,
      provider: {
        name: BRAND.name,
        website: origin,
        docsUrl: new URL(ARC_OPENAPI_PATH, origin).toString(),
        description: BRAND.description,
        category: "trust",
        tags: [...tags],
      },
    },
  };
}
