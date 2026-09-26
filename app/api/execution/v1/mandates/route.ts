/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { authenticateExecutionCaller } from "@/lib/execution/auth";
import {
  buildMandateEip712Message,
  computeCanonicalMandateHash,
  mandateTypesFor,
  MANDATE_VERSION_V1,
  MANDATE_VERSION_V2,
  VEYRA_EXECUTION_EIP712_DOMAIN,
} from "@/lib/execution/canonical";
import { isValidTimezone } from "@/lib/nova/autonomy";
import { AUTONOMY_FROZEN, AUTONOMY_FROZEN_CODE, AUTONOMY_FROZEN_MESSAGE } from "@/lib/execution/autonomy-freeze";
import { listExecutionMandatesByOwner } from "@/lib/execution/db";
import { sanitizeMandate } from "@/lib/execution/types";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const caller = await authenticateExecutionCaller(req);
    const mandates = await listExecutionMandatesByOwner(caller.wallet);
    const sanitizedMandates = mandates.map(sanitizeMandate);
    return NextResponse.json({ mandates: sanitizedMandates });
  } catch (err: any) {
    const status = err.status || 500;
    return NextResponse.json({ error: err.message, code: err.code || "SERVER_ERROR" }, { status });
  }
}

export async function POST(req: Request) {
  try {
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
      expiresAt,
      version = MANDATE_VERSION_V1,
      budgetTimezone,
      maxAutonomousAttemptsPerDay,
    } = body;

    if (!ownerWallet || !/^0x[0-9a-f]{40}$/i.test(ownerWallet)) {
      return NextResponse.json({ error: "Valid ownerWallet is required" }, { status: 400 });
    }
    if (!subjectAgentId || !subjectWallet || !/^0x[0-9a-f]{40}$/i.test(subjectWallet)) {
      return NextResponse.json(
        { error: "Valid subjectAgentId and subjectWallet are required" },
        { status: 400 }
      );
    }
    if (!["PREVIEW", "PREPARE", "AUTOPILOT"].includes(mode)) {
      return NextResponse.json({ error: "Invalid mode. Allowed: PREVIEW, PREPARE, AUTOPILOT" }, { status: 400 });
    }
    /* A mandate is offered for signature here, so a frozen mode is refused
       before anybody is asked to sign something that can never be used. */
    if (mode === "AUTOPILOT" && AUTONOMY_FROZEN) {
      return NextResponse.json({ error: AUTONOMY_FROZEN_MESSAGE, code: AUTONOMY_FROZEN_CODE }, { status: 403 });
    }
    if (
      typeof maxPerTransactionUsdc !== "number" ||
      typeof maxPerDayUsdc !== "number" ||
      typeof maxTotalUsdc !== "number"
    ) {
      return NextResponse.json(
        { error: "maxPerTransactionUsdc, maxPerDayUsdc, and maxTotalUsdc must be numbers" },
        { status: 400 }
      );
    }
    if (!expiresAt) {
      return NextResponse.json({ error: "expiresAt ISO timestamp is required" }, { status: 400 });
    }
    if (version !== MANDATE_VERSION_V1 && version !== MANDATE_VERSION_V2) {
      return NextResponse.json(
        { error: `Unknown mandate version. Allowed: ${MANDATE_VERSION_V1}, ${MANDATE_VERSION_V2}` },
        { status: 400 }
      );
    }
    /* v2 signs two more terms, and both have to be real before anything is put
       in front of a wallet. A mandate offered for signature with a timezone
       this server cannot read would produce a budget day nobody could compute
       and a signature nobody could act on. */
    if (version === MANDATE_VERSION_V2) {
      if (typeof budgetTimezone !== "string" || !isValidTimezone(budgetTimezone)) {
        return NextResponse.json(
          { error: "budgetTimezone must be an IANA zone, such as Europe/Berlin" },
          { status: 400 }
        );
      }
      if (
        !Number.isInteger(maxAutonomousAttemptsPerDay) ||
        maxAutonomousAttemptsPerDay < 0 ||
        maxAutonomousAttemptsPerDay > 100
      ) {
        return NextResponse.json(
          { error: "maxAutonomousAttemptsPerDay must be a whole number between 0 and 100" },
          { status: 400 }
        );
      }
    } else if (budgetTimezone !== undefined || maxAutonomousAttemptsPerDay !== undefined) {
      /* Refused rather than dropped. Silently discarding a term somebody asked
         for would hand them a signature that does not say what they think. */
      return NextResponse.json(
        { error: "budgetTimezone and maxAutonomousAttemptsPerDay require version v2" },
        { status: 400 }
      );
    }

    const mandateId = `vman_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const issuedAt = new Date().toISOString();

    const eip712Message = buildMandateEip712Message({
      mandateId,
      ownerWallet,
      subjectAgentId,
      subjectWallet,
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
      version,
      issuedAt,
      expiresAt,
    });

    const canonicalHash = computeCanonicalMandateHash(eip712Message);

    return NextResponse.json({
      mandateId,
      canonicalHash,
      eip712Domain: VEYRA_EXECUTION_EIP712_DOMAIN,
      /* The struct this version is signed under. Returning the v1 types for a
         v2 message would have the wallet hash a different statement from the
         one the server later verifies, and the signature would recover a
         stranger. */
      eip712Types: mandateTypesFor(version),
      eip712Message,
      instructions: "Sign the EIP-712 typed data with ownerWallet and submit to /api/execution/v1/mandates/{mandateId}/activate",
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
