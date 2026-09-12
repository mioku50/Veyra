/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import {
  onchainPaymentEventColumns,
  publishStoredProof,
  type OnchainPaymentEventRecord,
} from "@/lib/commerce/onchain-proof";
import { getServerSupabaseConfig } from "@/lib/supabase/server-env";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorized(request: Request) {
  const expected = process.env.AGENT_COMMERCE_PROOF_RECOVERY_TOKEN;
  const actual = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expected || !actual) return false;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as { paymentEventId?: unknown };
  if (
    typeof body.paymentEventId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.paymentEventId)
  ) {
    return NextResponse.json({ error: "A valid paymentEventId is required." }, { status: 400 });
  }

  const config = getServerSupabaseConfig();
  const supabase = createClient(config.url, config.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase
    .from("payment_events")
    .select(onchainPaymentEventColumns)
    .eq("id", body.paymentEventId)
    .in("onchain_status", ["pending", "failed"])
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: "Unable to load recoverable proof." }, { status: 503 });
  }
  if (!data) {
    return NextResponse.json(
      { recovered: false, reason: "not_recoverable" },
      { status: 409 },
    );
  }

  const result = await publishStoredProof({
    supabase,
    record: data as unknown as OnchainPaymentEventRecord,
  });
  return NextResponse.json({
    recovered: result.status === "verified",
    status: result.status,
    paymentEventId: result.paymentEventId,
    proofId: result.proofId,
    transactionHash: result.transactionHash,
    blockNumber: result.blockNumber,
  }, {
    status: result.status === "verified" ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
