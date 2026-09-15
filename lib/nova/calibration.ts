/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ShadowRecord } from "./autonomy.ts";

/**
 * Which decisions count as the calibration run, and which are development.
 *
 * D0 exists to answer what Nova's limits should be, and that answer is only
 * worth having if the decisions behind it were all made under the same terms.
 * The decisions already on record were not. They were made while shadow
 * autonomy kept its own list of executable verdicts, while the budget day moved
 * by a millisecond on every pass so the same signal could be decided three
 * times in twenty minutes, and while `allowedCapabilities` held discovery terms
 * rather than capabilities -- so a denial on capability_allowed in those rows
 * means something different from a denial on capability_allowed after them.
 *
 * Averaging across that boundary would not be a small error. It would answer
 * "what should the limits be" with a number half-derived from a mandate whose
 * capability list authorised nothing anybody could name.
 *
 * So the boundary is a signature. A mandate's canonical hash covers every term
 * in it, which makes it exactly the identity of "one set of limits": change a
 * capability, a budget or a threshold and the hash changes, and the run that
 * follows is a different run whether or not anybody remembers to say so.
 *
 * Append-only. An epoch that has begun is never edited, because a boundary that
 * can be moved afterwards is not one.
 */
export type CalibrationEpoch = {
  /** 1, 2, 3 -- in the order they began. */
  number: number;
  /** The canonical hash of the mandate whose decisions make up this epoch. */
  mandateHash: string;
  /** When the owner signed it. */
  startedAt: string;
  /** What this run is meant to answer, in one line. */
  purpose: string;
};

/**
 * The runs, in order.
 *
 * Epoch #1 is the mandate signed on 15 September 2026, the first carrying
 * `allowedCapabilities: ["research", "data"]` -- capabilities read off the
 * endpoint rather than the word the catalogue was searched with. It expires
 * seven days later, which is the calibration week.
 *
 * Everything decided before it is development history, and the boundary is not
 * a formality. Those decisions were made while shadow autonomy kept its own
 * list of executable verdicts and refused a tier Veyra allows; while the budget
 * day moved by a millisecond on every pass, so the backoff never fired and the
 * same signal was decided three times in twenty minutes; and while
 * allowedCapabilities held discovery terms, so every denial on
 * capability_allowed was against a list that authorised nothing anybody could
 * name. Eight decisions, all WOULD_DENY, all on capability. Counting them
 * towards a limit would answer "what should Nova be allowed to spend" with
 * evidence from a mandate that permitted nothing.
 */
export const CALIBRATION_EPOCHS: readonly CalibrationEpoch[] = [
  {
    number: 1,
    mandateHash: "0x32c4b9a9e1421b8a97afbe57704e27a250b6ff146569ea9179eecc0cacf87db1",
    startedAt: "2026-09-15T12:50:15.667Z",
    purpose: "What Nova's limits should be, measured on research and data at "
      + "$0.01 per action, $0.03 a day and three attempts.",
  },
];

/** The run in progress, or null before the first signature. */
export function currentEpoch(): CalibrationEpoch | null {
  return CALIBRATION_EPOCHS[CALIBRATION_EPOCHS.length - 1] ?? null;
}

export function epochFor(mandateHash: string): CalibrationEpoch | null {
  return CALIBRATION_EPOCHS.find((epoch) => epoch.mandateHash === mandateHash) ?? null;
}

/**
 * Decisions that belong to a calibration run, and decisions that came before.
 *
 * Returned as two lists rather than one filtered list on purpose. The
 * pre-calibration decisions are not rubbish and must not disappear: they are
 * the record of how the path was made to work at all, and three of the defects
 * this product has fixed were found by reading them. They are simply not
 * evidence about limits, and a function that silently dropped them would make
 * that distinction invisible at the one moment somebody needs to see it.
 *
 * With no epoch registered yet, everything is development history -- which is
 * the honest answer before an owner has signed anything, and keeps this from
 * quietly counting the old rows the day the module is first imported.
 */
export function splitByCalibration(
  records: readonly ShadowRecord[],
  epoch: CalibrationEpoch | null = currentEpoch(),
): { calibration: ShadowRecord[]; development: ShadowRecord[] } {
  if (!epoch) return { calibration: [], development: [...records] };
  const calibration: ShadowRecord[] = [];
  const development: ShadowRecord[] = [];
  for (const record of records) {
    (record.mandateHash === epoch.mandateHash ? calibration : development).push(record);
  }
  return { calibration, development };
}
