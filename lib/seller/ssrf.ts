/**
 * Copyright 2026 Circle Internet Group, Inc.  All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as dns } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { isTransientNetworkError, toErrorMessage } from "../agent/fetch-with-retry.ts";

export class SSRFProtectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SSRFProtectionError";
  }
}

export class ResponseSizeLimitExceededError extends Error {
  constructor(readonly maxBytes: number) {
    super(`SSRF protection: response size exceeded the limit of ${maxBytes} bytes`);
    this.name = "ResponseSizeLimitExceededError";
  }
}

export type SsrfFetchOptions = {
  maxTimeoutMs?: number;
  maxResponseSizeBytes?: number;
  allowLocalhostForTesting?: boolean;
  allowedHeaders?: string[];
  label?: string;
  pinnedResolvedIps?: string[];
  onDnsResolved?: (ips: string[]) => void;
};

type SellerRequestAdapter = (
  url: URL,
  init: RequestInit,
  pinnedIp: string,
  limits: { timeoutMs: number; maxSizeBytes: number },
) => Promise<Response>;

let testRequestAdapter: SellerRequestAdapter | null = null;

export function setSellerRequestAdapterForTests(adapter: SellerRequestAdapter | null) {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Seller request adapter overrides are test-only.");
  }
  testRequestAdapter = adapter;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_SIZE_BYTES = 1_048_576; // 1 MB
const ALLOWED_OUTGOING_HEADERS = new Set([
  "content-type",
  "accept",
  "user-agent",
  "payment-signature",
  "x-agent-commerce-request-id",
  "x-agent-commerce-verify-nonce",
]);

/**
 * Checks if an IP address is inside restricted ranges:
 * - Loopback / localhost (127.0.0.0/8, ::1)
 * - Link-local (169.254.0.0/16, fe80::/10)
 * - Cloud metadata (169.254.169.254, 100.100.100.200, fd00:ec2::254)
 * - Private IPv4 (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 0.0.0.0/8)
 * - Private IPv6 (fc00::/7)
 */
export function isRestrictedIpAddress(ip: string, allowLocalhost = false): boolean {
  const normalized = ip.toLowerCase().trim();

  // Strip IPv4-mapped IPv6 prefix ::ffff: if present
  const cleanIp = normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized;

  if (allowLocalhost) {
    if (
      cleanIp === "127.0.0.1" ||
      cleanIp === "localhost" ||
      cleanIp === "::1" ||
      cleanIp.startsWith("127.")
    ) {
      return false;
    }
  }

  // Range prefix checks below are valid only for literal IP addresses. Applying
  // them to hostnames caused false positives such as fdic.gov and ffmpeg.org.
  if (cleanIp !== "localhost" && isIP(cleanIp) === 0) return false;

  // Loopback / 0.0.0.0 / localhost
  if (
    cleanIp === "localhost" || cleanIp === "0.0.0.0" || cleanIp.startsWith("0.") ||
    cleanIp.startsWith("127.") || cleanIp === "::" || cleanIp === "::1" ||
    cleanIp === "0:0:0:0:0:0:0:0" || cleanIp === "0:0:0:0:0:0:0:1"
  ) {
    return true;
  }

  // Metadata endpoints
  if (
    cleanIp === "169.254.169.254" ||
    cleanIp === "100.100.100.200" ||
    cleanIp === "fd00:ec2::254"
  ) {
    return true;
  }

  // Link-local
  if (cleanIp.startsWith("169.254.") || cleanIp.startsWith("fe80:")) {
    return true;
  }

  if (/^fe[89ab][0-9a-f]:/i.test(cleanIp)) {
    return true;
  }

  // Private IPv4: 10.0.0.0/8
  if (cleanIp.startsWith("10.")) {
    return true;
  }

  // Private IPv4: 192.168.0.0/16
  if (cleanIp.startsWith("192.168.")) {
    return true;
  }

  // Private IPv4: 172.16.0.0/12
  if (cleanIp.startsWith("172.")) {
    const parts = cleanIp.split(".");
    if (parts.length >= 2) {
      const second = Number(parts[1]);
      if (second >= 16 && second <= 31) {
        return true;
      }
    }
  }

  // Carrier-grade NAT, benchmark, multicast, and reserved IPv4 ranges must
  // never be used as seller egress targets.
  const ipv4 = cleanIp.split(".").map(Number);
  if (ipv4.length === 4 && ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    const [first, second] = ipv4;
    if (
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 198 && (second === 18 || second === 19)) ||
      first >= 224
    ) return true;
  }

  // Private IPv6: Unique Local Address (ULA) fc00::/7 (fc00 - fdff)
  if (cleanIp.startsWith("fc") || cleanIp.startsWith("fd")) {
    return true;
  }

  if (cleanIp.startsWith("ff")) return true;

  return false;
}

