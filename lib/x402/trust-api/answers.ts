/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import { NextResponse, type NextRequest } from "next/server.js";
import { getAddress, zeroAddress } from "viem";
import { BRAND } from "../../brand.ts";
import {
  selectMarketplaceCounterparty,
  validateMarketplaceSelectionRequest,
} from "../../counterparty-selection/marketplace.ts";
import { CounterpartySelectionError } from "../../counterparty-selection/service.ts";
import { ARC_MAINNET_NETWORK } from "./arc-mainnet.ts";
import { attesterConfigured } from "./clearance-ledger.ts";
import { readJsonBody, trustApiError, TRUST_API_HEADERS } from "./http.ts";
import { loadEndpointObservations, summariseEndpointHistory } from "./observations.ts";
import { normalizeResourceUrl, parseProbeMethod, resourceKeyFor, TrustApiError } from "./resource.ts";
import type { TrustApiRail } from "./seller.ts";

/**
 * What `history` and `select` answer, on either rail.
 *
 * Each has a check the seller runs before any money moves. x402 has no refund,
 * so a request that cannot be served must be refused while it is still
 * unpaid. Both used to be refused only after settlement, and a `select` that
 * followed its own published schema was one of them.
 */

export function checkHistoryRequest(body: Record<string, unknown>) {
  const resource = normalizeResourceUrl(body.resource);
  const method = parseProbeMethod(body.method);
  return { resource, method, resourceKey: resourceKeyFor(method, resource) };
}

export async function answerHistory(request: NextRequest): Promise<NextResponse> {
  try {
    const { resource, method, resourceKey } = checkHistoryRequest(await readJsonBody(request));

    const rows = await loadEndpointObservations(resourceKey);
    const history = summariseEndpointHistory(resourceKey, rows);

    return NextResponse.json({
      resource,
      resourceKey,
      method,
      observations: history.observations,
      firstObservedAt: history.firstObservedAt,
      lastObservedAt: history.lastObservedAt,
      // Stated rather than implied: below ten observations the quality engine
      // refuses to score, and so does this response.
      statisticalEvidenceAvailable: history.statisticalEvidenceAvailable,
      availability: {
        uptimePercent: history.metrics.uptimePercent,
        validResponsePercent: history.metrics.validResponsePercent,
      },
      latencyMs: {
        p50: history.metrics.latencyP50Ms,
        p95: history.metrics.latencyP95Ms,
        max: history.metrics.latencyMaxMs,
      },
      priceUsdc: {
        min: history.metrics.quotedPriceMinUsdc,
        median: history.metrics.quotedPriceMedianUsdc,
        max: history.metrics.quotedPriceMaxUsdc,
      },
      quality: {
        status: history.quality.status,
        confidenceLevel: history.quality.confidenceLevel,
        overallScore: history.quality.overallScore,
      },
      payee: {
        current: history.payToNow,
        stableSince: history.payToStableSince,
        distinctSeen: history.distinctPayTos,
      },
      changes: history.changes,
      note: history.observations === 0
        ? `${BRAND.name} has no observations of this endpoint yet. Ask for a verdict first - that probe is free and it is what starts the record.`
        : undefined,
    }, { headers: TRUST_API_HEADERS });
  } catch (error) {
    return trustApiError(error);
  }
}

/**
 * `select`'s request, as the selection engine takes it.
 * - `requesterWallet` belongs to the Trust API, not to the engine. Passed on,
 *   it made the engine refuse the whole request.
 * - An engine refusal becomes the Trust API's own 400, with its code. It used
 *   to surface as "cannot answer right now".
 * - On Arc mainnet the search defaults to Arc.
 */
export function checkSelectRequest(body: Record<string, unknown>, rail: TrustApiRail) {
  const { requesterWallet, ...fields } = body;
  if (rail === "testnets" && typeof requesterWallet === "string") {
    try {
      getAddress(requesterWallet);
    } catch {
      throw new TrustApiError("requester_wallet_invalid", 400, "`requesterWallet` must be an EVM address.");
    }
  }
  try {
    return validateMarketplaceSelectionRequest(
      rail === "arc" && fields.network === undefined ? { ...fields, network: ARC_MAINNET_NETWORK } : fields,
    );
  } catch (error) {
    if (error instanceof CounterpartySelectionError) {
      throw new TrustApiError(error.code, error.status, `The selection request was refused: ${error.code}.`);
    }
    throw error;
  }
}

export async function answerSelect(request: NextRequest, payer: string | null, rail: TrustApiRail): Promise<NextResponse> {
  try {
    const body = await readJsonBody(request);
    const onArc = rail === "arc";
    const wallet = payer ?? (!onArc && typeof body.requesterWallet === "string" ? body.requesterWallet : null);

    let requesterWallet: `0x${string}`;
    try {
      requesterWallet = wallet ? getAddress(wallet) : zeroAddress;
    } catch {
      throw new TrustApiError("requester_wallet_invalid", 400, "`requesterWallet` must be an EVM address.");
    }

    const selection = await selectMarketplaceCounterparty({
      request: checkSelectRequest(body, rail),
      tenant: {
        tenantKey: `x402:${requesterWallet.toLowerCase()}`,
        requesterWallet,
      },
      // A clearance names the wallet it authorizes. Without a payer there is
      // nobody to authorize, so the ranking is returned unsigned rather than
      // signed to nobody. On Arc mainnet there is no TrustGate to verify one.
      issueClearance: !onArc && requesterWallet !== zeroAddress && attesterConfigured(),
    });

    return NextResponse.json({
      selection,
      note: onArc
        ? "No clearance is signed on Arc mainnet: the TrustGate that verifies one exists on Arc Testnet only."
        : requesterWallet === zeroAddress
          ? "No payer wallet was identified, so this selection is unsigned. Pay from the wallet that will spend, or send `requesterWallet`, to receive a clearance."
          : undefined,
    }, { headers: TRUST_API_HEADERS });
  } catch (error) {
    return trustApiError(error);
  }
}
