import { NextRequest, NextResponse } from "next/server";
import { isAddress, type Hex } from "viem";
import { requireOwnerSession } from "@/lib/byoa/http";
import { ByoaError, getByoaClient } from "@/lib/byoa/service";
import { getCanonicalAgentIdentity, getArcPublicClient } from "@/lib/erc8004/client";
import { fetchJobSubmittedLogs, fetchOnchainJob } from "@/lib/erc8183/client";
import { fetchLatestReputationSnapshot, fetchReputationEvidenceForAgent } from "@/lib/reputation/db";
import { deriveSettledErc8183ValueUsdc } from "@/lib/reputation/erc8183-adapter";
import { publishReputationSnapshotProofToArc } from "@/lib/reputation/snapshot";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function failure(code: string, status: number) {
  return NextResponse.json(
    { error: { code, message: "The reputation proof could not be safely published." } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ agentId: string }> },
) {
  try {
    const owner = requireOwnerSession(request);
    const { agentId } = await context.params;
    if (!/^\d{1,78}$/.test(agentId)) return failure("agent_not_found", 404);

    const publicClient = getArcPublicClient();
    const identity = await getCanonicalAgentIdentity(agentId, publicClient);
    if (!identity || identity.owner_address.toLowerCase() !== owner.wallet.toLowerCase()) {
      return failure("agent_not_found", 404);
    }

    const snapshot = await fetchLatestReputationSnapshot(agentId);
    if (!snapshot || snapshot.agentId !== agentId || snapshot.canonicalHash === `0x${"0".repeat(64)}`) {
      return failure("snapshot_not_found", 404);
    }
    const evidence = (await fetchReputationEvidenceForAgent(agentId))
      .filter((item) =>
        item.type === "erc8183_job_completed"
        && item.positive
        && item.verifiedOnchain
        && item.arcProofVerified
        && Boolean(item.sourceHash)
        && Number(item.economicValueUsdc || 0) > 0
        && /^\d+$/.test(item.sourceId)
      )
      .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt));

    for (const item of evidence) {
      const query = await getByoaClient()
        .from("erc8183_evaluations")
        .select("*")
        .eq("chain_id", 5_042_002)
        .eq("job_id", item.sourceId)
        .eq("status", "completed")
        .eq("decision", "complete")
        .maybeSingle();
      const evaluation = query.data;
      if (query.error || !evaluation
        || !isAddress(evaluation.agentic_commerce)
        || !/^0x[0-9a-f]{64}$/i.test(evaluation.settlement_tx_hash || "")
        || String(evaluation.deliverable_hash).toLowerCase() !== item.sourceHash!.toLowerCase()) continue;
      try {
        const [job, receipt, submittedLogs] = await Promise.all([
          fetchOnchainJob(evaluation.agentic_commerce, BigInt(item.sourceId), publicClient),
          publicClient.getTransactionReceipt({ hash: evaluation.settlement_tx_hash as Hex }),
          fetchJobSubmittedLogs(evaluation.agentic_commerce, BigInt(item.sourceId), publicClient),
        ]);
        const settledValueUsdc = deriveSettledErc8183ValueUsdc({
          job,
          receipt,
          commerceAddress: evaluation.agentic_commerce,
        });
        const exactBinding = receipt.status === "success"
          && job.status === "Completed"
          && job.client.toLowerCase() === String(evaluation.client_wallet).toLowerCase()
          && job.provider.toLowerCase() === identity.owner_address.toLowerCase()
          && job.provider.toLowerCase() === String(evaluation.provider_wallet).toLowerCase()
          && job.evaluator.toLowerCase() === String(evaluation.evaluator_contract).toLowerCase()
          && submittedLogs.length === 1
          && submittedLogs[0].deliverableHash.toLowerCase() === String(evaluation.deliverable_hash).toLowerCase()
          && Math.abs(settledValueUsdc - Number(item.economicValueUsdc)) < 0.000001;
        if (!exactBinding) continue;

        const proof = await publishReputationSnapshotProofToArc(
          snapshot,
          identity.owner_address,
          undefined,
          settledValueUsdc,
          { buyer: job.client, seller: job.provider, source: "erc8183_job", sourceId: job.jobId.toString() },
        );
        if (!proof.verifiedOnchain || !proof.transactionHash) continue;
        const persisted = await fetchLatestReputationSnapshot(agentId);
        if (!persisted
          || persisted.snapshotId !== snapshot.snapshotId
          || persisted.canonicalHash.toLowerCase() !== snapshot.canonicalHash.toLowerCase()
          || persisted.arcProofTx?.toLowerCase() !== proof.transactionHash.toLowerCase()) {
          return failure("proof_persistence_unavailable", 503);
        }
        return NextResponse.json(
          {
            snapshotId: persisted.snapshotId,
            canonicalHash: persisted.canonicalHash,
            arcProofTx: persisted.arcProofTx,
            blockNumber: proof.blockNumber,
            proofAlreadyRegistered: Boolean(proof.proofAlreadyRegistered),
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      } catch {
        // Fail closed and try the next independently persisted economic record.
      }
    }
    return failure("economic_evidence_not_found", 409);
  } catch (error) {
    if (error instanceof ByoaError) return failure("owner_session_required", error.status);
    console.error("Counterparty reputation proof publication failed", {
      code: error instanceof Error ? error.name : "unknown_error",
    });
    return failure("reputation_proof_unavailable", 503);
  }
}
