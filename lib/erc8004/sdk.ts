/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Erc8004Metadata, Erc8004ReputationSummary } from "./types.ts";

export interface PrepareValidationInput {
  evaluationPublicId: string;
  agentId: string;
  requestHash: `0x${string}`;
}

export const veyraErc8004Sdk = {
  async getAgent(baseUrl = ""): Promise<Erc8004Metadata> {
    const res = await fetch(`${baseUrl}/api/erc8004/v1/agent`);
    if (!res.ok) {
      throw new Error(`Failed to fetch ERC-8004 agent metadata: HTTP ${res.status}`);
    }
    return res.json();
  },

  async getReputation(baseUrl = ""): Promise<Erc8004ReputationSummary> {
    const res = await fetch(`${baseUrl}/api/erc8004/v1/reputation`);
    if (!res.ok) {
      throw new Error(`Failed to fetch ERC-8004 reputation: HTTP ${res.status}`);
    }
    return res.json();
  },

  async getValidations(baseUrl = "") {
    const res = await fetch(`${baseUrl}/api/erc8004/v1/validations`);
    if (!res.ok) {
      throw new Error(`Failed to fetch ERC-8004 validations list: HTTP ${res.status}`);
    }
    return res.json();
  },

  async getValidation(requestHash: string, baseUrl = "") {
    const res = await fetch(`${baseUrl}/api/erc8004/v1/validations/${requestHash}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Validation status not found: HTTP ${res.status}`);
    }
    return res.json();
  },

  async prepareValidation(input: PrepareValidationInput, baseUrl = "") {
    const res = await fetch(`${baseUrl}/api/erc8004/v1/validations/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Failed to prepare ERC-8004 validation: HTTP ${res.status}`);
    }
    return res.json();
  },
};
