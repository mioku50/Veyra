/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from "node:crypto";
import { BatchFacilitatorClient } from "@circle-fin/x402-batching/server";
import { NextResponse, type NextRequest } from "next/server";
import { BRAND } from "../../brand.ts";
import { getByoaClient } from "../../byoa/service.ts";
import { CREDIT_HEADER, isCreditTokenShaped, redeemCredit } from "./credits.ts";
import { TRUST_API_DOCS_PATH } from "./pricing.ts";

/**
 * Veyra as an x402 resource server.
 *
 * The existing `withGateway` wrapper hardwires one price on one network, which
 * is correct for the demo endpoints it serves and wrong for a product sold to
 * agents that hold their balance wherever they hold it. This wrapper advertises
 * every network Circle's facilitator will actually settle on, asked at runtime
 * rather than hardcoded, so a chain Circle adds becomes payable here without a
 * deploy — and a chain it removes stops being advertised, instead of being
 * offered and then failing.
 */

const GATEWAY_URL = process.env.VEYRA_X402_GATEWAY_URL
  ?? "https://gateway-api-testnet.circle.com";

const facilitator = new BatchFacilitatorClient({ url: GATEWAY_URL });

/** Circle's batched authorizations must stay valid long enough to be batched. */
const BATCHED_MAX_TIMEOUT_SECONDS = 604_900;

const SUPPORTED_TTL_MS = 10 * 60 * 1000;

export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
export const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
export const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";

export type TrustApiRequirement = {
  scheme: "exact";
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  /* Where x402 carries the schemas, despite the name: `.input` describes the
     request and `.output` the response. Buyers read it from the challenge, and
     Veyra's own probe scores an endpoint that omits it. */
  outputSchema?: { input: { body: unknown }; output: { body: unknown } };
  extra: Record<string, unknown>;
};

type SupportedCache = { at: number; kinds: Array<{ network: string; extra?: Record<string, unknown> }> };
let supportedCache: SupportedCache | null = null;

function payoutAddress(): string | null {
  const address = process.env.VEYRA_TRUST_API_PAY_TO || process.env.SELLER_ADDRESS || "";
  return /^0x[0-9a-fA-F]{40}$/.test(address) ? address : null;
}

/** Networks the operator is willing to be paid on, when they want to narrow it. */
function allowedNetworks(): Set<string> | null {
  const raw = process.env.VEYRA_TRUST_API_NETWORKS;
  if (!raw) return null;
  const entries = raw.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  return entries.length > 0 ? new Set(entries) : null;
}

async function supportedKinds() {
  if (supportedCache && Date.now() - supportedCache.at < SUPPORTED_TTL_MS) {
    return supportedCache.kinds;
  }
  const supported = await facilitator.getSupported();
  const kinds = (supported.kinds ?? [])
    .filter((kind) => kind.scheme === "exact" && typeof kind.network === "string")
    .map((kind) => ({ network: kind.network, extra: kind.extra }));
  supportedCache = { at: Date.now(), kinds };
  return kinds;
}

function usdcAtomic(priceUsdc: number): string {
  const atomic = Math.round(priceUsdc * 1_000_000);
  if (!Number.isSafeInteger(atomic) || atomic <= 0) {
    throw new Error("A positive USDC price with at most six decimals is required.");
  }
  return String(atomic);
}

/** One accept per network Circle will settle, priced identically. */
export async function buildTrustApiRequirements(
  priceUsdc: number,
  schema?: { input: unknown; output: unknown },
): Promise<TrustApiRequirement[]> {
  const payTo = payoutAddress();
  if (!payTo) return [];
  const amount = usdcAtomic(priceUsdc);
  const allowed = allowedNetworks();

  const requirements: TrustApiRequirement[] = [];
  for (const kind of await supportedKinds()) {
    if (allowed && !allowed.has(kind.network.toLowerCase())) continue;
    const extra = kind.extra ?? {};
    const assets = Array.isArray(extra.assets) ? extra.assets : [];
    const usdc = assets.find((asset): asset is { symbol?: string; address?: string } =>
      Boolean(asset) && typeof asset === "object"
      && String((asset as { symbol?: string }).symbol ?? "").toUpperCase() === "USDC");
    if (!usdc?.address) continue;
    requirements.push({
      scheme: "exact",
      network: kind.network,
      asset: usdc.address,
      amount,
      payTo,
      maxTimeoutSeconds: BATCHED_MAX_TIMEOUT_SECONDS,
      ...(schema ? { outputSchema: { input: { body: schema.input }, output: { body: schema.output } } } : {}),
      // Echo the facilitator's own domain data. Rebuilding it here is how a
      // resource server ends up advertising a verifying contract the
      // facilitator does not recognise.
      extra: {
        name: extra.name,
        version: extra.version,
        verifyingContract: extra.verifyingContract,
      },
    });
  }
  return requirements;
}

