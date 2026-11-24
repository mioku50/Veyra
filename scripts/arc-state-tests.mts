/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { BRAND } from "../lib/brand.ts";
import {
  ARC_STATE_SQL_PATH,
  computeArcStateReport,
  type ArcStateCheckRow,
  type ArcStateListingRow,
  type ArcStatePriorSnapshot,
} from "../lib/discovery/arc-state.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");

const listings: ArcStateListingRow[] = [
  { hostname: "b.example", method: "GET", sources: ["circle"], listed_amount: "0" },
  { hostname: "b.example", method: "GET", sources: ["circle", "bazaar"], listed_amount: "5000" },
  { hostname: "a.example", method: "POST", sources: ["bazaar"], listed_amount: "10000" },
  { hostname: "a.example", method: "GET", sources: ["circle"], listed_amount: "100000" },
  { hostname: "c.example", method: "POST", sources: ["erc8004"], listed_amount: "100000" },
  { hostname: "d.example", method: "GET", sources: ["circle"], listed_amount: "500000" },
  { hostname: "e.example", method: "POST", sources: ["bazaar"], listed_amount: "1000000" },
  { hostname: "f.example", method: "GET", sources: ["erc8004"], listed_amount: "2500000" },
];

const payeeOne = "0x" + "1".repeat(40);
const payeeTwo = "0x" + "2".repeat(40);
const keyOne = "a".repeat(64);
const keyTwo = "b".repeat(64);
const keyThree = "c".repeat(64);

const checks: ArcStateCheckRow[] = [
  {
    resource_key: keyOne,
    checked_at: "2026-11-01T10:00:00.000Z",
    http_status: 402,
    arc_challenge: true,
    live_amount: "100000",
    live_payee: payeeOne,
    drift: [],
    latency_ms: 100,
  },
  // Intermediate timeout has null fields; the next non-null payee must still compare against payeeOne.
  {
    resource_key: keyOne,
    checked_at: "2026-11-10T10:00:00.000Z",
    http_status: null,
    arc_challenge: false,
    live_amount: null,
    live_payee: null,
    drift: [],
    latency_ms: null,
  },
  {
    resource_key: keyOne,
    checked_at: "2026-11-20T10:00:00.000Z",
    http_status: 402,
    arc_challenge: true,
    live_amount: "200000",
    live_payee: payeeTwo,
    drift: ["payto_changed", "price_changed"],
    latency_ms: 151,
  },
  {
    resource_key: keyTwo,
    checked_at: "2026-11-18T10:00:00.000Z",
    http_status: 402,
    arc_challenge: false,
    live_amount: null,
    live_payee: null,
    drift: ["rail_changed"],
    latency_ms: 200,
  },
  {
    resource_key: keyThree,
    checked_at: "2026-11-21T10:00:00.000Z",
    http_status: 200,
    arc_challenge: false,
    live_amount: null,
    live_payee: null,
    drift: [],
    latency_ms: 50,
  },
];

const priorSnapshot: ArcStatePriorSnapshot = {
  snapshot_month: "2026-10-01",
  snapshot_at: "2026-11-15T00:00:00.000Z",
  payload: {
    overview: { listings: 6, distinctHosts: 5, checksInWindow: 3 },
    liveness: { arcChallengeRate: 0.3333 },
    drift: { anyRate: 0.3333 },
  },
};

