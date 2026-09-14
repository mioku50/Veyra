/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse } from "next/server";
import type { Hex } from "viem";
import {
  computeCanonicalMandateHash, MANDATE_VERSION_V1, MANDATE_VERSION_V2,
} from "@/lib/execution/canonical";
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
      version = MANDATE_VERSION_V1,
      budgetTimezone = null,
      maxAutonomousAttemptsPerDay = null,
    } = body;

    if (!signature || !/^0x[0-9a-f]{130}$/i.test(signature)) {
      return NextResponse.json({ error: "Valid 65-byte hex signature is required" }, { status: 400 });
    }
    if (version !== MANDATE_VERSION_V1 && version !== MANDATE_VERSION_V2) {
      return NextResponse.json({ error: "Unknown mandate version" }, { status: 400 });
    }
    /* A v1 mandate carrying v2 terms is a contradiction, not a lenient input:
       the struct it was signed under has no field for either of them, so the
       row would claim limits the signature never covered. */
    if (version === MANDATE_VERSION_V1
        && (budgetTimezone !== null || maxAutonomousAttemptsPerDay !== null)) {
      return NextResponse.json(
        { error: "budgetTimezone and maxAutonomousAttemptsPerDay require version v2" },
        { status: 400 }
      );
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
      budgetTimezone,
      maxAutonomousAttemptsPerDay,
      canonicalHash: "",
      signature: signature as Hex,
      nonce: 0,
      /* Read from the body rather than pinned. This said "v1" unconditionally,
         so a v2 mandate signed under the v2 struct would have been rebuilt and
         verified as v1 -- recovering a different address and being rejected as
         forged. The version is itself a signed field, so taking it from the
         caller cannot be used to widen anything: get it wrong and the
         signature fails to recover the owner. */
      version,
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

    const { sanitizeMandate } = await import("@/lib/execution/types");

    return NextResponse.json({
      success: true,
      mandateId,
      status: "ACTIVE",
      canonicalHash: mandate.canonicalHash,
      owner: mandate.ownerWallet,
      mandate: sanitizeMandate(mandate),
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
