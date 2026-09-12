/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import type { EvaluatorMetadata } from "./types.ts";

export interface PrepareDeliverableInput {
  title: string;
  summary: string;
  result: Record<string, unknown>;
  evidence?: Array<{ type: string; uri?: string; hash?: `0x${string}`; description: string }>;
  contentUri: string;
}

export interface EvaluateInput {
  jobId: string | number | bigint;
  contentUri: string;
}

export const veyraErc8183Sdk = {
  async getEvaluator(baseUrl = ""): Promise<EvaluatorMetadata> {
    const res = await fetch(`${baseUrl}/api/erc8183/v1/evaluator`);
    if (!res.ok) {
      throw new Error(`Failed to fetch evaluator metadata: HTTP ${res.status}`);
    }
    return res.json();
  },

  async prepareDeliverable(input: PrepareDeliverableInput, baseUrl = "") {
    const res = await fetch(`${baseUrl}/api/erc8183/v1/deliverables/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Failed to prepare deliverable: HTTP ${res.status}`);
    }
    return res.json();
  },

  async evaluate(input: EvaluateInput, baseUrl = "") {
    const res = await fetch(`${baseUrl}/api/erc8183/v1/evaluations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId: String(input.jobId),
        contentUri: input.contentUri,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Failed to submit evaluation: HTTP ${res.status}`);
    }
    return res.json();
  },

  async getEvaluation(evaluationId: string, baseUrl = "") {
    const res = await fetch(`${baseUrl}/api/erc8183/v1/evaluations/${evaluationId}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Evaluation not found: HTTP ${res.status}`);
    }
    return res.json();
  },
};
