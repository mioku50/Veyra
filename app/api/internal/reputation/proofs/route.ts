/**
 * Copyright 2026 Circle Internet Group, Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getByoaClient } from "@/lib/byoa/service";
import { getCanonicalVeyraAgentIdentity, getArcPublicClient } from "@/lib/erc8004/client";
import { fetchOnchainJob } from "@/lib/erc8183/client";
import type { Erc8183EvaluationRecord } from "@/lib/erc8183/types";
import {
  fetchLatestReputationSnapshot,
  fetchReputationEvidenceForAgent,
} from "@/lib/reputation/db";
import { deriveSettledErc8183ValueUsdc } from "@/lib/reputation/erc8183-adapter";
import { publishReputationSnapshotProofToArc } from "@/lib/reputation/snapshot";
import type { Hex } from "viem";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorized(header: string | null, expected: string) {
  const supplied = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const expectedDigest = createHash("sha256").update(expected).digest();
  const suppliedDigest = createHash("sha256").update(supplied).digest();
  return timingSafeEqual(expectedDigest, suppliedDigest) && supplied.length === expected.length;
}

function publicError(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function POST(request: Request) {
  const secret = process.env.REPUTATION_PROOF_PUBLISH_SECRET;
  if (!secret) {
    return publicError("reputation_proof_unavailable", "Reputation proof publishing is unavailable.", 503);
  }
  if (!authorized(request.headers.get("authorization"), secret)) {
    return publicError("unauthorized", "Unauthorized.", 401);
  }

  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Object.keys(body).length !== 0) {
      return publicError(
        "invalid_request",
        "The canonical Veyra snapshot is selected by the server; request fields are not accepted.",
        400,
      );
    }

    const publicClient = getArcPublicClient();
    const identity = await getCanonicalVeyraAgentIdentity(publicClient);
    if (!identity) {
      return publicError("identity_not_found", "Canonical Veyra identity was not found.", 404);
    }
    const snapshot = await fetchLatestReputationSnapshot(identity.agent_id);
    if (!snapshot || snapshot.canonicalHash === `0x${"0".repeat(64)}`) {
      return publicError("snapshot_not_found", "A canonical reputation snapshot was not found.", 404);
    }

    const evidence = await fetchReputationEvidenceForAgent(identity.agent_id);
    const economicEvidence = evidence.find(
      (item) =>
        item.type === "erc8183_job_completed" &&
        item.positive &&
        item.verifiedOnchain &&
        item.arcProofVerified &&
        Boolean(item.sourceHash) &&
        Number(item.economicValueUsdc || 0) > 0 &&
        /^\d+$/.test(item.sourceId),
    );
    if (!economicEvidence) {
      return publicError(
        "economic_evidence_not_found",
        "Verified economic evidence for this snapshot was not found.",
        409,
      );
    }

    const supabase = getByoaClient();
    const { data, error } = await supabase
      .from("erc8183_evaluations")
      .select("*")
      .eq("chain_id", 5042002)
      .eq("job_id", economicEvidence.sourceId)
      .eq("status", "completed")
      .eq("decision", "complete")
      .maybeSingle();
    if (error) {
      return publicError("reputation_storage_unavailable", "Reputation evidence is unavailable.", 503);
    }
    if (!data) {
      return publicError("evaluation_not_found", "The verified evaluation was not found.", 409);
    }

    const evaluation = data as Erc8183EvaluationRecord;
    if (
      !evaluation.settlement_tx_hash ||
      !/^0x[0-9a-f]{64}$/i.test(evaluation.settlement_tx_hash) ||
      evaluation.deliverable_hash.toLowerCase() !== economicEvidence.sourceHash!.toLowerCase()
    ) {
      return publicError("evaluation_mismatch", "The evaluation does not match reputation evidence.", 409);
    }

    const commerce = evaluation.agentic_commerce as `0x${string}`;
    const job = await fetchOnchainJob(commerce, BigInt(evaluation.job_id), publicClient);
    const receipt = await publicClient.getTransactionReceipt({
      hash: evaluation.settlement_tx_hash as Hex,
    });
    const settledValueUsdc = deriveSettledErc8183ValueUsdc({
      job,
      receipt,
      commerceAddress: commerce,
    });
    const exactBinding =
      job.client.toLowerCase() === evaluation.client_wallet.toLowerCase() &&
      job.provider.toLowerCase() === evaluation.provider_wallet.toLowerCase() &&
      job.evaluator.toLowerCase() === evaluation.evaluator_contract.toLowerCase() &&
      job.deliverableHash?.toLowerCase() === evaluation.deliverable_hash.toLowerCase() &&
      Math.abs(settledValueUsdc - Number(economicEvidence.economicValueUsdc)) < 0.000001;
    if (!exactBinding) {
      return publicError("economic_evidence_mismatch", "Economic evidence could not be verified.", 409);
    }

    const proof = await publishReputationSnapshotProofToArc(
      snapshot,
      identity.owner_address,
      undefined,
      settledValueUsdc,
      {
        buyer: job.client,
        seller: job.provider,
        source: "erc8183_job",
        sourceId: job.jobId.toString(),
      },
    );
    if (!proof.verifiedOnchain || !proof.transactionHash) {
      return publicError("reputation_proof_unverified", "The reputation proof was not verified.", 503);
    }

    const persisted = await fetchLatestReputationSnapshot(identity.agent_id);
    if (
      !persisted ||
      persisted.snapshotId !== snapshot.snapshotId ||
      persisted.canonicalHash.toLowerCase() !== snapshot.canonicalHash.toLowerCase() ||
      persisted.arcProofTx?.toLowerCase() !== proof.transactionHash.toLowerCase()
    ) {
      return publicError(
        "reputation_storage_unavailable",
        "The verified reputation proof could not be safely persisted.",
        503,
      );
    }

    return NextResponse.json({
      snapshotId: persisted.snapshotId,
      canonicalHash: persisted.canonicalHash,
      arcProofTx: persisted.arcProofTx,
      blockNumber: proof.blockNumber,
      proofAlreadyRegistered: Boolean(proof.proofAlreadyRegistered),
    });
  } catch (error) {
    console.error("Reputation proof publication failed", {
      code: error instanceof Error ? error.name : "unknown_error",
    });
    return publicError(
      "reputation_proof_unavailable",
      "The reputation proof could not be safely published.",
      503,
    );
  }
}
