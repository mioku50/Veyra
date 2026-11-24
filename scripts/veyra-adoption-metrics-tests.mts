/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import assert from "node:assert/strict";
import {
  makeAdoptionEvent,
  recordAdoptionEvent,
  verdictAdoptionChannel,
} from "../lib/x402/trust-api/adoption-metrics.ts";

const config = { secret: "8a".repeat(32), environment: "production" };
const monday = new Date("2026-11-16T00:00:00.000Z");
const headers = new Headers({
  "x-vercel-forwarded-for": "198.51.100.1",
  "x-forwarded-for": "198.51.100.99",
  authorization: "Bearer ignored",
  cookie: "session=ignored",
  "payment-signature": "ignored",
});
const rest = makeAdoptionEvent(headers, "rest_verdict", config, monday);
assert.ok(rest);
assert.deepEqual(rest, {
  p_event: "rest_verdict",
  p_week: "2026-11-16",
  p_caller: rest.p_caller,
  p_occurred_at: monday.toISOString(),
});
assert.match(rest.p_caller, /^[a-f\d]{64}$/);

// The same weekly network pseudonym works across REST, MCP, web UI and paid history.
const sameAddress = new Headers({ "x-vercel-forwarded-for": "198.51.100.1" });
for (const event of ["mcp_verdict", "web_verdict", "paid_history"] as const) {
  const result = makeAdoptionEvent(sameAddress, event, config, new Date("2026-11-22T23:59:59.999Z"));
  assert.equal(result?.p_event, event);
  assert.equal(result?.p_week, rest.p_week);
  assert.equal(result?.p_caller, rest.p_caller);
}

assert.equal(verdictAdoptionChannel(new Headers()), "rest_verdict");
assert.equal(verdictAdoptionChannel(new Headers({ "x-veyra-source": "cli" })), "rest_verdict");
assert.equal(verdictAdoptionChannel(new Headers({ "X-Veyra-Source": "web" })), "web_verdict");
assert.equal(verdictAdoptionChannel(new Headers({ "x-veyra-source": " WEB " })), "web_verdict");

const nextWeek = makeAdoptionEvent(headers, "rest_verdict", config, new Date("2026-11-23T00:00:00.000Z"));
assert.equal(nextWeek?.p_week, "2026-11-23");
assert.notEqual(nextWeek.p_caller, rest.p_caller);
assert.notEqual(makeAdoptionEvent(headers, "rest_verdict", { ...config, secret: "7c".repeat(32) }, monday)?.p_caller, rest.p_caller);

const ipv6A = new Headers({ "x-vercel-forwarded-for": "2001:0DB8:0:0:0:0:0:1" });
const ipv6B = new Headers({ "x-vercel-forwarded-for": "2001:db8::1" });
const firstIpv6 = makeAdoptionEvent(ipv6A, "rest_verdict", config, monday);
assert.ok(firstIpv6);
assert.equal(makeAdoptionEvent(ipv6B, "rest_verdict", config, monday)?.p_caller, firstIpv6.p_caller);
assert.notEqual(firstIpv6.p_caller, rest.p_caller);

const untrustedHeaders: Record<string, string>[] = [
  {},
  { "x-forwarded-for": "198.51.100.1" },
  { "x-vercel-forwarded-for": "secret.example/path" },
  { "x-vercel-forwarded-for": "198.51.100.1, 198.51.100.99" },
  { "x-vercel-forwarded-for": "fe80::1%test" },
  { "x-vercel-forwarded-for": "198.51.100.1", "sec-gpc": "1" },
];
for (const untrusted of untrustedHeaders) {
  assert.equal(makeAdoptionEvent(new Headers(untrusted), "rest_verdict", config, monday), null);
}
assert.equal(makeAdoptionEvent(headers, "rest_verdict", { ...config, environment: "preview" }, monday), null);
assert.equal(makeAdoptionEvent(headers, "rest_verdict", { ...config, secret: undefined }, monday), null);
assert.equal(makeAdoptionEvent(headers, "rest_verdict", { ...config, secret: "weak" }, monday), null);

// Scheduling can be unavailable outside a Next request. Keep the caller's
// response independent from metrics, and omit sensitive values from the log.
process.env.VERCEL_ENV = config.environment;
process.env.VEYRA_ADOPTION_METRICS_SECRET = config.secret;
const warn = console.warn;
const warnings: unknown[][] = [];
try {
  console.warn = (...args: unknown[]) => warnings.push(args);
  assert.doesNotThrow(() => recordAdoptionEvent(headers, "rest_verdict"));
  assert.deepEqual(warnings, [["veyra_adoption_event_not_recorded"]]);
} finally {
  console.warn = warn;
}

console.log("Veyra adoption event privacy, deduplication key and fail-open tests passed");
