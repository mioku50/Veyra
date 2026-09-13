/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse, type NextRequest } from "next/server";
import { getAddress, zeroAddress } from "viem";
import {
  selectMarketplaceCounterparty,
  validateMarketplaceSelectionRequest,
} from "@/lib/counterparty-selection/marketplace";
import { attesterConfigured } from "@/lib/x402/trust-api/clearance-ledger";
import { readJsonBody, trustApiError, TRUST_API_HEADERS } from "@/lib/x402/trust-api/http";
import { TRUST_API_PRICING } from "@/lib/x402/trust-api/pricing";
import { TrustApiError } from "@/lib/x402/trust-api/resource";
import { withTrustApiPayment } from "@/lib/x402/trust-api/seller";

export const dynamic = "force-dynamic";

/**
 * Paid. "Find me someone to buy this from, and tell me who not to."
 *
 * This costs the most to serve because it is the most work: Circle's catalog is
 * queried, every affordable candidate is probed live and in parallel, and all
 * of them are ranked against the same policy a single verdict uses. Each of
 * those probes is also written to the evidence base, so a paid selection makes
 * every later verdict — including the free ones — a little better informed.
 */
export const POST = withTrustApiPayment(async (request: NextRequest, context) => {
  try {
    const body = await readJsonBody(request);
    const wallet = context.payer
      ?? (typeof body.requesterWallet === "string" ? body.requesterWallet : null);

    let requesterWallet: `0x${string}`;
    try {
      requesterWallet = wallet ? getAddress(wallet) : zeroAddress;
    } catch {
      throw new TrustApiError("requester_wallet_invalid", 400, "`requesterWallet` must be an EVM address.");
    }

    const selection = await selectMarketplaceCounterparty({
      // Validated here so a malformed request is refused with the catalog's own
      // error rather than reaching the discovery call.
      request: validateMarketplaceSelectionRequest(body),
      tenant: {
        tenantKey: `x402:${requesterWallet.toLowerCase()}`,
        requesterWallet,
      },
      // A clearance names the wallet it authorizes. Without a payer there is
      // nobody to authorize, so the ranking is returned unsigned rather than
      // signed to nobody.
      issueClearance: requesterWallet !== zeroAddress && attesterConfigured(),
    });

    return NextResponse.json({
      selection,
      note: requesterWallet === zeroAddress
        ? "No payer wallet was identified, so this selection is unsigned. Pay from the wallet that will spend, or send `requesterWallet`, to receive a clearance."
        : undefined,
    }, { headers: TRUST_API_HEADERS });
  } catch (error) {
    return trustApiError(error);
  }
}, {
  endpoint: TRUST_API_PRICING.select.path,
  priceUsdc: TRUST_API_PRICING.select.priceUsdc,
  description: TRUST_API_PRICING.select.description,
});
