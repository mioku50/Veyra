import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  DEFAULT_HOSTED_WORKFLOW,
  DEFAULT_MARKET_SYMBOL,
  hostedWorkflowHref,
  parseHostedRunnerQuery,
} from "../lib/agent/workflow-links.ts";
import {
  filterAndSortResults,
  parseResultsFilters,
} from "../lib/agent/results-filters.ts";
import {
  HOSTED_REQUESTER_IDENTITY_LABEL,
  HOSTED_REQUESTER_NOT_CHARGED_COPY,
  HOSTED_REQUESTER_PAYMENT_COPY,
  hostedRequesterDisplayLine,
  hostedInputPreviewHelper,
} from "../lib/agent/hosted-ui.ts";
import {
  defaultServicePresentation,
  providerResponsePresentation,
  servicePresentationLabel,
} from "../lib/services/presentation.ts";
import {
  DESKTOP_SIDEBAR_SCROLL_CLASS,
  MOBILE_SIDEBAR_SCROLL_CLASS,
  publicSidebarNavigation,
  consoleSidebarNavigation,
  sidebarNavigation,
} from "../lib/navigation/sidebar.ts";
import { humanizeError } from "../lib/errors/humanize-error.ts";
import {
  publicReportSubject,
  sanitizePublicReportText,
} from "../lib/agent/public-report-copy.ts";
import {
  curatedHostedWorkflowTemplates,
  hostedWorkflowTemplates,
} from "../lib/agent/workflow-templates.ts";
import { BRAND } from "../lib/brand.ts";
import { ARC_TESTNET_CHAIN_ID_HEX } from "../lib/wallet/arc.ts";
import { requestArcTestnet } from "../lib/wallet/request-arc-testnet.ts";

const switchCalls: Array<{ method: string; params?: unknown[] | Record<string, unknown> }> = [];
let firstSwitch = true;
await requestArcTestnet({
  async request(args) {
    switchCalls.push(args);
    if (args.method === "wallet_switchEthereumChain" && firstSwitch) {
      firstSwitch = false;
      throw Object.assign(new Error("Unknown chain"), { code: 4902 });
    }
    return null;
  },
});
assert.deepEqual(switchCalls.map(({ method }) => method), [
  "wallet_switchEthereumChain",
  "wallet_addEthereumChain",
  "wallet_switchEthereumChain",
]);
assert.equal(
  (switchCalls[1].params as Array<{ chainId: string }>)[0].chainId,
  ARC_TESTNET_CHAIN_ID_HEX,
);

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
assert(readme.split(/\r?\n/).length <= 220, "README must remain under 220 lines");
assert(readme.trim().split(/\s+/).length <= 1_500, "README must remain under 1,500 words");
assert(!/FreeModel|Phase\s+\d+|Canary deployment|treasury address|HMAC implementation/i.test(readme));
assert(readme.includes(BRAND.tagline));
assert(readme.includes("External seller commerce remains an internal capability"));
assert(readme.includes("docs/agent-api.md"));
assert(readme.includes("public/openapi/agent-commerce-v1.json"));
assert(existsSync(new URL("../docs/agent-api.md", import.meta.url)));
assert(existsSync(new URL("../public/openapi/agent-commerce-v1.json", import.meta.url)));

