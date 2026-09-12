/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { normalizeAgentTrustInput } from "../lib/agent-trust/input.ts";
import { canonicalTrustSubject } from "../lib/monitoring/identity.ts";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

const githubVariants = [
  "github.com/openai/openai",
  "https://github.com/openai/openai/",
  "https://github.com/openai/openai/tree/main",
];
const githubIdentities = githubVariants.map((repositoryUrl) =>
  canonicalTrustSubject(normalizeAgentTrustInput({ repositoryUrl })),
);
assert.deepEqual(
  [...new Set(githubIdentities.map((identity) => identity.key))],
  ["github:openai/openai"],
);
assert(
  githubIdentities.every(
    (identity) =>
      identity.input.repositoryUrl === "https://github.com/openai/openai",
  ),
  "GitHub variants did not converge on one canonical subject input.",
);

const endpointA = canonicalTrustSubject({
  serviceEndpoint: "https://EXAMPLE.com/health?z=2&a=1#status",
});
const endpointB = canonicalTrustSubject({
  serviceEndpoint: "https://example.com/health?a=1&z=2",
});
assert.equal(endpointA.key, endpointB.key);
assert.equal(
  endpointA.input.serviceEndpoint,
  "https://example.com/health?a=1&z=2",
);

const migration = read("supabase/migrations/20260730230000_p31_public_trust_profiles.sql");
for (const expected of [
  "create table if not exists public.trust_profiles",
  "default ('vtr_'",
  "canonical_subject_key text not null unique",
  "add column if not exists profile_id",
  "add column if not exists visibility text not null default 'private'",
  "visibility = 'public'",
  "trust_watchlists_owner_profile_tenant_idx",
  "trust_watchlists_public_profile_idx",
  "alter table public.trust_profiles enable row level security",
  "revoke all on table public.trust_profiles from anon, authenticated",
]) {
  assert(
    migration.includes(expected),
    `P3.1 migration is missing: ${expected}`,
  );
}

const service = read("lib/monitoring/service.ts");
const publicService = service.slice(
  service.indexOf("export async function getPublicTrustProfile"),
  service.indexOf("export async function claimAndLaunchScheduledTrustRecheck"),
);
assert(publicService.includes('.eq("visibility", "public")'));
assert(publicService.includes('"Trust profile not found."'));
for (const forbidden of [
  "owner_wallet:",
  "machine_credential_id:",
  "byoa_agent_id:",
  "cadence:",
  "next_recheck_at:",
  "quote_id:",
  "payment_id:",
  "idempotency_hash:",
]) {
  assert(
    !publicService.includes(forbidden),
    `Public trust payload contains a private field mapping: ${forbidden}`,
  );
}

const publicRoute = read("app/api/monitoring/public/[publicId]/route.ts");
assert(publicRoute.includes("getPublicTrustProfile"));
assert(!publicRoute.includes("requireOwnerSession"));
assert(!publicRoute.includes("authenticateMachineRequest"));

const page = read("app/trust/[publicId]/page.tsx");
for (const expected of [
  "generateMetadata",
  "Veyra Trust Profile",
  "Trust Score history",
  "Meaningful Change Timeline",
  "View full report",
  "Run fresh check",
  "ShareProfileButton",
]) {
  assert(page.includes(expected), `Public profile UI is missing: ${expected}`);
}
const chart = read("app/trust/[publicId]/trust-score-chart.tsx");
for (const expected of [
  "snapshot.score",
  "New risks:",
  "Resolved risks:",
  "Arc verified",
  "available evidence is not yet sufficient",
  "onMouseEnter",
  "onFocus",
]) {
  assert(chart.includes(expected), `Trust Score graph is missing: ${expected}`);
}
assert(read("app/trust/[publicId]/opengraph-image.tsx").includes("ImageResponse"));
assert(read("app/trust/[publicId]/share-profile-button.tsx").includes("navigator.share"));
assert(read("app/trust/[publicId]/not-found.tsx").includes("Trust profile not found"));
assert(!existsSync(new URL("app/trust/[watchlistId]/page.tsx", root)));
assert(!existsSync(new URL("app/api/monitoring/public/[watchlistId]/route.ts", root)));

const openApi = JSON.parse(read("public/openapi/agent-commerce-v1.json")) as {
  paths: Record<string, { get?: { security?: unknown[] } }>;
  components: { schemas: Record<string, unknown> };
};
assert.deepEqual(
  openApi.paths["/api/monitoring/public/{publicId}"]?.get?.security,
  [],
);
assert(openApi.components.schemas.PublicTrustProfile);

console.log("[trust-profile-test] canonical identity=passed");
console.log("[trust-profile-test] privacy fail-closed contract=passed");
console.log("[trust-profile-test] graph, timeline, metadata, and share=passed");
console.log("[trust-profile-test] PASSED");
