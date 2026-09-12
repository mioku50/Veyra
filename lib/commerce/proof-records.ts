/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  onchainPaymentEventColumns,
  onchainProofMetadataFromRow,
  type OnchainPaymentEventRecord,
} from "./onchain-proof";
import { createPublicSupabase } from "../agent/runs-public";

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function isHash(value: string) {
  return /^0x[0-9a-f]{64}$/i.test(value);
}

async function paymentEventBy(
  column: "id" | "receipt_hash" | "onchain_proof_id" | "onchain_tx_hash",
  value: string,
) {
  const { data, error } = await createPublicSupabase()
    .from("payment_events")
    .select(onchainPaymentEventColumns)
    .eq(column, value)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return (data as unknown as OnchainPaymentEventRecord | null) ?? null;
}

export async function fetchProofRecordByReceiptIdentifier(identifier: string) {
  if (isUuid(identifier)) {
    const direct = await paymentEventBy("id", identifier);
    if (direct) return direct;

    const { data: step, error } = await createPublicSupabase()
      .from("agent_purchase_steps")
      .select("payment_event_id")
      .eq("id", identifier)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (step?.payment_event_id) {
      return paymentEventBy("id", step.payment_event_id);
    }
  }

  if (isHash(identifier)) {
    return (
      (await paymentEventBy("onchain_proof_id", identifier)) ??
      (await paymentEventBy("receipt_hash", identifier))
    );
  }

  return null;
}

export async function fetchProofRecordByTransactionHash(transactionHash: string) {
  if (!isHash(transactionHash)) return null;
  return paymentEventBy("onchain_tx_hash", transactionHash);
}

export function proofMetadataForRecord(record: OnchainPaymentEventRecord) {
  return onchainProofMetadataFromRow(record);
}