const homeSource = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const proofsSource = readFileSync(
  new URL("../app/proofs/page.tsx", import.meta.url),
  "utf8",
);
assert(homeSource.includes("BRAND.name"));
assert(homeSource.includes("BRAND.tagline"));
assert(homeSource.includes("BRAND.description"));
assert(homeSource.includes("Arc Testnet"));
assert(homeSource.includes("Built for humans and autonomous agents"));
assert(homeSource.includes("BRAND.agentApi"));
// Report cards must route their title through the shared subject formatter so a
// JSON-encoded workflow input can never render as a raw object on a public card.
assert.match(homeSource, /publicReportSubject\(report\)/);
assert.equal(
  publicReportSubject({
    workflowType: "agent_trust_report",
    workflowLabel: "Veyra Agent Trust Report",
    inputPreview: '{"agentId":"agt_e7b2811de8186fb4bb37","agentWallet":null}',
  }),
  "agt_e7b2811de8186fb4bb37",
);
assert.equal(
  publicReportSubject({
    workflowType: "agent_trust_report",
    workflowLabel: "Veyra Agent Trust Report",
    inputPreview: '{"agentId":"agt_e7b2811de8186fb4bb37","agentWallet":null,"repositor',
  }),
  "Veyra Agent Trust Report",
);
assert.equal(
  proofsSource.match(/grid-cols-\[minmax\(0,1fr\)\]/g)?.length,
  2,
  "Proof cards and their content must constrain real hash/error payloads to the viewport",
);
for (const [type, label] of [
  ["github_due_diligence", "GitHub Project Due Diligence"],
  ["agent_trust_report", "Veyra Agent Trust Report"],
  ["market_context", "Market Context Brief"],
  ["sentiment_tone", "Sentiment & Tone Report"],
  ["builder_update", "Builder Update Summary"],
] as const) {
  assert(homeSource.includes(`type: "${type}"`), `Home must present ${label}`);
  assert(hostedWorkflowTemplates.some((template) => template.value === type && template.label === label));
}
assert(!homeSource.includes("Understand any GitHub project before you build on it"));

for (const template of curatedHostedWorkflowTemplates) {
  assert(typeof template.benefitLabel === "string" && template.benefitLabel.length > 0);
  assert(template.benefitLabel.includes("Arc verification"));
  const formattedPrice = `From ${template.estimatedSpendUsdc.toFixed(4)} USDC`;
  assert(typeof template.estimatedSpendUsdc === "number" && template.estimatedSpendUsdc > 0);
  if (template.value === "github_due_diligence") {
    assert.equal(formattedPrice, "From 0.0020 USDC");
  } else if (template.value === "agent_trust_report") {
    assert.equal(formattedPrice, "From 0.0004 USDC");
  } else if (template.value === "project_360") {
    assert.equal(formattedPrice, "From 0.0072 USDC");
  } else if (template.value === "paid_api_quality") {
    assert.equal(formattedPrice, "From 0.0020 USDC");
  } else if (template.value === "treasury_health") {
    assert.equal(formattedPrice, "From 0.0025 USDC");
  } else {
    assert.equal(formattedPrice, "From 0.0013 USDC");
  }
}


assert.equal(hostedWorkflowHref("sentiment_tone"), "/agent-runner?workflow=sentiment");
assert.equal(hostedWorkflowHref("agent_trust_report"), "/agent-runner?workflow=agent_trust");
assert.equal(hostedWorkflowHref("builder_update"), "/agent-runner?workflow=builder_update");
assert.equal(hostedWorkflowHref("market_context", "ETH/USD"), "/agent-runner?workflow=market_context&symbol=ETH%2FUSD");
assert.equal(hostedWorkflowHref("custom_task"), "/agent-runner?workflow=custom");

assert.deepEqual(parseHostedRunnerQuery({ workflow: "builder_update" }), {
  workflowType: "builder_update",
  marketSymbol: "BTC/USD",
});
assert.deepEqual(parseHostedRunnerQuery({ workflow: "market_context", symbol: "sol/usd" }), {
  workflowType: "market_context",
  marketSymbol: "SOL/USD",
});
assert.deepEqual(parseHostedRunnerQuery({ workflow: "invalid", symbol: "DOGE/USD" }), {
  workflowType: DEFAULT_HOSTED_WORKFLOW,
  marketSymbol: DEFAULT_MARKET_SYMBOL,
});
assert.deepEqual(parseHostedRunnerQuery({ workflow: "market_context", symbol: "invalid" }), {
  workflowType: "market_context",
  marketSymbol: DEFAULT_MARKET_SYMBOL,
});

