/**
 * Copyright 2026 Circle Internet Group, Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { authenticateMachineRequest } from "@/lib/api/machine-auth";
import { createMachineErrorResponse } from "@/lib/api/machine-errors";
import { inspectMachineIdempotency, resolveMachineIdempotency, saveMachineIdempotency } from "@/lib/api/machine-idempotency";
import { getByoaClient } from "@/lib/byoa/service";
import { computeDeliverableHash, computePolicyHash } from "@/lib/erc8183/deliverable";
import { executeOffchainJobEvaluation } from "@/lib/erc8183/evaluator";
import type { VeyraDeliverableV1 } from "@/lib/erc8183/types";
import { isAddress, zeroAddress } from "viem";

export async function POST(req: Request) {
  const authResult = await authenticateMachineRequest(req, "erc8183:evaluate");
  if (!authResult.ok) {
    return authResult.response;
  }

  const { context } = authResult;
  const idempotencyKey =
    req.headers.get("idempotency-key") || req.headers.get("x-idempotency-key");

  let body: any;
  try {
    body = await req.json();
  } catch {
    return createMachineErrorResponse("invalid_request", "Request body must be valid JSON.", 400);
  }

  if (!body || typeof body !== "object") {
    return createMachineErrorResponse("invalid_request", "Request body must be a JSON object.", 400);
  }

  const { chainId, agenticCommerce, jobId, deliverable } = body;

  const evaluatorAddress = process.env.NEXT_PUBLIC_VEYRA_ERC8183_EVALUATOR_ADDRESS;
  const attesterKey = process.env.ERC8183_EVALUATOR_ATTESTER_PRIVATE_KEY;
  const relayerKey = process.env.ERC8183_EVALUATOR_RELAYER_PRIVATE_KEY;
  if (
    !evaluatorAddress ||
    !isAddress(evaluatorAddress) ||
    evaluatorAddress.toLowerCase() === zeroAddress ||
    !attesterKey ||
    !/^0x[0-9a-f]{64}$/i.test(attesterKey) ||
    !relayerKey ||
    !/^0x[0-9a-f]{64}$/i.test(relayerKey)
  ) {
    return createMachineErrorResponse(
      "provider_unavailable",
      "ERC-8183 evaluation is not configured.",
      503
    );
  }

  if (chainId !== 5042002) {
    return createMachineErrorResponse("invalid_request", "Only Arc Testnet (chainId 5042002) is supported in P5.0.", 400);
  }

  if (typeof agenticCommerce !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(agenticCommerce)) {
    return createMachineErrorResponse("invalid_request", "agenticCommerce must be a valid 0x EVM address.", 400);
  }

  if (typeof jobId !== "string" || !/^\d+$/.test(jobId)) {
    return createMachineErrorResponse("invalid_request", "jobId must be a numeric string.", 400);
  }

  if (!deliverable || typeof deliverable !== "object" || deliverable.version !== 1) {
    return createMachineErrorResponse("invalid_request", "deliverable must be a valid VeyraDeliverableV1 object.", 400);
  }

  const deliverableObj = deliverable as VeyraDeliverableV1;
  const deliverableHash = computeDeliverableHash(deliverableObj);
  const policyHash = computePolicyHash(deliverableObj.policyId);

  let reservationToken: string | undefined;

  // Idempotency check
  if (idempotencyKey) {
    const check = await inspectMachineIdempotency({
      key: idempotencyKey,
      credentialId: context.credential.id,
      route: "/api/erc8183/v1/evaluations",
      payload: body,
    });

    if (check.conflict) {
      return createMachineErrorResponse("idempotency_conflict", "Idempotency key reused with different payload.", 409);
    }
    if (check.unavailable) {
      return createMachineErrorResponse(
        "idempotency_store_unavailable",
        "The request cannot be safely processed right now.",
        503,
        true,
      );
    }
    if (check.pending) {
      return createMachineErrorResponse(
        "idempotency_in_progress",
        "An evaluation with this Idempotency-Key is already running.",
        409,
        true,
      );
    }
    if (check.cached && check.cachedResponse) {
      return NextResponse.json(check.cachedResponse.body, { status: check.cachedResponse.status });
    }

    const reservation = await resolveMachineIdempotency({
      key: idempotencyKey,
      credentialId: context.credential.id,
      agentId: context.agentId,
      route: "/api/erc8183/v1/evaluations",
      payload: body,
    });
    if (reservation.unavailable) {
      return createMachineErrorResponse(
        "idempotency_store_unavailable",
        "The request cannot be safely processed right now.",
        503,
        true,
      );
    }
    if (reservation.conflict) {
      return createMachineErrorResponse("idempotency_conflict", "Idempotency key reused with different payload.", 409);
    }
    if (reservation.pending) {
      return createMachineErrorResponse(
        "idempotency_in_progress",
        "An evaluation with this Idempotency-Key is already running.",
        409,
        true,
      );
    }
    if (reservation.cachedResponse) {
      return NextResponse.json(reservation.cachedResponse.body, {
        status: reservation.cachedResponse.status,
      });
    }
    reservationToken = reservation.reservationToken;
  }

  // Check existing DB evaluation record
  const supabase = getByoaClient();
  const { data: existingRecord, error: existingError } = await supabase
    .from("erc8183_evaluations")
    .select("*")
    .eq("chain_id", chainId)
    .eq("agentic_commerce", agenticCommerce.toLowerCase())
    .eq("job_id", jobId)
    .maybeSingle();
  if (existingError) {
    return createMachineErrorResponse(
      "provider_unavailable",
      "Evaluation storage is unavailable.",
      503
    );
  }

  let publicId: string;
  if (existingRecord) {
    if (existingRecord.status === "completed" || existingRecord.status === "rejected") {
      const responseBody = {
        evaluationId: existingRecord.public_id,
        status: existingRecord.status,
        statusUrl: `/api/erc8183/v1/evaluations/${existingRecord.public_id}`,
      };
      if (idempotencyKey) {
        await saveMachineIdempotency({
          key: idempotencyKey,
          credentialId: context.credential.id,
          agentId: context.agentId,
          route: "/api/erc8183/v1/evaluations",
          payload: body,
          responseStatus: 200,
          responseBody,
          reservationToken,
        });
        reservationToken = undefined;
      }
      return NextResponse.json(responseBody, { status: 200 });
    }
    publicId = existingRecord.public_id;
  } else {
    publicId = `vev_${randomUUID().replace(/-/g, "")}`;
    const { error: insertError } = await supabase.from("erc8183_evaluations").insert({
      public_id: publicId,
      chain_id: chainId,
      agentic_commerce: agenticCommerce.toLowerCase(),
      job_id: jobId,
      client_wallet: "0x0000000000000000000000000000000000000000",
      provider_wallet: "0x0000000000000000000000000000000000000000",
      evaluator_contract: evaluatorAddress.toLowerCase(),
      deliverable_hash: deliverableHash,
      content_hash: deliverableObj.contentHash,
      content_uri: deliverableObj.contentUri,
      policy_id: deliverableObj.policyId,
      policy_hash: policyHash,
      status: "evaluating",
      created_at: new Date().toISOString(),
    });

    if (insertError) {
      console.error("[erc8183-evaluations] Insert error:", insertError);
      return createMachineErrorResponse("internal_error", "Failed to queue evaluation record.", 500);
    }
  }

  // Run evaluation
  const result = await executeOffchainJobEvaluation({
    chainId,
    agenticCommerce: agenticCommerce as `0x${string}`,
    jobId,
    deliverable: deliverableObj,
    evaluatorContract: evaluatorAddress as `0x${string}`,
    attesterPrivateKey: attesterKey as `0x${string}`,
    relayerPrivateKey: relayerKey as `0x${string}`,
  });

  // Update DB record
  const updatePayload: Record<string, unknown> = {
    status: result.status,
    failure_category: result.failureCategory ?? null,
    evaluated_at: new Date().toISOString(),
  };

  if (result.decision) {
    updatePayload.decision = result.decision;
  }
  if (result.canonicalReport) {
    updatePayload.canonical_report = result.canonicalReport;
    updatePayload.report_hash = result.reportHash;
  }
  if (result.verdictDigest) {
    updatePayload.verdict_digest = result.verdictDigest;
  }
  if (result.settlementTxHash) {
    updatePayload.settlement_tx_hash = result.settlementTxHash;
    updatePayload.settled_at = new Date().toISOString();
  }

  const { error: updateError } = await supabase
    .from("erc8183_evaluations")
    .update(updatePayload)
    .eq("public_id", publicId);
  if (updateError) {
    return createMachineErrorResponse(
      "provider_unavailable",
      "Evaluation result could not be safely persisted.",
      503
    );
  }

  const responseBody = {
    evaluationId: publicId,
    status: result.status,
    statusUrl: `/api/erc8183/v1/evaluations/${publicId}`,
  };

  if (idempotencyKey) {
    await saveMachineIdempotency({
      key: idempotencyKey,
      credentialId: context.credential.id,
      route: "/api/erc8183/v1/evaluations",
      payload: body,
      responseStatus: 200,
      responseBody,
      reservationToken,
    });
    reservationToken = undefined;
  }

  return NextResponse.json(responseBody, { status: 200 });
}