test("computeArcStateReport is deterministic and matches exact counts, shares, buckets, changes, and latency", () => {
  const snapshotAt = new Date("2026-11-24T12:00:00.000Z");
  const first = computeArcStateReport({
    snapshotAt,
    listings,
    checks,
    priorSnapshot,
  });
  const second = computeArcStateReport({
    snapshotAt,
    listings: [...listings].reverse(),
    checks: [...checks].reverse(),
    priorSnapshot,
  });

  assert.deepEqual(first, second);
  assert.equal(first.snapshotMonth, "2026-11-01");
  assert.equal(first.snapshotAt, "2026-11-24T12:00:00.000Z");
  assert.deepEqual(first.overview, {
    listings: 8,
    distinctHosts: 6,
    checksInWindow: 5,
    distinctCheckedEndpoints: 3,
  });
  assert.deepEqual(first.liveness, {
    reachableCount: 4,
    reachableRate: 0.8,
    http402Count: 3,
    http402Rate: 0.6,
    arcChallengeCount: 2,
    arcChallengeRate: 0.4,
  });
  assert.deepEqual(first.drift, {
    anyCount: 2,
    anyRate: 0.4,
    paytoChangedCount: 1,
    paytoChangedRate: 0.2,
    priceChangedCount: 1,
    priceChangedRate: 0.2,
    railChangedCount: 1,
    railChangedRate: 0.2,
  });
  assert.deepEqual(first.changes.withinWindow, {
    endpointsWithMultipleChecks: 1,
    payeeChangeEvents: 1,
    endpointsWithPayeeChange: 1,
    priceChangeEvents: 1,
    endpointsWithPriceChange: 1,
  });
  assert.deepEqual(first.changes.sincePriorSnapshot, {
    priorSnapshotMonth: "2026-10-01",
    priorSnapshotAt: "2026-11-15T00:00:00.000Z",
    listingsDelta: 2,
    distinctHostsDelta: 1,
    checksInWindowDelta: 2,
    arcChallengeRateDelta: 0.0667,
    driftAnyRateDelta: 0.0667,
    payeeChangeEventsSincePrior: 1,
    priceChangeEventsSincePrior: 1,
    paytoDriftChecksSincePrior: 1,
    priceDriftChecksSincePrior: 1,
  });

  // Deterministic tie-breaking: a.example and b.example both have 2 listings; a.example ranks first.
  assert.equal(first.concentration.top1Host, "a.example");
  assert.equal(first.concentration.top1Share, 0.25);
  assert.equal(first.concentration.top5Share, 0.875);
  assert.deepEqual(
    first.concentration.top5Hosts.map((host) => host.hostname),
    ["a.example", "b.example", "c.example", "d.example", "e.example"],
  );

  assert.deepEqual(first.methods, {
    GET: { count: 5, share: 0.625 },
    POST: { count: 3, share: 0.375 },
  });
  assert.equal(first.pricing.exactTenCentsCount, 2);
  assert.equal(first.pricing.exactTenCentsShare, 0.25);
  const bucketTotal = first.pricing.buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  assert.equal(bucketTotal, first.overview.listings);

  assert.deepEqual(first.sources, {
    circle: { count: 4, share: 0.5 },
    bazaar: { count: 3, share: 0.375 },
    erc8004: { count: 2, share: 0.25 },
    multiSourceCount: 1,
  });

  // Sorted non-null check latencies: [50, 100, 151, 200] -> median = 125.5 ms
  assert.deepEqual(first.latency, {
    medianMs: 125.5,
    sampleSize: 4,
    source: "arc_offer_checks",
  });
});

test("computeArcStateReport falls back cleanly when check latencies or prior snapshot are absent", () => {
  const withoutCheckLatency = computeArcStateReport({
    snapshotAt: new Date("2026-11-24T12:00:00.000Z"),
    listings,
    checks: checks.map((check) => ({ ...check, latency_ms: null })),
    fallbackLatenciesMs: [40, 84, 85, 210],
    priorSnapshot: null,
  });
  assert.equal(withoutCheckLatency.changes.sincePriorSnapshot, null);
  assert.deepEqual(withoutCheckLatency.latency, {
    medianMs: 84.5,
    sampleSize: 4,
    source: "x402_endpoint_observations",
  });

  const empty = computeArcStateReport({
    snapshotAt: new Date("2026-11-24T12:00:00.000Z"),
    listings: [],
    checks: [],
  });
  assert.equal(empty.concentration.top1Host, null);
  assert.equal(empty.liveness.arcChallengeRate, null);
  assert.deepEqual(empty.latency, {
    medianMs: null,
    sampleSize: 0,
    source: "none",
  });
});

test("methodology wording uses Observed attribution and omits verification claims", () => {
  const report = computeArcStateReport({
    snapshotAt: new Date("2026-11-24T12:00:00.000Z"),
    listings,
    checks,
  });
  assert.equal(report.methodology.attribution, `Observed by ${BRAND.name}`);
  const serialized = JSON.stringify(report);
  assert(!/\bverif(?:ied|y|ying|ication)\b/i.test(serialized));
  assert(report.methodology.checkDefinition.includes("no payment header"));
  assert(report.methodology.checkDefinition.includes("no USDC spent"));
  assert(report.methodology.checkDefinition.includes("delivers results after payment"));

  const sql = readFileSync(resolve(REPO_ROOT, ARC_STATE_SQL_PATH), "utf8");
  for (const marker of [
    "arc_offer_index",
    "arc_offer_checks",
    "arc_state_snapshots",
    "x402_endpoint_observations",
    "percentile_cont(0.5)",
  ]) {
    assert(sql.includes(marker), `${ARC_STATE_SQL_PATH} must reference ${marker}`);
  }
});