/**
 * Validates target URL against strict SSRF rules before connection or DNS lookup.
 */
export function validateUrlSsrf(
  inputUrl: string,
  options: { allowLocalhost?: boolean } = {},
): URL {
  let url: URL;
  try {
    url = new URL(inputUrl);
  } catch {
    throw new SSRFProtectionError(`SSRF protection: invalid target URL "${inputUrl}"`);
  }

  const allowLocal =
    options.allowLocalhost ??
    (process.env.ALLOW_LOCAL_SSRF === "true" || process.env.NODE_ENV === "test");

  if (url.protocol !== "https:" && !(allowLocal && url.protocol === "http:")) {
    throw new SSRFProtectionError(
      `SSRF protection: only HTTPS URLs are allowed. Got protocol "${url.protocol}" for host "${url.hostname}"`,
    );
  }

  const hostname = url.hostname.toLowerCase();

  // Block obvious metadata domains
  if (
    hostname === "metadata.google.internal" ||
    hostname.includes("169.254.169.254") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".vercel-internal.com") ||
    hostname === "host.docker.internal" ||
    hostname === "kubernetes.default" ||
    hostname.endsWith(".svc.cluster.local")
  ) {
    throw new SSRFProtectionError(
      `SSRF protection: forbidden metadata or internal hostname "${hostname}"`,
    );
  }

  // Check if hostname itself is a restricted literal IP
  if (isIP(hostname) !== 0 && isRestrictedIpAddress(hostname, allowLocal)) {
    throw new SSRFProtectionError(
      `SSRF protection: target hostname "${hostname}" resolves or matches a restricted IP range`,
    );
  }

  return url;
}

/**
 * Resolves all DNS records for a hostname and verifies none point to restricted IP ranges.
 * This prevents DNS rebinding attacks and domain names pointing to private IPs.
 */
export async function verifyDnsSsrf(
  hostname: string,
  options: { allowLocalhost?: boolean; pinnedResolvedIps?: string[] } = {},
): Promise<string[]> {
  const allowLocal =
    options.allowLocalhost ??
    (process.env.ALLOW_LOCAL_SSRF === "true" || process.env.NODE_ENV === "test");

  // If hostname is already an IP, we already checked it in validateUrlSsrf
  if (/^[\d.]+$/.test(hostname) || hostname.includes(":")) {
    const cleanIp = hostname.toLowerCase().trim();
    if (options.pinnedResolvedIps && options.pinnedResolvedIps.length > 0) {
      if (!options.pinnedResolvedIps.includes(cleanIp)) {
        throw new SSRFProtectionError("SSRF protection: DNS rebinding detected");
      }
    }
    return [cleanIp];
  }

  try {
    const records = await dns.lookup(hostname, { all: true });
    if (!records || records.length === 0) {
      throw new SSRFProtectionError(`SSRF protection: DNS resolution returned no records for "${hostname}"`);
    }

    const resolvedIps: string[] = [];
    for (const record of records) {
      if (isRestrictedIpAddress(record.address, allowLocal)) {
        throw new SSRFProtectionError(
          `SSRF protection: hostname "${hostname}" resolved to restricted IP address "${record.address}" (${record.family === 6 ? "IPv6" : "IPv4"})`,
        );
      }
      resolvedIps.push(record.address.toLowerCase().trim());
    }

    if (options.pinnedResolvedIps && options.pinnedResolvedIps.length > 0) {
      const hasMatch = resolvedIps.some((ip) => options.pinnedResolvedIps!.includes(ip));
      if (!hasMatch) {
        throw new SSRFProtectionError("SSRF protection: DNS rebinding detected");
      }
    }

    return resolvedIps;
  } catch (error) {
    if (error instanceof SSRFProtectionError) {
      throw error;
    }
    const msg = toErrorMessage(error);
    throw new SSRFProtectionError(`SSRF protection: DNS lookup failed for "${hostname}": ${msg}`);
  }
}

