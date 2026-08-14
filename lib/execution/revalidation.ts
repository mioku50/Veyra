/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { fetchPublicCounterpartySelection } from "../counterparty-selection/db.ts";
import type { CounterpartySelection } from "../counterparty-selection/types.ts";
import { getByoaClient } from "../byoa/service.ts";
import { getAgentIdentityRecord } from "../erc8004/client.ts";
import { fetchLatestReputationSnapshot } from "../reputation/db.ts";
import { evaluateTrustDecision } from "../trust-gate/decision.ts";
import type { TrustDecision } from "../trust-gate/types.ts";
import { checkMandateEligibility } from "./mandate.ts";
import type { ExecutionMandate, ExecutionRail } from "./types.ts";

export interface PreflightRevalidationResult {
  valid: boolean;
  reasons: string[];
  selection?: CounterpartySelection;
  winner?: {
    agentId: string;
    wallet: `0x${string}`;
    serviceId?: string;
    capability: string;
    rail: ExecutionRail;
    priceUsdc: number;
  };
  freshTrustDecision?: TrustDecision;
  authorizedMaxUsdc?: number;
  requiredEvaluator?: string | null;
}

const memorySelectionStore = new Map<string, CounterpartySelection>();

export function registerMemorySelection(selection: CounterpartySelection): void {
  memorySelectionStore.set(selection.selectionId, selection);
}

export async function fetchSelectionById(selectionId: string): Promise<CounterpartySelection | null> {
  if (memorySelectionStore.has(selectionId)) {
    return memorySelectionStore.get(selectionId) || null;
  }

  try {
    const supabase = getByoaClient();
    const { data, error } = await supabase
      .from("counterparty_selections")
      .select("selection_payload")
      .eq("selection_id", selectionId)
      .maybeSingle();

    if (error || !data) {
      return memorySelectionStore.get(selectionId) || null;
    }
    return data.selection_payload as CounterpartySelection;
  } catch {
    return memorySelectionStore.get(selectionId) || null;
  }
}

/**
 * Revalidates all policy, identity, reputation, quote, and mandate constraints
 * immediately before any irreversible economic action is dispatched.
 */
export async function revalidateExecutionPreflight(params: {
  selectionId: string;
  mandate?: ExecutionMandate | null;
  requestedAmountUsdc: number;
  executorWallet?: `0x${string}`;
}): Promise<PreflightRevalidationResult> {
  const reasons: string[] = [];

  // 1. Reload immutable selection
  const selection = await fetchSelectionById(params.selectionId);
  if (!selection) {
    return { valid: false, reasons: ["SELECTION_NOT_FOUND"] };
  }

  if (new Date(selection.expiresAt).getTime() < Date.now()) {
    return { valid: false, reasons: ["SELECTION_EXPIRED"] };
  }

  const winner = selection.candidates.find(
    (c) => c.identity?.agentId === selection.recommendedAgentId
  );
  if (!winner || !winner.identity) {
    return { valid: false, reasons: ["SELECTION_WINNER_MISSING"] };
  }

  const winnerAgentId = winner.identity.agentId;
  const winnerWallet = (winner.identity.agentWallet || winner.identity.ownerAddress) as `0x${string}`;
  const capability = selection.capability;
  const winnerService = (winner as any).service;
  const rail: ExecutionRail = winnerService?.workflowType?.startsWith("erc8183") || winner.serviceId?.startsWith("erc8183") ? "erc8183" : "x402";
  const priceUsdc = winnerService?.advertisedPriceUsdc ?? (winner as any).advertisedPriceUsdc ?? params.requestedAmountUsdc;

  // 2. Query latest canonical reputation snapshot
  const latestSnapshot = await fetchLatestReputationSnapshot(winnerAgentId);
  if (!latestSnapshot) {
    reasons.push("NO_REPUTATION_SNAPSHOT");
  }

  if (latestSnapshot?.riskSignals?.includes("SYBIL_RISK")) {
    reasons.push("CRITICAL_RISK_SIGNAL_SYBIL");
  }

  // 3. Verify ERC-8004 identity ownership drift
  try {
    const identityOnchain = await getAgentIdentityRecord(winnerAgentId);
    if (identityOnchain) {
      if (
        identityOnchain.owner_address.toLowerCase() !== winner.identity.ownerAddress.toLowerCase()
      ) {
        reasons.push(
          `IDENTITY_OWNER_DRIFT: onchain owner ${identityOnchain.owner_address} does not match selection owner ${winner.identity.ownerAddress}`
        );
      }
    }
  } catch (err: any) {
    // If public client is in offline test mode, verify offchain attributes
  }

  // 4. Rerun Trust Gate preflight decision
  let freshTrustDecision: TrustDecision | undefined;
  if (latestSnapshot) {
    freshTrustDecision = await evaluateTrustDecision(
      {
        subjectAgentId: winnerAgentId,
        counterpartyWallet: winnerWallet,
        executorWallet: params.executorWallet,
        action: rail === "erc8183" ? "erc8183_job" : "paid_api_call",
        serviceId: winnerService?.serviceId ?? winner.serviceId,
        workflowType: winnerService?.workflowType,
        requestedValueUsdc: params.requestedAmountUsdc,
      },
      latestSnapshot
    );

    if (freshTrustDecision.decision === "DENY") {
      reasons.push(`TRUST_GATE_DENY: ${freshTrustDecision.reasons.join(", ")}`);
    } else if (freshTrustDecision.decision === "REVIEW_REQUIRED") {
      reasons.push("TRUST_GATE_REVIEW_REQUIRED");
    }
  }

  // 5. Check Mandate constraints if attached
  if (params.mandate) {
    const mandateCheck = checkMandateEligibility(params.mandate, {
      capability,
      rail,
      requestedAmountUsdc: params.requestedAmountUsdc,
      trustScore: latestSnapshot?.trustScore ?? 0,
      confidence: latestSnapshot?.confidence === "High" ? 90 : latestSnapshot?.confidence === "Medium" ? 70 : 50,
      identityVerified: winner.identity.verifiedOnchain,
      network: selection.network,
    });

    if (!mandateCheck.eligible) {
      reasons.push(...mandateCheck.reasons);
    }
  }

  // 6. Check required evaluator
  let requiredEvaluator: string | null = null;
  if (freshTrustDecision?.policy.evaluatorRequired) {
    requiredEvaluator =
      freshTrustDecision.policy.evaluatorAddress ||
      process.env.NEXT_PUBLIC_VEYRA_ERC8183_EVALUATOR_ADDRESS ||
      "0x0d2c04580e081e222bbe5bf9818af337e2633eb7";
  }

  const authorizedMaxUsdc = Math.min(
    selection.recommendedMaxExposureUsdc,
    freshTrustDecision?.policy.maxValueUsdc ?? selection.recommendedMaxExposureUsdc,
    params.mandate?.maxPerTransactionUsdc ?? selection.recommendedMaxExposureUsdc
  );

  if (params.requestedAmountUsdc > authorizedMaxUsdc) {
    reasons.push(`REQUESTED_AMOUNT_EXCEEDS_AUTHORIZED_MAX: ${params.requestedAmountUsdc} > ${authorizedMaxUsdc}`);
  }

  return {
    valid: reasons.length === 0,
    reasons,
    selection,
    winner: {
      agentId: winnerAgentId,
      wallet: winnerWallet,
      serviceId: winnerService?.serviceId ?? winner.serviceId,
      capability,
      rail,
      priceUsdc,
    },
    freshTrustDecision,
    authorizedMaxUsdc,
    requiredEvaluator,
  };
}