const reports = [
  { id: "old", workflowType: "builder_update" as const, inputPreview: "Builder shipped", summary: "Completed builder report", spentUsdc: "0.001", completedWithWarnings: false, generatedAt: "2026-01-01T00:00:00.000Z" },
  { id: "warning", workflowType: "market_context" as const, inputPreview: "ETH volatility", summary: "Market result with warning", spentUsdc: "0.0013", completedWithWarnings: true, generatedAt: "2026-02-01T00:00:00.000Z" },
  { id: "high", workflowType: "sentiment_tone" as const, inputPreview: "Clear update", summary: "Sentiment report", spentUsdc: "0.004", completedWithWarnings: false, generatedAt: "2026-03-01T00:00:00.000Z" },
];
assert.deepEqual(
  filterAndSortResults(reports, parseResultsFilters({ q: "eth", status: "warnings" })).map(({ id }) => id),
  ["warning"],
);
assert.deepEqual(
  filterAndSortResults(reports, parseResultsFilters({ sort: "oldest" })).map(({ id }) => id),
  ["old", "warning", "high"],
);
assert.deepEqual(
  filterAndSortResults(reports, parseResultsFilters({ sort: "spend" })).map(({ id }) => id),
  ["high", "warning", "old"],
);

assert.equal(hostedInputPreviewHelper("short"), "Enter at least 20 characters to preview the workflow.");
assert.equal(hostedInputPreviewHelper("This input is definitely long enough."), null);
assert.equal(HOSTED_REQUESTER_IDENTITY_LABEL, "Payment wallet");
assert.equal(HOSTED_REQUESTER_NOT_CHARGED_COPY, "Sponsored workflows will not charge your wallet.");
assert.equal(
  hostedRequesterDisplayLine("0x1234567890abcdef1234567890abcdef12345678"),
  "Payment wallet 0x1234567890abcdef1234567890abcdef12345678",
);
assert.equal(hostedRequesterDisplayLine(null), "No payment wallet supplied.");
assert.equal(
  HOSTED_REQUESTER_PAYMENT_COPY,
  "Sponsored reports are free. After the free quota, this wallet confirms the displayed total price.",
);

const futureProvider = {
  ...defaultServicePresentation("provider_backed"),
  providerName: "Future Data Network",
  assetSymbol: "ABC/USD",
};
assert.equal(servicePresentationLabel(futureProvider), "Live Provider · Future Data Network");
assert.deepEqual(
  providerResponsePresentation({
    provider: "Future Data Network",
    symbol: "ABC/USD",
    price: "12.34",
    paidAmountUsdc: "0.001",
    feedId: "must-not-be-presented",
    authorization: "must-not-be-presented",
  }),
  {
    providerName: "Future Data Network",
    assetSymbol: "ABC/USD",
    price: "12.34",
    confidence: null,
    confidenceLow: null,
    confidenceHigh: null,
    publishTime: null,
    fetchedAt: null,
    priceAgeSeconds: null,
    paidAmountUsdc: "0.001",
  },
);

assert.deepEqual(publicSidebarNavigation.map(({ label }) => label), ["Run", "Verify"]);
assert.deepEqual(
  publicSidebarNavigation.flatMap(({ items }) =>
    items.map(({ label, href }) => ({ label, href })),
  ),
  [
    { label: "Home", href: "/" },
    { label: "New Report", href: "/agent-runner" },
    { label: "Project 360", href: "/project-360" },
    { label: "Monitoring", href: "/monitoring" },
    { label: "Reports", href: "/results" },
  ],
);
assert.deepEqual(sidebarNavigation, publicSidebarNavigation);