/**
 * Filters incoming headers to only allow safe request headers.
 */
export function filterSafeHeaders(
  headers?: HeadersInit,
  customAllowed?: string[],
): Record<string, string> {
  if (!headers) return {};

  const allowedSet = customAllowed
    ? new Set([...ALLOWED_OUTGOING_HEADERS, ...customAllowed.map((h) => h.toLowerCase())])
    : ALLOWED_OUTGOING_HEADERS;

  const result: Record<string, string> = {};

  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      if (allowedSet.has(key.toLowerCase())) {
        result[key] = value;
      }
    });
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      if (allowedSet.has(key.toLowerCase())) {
        result[key] = value;
      }
    }
  } else {
    for (const [key, value] of Object.entries(headers)) {
      if (allowedSet.has(key.toLowerCase()) && value !== undefined) {
        result[key] = String(value);
      }
    }
  }

  return result;
}

function headersFromIncoming(headers: http.IncomingHttpHeaders) {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, item);
    } else if (value !== undefined) {
      result.set(name, value);
    }
  }
  return result;
}

/**
 * Returns only the address that passed the request-scoped SSRF checks. Node 22
 * enables family auto-selection for HTTPS requests and asks custom lookup
 * functions for `all` addresses. Supplying the legacy single-address callback
 * shape in that case makes Node discard the value and fail with
 * `Invalid IP address: undefined` before opening the socket.
 */
export function createPinnedAddressLookup(pinnedIp: string): LookupFunction {
  const family = isIP(pinnedIp);
  if (family !== 4 && family !== 6) {
    throw new SSRFProtectionError("SSRF protection: validated address is not a literal IP");
  }

  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address: pinnedIp, family }]);
      return;
    }
    callback(null, pinnedIp, family);
  };
}

/**
 * Opens the socket to the already validated IP while retaining the registered
 * hostname for Host/SNI certificate validation. Node's request API never follows
 * redirects, so the same request-scoped transport protects preflight and payment.
 */
async function requestPinnedAddress(
  url: URL,
  init: RequestInit,
  pinnedIp: string,
  limits: { timeoutMs: number; maxSizeBytes: number },
): Promise<Response> {
  const body = init.body;
  if (body !== undefined && body !== null && typeof body !== "string" && !Buffer.isBuffer(body)) {
    throw new SSRFProtectionError("SSRF protection: external seller request body must be buffered text or bytes");
  }

  return new Promise<Response>((resolve, reject) => {
    const requester = url.protocol === "https:" ? https.request : http.request;
    const request = requester(url, {
      method: init.method ?? "GET",
      headers: init.headers as http.OutgoingHttpHeaders,
      servername: url.hostname,
      lookup: createPinnedAddressLookup(pinnedIp),
    }, (response) => {
      if ((response.statusCode ?? 0) >= 300 && (response.statusCode ?? 0) < 400) {
        response.resume();
        reject(new SSRFProtectionError("SSRF protection: redirects are strictly forbidden for external seller fulfillment"));
        return;
      }

      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > limits.maxSizeBytes) {
          request.destroy(new ResponseSizeLimitExceededError(limits.maxSizeBytes));
          return;
        }
        chunks.push(bytes);
      });
      response.on("end", () => {
        const status = response.statusCode ?? 502;
        const responseBody =
          status === 204 || status === 205 || status === 304
            ? null
            : Buffer.concat(chunks);
        resolve(new Response(responseBody, {
          status,
          statusText: response.statusMessage,
          headers: headersFromIncoming(response.headers),
        }));
      });
      response.on("error", reject);
    });

    const onAbort = () => request.destroy(new Error(toErrorMessage(init.signal?.reason ?? "Request aborted")));
    if (init.signal) {
      if (init.signal.aborted) {
        onAbort();
        return;
      }
      init.signal.addEventListener("abort", onAbort, { once: true });
    }
    request.setTimeout(limits.timeoutMs, () => {
      request.destroy(new Error(`SSRF protection: request timed out after ${limits.timeoutMs}ms`));
    });
    request.on("error", reject);
    request.on("close", () => init.signal?.removeEventListener("abort", onAbort));
    if (body !== undefined && body !== null) request.write(body);
    request.end();
  });
}

