import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  freshnessLabel,
  publicTrustCacheHeaders,
  trustStatusEtag,
} from "../lib/monitoring/public-status.ts";

function read(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

const first = {
  profileId: "vtr_1234567890abcdef1234",
  score: 76,
  status: "review_recommended",
  verifiedOnArc: true,
  lastCheckedAt: "2026-07-30T17:30:00.000Z",
  profileUrl: "https://veyra.example/trust/vtr_1234567890abcdef1234",
};
const second = { ...first, score: 73, lastCheckedAt: "2026-07-31T17:30:00.000Z" };
assert.notEqual(
  trustStatusEtag(first),
  trustStatusEtag(second),
  "A new snapshot status must invalidate the previous ETag.",
);
assert.equal(publicTrustCacheHeaders(first)["Cache-Control"], "public, max-age=0, must-revalidate");
assert.equal(
  freshnessLabel(first.lastCheckedAt, Date.parse("2026-07-30T20:00:00.000Z")),
  "checked today",
);

const statusRoute = read("app/api/public/trust/[publicId]/status/route.ts");
assert(statusRoute.includes("getPublicTrustStatus"));
assert(statusRoute.includes("if-none-match"));
assert(!/owner_wallet|credential|quote|payment|job_id/.test(statusRoute));

const badgeRoute = read("app/api/trust/[publicId]/badge.svg/route.ts");
for (const required of [
  "image/svg+xml",
  "variant === \"status\"",
  "variant === \"arc\"",
  "freshnessLabel",
  "if-none-match",
  "escapeXml",
]) {
  assert(badgeRoute.includes(required), `Badge route missing: ${required}`);
}
assert(!/owner_wallet|credential|quote|payment|job_id/.test(badgeRoute));

const embed = read("app/trust/[publicId]/trust-badge-embed.tsx");
assert(embed.includes("[![Veyra Trust]("));
assert(embed.includes(`/api/trust/\${profileId}/badge.svg`));
assert(embed.includes(`/trust/\${profileId}`));

const openapi = JSON.parse(read("public/openapi/veyra-agent-api-v1.json")) as {
  paths: Record<string, unknown>;
};
assert(openapi.paths["/api/public/trust/{publicId}/status"]);
assert(openapi.paths["/api/trust/{publicId}/badge.svg"]);

console.log(
  "[trust-badge-test] passed: compact safe status, server SVG variants, snapshot-derived ETag invalidation, mandatory revalidation, embed link, and OpenAPI",
);
