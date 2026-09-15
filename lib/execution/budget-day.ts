/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What day it is, according to the person whose budget it is.
 *
 * This lived in lib/nova/autonomy.ts, where it was written for shadow
 * autonomy, while the executor that moves real money computed its budget day
 * in UTC. So a mandate could be judged against the owner's Tuesday in
 * rehearsal and charged against UTC's Tuesday in production -- two different
 * days for eight months of the year in Europe, and the difference only shows
 * up in the hours an unattended agent actually works in.
 *
 * The zone is a signed term of an ExecutionMandate v2. One implementation of
 * it, imported by both sides.
 */

/** A day, as the owner's clock reads it rather than as UTC does. */
export type OwnerDay = {
  /** Inclusive ISO instant of local midnight. */
  start: string;
  /** Exclusive ISO instant of the next local midnight. */
  end: string;
  timezone: string;
};

export function isValidTimezone(zone: string): boolean {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** How far the zone's clock is from UTC at one instant, in milliseconds. */
function offsetMsAt(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  /* Some ICU builds render midnight as hour 24 of the previous day. */
  const hour = read("hour") % 24;
  /* The instant's own milliseconds, because Intl does not format them and
     leaving them out does not round the offset -- it subtracts them from it.
     An offset is a whole number of minutes; this one came back as
     `trueOffset - now.getMilliseconds()`, and budgetPeriodFor subtracts it from
     a civil midnight, so the budget day started at 22:00:00.826 on one pass and
     22:00:00.253 on the next.
     What that cost is not cosmetic. `alreadyDecided` matches on
     budget_period_start exactly, and so does the unique index behind it, so the
     backoff this file documents as "one decision per signal per mandate per
     budget day" never matched a row: production has the same two signals
     decided three times inside twenty minutes, each under its own millisecond
     of a day. A week of statistics gathered that way would mostly be the same
     handful of signals counted over and over. */
  const asIfUtc = Date.UTC(
    read("year"), read("month") - 1, read("day"),
    hour, read("minute"), read("second"), instant.getUTCMilliseconds(),
  );
  return asIfUtc - instant.getTime();
}

/**
 * The owner's day containing this instant.
 *
 * A daily budget measured in UTC resets at 01:00 or 02:00 for most of Europe,
 * which is inside the window an unattended agent actually works in: a run at
 * 00:30 and a run at 02:30 would draw on two different days without anybody
 * having agreed to that. So the zone is a signed field of the mandate and the
 * day is computed from it.
 *
 * The offset is read twice because it can differ across the boundary. On the
 * night a zone springs forward, the second read is what makes the period start
 * at the first instant that exists rather than at one that does not.
 */
export function budgetPeriodFor(at: Date, timeZone: string): OwnerDay {
  const zone = isValidTimezone(timeZone) ? timeZone : "UTC";
  const offset = offsetMsAt(at, zone);
  const civil = new Date(at.getTime() + offset);

  const boundary = (dayShift: number): number => {
    const asIfUtc = Date.UTC(
      civil.getUTCFullYear(),
      civil.getUTCMonth(),
      civil.getUTCDate() + dayShift,
    );
    const first = asIfUtc - offset;
    const corrected = offsetMsAt(new Date(first), zone);
    return corrected === offset ? first : asIfUtc - corrected;
  };

  return {
    start: new Date(boundary(0)).toISOString(),
    end: new Date(boundary(1)).toISOString(),
    timezone: zone,
  };
}
