/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { BatchEvmScheme } from "@circle-fin/x402-batching/client";
import { formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  fetchWithSsrfProtection,
  SSRFProtectionError,
  type SsrfFetchOptions,
} from "./ssrf.ts";
import {
  validateExternal402Challenge,
  ExternalPaymentValidationError,
  hashChallenge,
  type ExternalChallengeSummary,
} from "./external-fulfillment.ts";
import type { ApiService } from "../services/registry.ts";

export class ExternalProxyError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 502) {
    super(message);
    this.name = "ExternalProxyError";
    this.statusCode = statusCode;
  }
}

export type ProxyExecutionInput = {
  service: ApiService;
  method: "GET" | "POST";
  body?: unknown;
  headers?: Record<string, string>;
  payerPrivateKey?: string;
  /** Server-decrypted credential. It must never be populated from request headers. */
  trustedAuthorization?: string;
};

export type ProxyExecutionResult = {
  status: number;
  data: unknown;
  paidAmountUsdc?: string;
  downstreamTransaction?: string;
  paymentRequiredChallenge?: ExternalChallengeSummary;
  sourceType: "external_seller";
};

type PreparedRequestBase = {
  service: ApiService;
  method: "GET" | "POST";
  safeHeaders: Record<string, string>;
  serializedBody?: string;
  pinnedIps: string[];
  ssrfOptions: SsrfFetchOptions;
};

export type PreparedExternalSellerRequest = PreparedRequestBase & {
  kind: "payment-required";
  paymentRequiredHeader: string;
  challenge: ExternalChallengeSummary;
};

export type PreparedExternalSellerResult =
  | { kind: "free-response"; result: ProxyExecutionResult }
  | PreparedExternalSellerRequest;

export function getPlatformBuyerPrivateKey(override?: string): string | null {
  if (override?.trim()) return override.trim();
  const candidates = [
    process.env.HOSTED_AGENT_PRIVATE_KEY,
    process.env.BUYER_PRIVATE_KEY,
    process.env.AGENT_PRIVATE_KEY,
  ];
  for (const key of candidates) {
    if (key?.trim() && /^0x[a-fA-F0-9]{64}$/.test(key.trim())) return key.trim();
  }
  return null;
}

function safeRequestParts(input: ProxyExecutionInput) {
  const safeHeaders: Record<string, string> = { Accept: "application/json" };
  if (input.method === "POST") safeHeaders["Content-Type"] = "application/json";
  if (input.headers?.["x-agent-commerce-request-id"]) {
    safeHeaders["X-Agent-Commerce-Request-Id"] = input.headers["x-agent-commerce-request-id"];
  }
  if (input.trustedAuthorization) {
    safeHeaders.Authorization = input.trustedAuthorization;
  }
  const serializedBody = input.method === "POST" && input.body !== undefined
    ? typeof input.body === "string" ? input.body : JSON.stringify(input.body)
    : undefined;
  return { safeHeaders, serializedBody };
}

async function parseResponseData(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json" && !contentType?.endsWith("+json")) {
    throw new ExternalProxyError("External seller returned an unsupported content type.", 502);
  }
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new ExternalProxyError("External seller returned invalid JSON.", 502);
  }
}

function validateService(service: ApiService) {
  if (!service.fulfillmentUrl) {
    throw new ExternalProxyError(`Service "${service.slug}" has no fulfillmentUrl configured.`, 500);
  }
  if (!service.sellerWallet) {
    throw new ExternalProxyError(`Service "${service.slug}" has no registered sellerWallet configured.`, 500);
  }
}

/**
 * Performs the sole unpaid request. Paid listings must yield a valid 402 before
 * the caller is allowed to enter its own buyer-settlement wrapper.
 */
