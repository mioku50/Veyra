# `@veyra/sdk`

Typed, dependency-free TypeScript client for Veyra Agent API v1 on Arc Testnet.

The SDK covers agent trust verification, counterparty selection, Trust Gate preflight, ERC-8183 evaluation, workflow execution, immutable quotes, idempotent runs, polling, structured reports, Markdown export, normalized errors, and Arc proof metadata. It also covers continuous trust monitoring, alerts, and signed webhooks.

It works in Node.js 20+ and modern runtimes that provide standard `fetch`, `AbortController`, and `crypto.randomUUID`.

```ts
import { VeyraClient } from "@veyra/sdk";

const client = new VeyraClient({
  baseUrl: process.env.VEYRA_API_BASE_URL || "https://veyra.app",
  credential: process.env.VEYRA_API_KEY!,
});

// Run a verified trust evaluation or workflow
const { report } = await client.executeWorkflow({
  workflow: "github_due_diligence",
  repository: "circlefin/developer-controlled-wallets-web-sdk",
});

console.log(report.verdict, report.verification);
```

Project 360 discovery is free. Every candidate is returned with
`included: false`; your agent must inspect provenance and explicitly pass the
selected candidate IDs and modules into the immutable quote:

```ts
const { discovery } = await client.discoverProject360(
  { type: "github_repository", value: "circlefin/agent-commerce" },
  { idempotencyKey: "project-360-discovery-001" },
);

const github = discovery.candidates.find(
  (candidate) => candidate.module === "github_due_diligence",
);
if (!github) throw new Error("No validated GitHub source was discovered");

const quote = await client.createProject360Quote(
  discovery.id,
  {
    revision: discovery.revision,
    selectedCandidateIds: [github.id],
    modules: [github.module],
  },
  { idempotencyKey: "project-360-quote-001" },
);

// Verify quote.project360.lineItems, expectedCoverage, warnings, and totalUsdc
// before calling createRun({ quoteId: quote.quoteId }).
```

Agent Trust Report uses a structured public-identifier input and the same
quote → run → report lifecycle:

```ts
import type { AgentTrustReport } from "@veyra/sdk";

const quote = await client.createQuote({
  workflow: "agent_trust_report",
  input: {
    agentWallet: "0x0000000000000000000000000000000000000001",
    repositoryUrl: "circlefin/developer-controlled-wallets-web-sdk",
  },
});

// Launch and wait as above, then request the canonical typed report:
const report = await client.getReport<AgentTrustReport>("REPORT_ID");
console.log(report.trustScore, report.verification);
```

Mutating methods create a fresh `Idempotency-Key` by default. For durable agent
runs, persist and pass your own quote and run idempotency keys so process
restarts replay the same operation.

Paid quotes require an existing Arc Testnet transaction authorization. Pass
`paymentAuthorization` or a callback that creates the transaction after
checking the immutable quote. The SDK never signs or sends funds by itself.
