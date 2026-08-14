/**
 * Copyright 2026 Circle Internet Group, Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse } from "next/server";
import { getCanonicalVeyraAgentIdentity } from "@/lib/erc8004/client";
import { BRAND } from "@/lib/brand";

export const dynamic = "force-dynamic";
export const revalidate = 3600;

export async function GET() {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://agent-commerce-six.vercel.app";
  const evaluatorAddress =
    process.env.NEXT_PUBLIC_VEYRA_ERC8183_EVALUATOR_ADDRESS || "0x0d2c04580e081e222bbe5bf9818af337e2633eb7";
  const commerceAddress =
    process.env.NEXT_PUBLIC_ARC_ERC8183_COMMERCE_ADDRESS || "0x0747EEf0706327138c69792bF28Cd525089e4583";
  const identity = await getCanonicalVeyraAgentIdentity();
  if (!identity) {
    return NextResponse.json(
      { error: { code: "identity_not_found", message: "Canonical Veyra identity was not found." } },
      { status: 503 }
    );
  }

  const metadata = {
    name: `${BRAND.name} Trust Evaluator`,
    description: "Independent trust, deliverable, and contract evaluator for agentic commerce on Arc Testnet.",
    version: "1.0.0",
    network: "arc-testnet",
    chainId: 5042002,
    identity: {
      standard: "ERC-8004",
      agentId: identity.agent_id,
      ownerAddress: identity.owner_address,
      registry: identity.registry_address,
      reputationRegistry: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
      validationRegistry: "0x8004Cb1BF31DAf7788923b405b754f57acEB4272",
    },
    evaluator: {
      standard: "ERC-8183",
      evaluatorAddress,
      commerceAddress,
      policy: "structured-deliverable-v1",
    },
    capabilities: [
      "erc8004_identity",
      "erc8183_evaluation",
      "erc8004_validation",
      "project_due_diligence",
      "trust_monitoring",
      "paid_api_quality",
      "treasury_health",
      "trust_routed_execution",
      "execution_mandates",
    ],
    services: {
      profile: `${baseUrl}/agents/veyra`,
      evaluatorProfile: `${baseUrl}/evaluators/erc8183`,
      machineApi: `${baseUrl}/api/erc8183/v1/evaluator`,
      agentMetadata: `${baseUrl}/api/erc8004/v1/agent`,
    },
  };

  return NextResponse.json(metadata, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600, s-maxage=3600",
    },
  });
}