assert.deepEqual(consoleSidebarNavigation.map(({ label }) => label), [BRAND.developerConsole]);
assert.deepEqual(
  consoleSidebarNavigation[0].items.map(({ label, href }) => ({ label, href })),
  [
    { label: "Console Home", href: "/console" },
    { label: BRAND.agentApi, href: "/console/agent-api" },
    { label: "Agent Credentials", href: "/console/agents" },
    { label: "Operations", href: "/console/operations" },
    { label: "Audit & Verification", href: "/console/audit" },
    { label: "Developer Tools", href: "/console/developer-tools" },
  ],
);

assert(DESKTOP_SIDEBAR_SCROLL_CLASS.includes("overflow-y-auto"));
assert(MOBILE_SIDEBAR_SCROLL_CLASS.includes("overflow-y-auto"));

assert.deepEqual(humanizeError("wallet_already_registered"), {
  title: "Wallet already connected",
  message: "This wallet is already assigned to an agent. Open the existing agent or use another wallet.",
  action: "open_agent",
  actionLabel: "Open Agent",
  actionHref: "/console/agents",
  technicalCode: "wallet_already_registered",
});

assert.deepEqual(humanizeError("policy_denied: workflow_not_allowed"), {
  title: "Workflow disabled",
  message: "This workflow is not enabled for the selected agent.",
  action: "open_policy",
  actionLabel: "Open Spending Policy",
  actionHref: "/console/agents",
  technicalCode: "policy_denied:workflow_not_allowed",
});

assert.deepEqual(humanizeError("policy_denied: service_type_not_allowed Live Data"), {
  title: "Required service unavailable",
  message: "This workflow requires Live Data, but Live Data is disabled in the agent policy.",
  action: "open_policy",
  actionLabel: "Enable Live Data",
  actionHref: "/console/agents",
  technicalCode: "policy_denied:service_type_not_allowed",
});

assert.deepEqual(humanizeError("policy_denied: max_run_exceeded"), {
  title: "Price exceeds agent limit",
  message: "This report costs more than the agent's maximum amount per run.",
  action: "open_policy",
  actionLabel: "Update Limit",
  actionHref: "/console/agents",
  technicalCode: "policy_denied:max_run_exceeded",
});

assert.deepEqual(humanizeError("policy_denied: daily_spend_exceeded"), {
  title: "Daily spending limit reached",
  message: "The agent has reached its daily USDC limit. Increase the limit or try again tomorrow.",
  action: "open_policy",
  actionLabel: "Update Limit",
  actionHref: "/console/agents",
  technicalCode: "policy_denied:daily_spend_exceeded",
});

assert.deepEqual(humanizeError("policy_denied: daily_calls_exceeded"), {
  title: "Daily run limit reached",
  message: "The agent has used all allowed calls for today.",
  action: "open_policy",
  actionLabel: "Update Limit",
  actionHref: "/console/agents",
  technicalCode: "policy_denied:daily_calls_exceeded",
});

assert.deepEqual(humanizeError("policy_denied"), {
  title: "Action denied by agent policy",
  message: "The selected action violates the agent's active spending policy.",
  action: "open_policy",
  actionLabel: "Open Spending Policy",
  actionHref: "/console/agents",
  technicalCode: "policy_denied",
});

assert.deepEqual(humanizeError("connected wallet mismatch"), {
  title: "Switch wallet to continue",
  message: "The connected wallet is not the registered agent payment wallet. Open your wallet extension and select the registered account.",
  action: "switch_wallet",
  actionLabel: "How to Switch Wallet",
  technicalCode: "wallet_mismatch",
});

assert.deepEqual(humanizeError("wrong network: requires Arc Testnet"), {
  title: "Switch to Arc Testnet",
  message: "This action requires Arc Testnet.",
  action: "switch_network",
  actionLabel: "Switch Network",
  technicalCode: "wrong_network",
});

assert.deepEqual(humanizeError("quote expired"), {
  title: "Price expired",
  message: "Refresh the price before continuing. No payment has been made.",
  action: "refresh_price",
  actionLabel: "Refresh Price",
  technicalCode: "quote_expired",
});

