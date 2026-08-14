/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExecutionAttempt, ExecutionRail, ExecutionResult } from "../types.ts";

export interface RailExecutionParams {
  executionId: string;
  selectionId: string;
  selectionHash: string;
  counterpartyAgentId: string;
  counterpartyWallet: `0x${string}`;
  capability: string;
  amountUsdc: number;
  evaluatorAddress?: string | null;
  clearanceDigest?: string | null;
  mandateId?: string | null;
  taskPayload?: any;
}

export interface NormalizedRailResult {
  executionId: string;
  rail: ExecutionRail;
  success: boolean;
  failureCode?: string | null;
  actualSettledAmountUsdc: number;
  externalReference?: string | null;
  createTx?: string | null;
  completeTx?: string | null;
  paymentTx?: string | null;
  evaluationId?: string | null;
  evaluationVerdict?: "Complete" | "Reject" | null;
  evidenceType: string;
  rawResult?: any;
}

export interface ExecutionRailAdapter {
  rail: ExecutionRail;
  prepare(params: RailExecutionParams): Promise<any>;
  execute(params: RailExecutionParams): Promise<NormalizedRailResult>;
}
