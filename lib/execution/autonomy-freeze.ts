/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Autonomous spending is frozen, for every user.
 *
 * Decided by the owner on 2026-09-26, the day MetaMask refused to sign the
 * option C permission on Arc mainnet: see
 * docs/audits/2026-09-26-autonomy-frozen.md. Nova proposes, and the owner
 * approves every payment. Nothing pays on its own, and nothing rehearses
 * paying on its own: no AUTOPILOT execution, no new AUTOPILOT mandate, no new
 * shadow-autonomy (PREVIEW) mandate, no shadow pass.
 *
 * Lifting it is a code change, reviewed and released, and not a deployment
 * setting: `VEYRA_AUTOPILOT_ENABLED` cannot undo it on its own. Typed as a
 * plain boolean so the code behind each check stays compiled and tested for
 * the day it is lifted.
 */
export const AUTONOMY_FROZEN: boolean = true;
export const AUTONOMY_FROZEN_SINCE = "2026-09-26";
export const AUTONOMY_FROZEN_CODE = "AUTONOMY_FROZEN";
export const AUTONOMY_FROZEN_MESSAGE =
  "Autonomous spending is frozen. Every payment is proposed to its owner and approved by them.";
