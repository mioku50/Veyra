/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { budgetPeriodFor, isValidTimezone } from "./budget-day.ts";
import { MANDATE_VERSION_V2 } from "./canonical.ts";

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

/**
 * The budget day a mandate is measured in.
 *
 * UTC was the only answer here, while an ExecutionMandate v2 carries a signed
 * timezone and Nova's shadow pass has always honoured it. So the same limits
 * could be judged against the owner's Tuesday in rehearsal and charged against
 * UTC's Tuesday in production -- a reset at 01:00 or 02:00 local for most of
 * Europe, which is inside the hours an unattended agent actually works.
 *
 * v1 stays UTC, because a v1 mandate was signed before the field existed and
 * reading a zone into somebody's signature is not a default, it is an
 * invention. It also does not grant unattended spending at all.
 */
export function dailyPeriodFor(
  mandate?: { version?: string | null; budgetTimezone?: string | null } | null,
  now = new Date(),
): BudgetPeriod {
  const zone = mandate?.budgetTimezone;
  if (mandate?.version === MANDATE_VERSION_V2 && typeof zone === "string" && isValidTimezone(zone)) {
    const day = budgetPeriodFor(now, zone);
    /* The end is the next local midnight rather than a millisecond before it.
       Nothing queries on it -- the usage row is keyed by (mandate, period
       start) -- so it is descriptive, and a half-open interval is the honest
       description. */
    return { periodStart: day.start, periodEnd: day.end };
  }
  return getCurrentDailyPeriod(now);
}

export interface BudgetReservationResult {
  success: boolean;
  reservedAmount?: number;
  remainingDaily?: number;
  remainingTotal?: number;
  reason?: string;
}
