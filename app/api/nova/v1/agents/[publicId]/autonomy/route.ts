/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getAddress, isAddress, type Hex } from "viem";
import { NOVA_HEADERS, novaErrorResponse, ownerSecretFrom } from "@/lib/nova/http";
import { db, loadOwned, NovaError } from "@/lib/nova/service";
import { saveExecutionMandate } from "@/lib/execution/db";
import { recoverMandateSigner } from "@/lib/execution/mandate";
import {
  isPreviewMandate, mandateFrom, previewMandateSigningRequest, previewMandateTerms,
  type PreviewMandateTerms,
} from "@/lib/nova/autonomy-mandate";
import { mandateReadiness } from "@/lib/nova/autonomy";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ publicId: string }> };

/**
 * Signing the limits Nova rehearses under.
 *
 * Two steps and one route. POST builds the terms and hands back exactly the
 * typed data a wallet will show; PUT takes the signature, rebuilds the same
 * message, and stores the mandate only if the signature recovers the wallet
 * that claims to have made it.
 *
 * The terms come back from the browser at the second step rather than being
 * held on the server between them. That is safe because the signature binds
 * them -- alter a limit and the recovered address is a stranger -- and it is
 * checked for being the D0 shape first anyway, because a confusing signature
 * error is a worse thing to return than a plain "these are not the terms".
 *
 * Nothing here can move money. The mandate it writes is PREVIEW, and
 * runAutopilotExecution refuses anything that is not AUTOPILOT.
 */
export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const { publicId } = await params;
    const body = await request.json().catch(() => ({})) as {
      wallet?: unknown;
      budgetTimezone?: unknown;
    };

    const agent = await loadOwned(publicId, ownerSecretFrom(request));

    if (typeof body.wallet !== "string" || !isAddress(body.wallet)) {
      throw new NovaError("Connect a wallet before signing limits.", "bad_request", 400);
    }
    /* The browser's own zone, and refused rather than silently defaulted. A
       budget day measured somewhere the owner does not live is a term they did
       not agree to, and it is the reason this field is signed at all. */
    if (typeof body.budgetTimezone !== "string" || !body.budgetTimezone) {
      throw new NovaError("A budget timezone is required.", "bad_request", 400);
    }

    const terms = previewMandateTerms({
      mandateId: `vman_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      ownerWallet: getAddress(body.wallet),
      agentPublicId: agent.public_id,
      budgetTimezone: body.budgetTimezone,
      now: new Date(),
    });
    if (!isPreviewMandate(terms)) {
      throw new NovaError("That timezone cannot be read here.", "bad_request", 400);
    }

    const signing = previewMandateSigningRequest(terms);
    return NextResponse.json({ terms, signing }, { headers: NOVA_HEADERS });
  } catch (error) {
    return novaErrorResponse(error);
  }
}

export async function PUT(request: NextRequest, { params }: RouteContext) {
  try {
    const { publicId } = await params;
    const body = await request.json().catch(() => ({})) as {
      terms?: PreviewMandateTerms;
      signature?: unknown;
    };

    const agent = await loadOwned(publicId, ownerSecretFrom(request));
    const terms = body.terms;
    if (!terms || typeof terms !== "object") {
      throw new NovaError("The signed terms are missing.", "bad_request", 400);
    }
    if (typeof body.signature !== "string" || !/^0x[0-9a-f]{130}$/i.test(body.signature)) {
      throw new NovaError("That is not a signature.", "bad_request", 400);
    }
    /* A mandate for one agent cannot be activated on another: the subject is a
       signed field, so this is a clearer error rather than a new protection. */
    if (terms.subjectAgentId !== agent.public_id) {
      throw new NovaError("Those limits were signed for a different agent.", "bad_request", 400);
    }
    if (!isPreviewMandate(terms)) {
      throw new NovaError("Those are not the limits this page offers.", "bad_request", 400);
    }

    const signing = previewMandateSigningRequest(terms);
    const signer = await recoverMandateSigner(
      terms as never,
      terms.mandateId,
      body.signature as Hex,
    );
    if (signer.toLowerCase() !== terms.ownerWallet.toLowerCase()) {
      throw new NovaError("That signature is not from the wallet these limits name.", "forbidden", 403);
    }

    const mandate = mandateFrom(terms, body.signature as Hex, signing.canonicalHash, new Date());

    /* The last gate is the one the scheduler will apply anyway. Storing a
       mandate the shadow pass would refuse means an owner signs something,
       sees it saved, and nothing ever happens -- which is worse than being
       told now. */
    const readiness = mandateReadiness(mandate, new Date());
    if (!readiness.ready) {
      throw new NovaError(readiness.detail, readiness.reason, 400);
    }

    await saveExecutionMandate(mandate);

    /* The mandate is found by the owner's wallet, so the agent has to remember
       which one signed it. This is also the first time a Nova is bound to a
       wallet at all: until now it has been a secret in a browser. */
    await db()
      .from("nova_agents")
      .update({ owner_wallet: mandate.ownerWallet, updated_at: new Date().toISOString() })
      .eq("agent_id", agent.agent_id);

    return NextResponse.json({
      ok: true,
      mandateId: mandate.mandateId,
      canonicalHash: mandate.canonicalHash,
      mode: mandate.mode,
      expiresAt: mandate.expiresAt,
    }, { headers: NOVA_HEADERS });
  } catch (error) {
    return novaErrorResponse(error);
  }
}
