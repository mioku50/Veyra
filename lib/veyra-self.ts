/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import { VEYRA_ARC_PAY_TO } from "./x402/trust-api/arc-mainnet.ts";

/**
 * Veyra's own listings, wherever discovery meets them.
 *
 * Once Veyra sells on Arc mainnet, it is listed in the places where it looks
 * for sellers: Circle's catalogue and the ERC-8004 registry. Chosen for an
 * owner, it would be the owner paying Veyra's wallet for Veyra's own answer,
 * with Veyra vouching for itself. So it is never a candidate, by address or by
 * wallet.
 */
const VEYRA_HOSTS = new Set(["agent-commerce-six.vercel.app", "veyras.vercel.app"]);

function appHost(): string | null {
  try {
    return process.env.NEXT_PUBLIC_APP_URL ? new URL(process.env.NEXT_PUBLIC_APP_URL).host.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function isVeyraItself(listing: { resource: string; payTo?: string | null }): boolean {
  let host: string | null = null;
  try {
    host = new URL(listing.resource).host.toLowerCase();
  } catch {
    /* Not a URL: nothing to match by address. */
  }
  if (host && (VEYRA_HOSTS.has(host) || host === appHost())) return true;
  return Boolean(VEYRA_ARC_PAY_TO && listing.payTo && listing.payTo.toLowerCase() === VEYRA_ARC_PAY_TO.toLowerCase());
}
