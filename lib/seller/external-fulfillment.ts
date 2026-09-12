/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from "node:crypto";
import { parseUnits } from "viem";
import type { ApiService } from "../services/registry.ts";

export const ARC_TESTNET_NETWORK = "eip155:5042002";
export const ARC_TESTNET_USDC = "0x3600000000000000000000000000000000000000";
export const ARC_TESTNET_GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
const MAX_GATEWAY_TIMEOUT_SECONDS = 604_900;

export class ExternalPaymentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExternalPaymentValidationError";
  }
}

export type ExternalPaymentAcceptance = {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
};

export type ExternalChallengeSummary = {
  x402Version: number;
  resource: { url: string; description: string; mimeType: string };
  acceptsCount: number;
  selectedAccept: ExternalPaymentAcceptance;
};

function decodeBase64Json(value: string): unknown | null {
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf-8"));
  } catch {
    return null;
  }
}

function parseAcceptance(value: unknown): ExternalPaymentAcceptance | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const accept = value as Record<string, unknown>;
  if (
    typeof accept.scheme !== "string" ||
    typeof accept.network !== "string" ||
    typeof accept.asset !== "string" ||
    typeof accept.amount !== "string" ||
    typeof accept.payTo !== "string" ||
    typeof accept.maxTimeoutSeconds !== "number" ||
    !Number.isInteger(accept.maxTimeoutSeconds) ||
    !accept.extra ||
    typeof accept.extra !== "object" ||
    Array.isArray(accept.extra)
  ) return null;
  return {
    scheme: accept.scheme,
    network: accept.network,
    asset: accept.asset,
    amount: accept.amount,
    payTo: accept.payTo,
    maxTimeoutSeconds: accept.maxTimeoutSeconds,
    extra: accept.extra as Record<string, unknown>,
  };
}

export function parsePaymentRequiredChallenge(
  headerValue: string | null | undefined,
): ExternalChallengeSummary | null {
  if (!headerValue) return null;
  const decoded = decodeBase64Json(headerValue);
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
  const challenge = decoded as Record<string, unknown>;
  const resource = challenge.resource;
  const accepts = challenge.accepts;
  if (
    (challenge.x402Version !== 1 && challenge.x402Version !== 2) ||
    !resource ||
    typeof resource !== "object" ||
    Array.isArray(resource) ||
    typeof (resource as Record<string, unknown>).url !== "string" ||
    typeof (resource as Record<string, unknown>).description !== "string" ||
    !(resource as Record<string, unknown>).description ||
    typeof (resource as Record<string, unknown>).mimeType !== "string" ||
    !(resource as Record<string, unknown>).mimeType ||
    !Array.isArray(accepts) ||
    accepts.length !== 1
  ) return null;
  const selectedAccept = parseAcceptance(accepts[0]);
  if (!selectedAccept) return null;
  return {
    x402Version: challenge.x402Version,
    resource: {
      url: (resource as Record<string, unknown>).url as string,
      description: (resource as Record<string, unknown>).description as string,
      mimeType: (resource as Record<string, unknown>).mimeType as string,
    },
    acceptsCount: accepts.length,
    selectedAccept,
  };
}

function normalizedResourceUrl(input: string) {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ExternalPaymentValidationError(`Invalid resource URL format: "${input}".`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ExternalPaymentValidationError(`Unsupported resource URL protocol: "${url.protocol}".`);
  }
  if (url.username || url.password || url.hash) {
    throw new ExternalPaymentValidationError("Resource URL credentials and fragments are forbidden.");
  }
  const effectivePort = url.port || (url.protocol === "https:" ? "443" : "80");
  const query = [...url.searchParams.entries()]
    .sort(([aKey, aValue], [bKey, bValue]) => aKey.localeCompare(bKey) || aValue.localeCompare(bValue))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  return {
    protocol: url.protocol.toLowerCase(),
    hostname: url.hostname.toLowerCase(),
    port: effectivePort,
    pathname: url.pathname || "/",
    query,
  };
}

