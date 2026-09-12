/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse } from "next/server";
import { readAgentCommerceProof } from "@/lib/commerce/onchain-proof";
import {
  fetchProofRecordByTransactionHash,
  proofMetadataForRecord,
} from "@/lib/commerce/proof-records";

type RouteContext = {
  params: Promise<{ transactionHash: string }>;
};

export const revalidate = 0;

export async function GET(_request: Request, { params }: RouteContext) {
  const { transactionHash } = await params;

  try {
    const record = await fetchProofRecordByTransactionHash(transactionHash);
    if (!record) {
      return NextResponse.json({ error: "Proof transaction not found" }, { status: 404 });
    }

    const metadata = proofMetadataForRecord(record);
    const proof = metadata ? await readAgentCommerceProof(metadata) : null;

    return NextResponse.json({
      transactionHash,
      paymentEventId: record.id,
      status: metadata?.status ?? "unavailable",
      metadata,
      proof,
    });
  } catch (error) {
    console.error(
      `[proof-registry] Transaction read failed for ${transactionHash}:`,
      error instanceof Error ? error.name : "UnknownError",
    );
    return NextResponse.json(
      { error: "Unable to read onchain proof transaction" },
      { status: 502 },
    );
  }
}
