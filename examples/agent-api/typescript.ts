/**
 * Copyright 2026 Circle Internet Group, Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Veyra Agent API v1 TypeScript Client Example
 *
 * Usage:
 *   npx tsx examples/agent-api/typescript.ts <BASE_URL> <API_KEY> [REPOSITORY]
 *
 * Example:
 *   npx tsx examples/agent-api/typescript.ts https://agent-commerce.vercel.app aac_live_your_key_here circlefin/agent-commerce
 */

import { randomUUID } from "node:crypto";

/** Standard Veyra workflow / finalizer pricing constant: 0.0020 USDC */
export const DEFAULT_FINALIZER_PRICE_USDC = "0.0020";

export interface MachineErrorResponse {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    requestId: string;
  };
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  shortName: string;
  description: string;
  task: string;
  estimatedUsdc: number;
  inputSchema: Record<string, unknown>;
  arc: {
    chainId: number;
    network: string;
    asset: string;
    tokenAddress: string;
  };
}

export interface WorkflowQuoteResponse {
  quoteId: string;
  workflow: string;
  repository: { fullName: string; canonicalUrl: string } | null;
  totalUsdc: number;
  sponsored: boolean;
  expiresAt: string;
  requiredPayment: {
    network: string;
    asset: string;
    amount: number;
    treasuryAddress: string;
    chainId: number;
    transaction: null | {
      protocol: "arc_memo_erc20_v1" | "arc_native_usdc_v1";
      chainId: 5_042_002;
      to: `0x${string}`;
      value: `0x${string}`;
      data: `0x${string}`;
    };
  };
}

export interface RunLaunchResponse {
  runId: string;
  status: string;
  pollAfterMs: number;
}

export interface RunStatusResponse {
  runId: string;
  status: string;
  progress: number;
  stage: string;
  pollAfterMs: number;
  reportId?: string;
  verification?: {
    status: string;
    verifiedSteps: number;
    requiredSteps: number;
  };
}

export interface StructuredReportResponse {
  reportId: string;
  workflow: string;
  repository: { fullName: string; canonicalUrl: string } | null;
  status: string;
  executiveSummary: string;
  projectPurpose: string;
  technology: {
    primaryLanguage: string;
    frameworks: string[];
    hasWorkflows: boolean;
    workflowCount: number;
  };
  activity: {
    commitCount30d: number;
    commitCount90d: number;
    commitCount180d: number;
    lastCommitAt: string | null;
  };
  strengths: string[];
  risks: Array<{
    code: string;
    title: string;
    severity: string;
    description: string;
    impact: string;
  }>;
  questionsBeforeAdoption: string[];
  confidence: string;
  verification: {
    status: string;
    network: string;
    proofs: Array<{
      receiptId?: string;
      txHash: string;
      status: string;
      explorerUrl: string | null;
    }>;
  };
  generatedAt: string;
}

