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
 * Empty until an owner signs. Epoch #1 begins with the first PREVIEW mandate
 * carrying `allowedCapabilities: ["research", "data"]`, and its hash is not
 * knowable before that signature -- the hash covers the owner's wallet, their
 * timezone and the moment of issue, so it is produced by the act of signing and
 * cannot be written down in advance.
 */
export const CALIBRATION_EPOCHS: readonly CalibrationEpoch[] = [];

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
