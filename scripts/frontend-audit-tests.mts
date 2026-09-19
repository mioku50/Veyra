import assert from "node:assert/strict";
import {
  formatUsdc,
  transactionUrl,
  chainLabel,
  matchesExecutionFilter,
  proofLabel,
} from "../lib/execution/presentation.ts";
import type { ExecutionAttempt } from "../lib/execution/types.ts";
import { publicExecutionView } from "../lib/execution/public-view.ts";

assert.equal(formatUsdc(0.001), "0.001");
assert.equal(formatUsdc(0.018), "0.018");
assert.equal(formatUsdc(0.000001), "0.000001");
assert.equal(formatUsdc(0.0000001), "<0.000001");
assert.equal(formatUsdc(null), "—");
const hash = `0x${"a".repeat(64)}`;
assert.equal(
  transactionUrl("eip155:8453", hash),
  `https://basescan.org/tx/${hash}`,
);
assert.equal(
  transactionUrl("eip155:1", hash),
  `https://etherscan.io/tx/${hash}`,
);
assert.equal(
  transactionUrl("eip155:5042002", hash),
  `https://testnet.arcscan.app/tx/${hash}`,
);
assert.equal(transactionUrl("eip155:999999", hash), null);
assert.equal(transactionUrl(null, hash), null);
assert.equal(transactionUrl("eip155:8453", "javascript:alert(1)"), null);
assert.equal(chainLabel("eip155:999999"), "Chain 999999");
assert(
  matchesExecutionFilter(
    {
      state: "SETTLED_SERVICE_FAILED",
      actualSettledAmountUsdc: 0.001,
      settlementProof: "onchain_final",
    },
    "Settled",
  ),
);
assert(
  matchesExecutionFilter(
    {
      state: "SETTLEMENT_FAILED",
      actualSettledAmountUsdc: 0,
      settlementProof: null,
    },
    "Failed / refused",
  ),
);
assert(
  matchesExecutionFilter(
    {
      state: "EVIDENCE_PENDING",
      actualSettledAmountUsdc: 0,
      settlementProof: null,
    },
    "Waiting",
  ),
);
assert(
  matchesExecutionFilter(
    { state: "EVALUATING", actualSettledAmountUsdc: 0, settlementProof: null },
    "In flight",
  ),
);
assert(
  !matchesExecutionFilter(
    {
      state: "COMPLETED_UNPROVEN",
      actualSettledAmountUsdc: 1,
      settlementProof: "presumed_spent",
    },
    "Settled",
  ),
);
assert.notEqual(proofLabel("presumed_spent"), proofLabel("onchain_final"));
assert.equal(proofLabel(null), "Confirmation level not recorded");

// A page boundary with equal timestamps must neither skip nor repeat an entry.
process.env.NODE_ENV = "test";
process.env.EXECUTION_ALLOW_MEMORY_STORE = "true";
const { saveExecutionAttempt, listExecutionAttempts, clearMemoryStores } =
  await import("../lib/execution/db.ts");
clearMemoryStores();
const recipient = `0x${"1".repeat(40)}` as const;
for (let i = 0; i < 55; i++) {
  const entry = {
    executionId: `vexec_${String(i).padStart(3, "0")}`,
    selectionId: "selection",
    rail: "x402",
    counterpartyAgentId: "seller",
    counterpartyWallet: recipient,
    capability: "web_search",
    requestedAmountUsdc: 0.001,
    authorizedAmountUsdc: 0.001,
    actualSettledAmountUsdc: 0.001,
    state: "COMPLETED",
    selectionHash: hash,
    canonicalHash: hash,
    createdAt: "2026-09-19T12:00:00.000Z",
    updatedAt: "2026-09-19T12:00:00.000Z",
  } as ExecutionAttempt;
  await saveExecutionAttempt(entry);
}
const ids: string[] = [];
let before: { createdAt: string; executionId: string } | undefined;
while (true) {
  const page = await listExecutionAttempts({ limit: 25, before });
  if (!page.length) break;
  ids.push(...page.map((e) => e.executionId));
  const last = page.at(-1)!;
  before = { createdAt: last.createdAt, executionId: last.executionId };
  assert(!("clearancePayload" in publicExecutionView(last)));
}
assert.equal(ids.length, 55);
assert.equal(new Set(ids).size, 55);
assert.equal(
  (await listExecutionAttempts({ counterpartyWallet: `0x${"2".repeat(40)}` }))
    .length,
  0,
);
clearMemoryStores();
console.log(
  "frontend audit units: precise USDC, network links, status groups, evidence grades, safe DTO, 55-row stable pagination passed",
);
