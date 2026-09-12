/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { chromium, type Page } from "playwright";
import { createClient } from "@supabase/supabase-js";
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  parseUnits,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { arcTestnetChain } from "../lib/wallet/arc.ts";
import { tryGetServerSupabaseConfig } from "../lib/supabase/server-env.ts";
import {
  computeProject360ReportHash,
  validateProject360ReportPayload,
} from "../lib/project-360/report.ts";

type JsonObject = Record<string, any>;
type SessionAccount = ReturnType<typeof privateKeyToAccount>;
type Candidate = {
  id: string;
  type: string;
  module: string;
  value: string;
  confidence: string;
  confidenceScore: number;
  included: boolean;
  validationStatus: string;
  provenance: {
    origin: string;
    file: string | null;
    lineStart: number | null;
    lineEnd: number | null;
  };
};

const REPOSITORY = "https://github.com/mioku50/Agent-Commerce";
const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1440, height: 1000 },
] as const;
const ACCEPTANCE_RUN_UUID = crypto.randomUUID();

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function requiredArgument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function productionUrl() {
  const confirmed = requiredArgument("--confirm-production");
  const configured = process.env.VEYRA_PRODUCTION_URL?.trim();
  assert(confirmed, "Pass --confirm-production with the exact Production URL.");
  const url = new URL(confirmed);
  assert(url.protocol === "https:", "Production acceptance requires HTTPS.");
  if (configured) {
    assert(
      new URL(configured).origin === url.origin,
      "VEYRA_PRODUCTION_URL does not match --confirm-production.",
    );
  }
  return url.origin;
}

function requirePaidRun() {
  assert(
    process.argv.includes("--confirm-paid-run"),
    "This acceptance sends one Arc Testnet USDC payment. Pass --confirm-paid-run.",
  );
}

async function requestJson(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
  cookie?: string,
) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    redirect: "manual",
    headers: {
      Accept: "application/json",
      Origin: baseUrl,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = (await response.json().catch(() => ({}))) as JsonObject;
  return { response, body };
}

async function ownerSession(baseUrl: string, account: SessionAccount) {
  const challengeResult = await requestJson(baseUrl, "/api/byoa/management/challenges", {
    method: "POST",
    body: JSON.stringify({ wallet: account.address }),
  });
  assert(
    challengeResult.response.status === 201,
    `Owner challenge failed with HTTP ${challengeResult.response.status}.`,
  );
  const challenge = challengeResult.body.challenge as
    | { id?: string; message?: string }
    | undefined;
  assert(challenge?.id && challenge.message, "Owner challenge response is incomplete.");
  const signature = await account.signMessage({ message: challenge.message });
  const sessionResult = await requestJson(baseUrl, "/api/byoa/management/session", {
    method: "POST",
    body: JSON.stringify({
      challengeId: challenge.id,
      message: challenge.message,
      signature,
    }),
  });
  assert(
    sessionResult.response.ok,
    `Owner session failed with HTTP ${sessionResult.response.status}.`,
  );
  const cookie = sessionResult.response.headers.get("set-cookie")?.split(";", 1)[0];
  assert(cookie, "Owner session cookie was not issued.");
  return cookie;
}

function chooseCandidates(candidates: Candidate[], baseUrl: string) {
  const requiredTypes = [
    "github_repository",
    "project_wallet",
    "agent_id",
    "arc_contract",
    "public_api_endpoint",
  ];
  for (const type of requiredTypes) {
    assert(
      candidates.some((candidate) => candidate.type === type),
      `Discovery did not produce a ${type} candidate.`,
    );
  }
  const github = candidates.find(
    (candidate) =>
      candidate.type === "github_repository" &&
      candidate.module === "github_due_diligence" &&
      candidate.provenance.origin === "primary",
  );
  const treasury = candidates.find(
    (candidate) =>
      candidate.type === "project_wallet" &&
      !/^0x0{40}$/i.test(candidate.value),
  );
  const contract = candidates.find(
    (candidate) =>
      candidate.type === "arc_contract" &&
      !/^0x0{40}$/i.test(candidate.value),
  );
  const endpoint = candidates.find(
    (candidate) =>
      candidate.type === "public_api_endpoint" &&
      candidate.value.startsWith(baseUrl) &&
      candidate.value.includes("console/agent-api"),
  ) ?? candidates.find(
    (candidate) =>
      candidate.type === "public_api_endpoint" && candidate.value.startsWith(baseUrl),
  );
  assert(github && treasury && contract && endpoint, "Discovery lacks the expected acceptance sources.");
  // Production currently has no qualifying Paid API Quality observation history
  // for the discovered endpoint. Keep the syntactically valid candidate visible
  // and unselected instead of turning a single availability probe into an
  // invented quality score. The final acceptance run selects only modules with
  // sufficient real evidence so every selected module must complete.
  return [github, treasury, contract];
}