function assertFullResourceUrl(actual: string, expected: string) {
  const actualUrl = normalizedResourceUrl(actual);
  const expectedUrl = normalizedResourceUrl(expected);
  if (
    actualUrl.protocol !== expectedUrl.protocol ||
    actualUrl.hostname !== expectedUrl.hostname ||
    actualUrl.port !== expectedUrl.port ||
    actualUrl.pathname !== expectedUrl.pathname ||
    actualUrl.query !== expectedUrl.query
  ) {
    throw new ExternalPaymentValidationError(
      `Resource URL mismatch: challenge "${actual}" does not match registered fulfillment URL "${expected}".`,
    );
  }
}

export type ValidateChallengeInput = {
  service: ApiService;
  status: number;
  paymentRequiredHeader?: string | null;
  fulfillmentUrl: string;
};

/** Validates the single exact acceptance that will be signed and submitted. */
export function validateExternal402Challenge({
  service,
  status,
  paymentRequiredHeader,
  fulfillmentUrl,
}: ValidateChallengeInput): ExternalChallengeSummary {
  if (status !== 402) {
    throw new ExternalPaymentValidationError(
      `Expected HTTP 402 Payment Required from external seller endpoint "${fulfillmentUrl}", but received status ${status}.`,
    );
  }
  if (!paymentRequiredHeader) {
    throw new ExternalPaymentValidationError(
      `External seller endpoint "${fulfillmentUrl}" returned HTTP 402 without PAYMENT-REQUIRED.`,
    );
  }

  const summary = parsePaymentRequiredChallenge(paymentRequiredHeader);
  if (!summary) {
    throw new ExternalPaymentValidationError(
      "PAYMENT-REQUIRED must contain a complete resource and exactly one complete, supported acceptance.",
    );
  }
  const acceptance = summary.selectedAccept;
  if (acceptance.scheme.toLowerCase() !== "exact") {
    throw new ExternalPaymentValidationError(`Unauthorized x402 scheme: "${acceptance.scheme}".`);
  }
  if (service.expectedNetwork !== ARC_TESTNET_NETWORK || acceptance.network !== ARC_TESTNET_NETWORK) {
    throw new ExternalPaymentValidationError(
      `Unauthorized network in x402 challenge: expected "${ARC_TESTNET_NETWORK}", got "${acceptance.network}".`,
    );
  }
  if (
    service.expectedAsset?.toLowerCase() !== ARC_TESTNET_USDC.toLowerCase() ||
    acceptance.asset.toLowerCase() !== ARC_TESTNET_USDC.toLowerCase()
  ) {
    throw new ExternalPaymentValidationError(
      `Unauthorized asset in x402 challenge: expected Arc Testnet USDC "${ARC_TESTNET_USDC}".`,
    );
  }
  const registeredWallet = service.sellerWallet ?? "";
  if (!/^0x[a-fA-F0-9]{40}$/.test(acceptance.payTo) || acceptance.payTo.toLowerCase() !== registeredWallet.toLowerCase()) {
    throw new ExternalPaymentValidationError(
      `Unauthorized payTo wallet in x402 challenge: expected registered seller wallet "${registeredWallet}".`,
    );
  }
  const quoteAtomic = parseUnits(String(service.priceUsd), 6);
  if (!/^\d+$/.test(acceptance.amount) || BigInt(acceptance.amount) !== quoteAtomic) {
    throw new ExternalPaymentValidationError(
      `Price quote mismatch: expected exactly ${quoteAtomic} atomic USDC units, got "${acceptance.amount}".`,
    );
  }
  if (acceptance.maxTimeoutSeconds < 1 || acceptance.maxTimeoutSeconds > MAX_GATEWAY_TIMEOUT_SECONDS) {
    throw new ExternalPaymentValidationError("Unsupported acceptance timeout.");
  }
  if (
    acceptance.extra.name !== "GatewayWalletBatched" ||
    acceptance.extra.version !== "1" ||
    typeof acceptance.extra.verifyingContract !== "string" ||
    acceptance.extra.verifyingContract.toLowerCase() !== ARC_TESTNET_GATEWAY_WALLET.toLowerCase()
  ) {
    throw new ExternalPaymentValidationError("Unsupported or ambiguous Gateway acceptance metadata.");
  }
  assertFullResourceUrl(summary.resource.url, fulfillmentUrl);
  return summary;
}

export function hashChallenge(header: string): string {
  return createHash("sha256").update(header).digest("hex");
}
