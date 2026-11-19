/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import { isAddress, zeroAddress } from "viem";
import { readCircleCatalogue } from "../../discovery/catalogues.ts";
import { ARC_MAINNET_NETWORK, ARC_MAINNET_USDC_ADDRESS } from "../../wallet/arc.ts";
import {
  normalizeResourceUrl,
  parseProbeMethod,
  readAccept,
  readX402Challenge,
  selectBaselineAccept,
  TrustApiError,
  type ObservedAccept,
  type ProbeMethod,
} from "./resource.ts";

const METHOD_CACHE_MS = 5 * 60_000;
const CATALOGUE_TIMEOUT_MS = 3_500;
type MethodSnapshot = {
  expiresAt: number;
  methods: Promise<Map<string, Set<ProbeMethod>>>;
};
let methodSnapshot: MethodSnapshot | undefined;

/** Share one bounded read per instance. No caller URL is sent to the catalogue. */
async function circleMethod(resource: string): Promise<ProbeMethod | null> {
  if (!methodSnapshot || methodSnapshot.expiresAt <= Date.now()) {
    const deadline = AbortSignal.timeout(CATALOGUE_TIMEOUT_MS);
    const methods = readCircleCatalogue({
      networks: [ARC_MAINNET_NETWORK],
      fetchImpl: (url, init) => fetch(url, {
        ...init,
        signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
      }),
    }).then(({ offers }) => {
      const byResource = new Map<string, Set<ProbeMethod>>();
      for (const offer of offers) {
        let key: string;
        try {
          key = normalizeResourceUrl(offer.resource);
        } catch (error) {
          if (error instanceof TrustApiError) continue;
          throw error;
        }
        const methodsForResource = byResource.get(key) ?? new Set<ProbeMethod>();
        methodsForResource.add(offer.method);
        byResource.set(key, methodsForResource);
      }
      return byResource;
    }).catch(() => new Map<string, Set<ProbeMethod>>());
    methodSnapshot = { expiresAt: Date.now() + METHOD_CACHE_MS, methods };
  }
  const methods = (await methodSnapshot.methods).get(resource);
  return methods?.size === 1 ? [...methods][0] : null;
}

function isArcPaymentOption(accept: ObservedAccept): boolean {
  return accept.network.toLowerCase() === ARC_MAINNET_NETWORK
    && accept.asset.toLowerCase() === ARC_MAINNET_USDC_ADDRESS
    && accept.scheme === "exact"
    && accept.priceUsdc !== null
    && isAddress(accept.payTo)
    && accept.payTo.toLowerCase() !== zeroAddress;
}

/** Constrain the scored probe as well as the initial read. A different asset on
 * the same chain must never supply the USDC price, even for the same payee. */
export function arcPaymentOptions(accepts: Record<string, unknown>[]): Record<string, unknown>[] {
  return accepts
    .map((raw) => ({ raw, accept: readAccept(raw) }))
    .filter(({ accept }) => isArcPaymentOption(accept))
    .sort((a, b) => (a.accept.priceUsdc ?? 0) - (b.accept.priceUsdc ?? 0))
    .map(({ raw }) => raw);
}

export async function readPublicArcChallenge(input: {
  resource: string;
  method?: unknown;
  lookupMethod?: (resource: string) => Promise<ProbeMethod | null>;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}): Promise<{ method: ProbeMethod; accept: ObservedAccept; docsUrl: string | null }> {
  if (!input.resource.startsWith("https://")) {
    throw new TrustApiError("resource_scheme_unsupported", 400, "Use an HTTPS resource URL.");
  }
  const explicit = input.method !== undefined && input.method !== null;
  if (explicit && typeof input.method !== "string") {
    throw new TrustApiError("method_unsupported");
  }
  const preferred = explicit
    ? parseProbeMethod(input.method)
    : (await (input.lookupMethod ?? circleMethod)(input.resource)) ?? "POST";
  const methods: ProbeMethod[] = explicit
    ? [preferred]
    : [preferred, preferred === "POST" ? "GET" : "POST"];

  let reachable = false;
  let offeredPayment = false;
  for (const method of methods) {
    const challenge = await readX402Challenge(input.resource, method, input.fetchImpl);
    reachable ||= challenge.httpStatus !== null;
    if (challenge.httpStatus !== 402) continue;
    offeredPayment ||= challenge.accepts.length > 0;
    const accept = selectBaselineAccept(challenge.accepts.filter(isArcPaymentOption));
    if (accept) return { method, accept, docsUrl: challenge.docsUrl };
  }
  if (!reachable) {
    throw new TrustApiError("endpoint_unreachable", 502, "The endpoint did not answer.");
  }
  if (offeredPayment) {
    throw new TrustApiError("arc_mainnet_not_offered", 422,
      "The endpoint offered no usable Arc mainnet USDC option in its live x402 challenge.");
  }
  throw new TrustApiError("no_payable_challenge", 422,
    "The endpoint published no readable HTTP 402 challenge for the method checked.");
}
