/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

export interface BudgetPeriod {
  periodStart: string;
  periodEnd: string;
}

/**
 * Computes the UTC start and end of the current 24-hour daily budget window.
 */
export function getCurrentDailyPeriod(now = new Date()): BudgetPeriod {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));

  return {
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
  };
}

export interface BudgetReservationResult {
  success: boolean;
  reservedAmount?: number;
  remainingDaily?: number;
  remainingTotal?: number;
  reason?: string;
}
