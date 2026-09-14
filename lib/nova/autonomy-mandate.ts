/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  buildMandateEip712Message, computeCanonicalMandateHash, hashCapabilities, hashRails,
  mandateTypesFor, MANDATE_VERSION_V2, VEYRA_EXECUTION_EIP712_DOMAIN,
} from "../execution/canonical.ts";
import type { ExecutionMandate } from "../execution/types.ts";
import { isValidTimezone } from "./autonomy.ts";

/**
 * The only mandate D0 issues, defined once.
 *
 * Every term here is chosen for a rehearsal rather than for spending, and three
 * of them are the whole point.
 *
 * `mode` is PREVIEW. Shadow autonomy needs permission to look at a price and
 * form an opinion, and nothing more. Asking for AUTOPILOT would mean asking
 * somebody to sign a real unattended-spending permission in order to watch a
 * rehearsal -- a signature that would go live the moment an operational wallet
 * existed, without their ever being asked again. runAutopilotExecution refuses
 * anything but AUTOPILOT, so this signature cannot become that one.
 *
 * `subjectWallet` is the zero address, deliberately. Nova has no operational
 * wallet, and inventing one to fill the field would put an address in a signed
 * document that names nothing. When D1 gives Nova a wallet, this mandate stays
 * in the record as history and the owner signs a new AUTOPILOT one naming the
 * real address.
 *
 * `minimumConfidence` and `requireVerifiedIdentity` are neutral because a
 * shadow decision has nothing to check either against. mandateReadiness refuses
 * a mandate that sets them, so leaving them out is not a shortcut -- it is the
 * only shape that works, and the alternative would be showing a limit that is
 * quietly ignored.
 */
export const PREVIEW_MANDATE = {
  mode: "PREVIEW",
  version: MANDATE_VERSION_V2,
  subjectWallet: "0x0000000000000000000000000000000000000000" as const,
  /* Where the money would move, not where the signature lives. Circle's
     catalogue publishes nothing on Arc, so Nova's x402 purchases settle on
     Base; the EIP-712 domain stays Arc Testnet, which is the chain this
     permission is expressed on. Two different questions, two different
     answers, and conflating them would deny every decision. */
  network: "eip155:8453",
  allowedRails: ["x402"],
  allowedCapabilities: ["research", "search"],
  maxPerTransactionUsdc: 0.01,
  maxPerDayUsdc: 0.03,
  maxTotalUsdc: 0.15,
  maxAutonomousAttemptsPerDay: 3,
  minimumTrustScore: 90,
  minimumConfidence: 0,
  requireVerifiedIdentity: false,
  evaluatorThresholdUsdc: 0,
  daysValid: 7,
} as const;

/** What the card shows before anything is signed, and the panel shows after. */
export type PreviewMandateTerms = {
  mandateId: string;
  ownerWallet: string;
  subjectAgentId: string;
  subjectWallet: string;
  mode: string;
  version: string;
  network: string;
  allowedCapabilities: string[];
  allowedRails: string[];
  maxPerTransactionUsdc: number;
  maxPerDayUsdc: number;
  maxTotalUsdc: number;
  maxAutonomousAttemptsPerDay: number;
  minimumTrustScore: number;
  minimumConfidence: number;
  requireVerifiedIdentity: boolean;
  evaluatorThresholdUsdc: number;
  budgetTimezone: string;
  issuedAt: string;
  expiresAt: string;
};