function assertCandidateSafety(candidates: Candidate[]) {
  assert(candidates.length >= 5, "Discovery returned too few candidates.");
  assert(
    candidates.every(
      (candidate) =>
        candidate.included === false &&
        ["high", "medium", "low"].includes(candidate.confidence) &&
        candidate.confidenceScore >= 0.4 &&
        candidate.confidenceScore <= 1,
    ),
    "Candidates were preselected or lack bounded confidence.",
  );
  assert(
    candidates
      .filter((candidate) => candidate.provenance.origin !== "primary")
      .every(
        (candidate) =>
          typeof candidate.provenance.file === "string" &&
          Number.isInteger(candidate.provenance.lineStart) &&
          Number(candidate.provenance.lineStart) > 0,
      ),
    "A discovered candidate lacks file/line provenance.",
  );
}

async function noHorizontalOverflow(page: Page, label: string) {
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    offenders: Array.from(document.querySelectorAll<HTMLElement>("body *"))
      .filter((element) =>
        element.scrollWidth > element.clientWidth + 1 &&
        !Array.from(element.children).some((child) => {
          const nested = child as HTMLElement;
          return nested.scrollWidth > nested.clientWidth + 1;
        })
      )
      .slice(0, 10)
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        className: element.className.toString().slice(0, 120),
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        text: (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 80),
      })),
  }));
  assert(
    dimensions.scrollWidth <= dimensions.clientWidth + 1,
    `${label} has horizontal overflow (${dimensions.scrollWidth} > ${dimensions.clientWidth}); offenders=${JSON.stringify(dimensions.offenders)}.`,
  );
}

