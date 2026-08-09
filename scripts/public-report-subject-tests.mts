import assert from "node:assert/strict";
import {
  publicReportSubject,
  repositoryFullName,
  shortenAddress,
} from "../lib/agent/public-report-copy.ts";

function subject(
  workflowType: string,
  inputPreview: string,
  workflowLabel = "Workflow",
  summary = "",
) {
  return publicReportSubject({ workflowType, workflowLabel, inputPreview, summary });
}

// Structured JSON inputs must never reach a public card verbatim.
{
  const agentTrustJson = JSON.stringify({
    agentId: "agt_e7b2811de8186fb4bb37",
    agentWallet: null,
    repositoryUrl: "https://github.com/mioku50/agent-commerce",
  });
  assert.equal(
    subject("agent_trust_report", agentTrustJson, "Veyra Agent Trust Report"),
    "mioku50/agent-commerce",
    "Agent trust reports prefer the repository over the raw object.",
  );
}

{
  const walletOnly = JSON.stringify({
    agentId: null,
    agentWallet: "0x9b57000000000000000000000000000000003dad",
  });
  assert.equal(
    subject("agent_trust_report", walletOnly, "Veyra Agent Trust Report"),
    "0x9b57…3dad",
  );
}

{
  const idOnly = JSON.stringify({ agentId: "agt_e7b2811de8186fb4bb37" });
  assert.equal(
    subject("agent_trust_report", idOnly, "Veyra Agent Trust Report"),
    "agt_e7b2811de8186fb4bb37",
  );
}

{
  const endpointOnly = JSON.stringify({
    serviceEndpoint: "https://api.example.com/v1/quote?key=redacted",
  });
  assert.equal(
    subject("agent_trust_report", endpointOnly, "Veyra Agent Trust Report"),
    "api.example.com",
  );
}

{
  const project360Json = JSON.stringify({
    schema: "veyra.project360.input.v1",
    discoveryId: "dsc_d526479b0fce1122aabb",
    sources: [{ candidateId: "a" }, { candidateId: "b" }],
    modules: ["github_due_diligence", "treasury_health"],
  });
  assert.equal(
    subject("project_360", project360Json, "Veyra Project 360 Due Diligence"),
    "2 modules · 2 sources",
  );
}

{
  const treasuryJson = JSON.stringify({
    walletAddress: "0x9b57000000000000000000000000000000003dad",
  });
  assert.equal(
    subject("treasury_health", treasuryJson, "Treasury Health Report"),
    "0x9b57…3dad",
  );
}

{
  const singleService = JSON.stringify({ services: ["srv_weather"], windowDays: 30 });
  assert.equal(
    subject("paid_api_quality", singleService, "Paid API Quality Report"),
    "srv_weather",
  );
  const manyServices = JSON.stringify({
    services: ["srv_weather", "srv_crypto", "srv_news"],
  });
  assert.equal(
    subject("paid_api_quality", manyServices, "Paid API Quality Report"),
    "srv_weather +2 more",
  );
}

// A truncated JSON preview cannot parse and must still fall back cleanly.
{
  const truncated = '{"agentId":"agt_e7b2811de8186fb4bb37","agentWallet":null,"repositor';
  assert.equal(
    subject("agent_trust_report", truncated, "Veyra Agent Trust Report"),
    "Veyra Agent Trust Report",
  );
}

// An empty structured object has no usable subject.
{
  assert.equal(
    subject("agent_trust_report", "{}", "Veyra Agent Trust Report"),
    "Veyra Agent Trust Report",
  );
}

// Plain-text workflows keep their readable subject.
{
  assert.equal(
    subject(
      "github_due_diligence",
      "https://github.com/mioku50/agent-commerce",
      "GitHub Project Due Diligence",
    ),
    "mioku50/agent-commerce",
  );
  assert.equal(
    subject("github_due_diligence", "github.com/vercel/next.js.git", "GitHub"),
    "vercel/next.js",
  );
  assert.equal(
    subject(
      "market_context",
      "user-paid SOL/USD workflow",
      "Market Context Brief",
    ),
    "SOL/USD Market Context",
  );
  assert.equal(
    subject("builder_update", "Shipped the new checkout flow", "Builder Update"),
    "Shipped the new checkout flow",
  );
}

// Internal phrasing is scrubbed from free-text subjects.
{
  assert.equal(
    subject("custom_task", "Phase 5.4: audit the downstream x402 calls", "Custom"),
    "audit the verified data services calls",
  );
}

// An empty preview always degrades to the workflow label.
{
  assert.equal(subject("custom_task", "", "Custom Task"), "Custom Task");
  assert.equal(subject("custom_task", "   ", "Custom Task"), "Custom Task");
}

// Helper units.
{
  assert.equal(shortenAddress("0x9b57000000000000000000000000000000003dad"), "0x9b57…3dad");
  assert.equal(shortenAddress("not-an-address"), "not-an-address");
  assert.equal(repositoryFullName("https://github.com/owner/repo/tree/main"), "owner/repo");
  assert.equal(repositoryFullName("owner/repo"), "owner/repo");
  assert.equal(repositoryFullName("https://example.com/owner/repo"), null);
}

console.log("public report subject tests passed");
