/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse } from "next/server";
import { Erc8004IdentityVerificationError, getCanonicalVeyraAgentIdentity } from "@/lib/erc8004/client";
import {
  ARC_ERC8004_REPUTATION_REGISTRY,
  ARC_ERC8004_VALIDATION_REGISTRY,
  type Erc8004AgentIdentityRecord,
} from "@/lib/erc8004/types";
import { VEYRA_AGENT_REGISTRY, VEYRA_AGENT_URI, VEYRA_ARC_AGENT_ID } from "@/lib/erc8004/veyra-registration";
import { ARC_MAINNET_CHAIN_ID, ARC_MAINNET_NETWORK, ARC_TESTNET_CHAIN_ID } from "@/lib/wallet/arc";
import { ARC_OPENAPI_PATH, ARC_TRUST_API } from "@/lib/x402/trust-api/arc-mainnet";
import { BRAND } from "@/lib/brand";

export const dynamic = "force-dynamic";

export async function GET() {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://agent-commerce-six.vercel.app";
  const evaluatorAddress =
    process.env.NEXT_PUBLIC_VEYRA_ERC8183_EVALUATOR_ADDRESS || "0x0d2c04580e081e222bbe5bf9818af337e2633eb7";
  const commerceAddress =
    process.env.NEXT_PUBLIC_ARC_ERC8183_COMMERCE_ADDRESS || "0x0747EEf0706327138c69792bF28Cd525089e4583";
  let identity: Erc8004AgentIdentityRecord | null = null;
  let identityError: { code: string; reason?: string } | null = null;
  try {
    identity = await getCanonicalVeyraAgentIdentity();
    if (!identity) identityError = { code: "identity_not_found" };
  } catch (error) {
    identityError = {
      code: "identity_verification_unavailable",
      ...(error instanceof Erc8004IdentityVerificationError ? { reason: error.code } : {}),
    };
  }

  const metadata = {
    name: `${BRAND.name} Trust Evaluator`,
    description:
      `${BRAND.name} offers its Trust API on Arc mainnet. The evaluator and identity fields describe the Arc Testnet integration.`,
    version: "1.0.0",
    arcMainnet: {
      network: ARC_MAINNET_NETWORK,
      chainId: ARC_MAINNET_CHAIN_ID,
      agentId: VEYRA_ARC_AGENT_ID,
      agentRegistry: VEYRA_AGENT_REGISTRY,
      registration: VEYRA_AGENT_URI,
      openapi: `${baseUrl}${ARC_OPENAPI_PATH}`,
      history: `${baseUrl}${ARC_TRUST_API.history.path}`,
      select: `${baseUrl}${ARC_TRUST_API.select.path}`,
    },
    // This URL is also the token URI of the Testnet evaluator identity.
    network: "arc-testnet",
    chainId: ARC_TESTNET_CHAIN_ID,
    identity: identity ? {
      standard: "ERC-8004",
      agentId: identity.agent_id,
      ownerAddress: identity.owner_address,
      registry: identity.registry_address,
      reputationRegistry: ARC_ERC8004_REPUTATION_REGISTRY,
      validationRegistry: ARC_ERC8004_VALIDATION_REGISTRY,
    } : null,
    identityError,
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
      "Cache-Control": identityError ? "no-store" : "public, max-age=3600, s-maxage=3600",
    },
  });
}