export class MachineApiClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  /**
   * 1. Discover available workflows
   */
  async listWorkflows(): Promise<WorkflowTemplate[]> {
    console.log("\n🔍 Step 1: Querying available Veyra Agent API workflows...");
    const res = await fetch(`${this.baseUrl}/api/agent/v1/workflows`, {
      method: "GET",
      headers: this.headers,
    });

    if (!res.ok) {
      const errData = (await res.json()) as MachineErrorResponse;
      throw new Error(
        `Failed to list workflows [${res.status}]: ${errData.error?.message || res.statusText}`,
      );
    }

    const data = (await res.json()) as { workflows: WorkflowTemplate[] };
    console.log(`✅ Discovered ${data.workflows.length} workflow(s):`);
    for (const wf of data.workflows) {
      console.log(`   - ${wf.name} (${wf.id}): ${wf.estimatedUsdc} USDC est.`);
    }
    return data.workflows;
  }

  /**
   * 2. Request an immutable quote with Idempotency-Key
   */
  async createQuote(
    workflow: string,
    repository: string,
    idempotencyKey?: string,
  ): Promise<WorkflowQuoteResponse> {
    const idKey = idempotencyKey || `idemp_${randomUUID()}`;
    console.log(
      `\n📜 Step 2: Creating quote for workflow '${workflow}' on '${repository}'...`,
    );
    console.log(`   - Idempotency-Key: ${idKey}`);

    const res = await fetch(`${this.baseUrl}/api/agent/v1/quotes`, {
      method: "POST",
      headers: {
        ...this.headers,
        "Idempotency-Key": idKey,
      },
      body: JSON.stringify({ workflow, repository }),
    });

    if (!res.ok) {
      const errData = (await res.json()) as MachineErrorResponse;
      throw new Error(
        `Failed to create quote [${res.status}]: ${errData.error?.message || res.statusText}`,
      );
    }

    const quote = (await res.json()) as WorkflowQuoteResponse;
    console.log(`✅ Quote Created: ${quote.quoteId}`);
    console.log(`   - Total Cost: ${quote.totalUsdc} USDC`);
    console.log(`   - Payment Mode: ${quote.sponsored ? "Sponsored Quota" : "Paid x402 Transaction"}`);
    console.log(`   - Expires At: ${quote.expiresAt}`);
    return quote;
  }

  /**
   * 3. Launch workflow run
   */
  async launchRun(
    quoteId: string,
    paymentTxHash?: string,
    idempotencyKey?: string,
  ): Promise<RunLaunchResponse> {
    const idKey = idempotencyKey || `idemp_${randomUUID()}`;
    console.log(`\n🚀 Step 3: Launching workflow run for quote '${quoteId}'...`);

    const payload: Record<string, unknown> = { quoteId };
    if (paymentTxHash) {
      payload.paymentAuthorization = {
        type: "arc_transaction",
        payload: paymentTxHash,
      };
    }

    const res = await fetch(`${this.baseUrl}/api/agent/v1/runs`, {
      method: "POST",
      headers: {
        ...this.headers,
        "Idempotency-Key": idKey,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errData = (await res.json()) as MachineErrorResponse;
      throw new Error(
        `Failed to launch run [${res.status}]: ${errData.error?.message || res.statusText}`,
      );
    }

    const run = (await res.json()) as RunLaunchResponse;
    console.log(`✅ Run Queued! Run ID: ${run.runId} (Initial status: ${run.status})`);
    return run;
  }

  /**
   * 4. Poll execution status until completed or failed
   */
  async pollUntilCompletion(
    runId: string,
    initialPollMs = 2000,
    maxAttempts = 60,
  ): Promise<RunStatusResponse> {
    console.log(`\n⏳ Step 4: Polling run execution status for '${runId}'...`);
    let pollInterval = initialPollMs;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const res = await fetch(`${this.baseUrl}/api/agent/v1/runs/${runId}`, {
        method: "GET",
        headers: this.headers,
      });

      if (!res.ok) {
        const errData = (await res.json()) as MachineErrorResponse;
        throw new Error(
          `Failed to poll run [${res.status}]: ${errData.error?.message || res.statusText}`,
        );
      }

      const statusData = (await res.json()) as RunStatusResponse;
      const pct = Math.round(statusData.progress * 100);
      console.log(
        `   [Attempt ${attempt}] Status: ${statusData.status} | Stage: ${statusData.stage} (${pct}%)`,
      );

      if (
        statusData.status === "completed" ||
        statusData.status === "completed_with_warnings" ||
        statusData.status === "failed"
      ) {
        console.log(`✅ Execution Finished with status: ${statusData.status}`);
        return statusData;
      }

      pollInterval = statusData.pollAfterMs || pollInterval;
      await new Promise((r) => setTimeout(r, pollInterval));
    }

    throw new Error(`Polling timed out after ${maxAttempts} attempts for run '${runId}'.`);
  }

  /**
   * 5. Retrieve structured final report
   */
  async getReport(reportId: string): Promise<StructuredReportResponse> {
    console.log(`\n📊 Step 5: Retrieving structured report '${reportId}'...`);
    const res = await fetch(`${this.baseUrl}/api/agent/v1/reports/${reportId}`, {
      method: "GET",
      headers: this.headers,
    });

    if (!res.ok) {
      const errData = (await res.json()) as MachineErrorResponse;
      throw new Error(
        `Failed to retrieve report [${res.status}]: ${errData.error?.message || res.statusText}`,
      );
    }

    const report = (await res.json()) as StructuredReportResponse;
    console.log(`✅ Report Retrieved Successfully!`);
    console.log(`   - Executive Summary: ${report.executiveSummary}`);
    console.log(`   - Language: ${report.technology.primaryLanguage}`);
    console.log(`   - Strengths: ${report.strengths.length}`);
    console.log(`   - Risks: ${report.risks.length}`);
    console.log(`   - Verification Status: ${report.verification.status}`);
    console.log(`   - Arc Proofs: ${report.verification.proofs.length} recorded on ${report.verification.network}`);

    if (report.verification.proofs.length > 0) {
      console.log(`\n🔗 Step 6: Arc Proof Trail:`);
      for (const proof of report.verification.proofs) {
        console.log(`   - Tx: ${proof.txHash} (${proof.status})`);
        if (proof.explorerUrl) {
          console.log(`     Explorer: ${proof.explorerUrl}`);
        }
      }
    }

    return report;
  }
}

// Runnable CLI execution entrypoint
async function main() {
  const args = process.argv.slice(2);
  const baseUrl = args[0] || process.env.API_BASE_URL || "http://localhost:3000";
  const apiKey = args[1] || process.env.API_KEY || "aac_live_demo_key";
  const repo = args[2] || "circlefin/agent-commerce";

  console.log("=================================================");
  console.log("Veyra Agent API v1 TS Example");
  console.log("=================================================");
  console.log(`Target Host: ${baseUrl}`);
  console.log(`Target Repo: ${repo}`);

  const client = new MachineApiClient(baseUrl, apiKey);

  try {
    // 1. Discover
    await client.listWorkflows();

    // 2. Quote
    const quote = await client.createQuote("github_due_diligence", repo);

    // 3. Launch handling (Sponsored vs Paid Arc Transaction)
    let paymentTxHash: string | undefined;
    if (!quote.sponsored) {
      paymentTxHash = process.env.PAYMENT_TX_HASH;
      if (!paymentTxHash) {
        console.log("\n⚠️ Paid quote requires an Arc USDC transaction.");
        console.log("   Provide PAYMENT_TX_HASH environment variable and run again.");
        return;
      }
    }

    const run = await client.launchRun(quote.quoteId, paymentTxHash);

    // 4. Poll
    const finalStatus = await client.pollUntilCompletion(run.runId);

    // 5. Retrieve Report & Verify
    if (finalStatus.reportId) {
      await client.getReport(finalStatus.reportId);
    }
    console.log("\n🎉 Complete Veyra Agent API flow completed successfully!");
  } catch (err) {
    console.error("\n❌ Veyra Agent API flow failed:", err);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
