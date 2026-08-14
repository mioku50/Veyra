/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse } from "next/server";
import type { Hex } from "viem";
import { computeCanonicalMandateHash } from "@/lib/execution/canonical";
import { saveExecutionMandate } from "@/lib/execution/db";
import { validateMandateAuthorization } from "@/lib/execution/mandate";
import type { ExecutionMandate } from "@/lib/execution/types";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ mandateId: string }> }
) {
  try {
    const { mandateId } = await params;
    const body = await req.json();
    const {
      ownerWallet,
      subjectAgentId,
      subjectWallet,
      mode,
      network = "eip155:5042002",
      allowedCapabilities = [],
      allowedRails = ["erc8183", "x402"],
      maxPerTransactionUsdc,
      maxPerDayUsdc,
      maxTotalUsdc,
      minimumTrustScore = 0,
      minimumConfidence = 0,
      requireVerifiedIdentity = true,
      evaluatorThresholdUsdc = 0,
      signature,
      issuedAt = new Date().toISOString(),
      expiresAt,
    } = body;

    if (!signature || !/^0x[0-9a-f]{130}$/i.test(signature)) {
      return NextResponse.json({ error: "Valid 65-byte hex signature is required" }, { status: 400 });
    }

    const mandate: ExecutionMandate = {
      mandateId,
      ownerWallet: ownerWallet.toLowerCase(),
      subjectAgentId,
      subjectWallet: subjectWallet.toLowerCase(),
      mode,
      network,
      allowedCapabilities,
      allowedRails,
      maxPerTransactionUsdc,
      maxPerDayUsdc,
      maxTotalUsdc,
      minimumTrustScore,
      minimumConfidence,
      requireVerifiedIdentity,
      evaluatorThresholdUsdc,
      canonicalHash: "",
      signature: signature as Hex,
      nonce: 0,
      version: "v1",
      issuedAt,
      expiresAt,
      createdAt: new Date().toISOString(),
    };

    mandate.canonicalHash = computeCanonicalMandateHash(mandate);

    // Cryptographic signature validation
    const auth = await validateMandateAuthorization(mandate, signature as Hex);
    if (!auth.valid) {
      return NextResponse.json(
        { error: `Mandate authorization rejected: ${auth.reason}` },
        { status: 401 }
      );
    }

    await saveExecutionMandate(mandate);

    return NextResponse.json({
      success: true,
      mandateId,
      status: "ACTIVE",
      canonicalHash: mandate.canonicalHash,
      owner: mandate.ownerWallet,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