async function runQuoteUiAtViewport(input: {
  browser: Awaited<ReturnType<typeof chromium.launch>>;
  baseUrl: string;
  cookie: string;
  viewport: (typeof VIEWPORTS)[number];
  selected?: Candidate[];
  expectedDiscoveryId?: string;
  expectedQuoteId?: string;
}) {
  const context = await input.browser.newContext({ viewport: input.viewport });
  const [cookieName, ...cookieParts] = input.cookie.split("=");
  await context.addCookies([{
    name: cookieName,
    value: cookieParts.join("="),
    url: input.baseUrl,
  }]);
  await context.addInitScript((stableUuid) => {
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      value: () => stableUuid,
    });
  }, ACCEPTANCE_RUN_UUID);
  const page = await context.newPage();
  try {
    await page.goto(`${input.baseUrl}/project-360`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: /Discover first\. Confirm evidence\. Pay once\./ }).waitFor();
    await page.getByPlaceholder("https://github.com/owner/repository").fill(REPOSITORY);
    const discoveryResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/project-360/discoveries",
    );
    await page.getByRole("button", { name: "Run free discovery" }).click();
    const discoveryResponse = await discoveryResponsePromise;
    const discoveryBody = (await discoveryResponse.json()) as JsonObject;
    assert(
      discoveryResponse.ok() && discoveryBody.discovery?.status === "ready",
      `Discovery UI failed at ${input.viewport.width}px (HTTP ${discoveryResponse.status()}, status ${String(discoveryBody.discovery?.status ?? "missing")}, code ${String(discoveryBody.error?.code ?? "none")}).`,
    );
    const discovery = discoveryBody.discovery as JsonObject;
    assert(discovery.free === true && discovery.paymentRequired === false, "Discovery is not free.");
    if (input.expectedDiscoveryId) {
      assert(discovery.id === input.expectedDiscoveryId, "Responsive replay created a second discovery.");
    }
    const candidates = discovery.candidates as Candidate[];
    assertCandidateSafety(candidates);
    const checkboxes = page.locator('input[type="checkbox"]');
    await checkboxes.first().waitFor();
    assert(
      await checkboxes.count() === candidates.length,
      "Discovery UI did not render every candidate checkbox.",
    );
    for (let index = 0; index < await checkboxes.count(); index += 1) {
      assert(!(await checkboxes.nth(index).isChecked()), "A paid module was selected by default.");
    }

    const selected = input.selected ?? chooseCandidates(candidates, input.baseUrl);
    for (const candidate of selected) {
      const label = page.locator("label").filter({ hasText: candidate.value }).first();
      await label.getByRole("checkbox").check();
      await label.getByText(new RegExp(`${candidate.confidence}.*${Math.round(candidate.confidenceScore * 100)}%`, "i")).waitFor();
      if (candidate.provenance.file && candidate.provenance.lineStart) {
        await label.getByText(`${candidate.provenance.file}:${candidate.provenance.lineStart}`, { exact: false }).waitFor();
      }
    }

    const quoteResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST" &&
      /\/api\/project-360\/discoveries\/dsc_[0-9a-f]{20}\/quote$/.test(
        new URL(response.url()).pathname,
      ),
    );
    await page.getByRole("button", { name: "Build transparent quote" }).click();
    const quoteResponse = await quoteResponsePromise;
    const quoteBody = (await quoteResponse.json()) as JsonObject;
    assert(
      quoteResponse.ok() && quoteBody.quote?.id && quoteBody.project360,
      `Quote UI failed at ${input.viewport.width}px (HTTP ${quoteResponse.status()}, code ${String(quoteBody.error?.code ?? "none")}, message ${String(quoteBody.error?.message ?? "none")}).`,
    );
    if (input.expectedQuoteId) {
      assert(quoteBody.quote.id === input.expectedQuoteId, "Responsive replay created a second quote.");
    }
    assert(
      quoteBody.project360.expectedCoverage?.selected === selected.length &&
      quoteBody.project360.expectedCoverage?.total === 5,
      "Expected coverage does not match the explicit selection.",
    );
    assert(
      Array.isArray(quoteBody.project360.lineItems) &&
      quoteBody.project360.lineItems.length === selected.length + 1 &&
      quoteBody.project360.lineItems.every((item: JsonObject) => Number(item.priceUsdc) > 0),
      "Itemized module/finalization prices are incomplete.",
    );
    const lineItemTotal = quoteBody.project360.lineItems.reduce(
      (sum: number, item: JsonObject) => sum + Number(item.priceUsdc),
      0,
    );
    assert(
      Math.abs(lineItemTotal - Number(quoteBody.quote.pricing.estimatedProviderCostUsdc)) < 0.000001,
      "Itemized prices do not equal the provider subtotal.",
    );
    assert(
      Number(quoteBody.quote.pricing.listPriceUsdc) ===
        Number(quoteBody.project360.pricing.totalUsdc),
      "Displayed total differs from the immutable Project 360 quote.",
    );
    await page.getByText(`${selected.length} / 5 modules`, { exact: true }).waitFor();
    await page.getByText("Total quote price", { exact: true }).waitFor();
    await page.getByText("Incomplete-data warnings", { exact: true }).waitFor();
    await noHorizontalOverflow(page, `Project 360 quote at ${input.viewport.width}px`);
    return { discoveryBody, quoteBody, selected };
  } finally {
    await context.close();
  }
}

function collectNormalizedKeys(value: unknown, keys = new Set<string>()) {
  if (Array.isArray(value)) {
    for (const item of value) collectNormalizedKeys(item, keys);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as JsonObject)) {
      keys.add(key.replaceAll("_", "").toLowerCase());
      collectNormalizedKeys(item, keys);
    }
  }
  return keys;
}