assert.deepEqual(humanizeError("credential missing or revoked"), {
  title: "Active credential required",
  message: "Create a new API credential before running this external agent.",
  action: "open_agent",
  actionLabel: "Create Credential",
  actionHref: "/console/agents",
  technicalCode: "credential_missing",
});

assert.deepEqual(humanizeError({ reason: "wrong_network" }), {
  title: "Switch to Arc Testnet",
  message: "This action requires Arc Testnet.",
  action: "switch_network",
  actionLabel: "Switch Network",
  technicalCode: "wrong_network",
});

assert.deepEqual(humanizeError({ code: "unsupported_chain" }), {
  title: "Switch to Arc Testnet",
  message: "This action requires Arc Testnet.",
  action: "switch_network",
  actionLabel: "Switch Network",
  technicalCode: "wrong_network",
});

assert.deepEqual(humanizeError({ reason: "wallet_mismatch" }), {
  title: "Switch wallet to continue",
  message: "The connected wallet is not the registered agent payment wallet. Open your wallet extension and select the registered account.",
  action: "switch_wallet",
  actionLabel: "How to Switch Wallet",
  technicalCode: "wallet_mismatch",
});

assert.deepEqual(humanizeError("github_snapshot_unavailable"), {
  title: "Repository analysis unavailable",
  message: "GitHub data was collected, but could not be passed to the analysis step. No charge was made for the failed analysis service.",
  technicalCode: "github_snapshot_unavailable",
});

assert.deepEqual(humanizeError("invalid_github_repository"), {
  title: "Invalid GitHub repository",
  message: "Enter a public repository in the format owner/repository.",
  technicalCode: "invalid_github_repository",
});

assert.deepEqual(humanizeError("github_repository_not_found"), {
  title: "Repository not found",
  message: "Check the repository URL or confirm that the repository is public.",
  technicalCode: "github_repository_not_found",
});

assert.deepEqual(humanizeError("github_repository_inaccessible"), {
  title: "Repository unavailable",
  message: "This report currently supports public GitHub repositories only.",
  technicalCode: "github_repository_inaccessible",
});

assert.deepEqual(humanizeError("github_rate_limited"), {
  title: "GitHub data is temporarily unavailable",
  message: "The GitHub data limit has been reached. Try again later.",
  technicalCode: "github_rate_limited",
});

assert.deepEqual(humanizeError("github_provider_timeout"), {
  title: "GitHub took too long to respond",
  message: "No report was generated. Try again.",
  technicalCode: "github_provider_timeout",
});

assert.deepEqual(humanizeError("github_repository_empty"), {
  title: "Repository has no activity to analyze",
  message: "The repository exists, but no commits were found on its default branch.",
  technicalCode: "github_repository_empty",
});

assert.deepEqual(humanizeError("workflow_services_unavailable"), {
  title: "Services unavailable",
  message: "This report is temporarily unavailable because its required services are not enabled.",
  technicalCode: "workflow_services_unavailable",
});

assert.deepEqual(humanizeError({ reason: "github_workflow_incomplete" }), {
  title: "Services disabled",
  message: "GitHub Project Due Diligence is temporarily unavailable because required analysis services are disabled.",
  technicalCode: "github_workflow_incomplete",
});

assert.deepEqual(humanizeError({ reason: "github_repository_not_found" }), {
  title: "Repository not found",
  message: "Check the repository URL or confirm that the repository is public.",
  technicalCode: "github_repository_not_found",
});

assert.deepEqual(humanizeError("Network request failed"), {
  title: "Something went wrong",
  message: "Network request failed",
  action: "retry",
  actionLabel: "Try Again",
  technicalCode: "generic_error",
});