type PaidContext = {
  paidWith: "usdc" | "credit";
  payer: string | null;
  amountUsdc: number;
  network: string | null;
  transaction: string | null;
  requestId: string;
};

async function recordCall(input: {
  endpoint: string;
  context: PaidContext;
  creditId?: string | null;
}) {
  try {
    await getByoaClient().from("x402_trust_api_calls").insert({
      endpoint: input.endpoint,
      paid_with: input.context.paidWith,
      payer: input.context.payer,
      amount_usdc: input.context.amountUsdc,
      network: input.context.network,
      settlement_tx: input.context.transaction,
      credit_id: input.creditId ?? null,
      request_id: input.context.requestId,
    });
  } catch (error) {
    console.warn("x402_trust_api_call_not_recorded", {
      errorName: error instanceof Error ? error.name : "unknown_error",
    });
  }
}

function challengeResponse(input: {
  requirements: TrustApiRequirement[];
  resourceUrl: string;
  description: string;
  docsUrl: string;
  requestId: string;
  priceUsdc: number;
}) {
  const challenge = {
    x402Version: 2,
    resource: {
      url: input.resourceUrl,
      description: input.description,
      mimeType: "application/json",
      // Veyra's own machine-readable index of what it sells. `provider_documented`
      // is a check Veyra applies to others; publishing nothing here is how it
      // failed that check itself.
      docsUrl: input.docsUrl,
    },
    accepts: input.requirements,
  };
  return new NextResponse(JSON.stringify({
    error: "payment_required",
    message: input.description,
    priceUsdc: input.priceUsdc,
    // Repeated in the body so a client that reads neither the header nor the
    // spec still learns how to earn it for free.
    freeAlternative: {
      verdict: "/api/x402/v1/verdict",
      earnCredit: "/api/x402/v1/outcomes",
      creditHeader: CREDIT_HEADER,
    },
    accepts: input.requirements,
  }), {
    status: 402,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Veyra-Request-Id": input.requestId,
      [PAYMENT_REQUIRED_HEADER]: Buffer.from(JSON.stringify(challenge)).toString("base64"),
    },
  });
}

/**
 * Wraps a Trust API handler in payment.
 *
 * A caller holding a credit earned by reporting an outcome is served without a
 * challenge at all: the point of the credit is that reporting evidence is worth
 * more to Veyra than the call costs.
 */
