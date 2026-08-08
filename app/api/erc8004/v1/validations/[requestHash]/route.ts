/**
 * Copyright 2026 Circle Internet Group, Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse } from "next/server";
import { getByoaClient } from "@/lib/byoa/service.ts";
import { fetchValidationStatusOnchain } from "@/lib/erc8004/client.ts";
import type { Erc8004ValidationLinkRecord } from "@/lib/erc8004/types.ts";
import { zeroAddress } from "viem";

export const revalidate = 15;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ requestHash: string }> }
) {
  const { requestHash } = await params;
  if (!/^0x[0-9a-fA-F]{64}$/.test(requestHash) || /^0x0{64}$/i.test(requestHash)) {
    return NextResponse.json({ error: "Invalid requestHash format" }, { status: 400 });
  }

  const supabase = getByoaClient();
  const { data, error: dbError } = await supabase
    .from("erc8004_validation_links")
    .select("*")
    .eq("request_hash", requestHash)
    .eq("status", "confirmed")
    .maybeSingle();
  if (dbError) {
    return NextResponse.json(
      { error: { code: "validation_storage_unavailable", message: "Validation status is unavailable." } },
      { status: 503 }
    );
  }
  const dbRecord = data ? (data as Erc8004ValidationLinkRecord) : null;

  let onchainStatus = null;
  try {
    onchainStatus = await fetchValidationStatusOnchain(requestHash as `0x${string}`);
    if (
      onchainStatus.validatorAddress.toLowerCase() === zeroAddress ||
      onchainStatus.lastUpdate === BigInt(0)
    ) {
      onchainStatus = null;
    }
  } catch {
    if (dbRecord) {
      return NextResponse.json(
        { error: { code: "validation_verification_unavailable", message: "Validation status is unavailable." } },
        { status: 503 }
      );
    }
  }

  if (!dbRecord && !onchainStatus) {
    return NextResponse.json({ error: "Validation request not found" }, { status: 404 });
  }
  if (
    dbRecord &&
    (!onchainStatus ||
      onchainStatus.agentId.toString() !== dbRecord.agent_id ||
      onchainStatus.response !== dbRecord.response ||
      onchainStatus.responseHash.toLowerCase() !== dbRecord.response_hash.toLowerCase() ||
      onchainStatus.tag !== dbRecord.tag)
  ) {
    return NextResponse.json(
      { error: { code: "validation_verification_unavailable", message: "Validation status is unavailable." } },
      { status: 503 }
    );
  }

  return NextResponse.json(
    {
      requestHash,
      record: dbRecord
        ? {
            requestHash: dbRecord.request_hash,
            agentId: dbRecord.agent_id,
            evaluationPublicId: dbRecord.evaluation_public_id,
            canonicalReportHash: dbRecord.canonical_report_hash,
            response: dbRecord.response,
            responseHash: dbRecord.response_hash,
            responseTx: dbRecord.response_tx,
            tag: dbRecord.tag,
            status: dbRecord.status,
            confirmedAt: dbRecord.confirmed_at,
          }
        : null,
      onchain: onchainStatus
        ? {
            validatorAddress: onchainStatus.validatorAddress,
            agentId: onchainStatus.agentId.toString(),
            response: onchainStatus.response,
            responseHash: onchainStatus.responseHash,
            tag: onchainStatus.tag,
            lastUpdate: onchainStatus.lastUpdate.toString(),
          }
        : null,
    },
    { headers: { "Cache-Control": "public, max-age=15, s-maxage=15" } }
  );
}
