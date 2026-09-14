/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse, type NextRequest } from "next/server";
import { NOVA_HEADERS, novaErrorResponse, ownerSecretFrom } from "@/lib/nova/http";
import { db, loadOwned, recordArcIdentity } from "@/lib/nova/service";
import { agentIdFromTransaction, confirmIdentity } from "@/lib/nova/identity";
import { standingFrom } from "@/lib/nova/standing";

export const dynamic = "force-dynamic";

/**
 * Records the ERC-8004 identity its owner just minted.
 *
 * Veyra does not mint it. `register(metadataURI)` mints to whoever calls it, so
 * the transaction is signed by the connected wallet in the browser and the
 * owner is the person -- not Veyra, not a key derived from the recovery secret,
 * not a server-side wallet. An identity Veyra held would be Veyra's agent lent
 * out, which is a different product.
 *
 * What this route does is refuse to take the browser's word for any of it. The
 * client says "I minted agent #482"; this reads ownerOf(482) off Arc and
 * compares it to the wallet claiming it. A row nobody verified would show
 * somebody a badge for an agent they do not own, which is worse than no row.
 *
 * And it is earned. Eligibility is a verified purchase, because an identity
 * registered at signup certifies that an account was created and nothing else.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ publicId: string }> }) {
  try {
    const { publicId } = await params;
    const agent = await loadOwned(publicId, ownerSecretFrom(request));
    const body = await request.json().catch(() => ({})) as {
      agentId?: unknown;
      transaction?: unknown;
      wallet?: unknown;
    };

    const wallet = typeof body.wallet === "string" ? body.wallet : "";
    if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
      return NextResponse.json(
        { ok: false, reason: "wallet_required", detail: "Connect the wallet that owns the identity." },
        { status: 400, headers: NOVA_HEADERS },
      );
    }

    const { data } = await db()
      .from("nova_research")
      .select("research_id, signal_id, status, question, proposal, terms, execution_public_id, paid_usdc, transaction_hash, verification, result, failure, reading, arc_proof, settled_at")
      .eq("agent_id", agent.agent_id);
    const standing = standingFrom(((data ?? []) as Array<Record<string, any>>).map((row) => ({
      researchId: row.research_id, signalId: row.signal_id, status: row.status,
      question: row.question, proposal: row.proposal ?? {},
      authorisedUsdc: null, provider: row.terms?.provider ?? null,
      executionPublicId: row.execution_public_id, paidUsdc: row.paid_usdc,
      transaction: row.transaction_hash, verification: row.verification ?? null,
      reading: row.reading ?? null, arcProof: row.arc_proof ?? null,
      result: row.result, failure: row.failure, settledAt: row.settled_at,
    })) as never);

    if (!standing.readyForArcIdentity) {
      return NextResponse.json(
        {
          ok: false,
          reason: "not_earned",
          detail: `${agent.name} needs one purchase that passed its delivery check before an identity has anything to point at.`,
        },
        { status: 409, headers: NOVA_HEADERS },
      );
    }

    /* The agent id comes from the mint's own Transfer log where a transaction
       was given, and is only accepted from the client as a fallback -- either
       way it is ownerOf that decides. */
    const transaction = typeof body.transaction === "string" ? body.transaction : null;
    const claimed = transaction
      ? await agentIdFromTransaction({ transaction, owner: wallet })
      : null;
    const agentId = claimed ?? (typeof body.agentId === "string" ? body.agentId : "");

    const confirmed = await confirmIdentity({ agentId, expectedOwner: wallet });
    if (!confirmed.ok) {
      return NextResponse.json(
        {
          ok: false,
          reason: confirmed.reason,
          detail: confirmed.reason === "wrong_owner"
            ? "Arc does not show that wallet as the owner of this identity."
            : "Arc does not show a registration for this identity yet.",
        },
        { status: 409, headers: NOVA_HEADERS },
      );
    }

    const identity = { ...confirmed.identity, transaction };
    await recordArcIdentity({ agentId: agent.agent_id, identity });
    return NextResponse.json({ ok: true, identity }, { headers: NOVA_HEADERS });
  } catch (error) {
    return novaErrorResponse(error);
  }
}
