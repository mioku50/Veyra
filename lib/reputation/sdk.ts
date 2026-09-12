/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

export const veyraReputationSdk = {
  async getAgent(agentId: string, baseUrl = "") {
    const res = await fetch(`${baseUrl}/api/reputation/v1/agents/${agentId}`);
    if (!res.ok) {
      throw new Error(`Failed to fetch agent reputation: HTTP ${res.status}`);
    }
    return res.json();
  },

  async getHistory(agentId: string, baseUrl = "") {
    const res = await fetch(`${baseUrl}/api/reputation/v1/agents/${agentId}/history`);
    if (!res.ok) {
      throw new Error(`Failed to fetch agent reputation history: HTTP ${res.status}`);
    }
    return res.json();
  },

  async getEvidence(agentId: string, baseUrl = "") {
    const res = await fetch(`${baseUrl}/api/reputation/v1/agents/${agentId}/evidence`);
    if (!res.ok) {
      throw new Error(`Failed to fetch agent sanitized evidence: HTTP ${res.status}`);
    }
    return res.json();
  },
};
