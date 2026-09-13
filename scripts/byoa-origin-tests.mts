/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { getByoaConfig } from "../lib/byoa/config.ts";

const SECRETS = {
  BYOA_MANAGEMENT_SESSION_SECRET: "x".repeat(48),
  BYOA_CREDENTIAL_PEPPER: "y".repeat(48),
  NODE_ENV: "production",
} as NodeJS.ProcessEnv;

function origins(extra: NodeJS.ProcessEnv) {
  return getByoaConfig({ ...SECRETS, ...extra }).origins;
}

// The regression: a deployment moved to a new domain and every decision failed
// with "BYOA request origin is not allowed", because the allowlist only knew
// the old one. The deployment's own host is now trusted without configuration.
const moved = origins({ VERCEL_PROJECT_PRODUCTION_URL: "agent-commerce-six.vercel.app" });
assert.ok(moved.has("https://agent-commerce-six.vercel.app"), "the production host must be trusted");

// Vercel publishes the host without a scheme; a configured value may carry one.
assert.ok(origins({ VERCEL_URL: "veyras-abc123.vercel.app" }).has("https://veyras-abc123.vercel.app"));
assert.ok(origins({ VERCEL_URL: "https://veyras-abc123.vercel.app" }).has("https://veyras-abc123.vercel.app"));

// Explicit configuration still works and still wins nothing away from itself.
const configured = origins({
  BYOA_ALLOWED_ORIGINS: "https://veyra.app,https://www.veyra.app",
  NEXT_PUBLIC_APP_URL: "https://agent-commerce-six.vercel.app",
});
assert.ok(configured.has("https://veyra.app"));
assert.ok(configured.has("https://www.veyra.app"));
assert.ok(configured.has("https://agent-commerce-six.vercel.app"));

// A third party's origin is still refused: widening the list to the deployment
// itself must not widen it to anyone else.
assert.equal(configured.has("https://evil.example"), false);
assert.equal(moved.has("https://agent-commerce-six.vercel.app.evil.example"), false);

// One malformed entry must not take down the origins beside it.
const withJunk = origins({
  BYOA_ALLOWED_ORIGINS: "not a url,https://veyra.app",
  VERCEL_PROJECT_PRODUCTION_URL: "agent-commerce-six.vercel.app",
});
assert.ok(withJunk.has("https://veyra.app"));
assert.ok(withJunk.has("https://agent-commerce-six.vercel.app"));

// And with nothing configured at all the config still refuses to start, rather
// than silently trusting everything.
assert.throws(() => getByoaConfig(SECRETS), /BYOA_ALLOWED_ORIGINS or NEXT_PUBLIC_APP_URL/);

console.log("[byoa-origin-test] passed: the deployment's own host is trusted, explicit origins still apply, lookalike and third-party origins are refused, and a malformed entry does not poison the list");
