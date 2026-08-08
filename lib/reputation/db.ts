/**
 * Copyright 2026 Circle Internet Group, Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { getByoaClient } from "../byoa/service.ts";
import type { ReputationEvidence, ReputationSnapshot } from "./types.ts";

const memoryEvidenceStore = new Map<string, ReputationEvidence[]>();
const memorySnapshotStore = new Map<string, ReputationSnapshot[]>();

function isMemoryStoreAllowed(): boolean {
  return process.env.NODE_ENV === "test" || process.env.REPUTATION_ALLOW_MEMORY_STORE === "true";
}

export async function saveReputationEvidence(evidence: ReputationEvidence): Promise<boolean> {
  const allowMemory = isMemoryStoreAllowed();
  if (allowMemory) {
    const list = memoryEvidenceStore.get(evidence.agentId) || [];
    const existingIndex = list.findIndex(
      (e) => e.sourceId === evidence.sourceId && e.canonicalHash === evidence.canonicalHash
    );
    if (existingIndex >= 0) {
      list[existingIndex] = evidence;
    } else {
      list.unshift(evidence);
    }
    memoryEvidenceStore.set(evidence.agentId, list);
    return true;
  }

  try {
    const supabase = getByoaClient();
    const { error } = await supabase.from("agent_reputation_evidence").upsert(
      {
        agent_id: evidence.agentId,
        evidence_type: evidence.type,
        tier: evidence.tier,
        source_id: evidence.sourceId,
        source_hash: evidence.sourceHash || null,
        score: evidence.score ?? null,
        positive: evidence.positive,
        confidence: evidence.confidence,
        economic_value_usdc: evidence.economicValueUsdc || 0,
        counterparty_address: evidence.counterpartyAddress || null,
        verified_onchain: evidence.verifiedOnchain,
        arc_proof_verified: evidence.arcProofVerified,
        sybil_risk: evidence.sybilRisk,
        observed_at: evidence.observedAt,
        canonical_hash: evidence.canonicalHash,
        metadata: {
          reason: evidence.reason || null,
        },
      },
      { onConflict: "agent_id,source_id,canonical_hash" }
    );
    if (error) {
      if (!allowMemory) {
        throw new Error(`DB Evidence Upsert Failed: ${error.message}`);
      }
      return true;
    }
    return true;
  } catch (err) {
    if (!allowMemory) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    return true;
  }
}

export async function fetchReputationEvidenceForAgent(agentId: string): Promise<ReputationEvidence[]> {
  const allowMemory = isMemoryStoreAllowed();
  const memList = memoryEvidenceStore.get(agentId) || [];
  if (allowMemory) return memList;
  try {
    const supabase = getByoaClient();
    const { data, error } = await supabase
      .from("agent_reputation_evidence")
      .select("*")
      .eq("agent_id", agentId)
      .order("observed_at", { ascending: false });

    if (error) {
      if (!allowMemory) {
        throw new Error(`DB Fetch Evidence Failed: ${error.message}`);
      }
    }

    if (data && data.length > 0) {
      const dbList: ReputationEvidence[] = data.map((row) => ({
        evidenceId: row.id,
        agentId: row.agent_id,
        type: row.evidence_type,
        tier: row.tier as 0 | 1 | 2 | 3 | 4,
        sourceId: row.source_id,
        sourceHash: row.source_hash || undefined,
        score: row.score !== null ? Number(row.score) : undefined,
        positive: Boolean(row.positive),
        confidence: Number(row.confidence),
        economicValueUsdc: row.economic_value_usdc ? Number(row.economic_value_usdc) : 0,
        counterpartyAddress: row.counterparty_address || undefined,
        verifiedOnchain: Boolean(row.verified_onchain),
        arcProofVerified: Boolean(row.arc_proof_verified),
        sybilRisk: row.sybil_risk || "none",
        reason: row.metadata?.reason || undefined,
        observedAt: row.observed_at,
        canonicalHash: row.canonical_hash,
      }));

      return dbList;
    }
  } catch (err) {
    if (!allowMemory) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    console.error("Failed to fetch reputation evidence:", err);
  }
  return allowMemory ? memList : [];
}

export async function saveReputationSnapshot(snapshot: ReputationSnapshot): Promise<boolean> {
  const allowMemory = isMemoryStoreAllowed();
  if (allowMemory) {
    const list = memorySnapshotStore.get(snapshot.agentId) || [];
    const existingIndex = list.findIndex((s) => s.snapshotId === snapshot.snapshotId);
    if (existingIndex >= 0) {
      list[existingIndex] = snapshot;
    } else {
      list.unshift(snapshot);
    }
    memorySnapshotStore.set(snapshot.agentId, list);
    return true;
  }

  try {
    const supabase = getByoaClient();
    const { error } = await supabase.from("agent_reputation_snapshots").upsert({
      snapshot_id: snapshot.snapshotId,
      agent_id: snapshot.agentId,
      trust_score: snapshot.trustScore,
      identity_score: snapshot.dimensions.identity,
      execution_score: snapshot.dimensions.execution,
      validation_score: snapshot.dimensions.validation,
      economic_reliability_score: snapshot.dimensions.economicReliability,
      service_quality_score: snapshot.dimensions.serviceQuality,
      reputation_score: snapshot.dimensions.reputation,
      coverage: snapshot.coverage,
      confidence: snapshot.confidence,
      status_label: snapshot.statusLabel,
      evidence_count: snapshot.evidenceCount,
      economic_evidence_count: snapshot.economicEvidenceCount,
      canonical_hash: snapshot.canonicalHash,
      arc_proof_tx: snapshot.arcProofTx || null,
      snapshot_payload: snapshot as unknown as Record<string, unknown>,
    });
    if (error) {
      if (!allowMemory) {
        throw new Error(`DB Save Snapshot Failed: ${error.message}`);
      }
      return true;
    }
    return true;
  } catch (err) {
    if (!allowMemory) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    return true;
  }
}

export async function fetchLatestReputationSnapshot(agentId: string): Promise<ReputationSnapshot | null> {
  const allowMemory = isMemoryStoreAllowed();
  const memList = memorySnapshotStore.get(agentId) || [];
  if (allowMemory) return memList[0] || null;
  try {
    const supabase = getByoaClient();
    const { data, error } = await supabase
      .from("agent_reputation_snapshots")
      .select("snapshot_payload")
      .eq("agent_id", agentId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      if (!allowMemory) {
        throw new Error(`DB Fetch Latest Snapshot Failed: ${error.message}`);
      }
    }

    if (data && data.snapshot_payload) {
      return data.snapshot_payload as unknown as ReputationSnapshot;
    }
  } catch (err) {
    if (!allowMemory) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
  return allowMemory ? memList[0] || null : null;
}

export async function fetchReputationSnapshotHistory(agentId: string): Promise<ReputationSnapshot[]> {
  const allowMemory = isMemoryStoreAllowed();
  const memList = memorySnapshotStore.get(agentId) || [];
  if (allowMemory) return memList;
  try {
    const supabase = getByoaClient();
    const { data, error } = await supabase
      .from("agent_reputation_snapshots")
      .select("snapshot_payload")
      .eq("agent_id", agentId)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) {
      if (!allowMemory) {
        throw new Error(`DB Fetch Snapshot History Failed: ${error.message}`);
      }
    }

    if (data && data.length > 0) {
      const dbList = data.map((r) => r.snapshot_payload as unknown as ReputationSnapshot);
      return dbList;
    }
  } catch (err) {
    if (!allowMemory) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
  return allowMemory ? memList : [];
}
