/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse } from "next/server";
import { Erc8004IdentityVerificationError, getArcPublicClient, getCanonicalVeyraAgentIdentity } from "@/lib/erc8004/client.ts";
import { VEYRA_AGENT_URI, VEYRA_ARC_AGENT_ID } from "@/lib/erc8004/veyra-registration.ts";
import { BRAND } from "@/lib/brand.ts";
import {
  ARC_ERC8004_REPUTATION_REGISTRY,
  ARC_ERC8004_VALIDATION_REGISTRY,
} from "@/lib/erc8004/types.ts";

export const dynamic = "force-dynamic";
export const revalidate = 60;

export async function GET() {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://agent-commerce-six.vercel.app";
  const publicClient = getArcPublicClient();
  let identityRecord;
  try {
    identityRecord = await getCanonicalVeyraAgentIdentity(publicClient);
  } catch (error) {
    /* Arc Testnet stopped returning the identity's registration transaction.
       That is not a server fault: this answered 500 with no body. It now says
       what failed, as /api/erc8004/v1/reputation does, and where the mainnet
       identity is. */
    if (error instanceof Erc8004IdentityVerificationError) {
      return NextResponse.json(
        {
          error: {
            code: "identity_verification_unavailable",
            message: "The canonical Arc Testnet identity could not be verified.",
            reason: error.code,
          },
          arcMainnet: VEYRA_ARC_AGENT_ID === null ? null : { agentId: VEYRA_ARC_AGENT_ID, registration: VEYRA_AGENT_URI },
        },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    throw error;
  }
  if (!identityRecord) {
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
    verifiedOnchain: true,
    identity: {
      standard: "ERC-8004",
      registry: identityRecord.registry_address,
      reputationRegistry: ARC_ERC8004_REPUTATION_REGISTRY,
      validationRegistry: ARC_ERC8004_VALIDATION_REGISTRY,
      agentId: identityRecord.agent_id,
      ownerAddress: identityRecord.owner_address,
    },
    evaluator: {
      standard: "ERC-8183",
      evaluatorAddress:
        process.env.NEXT_PUBLIC_VEYRA_ERC8183_EVALUATOR_ADDRESS || "0x0d2c04580e081e222bbe5bf9818af337e2633eb7",
      commerceAddress:
        process.env.NEXT_PUBLIC_ARC_ERC8183_COMMERCE_ADDRESS || "0x0747EEf0706327138c69792bF28Cd525089e4583",
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
    ],
    services: {
      profile: `${baseUrl}/agents/veyra`,
      evaluatorProfile: `${baseUrl}/evaluators/erc8183`,
      machineApi: `${baseUrl}/api/erc8183/v1/evaluator`,
      agentMetadata: `${baseUrl}/api/erc8004/v1/agent`,
    },
  };

  return NextResponse.json(metadata, {
    headers: { "Cache-Control": "public, max-age=60, s-maxage=60" },
  });
}
