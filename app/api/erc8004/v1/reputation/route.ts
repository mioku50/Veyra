/**
 * Copyright 2026 Circle Internet Group, Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse, type NextRequest } from "next/server";
import {
  Erc8004IdentityVerificationError,
  getArcPublicClient,
  getCanonicalAgentIdentity,
  getCanonicalVeyraAgentIdentity,
} from "@/lib/erc8004/client.ts";
import { fetchLatestReputationSnapshot, fetchReputationEvidenceForAgent } from "@/lib/reputation/db.ts";
import { computeAgentReputation, createReputationSnapshot } from "@/lib/reputation/engine.ts";

export const dynamic = "force-dynamic";
export const revalidate = 30;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const publicClient = getArcPublicClient();

  try {
    const requestedAgentId = searchParams.get("agentId")?.trim();
    const identity = requestedAgentId
      ? await getCanonicalAgentIdentity(requestedAgentId, publicClient)
      : await getCanonicalVeyraAgentIdentity(publicClient);
    if (!identity) {
      return NextResponse.json(
        { error: { code: "identity_not_found", message: "Agent identity was not found." } },
        { status: 404 }
      );
    }

    const canonicalIdentity = {
      agentId: identity.agent_id,
      chainId: 5042002 as const,
      identityRegistry: identity.registry_address,
      owner: identity.owner_address,
      metadataUri: identity.metadata_uri,
      verifiedOnchain: true,
    };
    const evidenceList = await fetchReputationEvidenceForAgent(identity.agent_id);
    const explanation = computeAgentReputation(canonicalIdentity, evidenceList);
    const latestSnapshot =
      (await fetchLatestReputationSnapshot(identity.agent_id)) ||
      createReputationSnapshot(canonicalIdentity, evidenceList, explanation);

    return NextResponse.json({
      agentId: identity.agent_id,
      trustScore: explanation.trustScore,
      confidence: explanation.confidence,
      coverage: explanation.coverage,
      statusLabel: explanation.statusLabel,
      dimensions: explanation.dimensions,
      totalFeedbackCount: evidenceList.length,
      independentReviewersCount: new Set(evidenceList.map((item) => item.counterpartyAddress).filter(Boolean)).size,
      evidenceLinkedCount: evidenceList.filter((item) => item.arcProofVerified || item.verifiedOnchain).length,
      unlinkedCount: evidenceList.filter((item) => !item.verifiedOnchain).length,
      topPositiveEvidence: explanation.topPositiveEvidence,
      riskSignals: explanation.riskSignals,
      canonicalHash: latestSnapshot.canonicalHash,
    }, {
      headers: { "Cache-Control": "public, max-age=30, s-maxage=30" },
    });
  } catch (error) {
    if (error instanceof Erc8004IdentityVerificationError) {
      return NextResponse.json(
        { error: { code: "identity_verification_unavailable", message: "Agent identity could not be verified." } },
        { status: 503 }
      );
    }
    throw error;
  }
}
