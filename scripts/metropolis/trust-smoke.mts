import { collectMonadEvidence } from "../../lib/monad/evidence.ts";
import { evaluateMonadPurchase } from "../../lib/monad/trust.ts";
import { keccak256, toBytes } from "viem";

// A read-only assessment of a public identity, not a quote, provider endorsement or payment.
const argument = process.argv[2] ?? "1";
if (!/^[1-9]\d*$/.test(argument)) throw new Error("Supply a positive ERC-8004 agent ID");
const bundle = await collectMonadEvidence(BigInt(argument));
const result = evaluateMonadPurchase(bundle, {
  executor: "0x000000000000000000000000000000000000F001",
  amountUsdc: "0.012", budgetUsdc: "0.02", serviceId: "read-only-hypothetical-purchase",
  requestHash: keccak256(toBytes("This is a read-only trust probe, not a real order.")),
});
console.log(JSON.stringify({
  note: "Public identity read only. No payment history, delivery assessments or client feedback were supplied. This is not a Veyra demo agent or an endorsed seller.",
  chainId: result.chainId, agentId: bundle.identity.agentId, block: bundle.identity.blockNumber.toString(), commitment: bundle.identity.commitment,
  score: result.decision.trust.score, coverage: result.decision.trust.coverage,
  decision: result.decision.decision, executable: result.executable,
  reasons: result.reasons, disclosures: result.disclosures,
}, null, 2));
