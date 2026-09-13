/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { isAddress } from "viem";
import { getByoaClient } from "../../byoa/service.ts";
import type { MarketplaceSelectionClearance } from "../../counterparty-selection/marketplace.ts";

/** Whether a clearance can be signed at all, asked before anyone is charged. */
export function attesterConfigured(): boolean {
  const key = process.env.VEYRA_TRUST_ATTESTER_PRIVATE_KEY
    || process.env.ERC8183_EVALUATOR_ATTESTER_PRIVATE_KEY;
  const gate = process.env.VEYRA_TRUST_GATE_ADDRESS;
  return Boolean(key && /^0x[0-9a-f]{64}$/i.test(key) && gate && isAddress(gate));
}

export type IssuedClearanceRecord = {
  clearance_digest: string;
  resource_key: string;
  resource_url: string;
  payer: string | null;
  pay_to: string | null;
  decision: string;
  max_exposure_usdc: string | number;
  chain_id: number;
  issued_at: string;
  expires_at: string;
};

/**
 * Records that Veyra signed this, so an outcome reported against it later can
 * be believed. An unrecorded clearance is still valid onchain — the signature
 * does not depend on this table — but it cannot earn a credit, which is the
 * conservative direction to fail in.
 */
export async function recordIssuedClearance(input: {
  clearance: MarketplaceSelectionClearance;
  resourceKey: string;
  resourceUrl: string;
  payer: string | null;
  payTo: string | null;
  decision: string;
  maxExposureUsdc: number;
}): Promise<boolean> {
  try {
    const { error } = await getByoaClient().from("x402_trust_clearances").insert({
      clearance_digest: input.clearance.clearanceDigest.toLowerCase(),
      clearance_id: input.clearance.clearanceId,
      decision_id: input.clearance.decisionId,
      resource_key: input.resourceKey,
      resource_url: input.resourceUrl,
      payer: input.payer,
      pay_to: input.payTo,
      decision: input.decision,
      max_exposure_usdc: input.maxExposureUsdc,
      chain_id: input.clearance.chainId,
      issued_at: input.clearance.issuedAt,
      expires_at: input.clearance.expiresAt,
    });
    if (error) {
      console.warn("x402_clearance_not_recorded", { code: error.code });
      return false;
    }
    return true;
  } catch (error) {
    console.warn("x402_clearance_ledger_unavailable", {
      errorName: error instanceof Error ? error.name : "unknown_error",
    });
    return false;
  }
}

export async function findIssuedClearance(digest: string): Promise<IssuedClearanceRecord | null> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(digest)) return null;
  try {
    const { data, error } = await getByoaClient()
      .from("x402_trust_clearances")
      .select("*")
      .eq("clearance_digest", digest.toLowerCase())
      .maybeSingle();
    if (error || !data) return null;
    return data as IssuedClearanceRecord;
  } catch {
    return null;
  }
}