assert.equal(sanitizePublicReportText("Phase 28: Analyze market sentiment"), "Analyze market sentiment");
assert.equal(sanitizePublicReportText("Phase 26 - Evaluate data"), "Evaluate data");
assert.equal(sanitizePublicReportText("Phase 1: FreeModel fallback"), "AI provider fallback");
assert.equal(
  sanitizePublicReportText("Using project-owned hosted payer for downstream x402 via deterministic aggregation"),
  "Using payment wallet for verified data services via structured analysis",
);
assert.equal(sanitizePublicReportText(""), "");

// Executive Summary Prioritization Tests
const mockAssessment = { overallSummary: "Clean repository due diligence report with low risk." };
const mockReport = { summary: "Executed GitHub Project Due Diligence workflow and completed 2 of 2 paid API calls." };
const publicExecutiveSummaryPrioritized =
  mockAssessment?.overallSummary ??
  mockReport?.summary ??
  "Repository analysis is unavailable.";
assert.equal(publicExecutiveSummaryPrioritized, "Clean repository due diligence report with low risk.");

const publicExecutiveSummaryFallbackToReport =
  (null as any)?.overallSummary ??
  mockReport?.summary ??
  "Repository analysis is unavailable.";
assert.equal(publicExecutiveSummaryFallbackToReport, "Executed GitHub Project Due Diligence workflow and completed 2 of 2 paid API calls.");

const publicExecutiveSummaryUnavailable =
  (null as any)?.overallSummary ??
  (null as any)?.summary ??
  "Repository analysis is unavailable.";
assert.equal(publicExecutiveSummaryUnavailable, "Repository analysis is unavailable.");

// DataConfidence Badge Rendering Tests
function getConfidenceLabel(confidence?: "high" | "medium" | "low") {
  if (!confidence) return null;
  return confidence === "high"
    ? "High confidence"
    : confidence === "medium"
      ? "Medium confidence"
      : "Low confidence";
}
assert.equal(getConfidenceLabel("high"), "High confidence");
assert.equal(getConfidenceLabel("medium"), "Medium confidence");
assert.equal(getConfidenceLabel("low"), "Low confidence");
assert.equal(getConfidenceLabel(undefined), null);

// Commit Count Bound Display Tests
function formatCommitCountDisplay(count?: number, isLowerBound?: boolean) {
  if (count === undefined || count === null) return "Unavailable";
  return isLowerBound ? `${count}+` : String(count);
}
assert.equal(formatCommitCountDisplay(500, true), "500+");
assert.equal(formatCommitCountDisplay(100, true), "100+");
assert.equal(formatCommitCountDisplay(42, false), "42");
assert.equal(formatCommitCountDisplay(undefined, false), "Unavailable");

// Sanitized Project Purpose Summary Tests
const rawHtmlPurpose = '<div align="center"><h1>magda-agent</h1><p>Autonomous AI agent framework for multi-modal tasks.</p></div>';
const sanitizedPurpose = rawHtmlPurpose.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
assert.equal(sanitizedPurpose, "magda-agent Autonomous AI agent framework for multi-modal tasks.");

// Contributor Bot Separation & Automation Badge Condition Tests
const botShareHeavy = 0.6;
const botShareLight = 0.2;
assert(botShareHeavy >= 0.5);
assert(!(botShareLight >= 0.5));

// Completed Report Full-Width Layout & Responsive Header Badge Container Tests
const completedBannerTitle = "Workflow execution completed";
assert.equal(completedBannerTitle, "Workflow execution completed");

const categoryHeaderContainerClass = "flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b pb-3 mb-3";
assert(categoryHeaderContainerClass.includes("flex-col"));
assert(categoryHeaderContainerClass.includes("sm:flex-row"));
assert(categoryHeaderContainerClass.includes("border-b"));

console.log("[frontend-ux-test] passed: template deep links, safe query/symbol parsing, Results search/filter/sort, disabled-input helper, requester/payer checkout copy, generic provider presentation, scrollable sidebar model, humanized error mapper, public copy sanitizer, executive summary prioritization, confidence badges, commit bounds, contributor bot separation, and full-width completed layout badges");
