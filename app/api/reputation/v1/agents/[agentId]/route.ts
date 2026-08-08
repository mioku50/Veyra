/**
 * Copyright 2026 Circle Internet Group, Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse, type NextRequest } from "next/server";
import {
  Erc8004IdentityVerificationError,
  getArcPublicClient,
  getCanonicalAgentIdentity,
} from "@/lib/erc8004/client.ts";
import { fetchLatestReputationSnapshot, fetchReputationEvidenceForAgent } from "@/lib/reputation/db.ts";
import { computeAgentReputation, createReputationSnapshot } from "@/lib/reputation/engine.ts";

export const revalidate = 30;

export async function GET(req: NextRequest, context: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await context.params;
  const publicClient = getArcPublicClient();
  let canonicalIdentity;
  try {
    canonicalIdentity = await getCanonicalAgentIdentity(agentId, publicClient);
  } catch (error) {
    if (error instanceof Erc8004IdentityVerificationError) {
      return NextResponse.json(
        {
          error: {
            code: "identity_verification_unavailable",
            message: "Agent identity could not be verified.",
          },
        },
        { status: 503 }
      );
    }
    throw error;
  }
  if (!canonicalIdentity) {
    return NextResponse.json(
      { error: { code: "identity_not_found", message: "Agent identity was not found." } },
      { status: 404 }
    );
  }

  const identity = {
    agentId,
    chainId: 5042002 as const,
    identityRegistry: canonicalIdentity.registry_address,
    owner: canonicalIdentity.owner_address,
    metadataUri: canonicalIdentity.metadata_uri,
    verifiedOnchain: true,
  };

  const evidenceList = await fetchReputationEvidenceForAgent(agentId);
  const explanation = computeAgentReputation(identity, evidenceList);
  const snapshot = (await fetchLatestReputationSnapshot(agentId)) || createReputationSnapshot(identity, evidenceList, explanation);

  return NextResponse.json({
    standard: "ERC-8004",
    network: "arc-testnet",
    chainId: 5042002,
    agentId,
    identity,
    trustScore: explanation.trustScore,
    confidence: explanation.confidence,
    coverage: explanation.coverage,
    statusLabel: explanation.statusLabel,
    dimensions: explanation.dimensions,
    topPositiveEvidence: explanation.topPositiveEvidence,
    riskSignals: explanation.riskSignals,
    canonicalHash: snapshot.canonicalHash,
    arcProofTx: snapshot.arcProofTx || null,
    createdAt: snapshot.createdAt,
  }, {
    headers: { "Cache-Control": "public, max-age=30, s-maxage=30" },
  });
}
