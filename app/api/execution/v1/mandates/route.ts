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
  EIP712_MANDATE_TYPES,
  VEYRA_EXECUTION_EIP712_DOMAIN,
} from "@/lib/execution/canonical";
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
      issuedAt,
      expiresAt,
    });

    const canonicalHash = computeCanonicalMandateHash(eip712Message);

    return NextResponse.json({
      mandateId,
      canonicalHash,
      eip712Domain: VEYRA_EXECUTION_EIP712_DOMAIN,
      eip712Types: EIP712_MANDATE_TYPES,
      eip712Message,
      instructions: "Sign the EIP-712 typed data with ownerWallet and submit to /api/execution/v1/mandates/{mandateId}/activate",
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
