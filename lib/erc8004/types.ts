/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

export const ARC_ERC8004_IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const;
export const ARC_ERC8004_REPUTATION_REGISTRY = "0x8004B663056A597Dffe9eCcC1965A193B7388713" as const;
export const ARC_ERC8004_VALIDATION_REGISTRY = "0x8004Cb1BF31DAf7788923b405b754f57acEB4272" as const;

export interface Erc8004AgentIdentityRecord {
  id: string;
  agent_id: string;
  registry_address: string;
  chain_id: number;
  owner_address: string;
  metadata_uri: string;
  registration_tx: string;
  created_at: string;
}

export interface Erc8004ValidationLinkRecord {
  id: string;
  request_hash: string;
  agent_id: string;
  evaluation_public_id: string | null;
  canonical_report_hash: string;
  response: 0 | 100;
  response_hash: string;
  response_tx: string | null;
  tag: string;
  status: "pending" | "submitted" | "confirmed" | "failed";
  created_at: string;
  confirmed_at: string | null;
}

export interface Erc8004Metadata {
  name: string;
  description: string;
  version: string;
  network: string;
  chainId: number;
  identity: {
    standard: "ERC-8004";
    registry: string;
    reputationRegistry: string;
    validationRegistry: string;
    agentId?: string;
    ownerAddress?: string;
  };
  evaluator: {
    standard: "ERC-8183";
    evaluatorAddress: string;
    commerceAddress: string;
    policy: string;
  };
  capabilities: string[];
  services: {
    profile: string;
    evaluatorProfile: string;
    machineApi: string;
    agentMetadata: string;
  };
}

export interface Erc8004FeedbackItem {
  id: string;
  agentId: string;
  reviewerAddress: string;
  score: number;
  tag: string;
  detail?: string;
  endpoint?: string;
  feedbackURI?: string;
  feedbackHash: string;
  evidenceLinked: boolean;
  evaluationPublicId?: string;
  createdAt: string;
}

export interface Erc8004ReputationSummary {
  agentId: string;
  totalFeedbackCount: number;
  independentReviewersCount: number;
  evidenceLinkedCount: number;
  unlinkedCount: number;
  averageScore?: number;
  recentFeedback: Erc8004FeedbackItem[];
}

export interface Erc8004ValidationStatus {
  validatorAddress: `0x${string}`;
  agentId: bigint;
  response: number; // 100 = passed, 0 = failed
  responseHash: `0x${string}`;
  tag: string;
  lastUpdate: bigint;
}