export async function prepareExternalSellerRequest(
  input: ProxyExecutionInput,
): Promise<PreparedExternalSellerResult> {
  validateService(input.service);
  const service = input.service;
  const fulfillmentUrl = service.fulfillmentUrl!;
  const { safeHeaders, serializedBody } = safeRequestParts(input);
  let pinnedIps: string[] = [];
  const ssrfOptions: SsrfFetchOptions = {
    maxResponseSizeBytes: service.maxResponseSizeBytes ?? 1_048_576,
    maxTimeoutMs: service.maxTimeoutMs ?? 15_000,
    onDnsResolved: (ips) => { pinnedIps = [...ips]; },
    ...(input.trustedAuthorization ? { allowedHeaders: ["authorization"] } : {}),
  };

  let response: Response;
  try {
    response = await fetchWithSsrfProtection(
      fulfillmentUrl,
      {
        method: input.method,
        headers: safeHeaders,
        ...(serializedBody !== undefined ? { body: serializedBody } : {}),
      },
      ssrfOptions,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ExternalProxyError(
      error instanceof SSRFProtectionError
        ? `External seller endpoint rejected due to security rules: ${message}`
        : `Failed to connect to external seller endpoint: ${message}`,
      502,
    );
  }

  if (response.status >= 200 && response.status < 300) {
    if (service.priceUsd !== 0) {
      throw new ExternalProxyError(
        "Paid external seller returned a direct success without x402; buyer settlement was not started.",
        502,
      );
    }
    return {
      kind: "free-response",
      result: {
        status: response.status,
        data: await parseResponseData(response),
        sourceType: "external_seller",
      },
    };
  }
  if (response.status !== 402) {
    throw new ExternalProxyError(
      `External seller endpoint returned unexpected HTTP status ${response.status}.`,
      response.status >= 400 && response.status < 600 ? response.status : 502,
    );
  }
  if (service.priceUsd === 0) {
    throw new ExternalProxyError("A free external listing unexpectedly required downstream payment.", 502);
  }

  const paymentRequiredHeader = response.headers.get("PAYMENT-REQUIRED");
  try {
    const challenge = validateExternal402Challenge({
      service,
      status: response.status,
      paymentRequiredHeader,
      fulfillmentUrl,
    });
    return {
      kind: "payment-required",
      service,
      method: input.method,
      safeHeaders,
      serializedBody,
      pinnedIps,
      ssrfOptions,
      paymentRequiredHeader: paymentRequiredHeader!,
      challenge,
    };
  } catch (error) {
    if (error instanceof ExternalPaymentValidationError) {
      throw new ExternalProxyError(
        `External seller 402 challenge failed security validation: ${error.message}`,
        502,
      );
    }
    throw error;
  }
}

function parsePaymentResponse(header: string | null) {
  if (!header) throw new ExternalProxyError("External seller omitted PAYMENT-RESPONSE after payment.", 502);
  try {
    const value = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as Record<string, unknown>;
    if (value.success !== true || typeof value.transaction !== "string" || !value.transaction) {
      throw new Error("missing successful transaction confirmation");
    }
    return value.transaction;
  } catch (error) {
    if (error instanceof ExternalProxyError) throw error;
    throw new ExternalProxyError("External seller returned an invalid PAYMENT-RESPONSE.", 502);
  }
}

/** Signs the exact prevalidated acceptance and submits it over the pinned transport. */
export async function executePreparedExternalSellerPayment(
  prepared: PreparedExternalSellerRequest,
  payerPrivateKey?: string,
): Promise<ProxyExecutionResult> {
  // Re-validate immutable listing fields and the exact acceptance immediately
  // before signing. No new challenge is fetched here.
  const challenge = validateExternal402Challenge({
    service: prepared.service,
    status: 402,
    paymentRequiredHeader: prepared.paymentRequiredHeader,
    fulfillmentUrl: prepared.service.fulfillmentUrl!,
  });
  const resolvedPrivateKey = getPlatformBuyerPrivateKey(payerPrivateKey);
  if (!resolvedPrivateKey) {
    throw new ExternalProxyError("Platform buyer agent private key is not configured to pay external sellers.", 500);
  }

  const signer = privateKeyToAccount(resolvedPrivateKey as `0x${string}`);
  const scheme = new BatchEvmScheme(signer);
  const payload = await scheme.createPaymentPayload(
    challenge.x402Version,
    challenge.selectedAccept,
  );
  const paymentSignature = Buffer.from(JSON.stringify({
    ...payload,
    resource: challenge.resource,
    accepted: challenge.selectedAccept,
  })).toString("base64");

  let paidResponse: Response;
  try {
    paidResponse = await fetchWithSsrfProtection(
      prepared.service.fulfillmentUrl!,
      {
        method: prepared.method,
        headers: { ...prepared.safeHeaders, "Payment-Signature": paymentSignature },
        ...(prepared.serializedBody !== undefined ? { body: prepared.serializedBody } : {}),
      },
      {
        ...prepared.ssrfOptions,
        pinnedResolvedIps: prepared.pinnedIps,
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ExternalProxyError(`Failed to submit protected external seller payment request: ${message}`, 502);
  }

  if (paidResponse.status === 402) {
    const actualHeader = paidResponse.headers.get("PAYMENT-REQUIRED");
    if (!actualHeader || hashChallenge(actualHeader) !== hashChallenge(prepared.paymentRequiredHeader)) {
      throw new ExternalProxyError("Actual payment challenge changed after preflight — aborting", 422);
    }
    throw new ExternalProxyError("External seller rejected the signed downstream payment.", 502);
  }
  if (!paidResponse.ok) {
    throw new ExternalProxyError(`External seller payment request failed with HTTP ${paidResponse.status}.`, 502);
  }

  const transaction = parsePaymentResponse(paidResponse.headers.get("PAYMENT-RESPONSE"));
  return {
    status: paidResponse.status,
    data: await parseResponseData(paidResponse),
    paidAmountUsdc: formatUnits(BigInt(challenge.selectedAccept.amount), 6),
    downstreamTransaction: transaction,
    paymentRequiredChallenge: challenge,
    sourceType: "external_seller",
  };
}

export async function executeExternalSellerProxy(input: ProxyExecutionInput): Promise<ProxyExecutionResult> {
  const prepared = await prepareExternalSellerRequest(input);
  if (prepared.kind === "free-response") return prepared.result;
  return executePreparedExternalSellerPayment(prepared, input.payerPrivateKey);
}
