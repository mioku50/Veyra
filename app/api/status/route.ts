/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse } from "next/server";
import { VEYRA_ARC_AGENT_ID, VEYRA_AGENT_URI } from "@/lib/erc8004/veyra-registration";
import { ARC_MAINNET_CHAIN_ID, ARC_MAINNET_NETWORK, ARC_TESTNET_CHAIN_ID } from "@/lib/wallet/arc";
import { ARC_OPENAPI_PATH, ARC_TRUST_API } from "@/lib/x402/trust-api/arc-mainnet";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    {
      status: "operational",
      network: ARC_MAINNET_NETWORK,
      chainId: ARC_MAINNET_CHAIN_ID,
      trustApi: {
        network: ARC_MAINNET_NETWORK,
        chainId: ARC_MAINNET_CHAIN_ID,
        agentId: VEYRA_ARC_AGENT_ID,
        registration: VEYRA_AGENT_URI,
        openapi: ARC_OPENAPI_PATH,
        products: Object.values(ARC_TRUST_API).map(({ path, priceUsdc }) => ({ path, priceUsdc })),
      },
      testnet: {
        network: "arc-testnet",
        chainId: ARC_TESTNET_CHAIN_ID,
        services: ["TrustGate", "ERC-8183 evaluator"],
      },
      version: "0.3.0-beta.1",
      timestamp: new Date().toISOString(),
    },
    {
      status: 200,
      headers: {
        "Cache-Control": "public, max-age=15, s-maxage=30",
      },
    },
  );
}
