/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { listExecutionAttempts } from "./db.ts";
import { reconcileExecutionSettlement } from "./executor.ts";
import type { SettlementResolver } from "./settlement-resolver.ts";

/**
 * The thing that actually asks.
 *
 * SETTLEMENT_UNVERIFIED is the state a purchase lands in when Veyra cannot say
 * whether money moved: the response went missing, or the seller refused after
 * being handed a live authorization. It is explicitly not terminal -- the
 * reconciler is supposed to come back and settle it against the chain.
 *
 * Nothing ever came back. The only caller of reconcileExecutionSettlement was
 * an HTTP route addressed by execution id, so an attempt was reconciled exactly
 * when a human already knew about it and went looking. Everything else sat
 * there with its budget reserved, holding part of a daily cap against a payment
 * that had either happened or hadn't, forever. A state whose exit is manual is
 * not a state, it is a leak.
 *
 * So: a sweep, oldest first, bounded, and idempotent by construction --
 * reconcileExecutionSettlement guards on the expected state, so two overlapping
 * ticks cannot settle the same attempt twice.
 *
 * Deliberately not clever about which attempts are ready. An authorization
 * inside its validity window resolves to "nothing to say" for the cost of one
 * eth_call, and paying that every hour is cheaper than maintaining a second
 * opinion about when the chain is worth asking.
 */

/** How many attempts one tick will work through. Bounded so a backlog costs
 *  many cheap ticks rather than one that runs past the platform's timeout and
 *  gets killed halfway, having done work it cannot report. */
export const SWEEP_BATCH_LIMIT = 25;

export type SweepOutcome = {
  /** Attempts found waiting, up to the limit. */
  examined: number;
  /** Answered with "money moved": COMPLETED, COMPLETED_UNPROVEN, or
   *  SETTLED_SERVICE_FAILED. The spend is now booked against the budget. */
  settled: number;
  /** Answered with "money did not move". The reservation was released. */
  failed: number;
  /** Still nothing to say. Left exactly as they were. */
  unresolved: number;
  /** Reconciliation threw. Counted, never fatal: one bad row must not stop the
   *  sweep from reaching the next twenty-four. */
  errored: number;
  durationMs: number;
};

export async function sweepUnverifiedSettlements(options?: {
  limit?: number;
  resolver?: SettlementResolver;
}): Promise<SweepOutcome> {
  const startedAt = Date.now();
  const limit = options?.limit ?? SWEEP_BATCH_LIMIT;

  const waiting = await listExecutionAttempts({
    state: "SETTLEMENT_UNVERIFIED",
    oldestFirst: true,
    limit,
  });

  const outcome: SweepOutcome = {
    examined: waiting.length,
    settled: 0,
    failed: 0,
    unresolved: 0,
    errored: 0,
    durationMs: 0,
  };

  for (const attempt of waiting) {
    try {
      const result = await reconcileExecutionSettlement(attempt.executionId, {
        resolver: options?.resolver,
      });
      /* Widened deliberately: an attempt that reached a terminal state before
         this tick is echoed back with its own state, and SETTLEMENT_FAILED is
         one the declared return union does not list. Tallying against the
         narrow type would drop it into the wrong bucket. */
      const status: string = result.status;
      if (
        status === "COMPLETED" ||
        status === "COMPLETED_UNPROVEN" ||
        status === "SETTLED_SERVICE_FAILED"
      ) {
        outcome.settled += 1;
      } else if (status === "SETTLEMENT_UNVERIFIED") {
        outcome.unresolved += 1;
      } else {
        outcome.failed += 1;
      }
    } catch (error) {
      outcome.errored += 1;
      /* Named, not detailed. This log is read from a public Actions run, and
         an execution id plus an error name is enough to find the row. */
      console.warn("settlement_sweep_attempt_failed", {
        executionId: attempt.executionId,
        errorName: error instanceof Error ? error.name : "unknown_error",
      });
    }
  }

  outcome.durationMs = Date.now() - startedAt;
  return outcome;
}
