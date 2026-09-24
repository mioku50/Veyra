/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { MARKETPLACE_NETWORKS } from "../counterparty-selection/marketplace-source.ts";
import type { SubjectDigest } from "./types.ts";

/**
 * Which chain a price is denominated on, in the name a person uses for it.
 *
 * An interest is not a network, and the brief was letting one stand in for the
 * other. "Arc" is a thing to care about; its capability terms are `arc`, `usdc`
 * and `stablecoin`, matched against what a seller says it does. When Nova's
 * catalogue read asked for Base only, choosing Arc as an interest returned
 * endpoints that settle somewhere else, and the card put the word ARC directly
 * above "$0.01". Nobody reads that as "this matched your interest in Arc". The
 * read now asks Arc first and Base after, and the card names the chain the
 * price is on, whichever interest matched.
 */
export function networkName(network: string | null | undefined): string | null {
  if (!network) return null;
  return MARKETPLACE_NETWORKS[network as keyof typeof MARKETPLACE_NETWORKS]
    ?? (network.startsWith("eip155:") ? null : network);
}

/** The chain a signal's money would move on, when the signal is about money. */
export function settlementNetworkOf(digest: SubjectDigest | null | undefined): string | null {
  if (!digest || digest.kind !== "x402_resource") return null;
  return networkName(digest.network);
}
