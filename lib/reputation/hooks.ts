/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { fetchLatestReputationSnapshot } from "./db.ts";
import { generateAndSaveReputationSnapshot } from "./snapshot.ts";
import type { CanonicalAgentIdentity, ReputationSnapshot } from "./types.ts";
import { dispatchWebhookEvents } from "../monitoring/webhooks.ts";

export async function handleReputationEvent(
  identity: CanonicalAgentIdentity,
  eventType: "evidence.added" | "erc8183.job_rejected" | "reputation.updated",
  eventPayload: Record<string, unknown>
): Promise<ReputationSnapshot> {
  const previousSnapshot = await fetchLatestReputationSnapshot(identity.agentId);
  const newSnapshot = await generateAndSaveReputationSnapshot(identity);

  // Check for significant delta
  if (previousSnapshot) {
    const delta = newSnapshot.trustScore - previousSnapshot.trustScore;

    if (delta <= -10 || eventType === "erc8183.job_rejected") {
      await dispatchWebhookEvents({
        ownerWallet: identity.owner,
        eventType: eventType === "erc8183.job_rejected" ? "erc8183.job_rejected" : "reputation.degraded",
        eventFingerprint: `rep_deg_${newSnapshot.canonicalHash.substring(2, 18)}`,
        message: `Agent ${identity.agentId} reputation score dropped by ${Math.abs(delta)} points (now ${newSnapshot.trustScore}).`,
        payload: {
          agentId: identity.agentId,
          previousScore: previousSnapshot.trustScore,
          newScore: newSnapshot.trustScore,
          delta,
          ...eventPayload,
        },
      }).catch((err) => console.error("Failed to dispatch reputation degradation webhook:", err));
    } else if (delta >= 10) {
      await dispatchWebhookEvents({
        ownerWallet: identity.owner,
        eventType: "reputation.recovered",
        eventFingerprint: `rep_rec_${newSnapshot.canonicalHash.substring(2, 18)}`,
        message: `Agent ${identity.agentId} reputation score recovered by ${delta} points (now ${newSnapshot.trustScore}).`,
        payload: {
          agentId: identity.agentId,
          previousScore: previousSnapshot.trustScore,
          newScore: newSnapshot.trustScore,
          delta,
          ...eventPayload,
        },
      }).catch((err) => console.error("Failed to dispatch reputation recovery webhook:", err));
    }
  }

  // Always emit reputation.updated
  await dispatchWebhookEvents({
    ownerWallet: identity.owner,
    eventType: "reputation.updated",
    eventFingerprint: `rep_upd_${newSnapshot.canonicalHash.substring(2, 18)}`,
    message: `Agent ${identity.agentId} reputation updated: Trust Score ${newSnapshot.trustScore}.`,
    payload: {
      agentId: identity.agentId,
      trustScore: newSnapshot.trustScore,
      confidence: newSnapshot.confidence,
      coverage: newSnapshot.coverage,
      ...eventPayload,
    },
  }).catch((err) => console.error("Failed to dispatch reputation updated webhook:", err));

  return newSnapshot;
}
