import {
  AgentCommerceClient,
  type AgentTrustReport,
  type AgentTrustReportInput,
} from "../../sdk/typescript/src/index.ts";

const baseUrl =
  process.env.VEYRA_API_BASE_URL ?? "https://agent-commerce-six.vercel.app";
const credential = process.env.VEYRA_AGENT_API_KEY;
if (!credential) throw new Error("Set VEYRA_AGENT_API_KEY.");

const input: AgentTrustReportInput = {
  ...(process.env.VEYRA_TARGET_AGENT_ID
    ? { agentId: process.env.VEYRA_TARGET_AGENT_ID }
    : {}),
  ...(process.env.VEYRA_TARGET_WALLET
    ? { agentWallet: process.env.VEYRA_TARGET_WALLET }
    : {}),
  repositoryUrl:
    process.env.VEYRA_TARGET_REPOSITORY ??
    "circlefin/developer-controlled-wallets-web-sdk",
  ...(process.env.VEYRA_TARGET_CONTRACT
    ? { contractAddress: process.env.VEYRA_TARGET_CONTRACT }
    : {}),
  ...(process.env.VEYRA_TARGET_ENDPOINT
    ? { serviceEndpoint: process.env.VEYRA_TARGET_ENDPOINT }
    : {}),
};

const client = new AgentCommerceClient({ baseUrl, credential });
const quote = await client.createQuote(
  { workflow: "agent_trust_report", input },
  { idempotencyKey: "agent-trust-example-quote-v1" },
);

const paymentHash = process.env.VEYRA_ARC_PAYMENT_TX_HASH;
if (!quote.sponsored && !paymentHash) {
  const transaction = quote.requiredPayment.transaction;
  throw new Error(
    transaction
      ? `Submit the immutable ${transaction.protocol} Arc transaction from requiredPayment.transaction (to=${transaction.to}, value=${transaction.value}, data=${transaction.data}), then set VEYRA_ARC_PAYMENT_TX_HASH.`
      : "The paid quote did not include an Arc transaction request.",
  );
}

const launch = await client.createRun(
  {
    quoteId: quote.quoteId,
    ...(paymentHash
      ? {
          paymentAuthorization: {
            type: "arc_transaction" as const,
            payload: paymentHash as `0x${string}`,
          },
        }
      : {}),
  },
  { idempotencyKey: "agent-trust-example-run-v1" },
);
const run = await client.waitForRun(launch.runId, {
  onStatus: ({ status, progress }) =>
    console.log(status, `${Math.round(progress * 100)}%`),
});
if (!run.reportId) throw new Error(`Run ended as ${run.status} without a report.`);

const report = await client.getReport<AgentTrustReport>(run.reportId);
console.log(
  JSON.stringify(
    {
      reportId: report.reportId,
      trustScore: report.trustScore,
      verification: report.verification,
      questionsBeforeIntegration: report.questionsBeforeIntegration,
    },
    null,
    2,
  ),
);