export function withTrustApiPayment(
  handler: (request: NextRequest, context: PaidContext) => Promise<NextResponse>,
  options: {
    endpoint: string;
    priceUsdc: number;
    description: string;
    /** Published in the challenge so a buyer can build a valid request and
     *  check the answer, instead of guessing the shape and paying for a 400. */
    schema?: { input: unknown; output: unknown };
    /** Runs before any money moves. Returning a reason refuses the call with a
     *  503 instead of charging for something Veyra cannot currently deliver -
     *  a signature it has no attester key for, most of all. There is no refund
     *  in x402, so the only honest place to fail is before settlement. */
    preflight?: () => Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  },
) {
  return async (request: NextRequest): Promise<NextResponse> => {
    const requestId = randomUUID();
    const resourceUrl = new URL(options.endpoint, request.nextUrl.origin).toString();

    if (options.preflight) {
      const ready = await options.preflight();
      if (!ready.ok) {
        return NextResponse.json({
          error: ready.code,
          message: ready.message,
        }, { status: 503, headers: { "X-Veyra-Request-Id": requestId, "Cache-Control": "no-store" } });
      }
    }

    // 1. A credit spends before any money is asked for.
    const creditToken = request.headers.get(CREDIT_HEADER);
    if (creditToken && isCreditTokenShaped(creditToken)) {
      const redeemed = await redeemCredit(creditToken);
      if (redeemed) {
        const context: PaidContext = {
          paidWith: "credit",
          payer: null,
          amountUsdc: 0,
          network: null,
          transaction: null,
          requestId,
        };
        void recordCall({ endpoint: options.endpoint, context, creditId: redeemed.creditId });
        const response = await handler(request, context);
        response.headers.set("X-Veyra-Request-Id", requestId);
        response.headers.set("X-Veyra-Paid-With", "credit");
        return response;
      }
      return NextResponse.json({
        error: "credit_invalid",
        message: "That credit is unknown, already spent, or expired.",
      }, { status: 402, headers: { "X-Veyra-Request-Id": requestId } });
    }

    let requirements: TrustApiRequirement[];
    try {
      requirements = await buildTrustApiRequirements(options.priceUsdc, options.schema);
    } catch {
      requirements = [];
    }
    if (requirements.length === 0) {
      return NextResponse.json({
        error: "payments_unavailable",
        message: `${BRAND.name} cannot currently accept payment for this resource. The free verdict endpoint is unaffected.`,
      }, { status: 503, headers: { "X-Veyra-Request-Id": requestId } });
    }

    // 2. No payment presented: publish the challenge.
    const paymentHeader = request.headers.get(PAYMENT_SIGNATURE_HEADER)
      ?? request.headers.get("x-payment");
    if (!paymentHeader) {
      return challengeResponse({
        requirements,
        resourceUrl,
        description: options.description,
        requestId,
        priceUsdc: options.priceUsdc,
        docsUrl: new URL(TRUST_API_DOCS_PATH, request.nextUrl.origin).toString(),
      });
    }

    // 3. Verify and settle the rail the payer actually chose.
    let payload: {
      x402Version?: number;
      accepted?: Record<string, unknown>;
      payload?: Record<string, unknown>;
    };
    try {
      payload = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf-8"));
    } catch {
      return NextResponse.json({
        error: "payment_unparseable",
        message: "The payment header is not a base64 x402 payload.",
      }, { status: 400, headers: { "X-Veyra-Request-Id": requestId } });
    }

    const chosenNetwork = typeof payload.accepted?.network === "string"
      ? payload.accepted.network.toLowerCase()
      : null;
    const requirement = chosenNetwork
      ? requirements.find((item) => item.network.toLowerCase() === chosenNetwork)
      : requirements[0];
    if (!requirement) {
      return NextResponse.json({
        error: "payment_network_not_offered",
        message: "That payment names a network this resource did not offer.",
        accepts: requirements,
      }, { status: 402, headers: { "X-Veyra-Request-Id": requestId } });
    }

    try {
      const verified = await facilitator.verify(payload as never, requirement as never);
      if (!verified.isValid) {
        console.warn("x402_trust_api_verify_rejected", {
          requestId,
          endpoint: options.endpoint,
          reason: verified.invalidReason,
        });
        return NextResponse.json({
          error: "payment_invalid",
          reason: verified.invalidReason ?? "verification_failed",
        }, { status: 402, headers: { "X-Veyra-Request-Id": requestId } });
      }

      const settled = await facilitator.settle(payload as never, requirement as never);
      if (!settled.success) {
        return NextResponse.json({
          error: "payment_settlement_failed",
          reason: settled.errorReason ?? "settlement_failed",
        }, { status: 402, headers: { "X-Veyra-Request-Id": requestId } });
      }

      const context: PaidContext = {
        paidWith: "usdc",
        payer: settled.payer ?? verified.payer ?? null,
        amountUsdc: Number(requirement.amount) / 1_000_000,
        network: requirement.network,
        transaction: settled.transaction ?? null,
        requestId,
      };
      void recordCall({ endpoint: options.endpoint, context });

      const response = await handler(request, context);
      response.headers.set("X-Veyra-Request-Id", requestId);
      response.headers.set("X-Veyra-Paid-With", "usdc");
      response.headers.set(PAYMENT_RESPONSE_HEADER, Buffer.from(JSON.stringify({
        success: true,
        transaction: settled.transaction,
        network: requirement.network,
        payer: context.payer,
      })).toString("base64"));
      return response;
    } catch (error) {
      console.error("x402_trust_api_settlement_error", {
        requestId,
        endpoint: options.endpoint,
        errorName: error instanceof Error ? error.name : "unknown_error",
      });
      return NextResponse.json({
        error: "payment_processing_failed",
        message: "The payment could not be processed. Nothing was charged.",
      }, { status: 502, headers: { "X-Veyra-Request-Id": requestId } });
    }
  };
}