async function waitForCompletedReport(baseUrl: string, jobId: string) {
  const deadline = Date.now() + 8 * 60_000;
  let latest: JsonObject = {};
  while (Date.now() < deadline) {
    const result = await requestJson(baseUrl, `/api/hosted-agent/jobs/${jobId}`);
    assert(result.response.ok, `Public job status returned HTTP ${result.response.status}.`);
    latest = result.body;
    if (latest.job?.status === "failed") {
      throw new Error(`Project 360 execution failed: ${latest.job?.error ?? "sanitized failure"}`);
    }
    const report = latest.job?.structuredResult?.workflowData?.report;
    if (
      latest.job?.status === "completed" &&
      report?.verification?.status === "verified"
    ) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error("Project 360 report or aggregate Arc proof did not complete in time.");
}

async function verifyReportResponsive(input: {
  browser: Awaited<ReturnType<typeof chromium.launch>>;
  baseUrl: string;
  jobId: string;
  score: number | null;
  proofHash: string;
}) {
  for (const viewport of VIEWPORTS) {
    const page = await input.browser.newPage({ viewport });
    try {
      await page.goto(`${input.baseUrl}/agent-runner/${input.jobId}`, {
        waitUntil: "domcontentloaded",
      });
      await page.getByRole("heading", { name: "Veyra Project 360 Report" }).waitFor();
      await page.getByText("Project 360 module progress", { exact: true }).waitFor();
      await page.getByTestId("project-360-module-statuses").waitFor();
      await page.getByText("Section 15", { exact: true }).waitFor();
      await page.getByRole("heading", { name: "Project Trust Score", exact: true }).waitFor();
      await page.getByText(input.proofHash, { exact: true }).waitFor();
      await page.getByRole("link", { name: "View aggregate proof on Arc" }).waitFor();
      assert(
        await page.locator('section:has-text("Section ")').count() >= 15,
        "The Production report does not render all 15 sections.",
      );
      if (input.score !== null) {
        await page.getByText(`${input.score}/100`, { exact: true }).waitFor();
      }
      await noHorizontalOverflow(page, `Project 360 report at ${viewport.width}px`);
    } finally {
      await page.close();
    }
  }
}

async function main() {
  requirePaidRun();
  const baseUrl = productionUrl();
  const privateKey =
    process.env.PHASE26_CHECKOUT_PRIVATE_KEY?.trim() ??
    process.env.BUYER_PRIVATE_KEY?.trim();
  assert(
    privateKey && /^0x[0-9a-fA-F]{64}$/.test(privateKey),
    "PHASE26_CHECKOUT_PRIVATE_KEY or BUYER_PRIVATE_KEY is required for the paid Production acceptance.",
  );
  const account = privateKeyToAccount(privateKey as Hex);
  const serverConfig = tryGetServerSupabaseConfig();
  assert(serverConfig, "Production service-role Supabase configuration is required.");
  const server = createClient(serverConfig.url, serverConfig.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const rpcUrl = process.env.ARC_TESTNET_RPC_URL?.trim() || arcTestnetChain.rpcUrls.default.http[0];
  const publicClient = createPublicClient({ chain: arcTestnetChain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain: arcTestnetChain, transport: http(rpcUrl) });
  const chainId = await publicClient.getChainId();
  assert(chainId === 5_042_002, "The acceptance wallet is not connected to Arc Testnet.");

  const startedAt = new Date().toISOString();
  const cookie = await ownerSession(baseUrl, account);
  const browser = await chromium.launch({ headless: true });
  try {
    const first = await runQuoteUiAtViewport({
      browser,
      baseUrl,
      cookie,
      viewport: VIEWPORTS[0],
    });
    const discovery = first.discoveryBody.discovery as JsonObject;
    const quote = first.quoteBody.quote as JsonObject;
    const projectQuote = first.quoteBody.project360 as JsonObject;
    assert(quote.paymentMode === "paid", "Production acceptance requires a real paid quote, not sponsored quota.");
    assert(Number(quote.pricing.amountDueUsdc) > 0, "Paid quote amount is zero.");

    for (const viewport of VIEWPORTS.slice(1)) {
      await runQuoteUiAtViewport({
        browser,
        baseUrl,
        cookie,
        viewport,
        selected: first.selected,
        expectedDiscoveryId: discovery.id,
        expectedQuoteId: quote.id,
      });
    }

    const noPaymentsYet = await server
      .from("hosted_workflow_user_payments")
      .select("id", { count: "exact", head: true })
      .ilike("requester_wallet", account.address)
      .gte("created_at", startedAt);
    assert(!noPaymentsYet.error && noPaymentsYet.count === 0, "Discovery or quote creation produced a payment.");

    const discoveryKey = `project360-discovery-${ACCEPTANCE_RUN_UUID}`;
    const quoteKey = `project360-quote-${ACCEPTANCE_RUN_UUID}`;
    const discoveryConflict = await requestJson(
      baseUrl,
      "/api/project-360/discoveries",
      {
        method: "POST",
        headers: { "Idempotency-Key": discoveryKey },
        body: JSON.stringify({ type: "github_repository", value: "https://github.com/openai/openai-node" }),
      },
      cookie,
    );
    assert(
      discoveryConflict.response.status === 409 &&
        discoveryConflict.body.error?.code === "idempotency_conflict",
      "Changed discovery payload did not return 409 idempotency_conflict.",
    );

    const quoteConflict = await requestJson(
      baseUrl,
      `/api/project-360/discoveries/${discovery.id}/quote`,
      {
        method: "POST",
        headers: { "Idempotency-Key": quoteKey },
        body: JSON.stringify({
          revision: discovery.revision,
          selectedCandidateIds: [first.selected[0].id],
          modules: [first.selected[0].module],
        }),
      },
      cookie,
    );
    assert(
      quoteConflict.response.status === 409 && quoteConflict.body.error?.code === "idempotency_conflict",
      "Changed quote payload did not return 409 idempotency_conflict.",
    );

    const ownerB = privateKeyToAccount(generatePrivateKey());
    const cookieB = await ownerSession(baseUrl, ownerB);
    const crossDiscovery = await requestJson(
      baseUrl,
      `/api/project-360/discoveries/${discovery.id}`,
      {},
      cookieB,
    );
    assert(crossDiscovery.response.status === 404, "A foreign owner can read the discovery.");
    const crossQuote = await requestJson(
      baseUrl,
      `/api/project-360/quotes/${quote.id}/confirm`,
      {
        method: "POST",
        headers: { "Idempotency-Key": `foreign-${crypto.randomUUID()}` },
        body: "{}",
      },
      cookieB,
    );
    assert(crossQuote.response.status === 404, "A foreign owner can address the quote.");

    for (const body of [
      { selectedCandidateIds: [first.selected[0].id] },
      { modules: [...projectQuote.selectedModules, "agent_trust_report"] },
      { amountUsdc: 0 },
    ]) {
      const tamper = await requestJson(
        baseUrl,
        `/api/project-360/quotes/${quote.id}/confirm`,
        {
          method: "POST",
          headers: { "Idempotency-Key": quoteKey },
          body: JSON.stringify(body),
        },
        cookie,
      );
      assert(
        tamper.response.status === 409 && tamper.body.error?.code === "project_quote_immutable",
        "Quote/candidate/module tampering was not rejected.",
      );
    }

    for (const endpoint of [
      "https://localhost/admin",
      "https://127.0.0.1/admin",
      "https://169.254.169.254/latest/meta-data",
      "https://metadata.google.internal/computeMetadata/v1",
    ]) {
      const blocked = await requestJson(
        baseUrl,
        "/api/project-360/discoveries",
        {
          method: "POST",
          headers: { "Idempotency-Key": `ssrf-${crypto.randomUUID()}` },
          body: JSON.stringify({ type: "public_api_endpoint", value: endpoint }),
        },
        cookie,
      );
      assert(
        blocked.response.status === 400 &&
          blocked.body.error?.code === "endpoint_private_network_blocked",
        `SSRF target was not blocked: ${new URL(endpoint).hostname}`,
      );
    }

    const amount = String(quote.pricing.amountDueUsdc);
    const amountRaw = parseUnits(amount, 18);
    const initialBalance = await publicClient.getBalance({ address: account.address });
    assert(
      initialBalance > amountRaw + parseUnits("0.001", 18),
      "Buyer wallet has insufficient Arc Testnet USDC for the immutable quote and gas.",
    );
    const paymentTransaction = await walletClient.sendTransaction({
      account,
      chain: arcTestnetChain,
      to: getAddress(String(quote.treasuryAddress)),
      value: amountRaw,
      data: "0x",
    });
    const paymentReceipt = await publicClient.waitForTransactionReceipt({
      hash: paymentTransaction,
      confirmations: 1,
    });
    assert(paymentReceipt.status === "success", "The user payment reverted.");

    const confirmation = await requestJson(
      baseUrl,
      `/api/project-360/quotes/${quote.id}/confirm`,
      {
        method: "POST",
        headers: { "Idempotency-Key": quoteKey },
        body: JSON.stringify({ transactionHash: paymentTransaction }),
      },
      cookie,
    );
    assert(
      (confirmation.response.status === 200 || confirmation.response.status === 202) &&
        typeof confirmation.body.jobId === "string" &&
        typeof confirmation.body.userPaymentId === "string",
      `Project 360 confirmation failed with HTTP ${confirmation.response.status}.`,
    );
    const jobId = confirmation.body.jobId as string;
    const userPaymentId = confirmation.body.userPaymentId as string;

    const replay = await requestJson(
      baseUrl,
      `/api/project-360/quotes/${quote.id}/confirm`,
      {
        method: "POST",
        headers: { "Idempotency-Key": quoteKey },
        body: JSON.stringify({ transactionHash: paymentTransaction }),
      },
      cookie,
    );
    assert(
      replay.response.status === 200 &&
        replay.body.idempotent === true &&
        replay.body.jobId === jobId &&
        replay.body.userPaymentId === userPaymentId,
      "Confirmation replay created or returned different execution artifacts.",
    );

    const final = await waitForCompletedReport(baseUrl, jobId);
    const report = final.job.structuredResult.workflowData.report as JsonObject;
    assert(validateProject360ReportPayload(report), "Production report payload failed canonical validation.");
    assert(report.sections.length === 15, "Production report does not contain 15 sections.");
    assert(
      computeProject360ReportHash(report) === report.verification.reportHash,
      "Canonical report hash differs from the published report hash.",
    );
    assert(
      report.coverage.expected === first.selected.length &&
        report.coverage.completed === first.selected.length &&
        report.coverage.status === (first.selected.length === 5 ? "complete" : "partial"),
      "Production coverage does not reflect the immutable selection.",
    );
    const selectedModuleNames = new Set(projectQuote.selectedModules as string[]);
    assert(
      report.modules.every((module: JsonObject) =>
        selectedModuleNames.has(module.module)
          ? module.status === "completed"
          : ["not_provided", "not_selected"].includes(module.status),
      ),
      "A selected Production module did not complete or an unselected module was not normalized safely.",
    );
    assert(
      report.score.breakdown.every((item: JsonObject) =>
        report.modules.some(
          (module: JsonObject) =>
            module.module === item.module &&
            module.status === "completed" &&
            module.score !== null,
        ),
      ),
      "Project Trust Score includes an unexecuted or unscored module.",
    );
    const apiModule = report.modules.find((module: JsonObject) => module.module === "paid_api_quality");
    assert(
      apiModule && (apiModule.score === null || typeof apiModule.score === "number"),
      "Unavailable API evidence produced an invalid invented score.",
    );

    const publicKeys = collectNormalizedKeys(final);
    for (const forbidden of [
      "ownerwallet",
      "requesterwallet",
      "machinecredentialid",
      "byoaagentid",
      "workflowquoteid",
      "userpaymentid",
      "paymenteventid",
      "idempotencyhash",
      "internalerrorcode",
      "executiontelemetry",
    ]) {
      assert(!publicKeys.has(forbidden), `Public Project 360 payload leaked ${forbidden}.`);
    }

    const paymentRows = await server
      .from("hosted_workflow_user_payments")
      .select("id,quote_id,job_id,gross_amount_usdc,provider_cost_usdc,transaction_hash,status")
      .eq("quote_id", quote.id);
    assert(
      !paymentRows.error &&
        paymentRows.data?.length === 1 &&
        paymentRows.data[0].id === userPaymentId &&
        paymentRows.data[0].job_id === jobId &&
        paymentRows.data[0].transaction_hash?.toLowerCase() === paymentTransaction.toLowerCase() &&
        Number(paymentRows.data[0].gross_amount_usdc) === Number(amount) &&
        Number(paymentRows.data[0].provider_cost_usdc) ===
          Number(quote.pricing.estimatedProviderCostUsdc) &&
        paymentRows.data[0].status === "settled",
      "Payment accounting is not exactly one settled immutable-quote charge.",
    );
    const jobRows = await server
      .from("hosted_agent_jobs")
      .select("id,spent_usdc")
      .eq("workflow_quote_id", quote.id);
    assert(!jobRows.error && jobRows.data?.length === 1, "The immutable quote created duplicate executions.");
    assert(
      Number(jobRows.data[0].spent_usdc) === Number(quote.pricing.estimatedProviderCostUsdc),
      "Provider spend does not equal the immutable quote provider subtotal.",
    );
    const projectQuoteRows = await server
      .from("project_360_quotes")
      .select("quote_id")
      .eq("quote_id", quote.id);
    assert(
      !projectQuoteRows.error && projectQuoteRows.data?.length === 1,
      "The Production run does not have exactly one immutable Project 360 quote mapping.",
    );
    const moduleRows = await server
      .from("project_360_module_runs")
      .select("module,status,score,child_report_hash,attempt_count,error_code,provider,retryable,duration_ms,execution_telemetry")
      .eq("job_id", jobId)
      .order("module");
    assert(!moduleRows.error && moduleRows.data?.length === 5, "Module-run ledger is incomplete.");
    const selectedModules = new Set(projectQuote.selectedModules as string[]);
    assert(
      moduleRows.data.every((module) =>
        selectedModules.has(module.module)
          ? module.status === "completed"
          : ["not_provided", "not_selected"].includes(module.status),
      ),
      "Executed/skipped modules do not match the immutable quote.",
    );
    const treasuryModule = moduleRows.data.find((module) => module.module === "treasury_health");
    assert(
      treasuryModule?.status === "completed" &&
        treasuryModule.error_code === null &&
        treasuryModule.attempt_count >= 1 &&
        treasuryModule.attempt_count <= 3 &&
        treasuryModule.provider === "arcscan_blockscout" &&
        Number(treasuryModule.duration_ms) >= 0 &&
        Array.isArray((treasuryModule.execution_telemetry as JsonObject)?.attempts),
      "Treasury Health did not complete with bounded private attempt telemetry.",
    );
    assert(
      moduleRows.data.every((module) => module.status !== "provider_unavailable" && module.status !== "failed"),
      "Production Project 360 contains a provider or module failure.",
    );

    const aggregateProof = final.proofs.find(
      (proof: JsonObject) =>
        proof.responseHash?.toLowerCase() === report.verification.reportHash.toLowerCase(),
    );
    assert(
      aggregateProof?.status === "verified" &&
        /^0x[0-9a-f]{64}$/i.test(aggregateProof.transactionHash ?? ""),
      "The exact canonical report hash lacks a verified aggregate Arc proof.",
    );
    const proofReceipt = await publicClient.getTransactionReceipt({
      hash: aggregateProof.transactionHash as Hex,
    });
    assert(proofReceipt.status === "success", "Aggregate Arc proof transaction reverted.");
    assert(
      await publicClient.getBlockNumber() >= proofReceipt.blockNumber,
      "Aggregate Arc proof is not included in an Arc block.",
    );

    await verifyReportResponsive({
      browser,
      baseUrl,
      jobId,
      score: report.score.value,
      proofHash: report.verification.reportHash,
    });

    console.log(JSON.stringify({
      productionUrl: baseUrl,
      migration: "20260802120000_p422_project_360_module_reliability.sql",
      discoveryId: discovery.id,
      quoteId: quote.id,
      jobId,
      paymentId: userPaymentId,
      publicReportUrl: `${baseUrl}/agent-runner/${jobId}`,
      amountQuotedUsdc: amount,
      amountChargedUsdc: amount,
      providerSpendUsdc: String(jobRows.data[0].spent_usdc),
      paymentTransaction,
      selectedModules: projectQuote.selectedModules,
      moduleResults: moduleRows.data.map((module) => ({
        module: module.module,
        status: module.status,
      })),
      coverage: report.coverage,
      projectTrustScore: report.score.value,
      confidencePercent: report.score.confidencePercent,
      canonicalReportHash: report.verification.reportHash,
      arcProofTransaction: aggregateProof.transactionHash,
      idempotentReplayPassed: true,
      tenantIsolationPassed: true,
      ssrfPassed: true,
      responsiveWidths: VIEWPORTS.map((viewport) => viewport.width),
    }, null, 2));
    console.log("[p42-production-smoke] PASS");
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(
    `[p42-production-smoke] FAIL: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
