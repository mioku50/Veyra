/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { prepareEconomicProvenance } from "../lib/reputation/economic-provenance.ts";

console.log("Reputation economic provenance regression (read-only)");

assert.equal(prepareEconomicProvenance(undefined, 10), null);
assert.equal(
  prepareEconomicProvenance({
    buyer: "invalid",
    seller: "also-invalid",
    source: "erc8183_job",
    sourceId: "job-1",
  }, 10),
  null,
);

assert.throws(
  () => prepareEconomicProvenance({
    buyer: "0x1111111111111111111111111111111111111111",
    seller: "0x2222222222222222222222222222222222222222",
    source: "erc8183_job",
    sourceId: "job-1",
  }, 0),
  /missing or zero/,
);

assert.throws(
  () => prepareEconomicProvenance({
    buyer: "0x1111111111111111111111111111111111111111",
    seller: "0x2222222222222222222222222222222222222222",
    source: "x402_payment",
    sourceId: "",
  }, 1),
  /sourceId is required/,
);

const prepared = prepareEconomicProvenance({
  buyer: "0x1111111111111111111111111111111111111111",
  seller: "0x2222222222222222222222222222222222222222",
  source: "erc8183_job",
  sourceId: "173209",
}, 0.025);
assert.ok(prepared);
assert.equal(prepared.amountAtomic, BigInt(25_000));
assert.equal(prepared.source, "erc8183_job");
assert.equal(prepared.sourceId, "173209");

console.log("reputation provenance regression: PASS");
