/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getByoaClient } from "../../byoa/service.ts";

/** Credits expire so the ledger cannot grow into an unbounded liability, and
 *  so that evidence bought with them stays roughly contemporaneous with the
 *  outcome that earned them. */
export const CREDIT_TTL_SECONDS = 30 * 24 * 60 * 60;

/** One reported outcome buys one paid call. The loop is deliberately not
 *  profitable to farm: earning a credit requires a clearance, and a clearance
 *  costs more than the credit returns. */
export const CREDIT_USES_PER_OUTCOME = 1;

export const CREDIT_HEADER = "X-Veyra-Credit";

const TOKEN_PATTERN = /^vcr_[0-9a-f]{64}$/;

export function hashCreditToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function isCreditTokenShaped(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value.trim());
}

export type IssuedCredit = {
  token: string;
  creditId: string;
  expiresAt: string;
  uses: number;
};

/**
 * Mints a bearer grant and returns it exactly once.
 *
 * Only the hash is stored, so nobody with database access - including Veyra -
 * can spend a credit after it is issued. That is the same reason the token is
 * never logged: the response to the agent that earned it is the only copy.
 */
export async function issueCredit(input: {
  outcomeId: string;
  uses?: number;
  ttlSeconds?: number;
}): Promise<IssuedCredit | null> {
  const token = `vcr_${randomBytes(32).toString("hex")}`;
  const uses = Math.max(1, input.uses ?? CREDIT_USES_PER_OUTCOME);
  const expiresAt = new Date(
    Date.now() + (input.ttlSeconds ?? CREDIT_TTL_SECONDS) * 1000,
  ).toISOString();

  try {
    const { data, error } = await getByoaClient()
      .from("x402_trust_credits")
      .insert({
        token_hash: hashCreditToken(token),
        outcome_id: input.outcomeId,
        uses_total: uses,
        uses_remaining: uses,
        expires_at: expiresAt,
      })
      .select("credit_id")
      .single();
    if (error || !data) {
      console.warn("x402_credit_issue_failed", { code: error?.code });
      return null;
    }
    return { token, creditId: String(data.credit_id), expiresAt, uses };
  } catch (error) {
    console.warn("x402_credit_store_unavailable", {
      errorName: error instanceof Error ? error.name : "unknown_error",
    });
    return null;
  }
}

export type RedeemedCredit = { creditId: string; usesRemaining: number };

/**
 * Spends one use, atomically.
 *
 * The decrement happens inside a conditional UPDATE in Postgres, so two
 * requests presenting the same token race against the row rather than against
 * a read-then-write in this process: exactly one of them is served.
 */
export async function redeemCredit(token: string): Promise<RedeemedCredit | null> {
  if (!isCreditTokenShaped(token)) return null;
  try {
    const { data, error } = await getByoaClient().rpc("redeem_x402_trust_credit_v1", {
      p_token_hash: hashCreditToken(token.trim()),
    });
    if (error) {
      console.warn("x402_credit_redeem_failed", { code: error.code });
      return null;
    }
    const row = (data as Array<{ credit_id?: string; uses_remaining?: number }> | null)?.[0];
    if (!row?.credit_id) return null;
    return {
      creditId: String(row.credit_id),
      usesRemaining: Number(row.uses_remaining ?? 0),
    };
  } catch (error) {
    console.warn("x402_credit_store_unavailable", {
      errorName: error instanceof Error ? error.name : "unknown_error",
    });
    return null;
  }
}

/** Constant-time compare for callers that need to match two tokens directly. */
export function creditTokensMatch(left: string, right: string): boolean {
  const a = Buffer.from(hashCreditToken(left), "hex");
  const b = Buffer.from(hashCreditToken(right), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