/**
 * Executes an HTTP fetch request with comprehensive SSRF protection, strict timeout,
 * forbidden redirects, and response size limiting.
 */
export async function fetchWithSsrfProtection(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: SsrfFetchOptions = {},
): Promise<Response> {
  const inputUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const allowLocal =
    options.allowLocalhostForTesting ??
    (process.env.ALLOW_LOCAL_SSRF === "true" || process.env.NODE_ENV === "test");

  // Step 1: Validate URL protocol, hostname rules, and literal IP restrictions
  const validatedUrl = validateUrlSsrf(inputUrl, { allowLocalhost: allowLocal });

  if (process.env.NODE_ENV !== "test" && !options.allowLocalhostForTesting && validatedUrl.protocol !== "https:") {
    throw new SSRFProtectionError("SSRF protection: HTTPS required in production");
  }

  // Step 2: Verify DNS resolution against private / restricted IPs
  const resolvedIps = await verifyDnsSsrf(validatedUrl.hostname, {
    allowLocalhost: allowLocal,
    pinnedResolvedIps: options.pinnedResolvedIps,
  });
  if (options.onDnsResolved) {
    options.onDnsResolved(resolvedIps);
  }

  // Step 3: Filter headers to safe allowlist
  const safeHeaders = filterSafeHeaders(init.headers, options.allowedHeaders);

  const timeoutMs = options.maxTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxSizeBytes = options.maxResponseSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
  const controller = new AbortController();

  const timeoutId = setTimeout(() => {
    controller.abort(new Error(`SSRF protection: request timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  // Merge a caller abort into the request-local timeout controller.
  if (init.signal) {
    if (init.signal.aborted) {
      clearTimeout(timeoutId);
      throw new Error(toErrorMessage(init.signal.reason));
    }
    const abortListener = () => controller.abort(init.signal?.reason);
    init.signal.addEventListener("abort", abortListener, { once: true });
  }

  try {
    const pinnedIp = options.pinnedResolvedIps?.find((ip) => resolvedIps.includes(ip)) ?? resolvedIps[0];
    if (!pinnedIp) {
      throw new SSRFProtectionError("SSRF protection: no validated address available for connection");
    }
    const adapter = process.env.NODE_ENV === "test" && testRequestAdapter
      ? testRequestAdapter
      : requestPinnedAddress;
    const response = await adapter(validatedUrl, {
      ...init,
      headers: safeHeaders,
      signal: controller.signal,
      redirect: "manual",
    }, pinnedIp, { timeoutMs, maxSizeBytes });

    // Check for redirects
    if (
      response.type === "opaqueredirect" ||
      (response.status >= 300 && response.status < 400 && response.headers.has("location"))
    ) {
      const location = response.headers.get("location") ?? "unknown";
      throw new SSRFProtectionError(
        `SSRF protection: redirects are strictly forbidden for external seller fulfillment. Endpoint attempted redirect to "${location}"`,
      );
    }

    return response;
  } catch (error) {
    if (error instanceof SSRFProtectionError || error instanceof ResponseSizeLimitExceededError) {
      throw error;
    }
    const message = toErrorMessage(error);
    if (message.includes("redirect")) {
      throw new SSRFProtectionError(`SSRF protection: redirect forbidden or fetch failed: ${message}`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