export function previewMandateTerms(input: {
  mandateId: string;
  ownerWallet: string;
  agentPublicId: string;
  budgetTimezone: string;
  now: Date;
}): PreviewMandateTerms {
  const expires = new Date(input.now.getTime() + PREVIEW_MANDATE.daysValid * 86_400_000);
  return {
    mandateId: input.mandateId,
    ownerWallet: input.ownerWallet.toLowerCase(),
    subjectAgentId: input.agentPublicId,
    subjectWallet: PREVIEW_MANDATE.subjectWallet,
    mode: PREVIEW_MANDATE.mode,
    version: PREVIEW_MANDATE.version,
    network: PREVIEW_MANDATE.network,
    allowedCapabilities: [...PREVIEW_MANDATE.allowedCapabilities],
    allowedRails: [...PREVIEW_MANDATE.allowedRails],
    maxPerTransactionUsdc: PREVIEW_MANDATE.maxPerTransactionUsdc,
    maxPerDayUsdc: PREVIEW_MANDATE.maxPerDayUsdc,
    maxTotalUsdc: PREVIEW_MANDATE.maxTotalUsdc,
    maxAutonomousAttemptsPerDay: PREVIEW_MANDATE.maxAutonomousAttemptsPerDay,
    minimumTrustScore: PREVIEW_MANDATE.minimumTrustScore,
    minimumConfidence: PREVIEW_MANDATE.minimumConfidence,
    requireVerifiedIdentity: PREVIEW_MANDATE.requireVerifiedIdentity,
    evaluatorThresholdUsdc: PREVIEW_MANDATE.evaluatorThresholdUsdc,
    budgetTimezone: isValidTimezone(input.budgetTimezone) ? input.budgetTimezone : "UTC",
    issuedAt: input.now.toISOString(),
    expiresAt: expires.toISOString(),
  };
}

/** Exactly what the wallet is asked to sign. */
export function previewMandateSigningRequest(terms: PreviewMandateTerms) {
  const message = buildMandateEip712Message({
    ...terms,
    ownerWallet: terms.ownerWallet as `0x${string}`,
    subjectWallet: terms.subjectWallet as `0x${string}`,
  });
  return {
    domain: VEYRA_EXECUTION_EIP712_DOMAIN,
    types: mandateTypesFor(terms.version),
    primaryType: "ExecutionMandate" as const,
    message,
    canonicalHash: computeCanonicalMandateHash(message),
  };
}

/**
 * Whether a set of terms is the D0 mandate and nothing else.
 *
 * The terms come back from the browser at activation so the server can rebuild
 * the exact message that was signed. The signature already binds them -- change
 * one and it recovers a stranger -- but a wrong signature is a confusing error,
 * and a mandate that differed from the one on the card would be a worse thing
 * to store even if it verified. So the shape is checked before the signature,
 * and the one field a caller may genuinely vary is the timezone.
 */
export function isPreviewMandate(terms: PreviewMandateTerms): boolean {
  return terms.mode === PREVIEW_MANDATE.mode
    && terms.version === PREVIEW_MANDATE.version
    && terms.subjectWallet.toLowerCase() === PREVIEW_MANDATE.subjectWallet
    && terms.network === PREVIEW_MANDATE.network
    && terms.maxPerTransactionUsdc === PREVIEW_MANDATE.maxPerTransactionUsdc
    && terms.maxPerDayUsdc === PREVIEW_MANDATE.maxPerDayUsdc
    && terms.maxTotalUsdc === PREVIEW_MANDATE.maxTotalUsdc
    && terms.maxAutonomousAttemptsPerDay === PREVIEW_MANDATE.maxAutonomousAttemptsPerDay
    && terms.minimumTrustScore === PREVIEW_MANDATE.minimumTrustScore
    && terms.minimumConfidence === PREVIEW_MANDATE.minimumConfidence
    && terms.requireVerifiedIdentity === PREVIEW_MANDATE.requireVerifiedIdentity
    && terms.evaluatorThresholdUsdc === PREVIEW_MANDATE.evaluatorThresholdUsdc
    && isValidTimezone(terms.budgetTimezone)
    && hashRails(terms.allowedRails) === hashRails([...PREVIEW_MANDATE.allowedRails])
    && hashCapabilities(terms.allowedCapabilities)
      === hashCapabilities([...PREVIEW_MANDATE.allowedCapabilities]);
}

export function mandateFrom(
  terms: PreviewMandateTerms,
  signature: `0x${string}`,
  canonicalHash: string,
  now: Date,
): ExecutionMandate {
  return {
    ...terms,
    ownerWallet: terms.ownerWallet.toLowerCase() as `0x${string}`,
    subjectWallet: terms.subjectWallet.toLowerCase() as `0x${string}`,
    mode: terms.mode as ExecutionMandate["mode"],
    allowedRails: terms.allowedRails as ExecutionMandate["allowedRails"],
    canonicalHash,
    signature,
    nonce: 0,
    revokedAt: null,
    createdAt: now.toISOString(),
  };
}
