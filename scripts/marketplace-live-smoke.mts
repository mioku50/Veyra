/**
 * Copyright 2026 Circle Internet Group, Inc.  All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Live smoke against Circle's public x402 discovery API and real seller
 * endpoints. Read-only: it reads the catalog and reads 402 challenges. It
 * never sends a payment header and never settles anything.
 */

import {
  discoverMarketplaceCandidates,
  MARKETPLACE_DISCOVERY_URL,
} from "../lib/counterparty-selection/marketplace-source.ts";
import {
  probeExpectationFor,
  marketplaceEvidenceCoverage,
  buildMarketplaceTrustDecision,
} from "../lib/counterparty-selection/marketplace.ts";
import { buildX402ProbeEvidence, probeX402Resource } from "../lib/providers/x402-probe.ts";

const capability = process.argv[2] || "market_research";
const maxPriceUsdc = Number(process.argv[3] || "0.02");
const REQUESTER = "0x00000000000000000000000000000000000000aa" as const;

console.log(`Catalog: ${MARKETPLACE_DISCOVERY_URL}`);
console.log(`Capability: ${capability}   Price ceiling: $${maxPriceUsdc}\n`);

// Arc check, stated as a measurement rather than an assumption.
const arcProbe = await fetch(
  `${MARKETPLACE_DISCOVERY_URL}?network=eip155:5042002&limit=1`,
  { headers: { accept: "application/json" } },
);
const arcPayload = await arcProbe.json() as { pagination?: { total?: number } };
console.log(`Arc Testnet (eip155:5042002) resources in the Circle catalog: ${arcPayload.pagination?.total ?? "?"}`);
console.log("Marketplace settlement therefore happens off-Arc.\n");

const discovery = await discoverMarketplaceCandidates({
  capability,
  maxPriceUsdc,
  limit: 5,
});
console.log(`Catalog matches: ${discovery.catalogTotal}   Usable candidates: ${discovery.candidates.length}`);
console.log(`Network: ${discovery.networkLabel} (${discovery.network})\n`);

if (discovery.candidates.length === 0) {
  console.log("No candidates matched. Try another capability, e.g. `npm run marketplace:live -- crypto_market`.");
  process.exit(0);
}

for (const candidate of discovery.candidates) {
  const probe = await probeX402Resource(probeExpectationFor(candidate));
  const evidence = buildX402ProbeEvidence([probe]);
  const coverage = marketplaceEvidenceCoverage(evidence);
  const decision = buildMarketplaceTrustDecision({
    requesterWallet: REQUESTER,
    payTo: candidate.selectedAccept.payTo as `0x${string}`,
    candidate,
    integrityScore: evidence.integrityScore,
    coverage: coverage.coverage,
    confidence: 0.3,
    evidenceHash: candidate.catalogHash,
    capability: discovery.capability,
    requestedValueUsdc: candidate.priceUsdc,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    riskSignals: [],
  });
  const failed = probe.checks.filter((check) => !check.passed).map((check) => check.id);
  console.log(`- ${candidate.provider.name || candidate.origin}  $${candidate.priceUsdc}  ${candidate.capabilityMatch}`);
  console.log(`  ${candidate.resource}`);
  console.log(`  HTTP ${probe.httpStatus ?? "none"}  402=${probe.respondedWith402}  ${probe.latencyMs ?? "-"}ms`);
  console.log(`  integrity=${probe.integrityScore}/100  drift=[${probe.catalogDrift.join(",") || "none"}]  critical=${probe.criticalFailure ?? "none"}`);
  console.log(`  failed checks: ${failed.join(", ") || "none"}`);
  console.log(`  quality: ${evidence.qualityScore.status}  coverage=${(coverage.coverage * 100).toFixed(0)}%`);
  console.log(`  verdict: ${decision.decision}  max exposure $${decision.policy.maxValueUsdc}\n`);
}

console.log("Live smoke complete. No payment was authorized or settled.");
