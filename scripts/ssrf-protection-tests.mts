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

import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  isRestrictedIpAddress,
  validateUrlSsrf,
  verifyDnsSsrf,
  filterSafeHeaders,
  SSRFProtectionError,
  fetchWithSsrfProtection,
  setSellerRequestAdapterForTests,
  createPinnedAddressLookup,
} from "../lib/seller/ssrf.ts";

process.env.NODE_ENV = "test";

async function runTests() {
  console.log("Running SSRF protection tests...");

  // Test 1: Restricted IPs
  assert.equal(isRestrictedIpAddress("127.0.0.1"), true, "127.0.0.1 must be restricted");
  assert.equal(isRestrictedIpAddress("localhost"), true, "localhost must be restricted");
  assert.equal(isRestrictedIpAddress("10.0.1.50"), true, "10.0.1.50 must be restricted");
  assert.equal(isRestrictedIpAddress("192.168.1.1"), true, "192.168.1.1 must be restricted");
  assert.equal(isRestrictedIpAddress("172.16.0.1"), true, "172.16.0.1 must be restricted");
  assert.equal(isRestrictedIpAddress("169.254.169.254"), true, "169.254.169.254 metadata must be restricted");
  assert.equal(isRestrictedIpAddress("100.100.100.200"), true, "100.100.100.200 metadata must be restricted");
  assert.equal(isRestrictedIpAddress("100.64.0.1"), true, "carrier-grade NAT must be restricted");
  assert.equal(isRestrictedIpAddress("fe90::1"), true, "the full IPv6 link-local range must be restricted");
  assert.equal(isRestrictedIpAddress("0:0:0:0:0:0:0:1"), true, "expanded IPv6 loopback must be restricted");
  assert.equal(isRestrictedIpAddress("8.8.8.8"), false, "8.8.8.8 must not be restricted");
  assert.equal(isRestrictedIpAddress("ffmpeg.org"), false, "hostnames beginning with ff must not be treated as IPv6");
  assert.equal(isRestrictedIpAddress("fdic.gov"), false, "hostnames beginning with fd must not be treated as IPv6");
  assert.equal(isRestrictedIpAddress("fc-bayern.com"), false, "hostnames beginning with fc must not be treated as IPv6");
  assert.equal(isRestrictedIpAddress("127.0.0.1", true), false, "127.0.0.1 allowed when allowLocalhost is true");

  // Test 2: URL validation
  assert.throws(
    () => validateUrlSsrf("http://example.com", { allowLocalhost: false }),
    (err: unknown) => err instanceof SSRFProtectionError && err.message.includes("only HTTPS URLs are allowed"),
    "HTTP without local override must throw SSRFProtectionError",
  );

  assert.throws(
    () => validateUrlSsrf("https://169.254.169.254/latest/meta-data/"),
    (err: unknown) => err instanceof SSRFProtectionError && (err.message.includes("restricted IP range") || err.message.includes("forbidden metadata")),
    "Metadata IP must throw SSRFProtectionError",
  );

  assert.throws(
    () => validateUrlSsrf("https://metadata.google.internal/computeMetadata/v1/"),
    (err: unknown) => err instanceof SSRFProtectionError && err.message.includes("forbidden metadata"),
    "Metadata domain must throw SSRFProtectionError",
  );

  const validUrl = validateUrlSsrf("https://api.example.com/fulfillment");
  assert.equal(validUrl.hostname, "api.example.com");
  assert.equal(validateUrlSsrf("https://ffmpeg.org/").hostname, "ffmpeg.org");
  assert.equal(validateUrlSsrf("https://fdic.gov/").hostname, "fdic.gov");

  // Test 3: Safe header filtering
  const filtered = filterSafeHeaders({
    "Content-Type": "application/json",
    "Authorization": "Bearer secret-token",
    "Cookie": "session=secret",
    "Payment-Signature": "base64sig==",
  });
  assert.equal(filtered["Content-Type"], "application/json");
  assert.equal(filtered["Payment-Signature"], "base64sig==");
  assert.equal(filtered["Authorization"], undefined, "Authorization must be stripped");
  assert.equal(filtered["Cookie"], undefined, "Cookie must be stripped");

  // Test 4: Node 22 requests custom lookup results in both callback shapes.
  const pinnedLookup = createPinnedAddressLookup("203.0.113.8");
  pinnedLookup("seller.example", { all: false }, (error, address, family) => {
    assert.ifError(error);
    assert.equal(address, "203.0.113.8");
    assert.equal(family, 4);
  });
  pinnedLookup("seller.example", { all: true }, (error, addresses) => {
    assert.ifError(error);
    assert.deepEqual(addresses, [{ address: "203.0.113.8", family: 4 }]);
  });
  assert.throws(
    () => createPinnedAddressLookup("not-an-ip"),
    (error: unknown) => error instanceof SSRFProtectionError && error.message.includes("literal IP"),
    "Pinned lookup must reject non-IP values",
  );

  // Test 5: the production request-scoped transport never follows redirects.
  setSellerRequestAdapterForTests(null);
  const server = createServer((request, response) => {
    if (request.url === "/empty") {
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data" });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert(address && typeof address === "object");
    await assert.rejects(
      () => fetchWithSsrfProtection(
        `http://127.0.0.1:${address.port}/redirect`,
        { method: "GET" },
        { allowLocalhostForTesting: true, maxTimeoutMs: 2000, maxResponseSizeBytes: 1024 },
      ),
      (error: unknown) => error instanceof SSRFProtectionError && error.message.includes("redirects are strictly forbidden"),
      "Actual external seller transport must reject redirects without following them",
    );
    const emptyResponse = await fetchWithSsrfProtection(
      `http://127.0.0.1:${address.port}/empty`,
      { method: "POST", body: "{}" },
      {
        allowLocalhostForTesting: true,
        maxTimeoutMs: 2000,
        maxResponseSizeBytes: 1024,
        allowedHeaders: ["content-type"],
      },
    );
    assert.equal(emptyResponse.status, 204);
    assert.equal(await emptyResponse.text(), "");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  console.log("All SSRF protection tests passed, including pinned request transport redirect rejection! ✅");
}

runTests().catch((err) => {
  console.error("SSRF protection tests failed:", err);
  process.exit(1);
});
