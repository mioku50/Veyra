/**
 * Copyright 2026 Veyra
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse } from "next/server";
import { fetchReceiptById } from "@/lib/commerce/receipts";
import { readAgentCommerceProof } from "@/lib/commerce/onchain-proof";
import {
  fetchProofRecordByReceiptIdentifier,
  proofMetadataForRecord,
} from "@/lib/commerce/proof-records";

type RouteContext = {
  params: Promise<{
    receiptId: string;
  }>;
};

export const revalidate = 0;

export async function GET(_request: Request, { params }: RouteContext) {
  const { receiptId } = await params;

  try {
    const receipt = await fetchReceiptById(receiptId);
    const record = receipt
      ? null
      : await fetchProofRecordByReceiptIdentifier(receiptId);
    const metadata = receipt?.onchainProof ??
      (record ? proofMetadataForRecord(record) : null);

    if (!receipt && !record) {
      return NextResponse.json({ error: "Receipt not found" }, { status: 404 });
    }

    if (!metadata) {
      return NextResponse.json({
        receiptId,
        status: "unavailable",
        metadata: null,
        proof: null,
      });
    }

    const proof = await readAgentCommerceProof(metadata);

    return NextResponse.json({
      receiptId,
      paymentEventId:
        receipt?.paymentEvent?.id ?? record?.id ?? null,
      status: metadata.status,
      metadata,
      proof,
    });
  } catch (error) {
    console.error(
      `[proof-registry] Read failed for receipt ${receiptId}:`,
      error instanceof Error ? error.name : "UnknownError",
    );
    return NextResponse.json(
      { error: "Unable to read onchain proof" },
      { status: 502 },
    );
  }
}
