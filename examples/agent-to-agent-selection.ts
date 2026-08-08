import { veyraTrustSdk } from "../sdk/typescript/src/index.ts";

const baseUrl = process.env.VEYRA_BASE_URL || "https://agent-commerce-one.vercel.app";
const credential = process.env.VEYRA_MACHINE_API_CREDENTIAL;
const candidateIds = (process.env.VEYRA_COUNTERPARTY_AGENT_IDS || "")
  .split(",").map((item) => item.trim()).filter(Boolean);

if (!credential) throw new Error("VEYRA_MACHINE_API_CREDENTIAL is required");
if (candidateIds.length === 0) throw new Error("VEYRA_COUNTERPARTY_AGENT_IDS must contain at least one public ERC-8004 Agent ID");

const client = veyraTrustSdk({ baseUrl, credential });
const discovery = await client.discoverCounterparties({ capability: "github_due_diligence", limit: 10 });
console.log(`Discovered ${discovery.candidates.length} verified public candidates.`);

const result = await client.selectCounterparty({
  capability: "github_due_diligence",
  task: "Select a counterparty for repository due diligence",
  budgetUsdc: 0.1,
  candidates: candidateIds.map((agentId) => ({ agentId })),
  visibility: "public",
});
console.log({
  selectionId: result.selection.selectionId,
  winnerAgentId: result.selection.recommendedAgentId,
  decision: result.selection.decision,
  maxExposureUsdc: result.selection.recommendedMaxExposureUsdc,
  canonicalHash: result.selection.canonicalHash,
  paymentCreated: result.paymentCreated,
  jobCreated: result.jobCreated,
});

// Clearance and Arc publication are intentionally separate, explicit actions:
// await client.issueClearance(result.selection.selectionId);
// await client.publishSelectionProof(result.selection.selectionId);
