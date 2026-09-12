/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse } from "next/server";
import { prepareDeliverableCommitment } from "@/lib/erc8183/deliverable";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    if (!body || typeof body !== "object") {
      return NextResponse.json(
        { error: "invalid_request", message: "Request body must be a valid JSON object." },
        { status: 400 },
      );
    }

    const { contentUri, contentHash, contentType, schemaId, policyId } = body;
    if (typeof contentUri !== "string" || !contentUri.startsWith("https://")) {
      return NextResponse.json(
        { error: "invalid_request", message: "contentUri must be a valid HTTPS URL." },
        { status: 400 },
      );
    }

    if (typeof contentHash !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(contentHash)) {
      return NextResponse.json(
        { error: "invalid_request", message: "contentHash must be a 32-byte 0x-prefixed hex string." },
        { status: 400 },
      );
    }

    const result = prepareDeliverableCommitment({
      contentUri,
      contentHash: contentHash as `0x${string}`,
      contentType,
      schemaId,
      policyId,
    });

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    return NextResponse.json(
      { error: "internal_error", message: error instanceof Error ? error.message : "Unexpected error" },
      { status: 500 },
    );
  }
}
