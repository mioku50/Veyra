import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const files = await Promise.all([
  "lib/counterparty-selection/service.ts",
  "lib/counterparty-selection/proof.ts",
  "lib/byoa/service.ts",
  "sdk/typescript/src/index.ts",
  "app/trust/select/trust-selection-client.tsx",
  "app/trust/selections/[publicId]/page.tsx",
  "app/api/reputation/v1/agents/[agentId]/proof/route.ts",
].map((file) => readFile(new URL(`../${file}`, import.meta.url), "utf8")));
const [service, proof, manifest, sdk, ui, receipt, reputationProofRoute] = files;

for (const endpoint of ["discoverCounterparties", "selectCounterparty", "getSelection", "getSelectionEvidence", "issueSelectionClearance", "publishSelectionProof"]) {
  assert.match(sdk, new RegExp(`\\b${endpoint}\\b`), `SDK method ${endpoint} is missing`);
}
assert.match(manifest, /counterparty_selection/);
assert.match(manifest, /veyra-counterparty-selection-v1/);
assert.match(service, /paymentCreated:\s*false/);
assert.match(service, /jobCreated:\s*false/);
assert.match(service, /proof_requires_explicit_action/);
assert.match(proof, /resolveEconomicEvidence/, "Selection proof must reuse verified economic provenance");
assert.match(proof, /chargedUsdc:\s*0/, "Publishing a selection proof must not charge the requester");
assert.doesNotMatch(proof, /amount:\s*BigInt\(0\)/, "Registry rejects zero-value provenance");
assert.doesNotMatch(service, /createHostedAgentJob|createPayment|checkout/i);
assert.match(ui, /all off by default/i);
assert.match(ui, /does not execute or pay the winner/i);
assert.match(receipt, /not a payment, execution, endorsement, or guarantee/i);
assert.doesNotMatch(receipt, /machineCredentialId|tenantKey|requesterWallet/);
assert.match(reputationProofRoute, /requireOwnerSession/);
assert.match(reputationProofRoute, /getCanonicalAgentIdentity/);
assert.match(reputationProofRoute, /job\.provider\.toLowerCase\(\) === identity\.owner_address\.toLowerCase\(\)/);
assert.match(reputationProofRoute, /fetchJobSubmittedLogs/);
assert.doesNotMatch(reputationProofRoute, /request\.json\(\)/, "The proof route must not accept client-derived proof fields");
console.log("Counterparty selection product contract tests passed.");
