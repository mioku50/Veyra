/**
 * Copyright 2026 Circle Internet Group, Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse } from "next/server";
import {
  ARC_ERC8004_IDENTITY_REGISTRY,
  ARC_ERC8004_VALIDATION_REGISTRY,
  getArcPublicClient,
  getCanonicalVeyraAgentIdentity,
} from "@/lib/erc8004/client.ts";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const publicClient = getArcPublicClient();

    // Check RPC connectivity
    const chainId = await publicClient.getChainId();

    // Check Veyra identity in DB & onchain
    const identityRecord = await getCanonicalVeyraAgentIdentity(publicClient);
    const hasIdentity = Boolean(identityRecord?.agent_id);

    // Check registry code existence
    const identityCode = await publicClient.getCode({ address: ARC_ERC8004_IDENTITY_REGISTRY });
    const validationCode = await publicClient.getCode({ address: ARC_ERC8004_VALIDATION_REGISTRY });

    const identityReady = identityCode && identityCode !== "0x";
    const validationReady = validationCode && validationCode !== "0x";
    const relayerReady = Boolean(
      process.env.VEYRA_EVALUATOR_RELAYER_PRIVATE_KEY ||
      process.env.ERC8183_EVALUATOR_RELAYER_PRIVATE_KEY
    );
    const responderAuthReady = Boolean(process.env.ERC8004_VALIDATION_RESPOND_SECRET);

    const productionReady =
      chainId === 5042002 &&
      hasIdentity &&
      Boolean(identityReady) &&
      Boolean(validationReady) &&
      relayerReady &&
      responderAuthReady;

    return NextResponse.json({
      standard: "ERC-8004",
      network: "arc-testnet",
      chainId,
      identity: hasIdentity,
      agentId: identityRecord?.agent_id || null,
      metadata: Boolean(identityRecord?.metadata_uri),
      evaluator: true,
      evaluatorAddress: "0x0d2c04580e081e222bbe5bf9818af337e2633eb7",
      relayer: relayerReady,
      responderAuth: responderAuthReady,
      validationRegistry: Boolean(validationReady),
      productionReady,
    });
  } catch {
    return NextResponse.json(
      {
        productionReady: false,
        error: "ERC-8004 readiness could not be verified.",
      },
      { status: 503 }
    );
  }
}
