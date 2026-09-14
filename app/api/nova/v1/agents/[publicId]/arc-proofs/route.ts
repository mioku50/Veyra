/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse, type NextRequest } from "next/server";
import { NOVA_HEADERS, novaErrorResponse, ownerSecretFrom } from "@/lib/nova/http";
import { db, loadOwned } from "@/lib/nova/service";
import { publishMissingArcProofs } from "@/lib/nova/arc-proof";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Records this agent's verified purchases on Arc, at its owner's request.
 *
 * The first version of this was an operator route behind a shared token, which
 * had the authority backwards: recording that a person's own purchase passed
 * its check is not an administrative act, it is the thing they were promised.
 * The owner secret already proves who is asking, and it scopes the sweep to
 * their rows -- so nobody needs a deployment secret to get their own history
 * onto the chain.
 *
 * What is signed is still Veyra's attestation, by Veyra's attester. The owner
 * is asking for it to be published, not signing it: the verdict is Veyra's and
 * so is the responsibility for it.
 *
 * Purchases attest themselves as they settle. This exists for the ones that
 * settled before that was true, and for the ones where Arc was unreachable at
 * the moment it mattered -- which must never have cost the purchase, and did
 * not.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ publicId: string }> }) {
  try {
    const { publicId } = await params;
    const agent = await loadOwned(publicId, ownerSecretFrom(request));

    const results = await publishMissingArcProofs({ db: db(), agentId: agent.agent_id });
    const published = results.filter((entry) => entry.published);

    return NextResponse.json(
      {
        ok: true,
        considered: results.length,
        published: published.length,
        /* Named individually, because "2 published" over a list a person can
           check against their own receipts is worth less than the list. */
        proofs: published.map((entry) => ({
          executionPublicId: entry.executionPublicId,
          provider: entry.provider,
          source: entry.source,
          explorerUrl: entry.explorerUrl,
        })),
        unreachable: results.filter((entry) => !entry.published).map((entry) => entry.executionPublicId),
      },
      { headers: NOVA_HEADERS },
    );
  } catch (error) {
    return novaErrorResponse(error);
  }
}
