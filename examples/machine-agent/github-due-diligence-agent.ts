import {
  AgentCommerceApiError,
  AgentCommerceClient,
} from "../../sdk/typescript/src/index.ts";

const credential = process.env.ARC_AGENT_COMMERCE_API_KEY;
if (!credential) {
  throw new Error(
    "Set ARC_AGENT_COMMERCE_API_KEY to a Veyra Agent API credential shown once in Veyra Developer Console.",
  );
}

const repository =
  process.argv[2] ?? "circlefin/developer-controlled-wallets-web-sdk";
const client = new AgentCommerceClient({
  baseUrl:
    process.env.ARC_AGENT_COMMERCE_BASE_URL ??
    "https://agent-commerce-six.vercel.app",
  credential,
});

try {
  const workflows = await client.listWorkflows();
  if (!workflows.some((workflow) => workflow.id === "github_due_diligence")) {
    throw new Error("GitHub Due Diligence is not enabled for this credential.");
  }

  const execution = await client.executeWorkflow(
    {
      workflow: "github_due_diligence",
      repository,
    },
    {
      quoteIdempotencyKey:
        process.env.QUOTE_IDEMPOTENCY_KEY ?? `github-quote-${repository}`,
      runIdempotencyKey:
        process.env.RUN_IDEMPOTENCY_KEY ?? `github-run-${repository}`,
      wait: {
        timeoutMs: 5 * 60 * 1_000,
        onStatus: (status) => {
          process.stdout.write(
            `run=${status.runId} status=${status.status} progress=${Math.round(status.progress * 100)}%\n`,
          );
        },
      },
    },
  );

  const verdict = execution.report.verdict;
  process.stdout.write(
    JSON.stringify(
      {
        reportId: execution.report.reportId,
        workflow: execution.report.workflow,
        verdict: verdict
          ? {
              code: verdict.code,
              label: verdict.label,
              confidence: verdict.confidence,
            }
          : null,
        verification: execution.report.verification,
      },
      null,
      2,
    ) + "\n",
  );
} catch (error) {
  if (error instanceof AgentCommerceApiError) {
    process.stderr.write(
      `Veyra Agent API error code=${error.code} status=${error.status} retryable=${error.retryable} requestId=${error.requestId ?? "n/a"}: ${error.message}\n`,
    );
  } else {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Unknown agent error"}\n`,
    );
  }
  process.exitCode = 1;
}
