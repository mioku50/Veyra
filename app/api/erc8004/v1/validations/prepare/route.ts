/**
 * Copyright 2026 Circle Internet Group, Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse } from "next/server";
import { isHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  fetchValidationStatusOnchain,
  getArcPublicClient,
  getCanonicalAgentIdentity,
} from "@/lib/erc8004/client.ts";
import {
  buildCanonicalValidationResponse,
  isPendingValidationStatus,
} from "@/lib/erc8004/validation.ts";
import { getByoaClient } from "@/lib/byoa/service.ts";
import type { Erc8183EvaluationRecord } from "@/lib/erc8183/types.ts";
import type { Erc8004ValidationLinkRecord } from "@/lib/erc8004/types.ts";

function publicError(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const evaluationPublicId = typeof body?.evaluationPublicId === "string"
      ? body.evaluationPublicId.trim()
      : "";
    const requestHash = typeof body?.requestHash === "string" ? body.requestHash : "";

    if (
      !evaluationPublicId ||
      !isHex(requestHash) ||
      requestHash.length !== 66 ||
      /^0x0{64}$/i.test(requestHash)
    ) {
      return publicError("invalid_validation_request", "The validation request is invalid.", 400);
    }

    const supabase = getByoaClient();
    const { data: record, error: evaluationError } = await supabase
      .from("erc8183_evaluations")
      .select("*")
      .eq("public_id", evaluationPublicId)
      .maybeSingle();
    if (evaluationError) {
      return publicError(
        "validation_storage_unavailable",
        "The validation request cannot be safely prepared right now.",
        503
      );
    }
    if (!record) {
      return publicError("evaluation_not_found", "Evaluation not found.", 404);
    }

    const evaluation = record as Erc8183EvaluationRecord;
    const publicClient = getArcPublicClient();
    const onchain = await fetchValidationStatusOnchain(requestHash as Hex, undefined, publicClient);
    if (!isPendingValidationStatus(onchain)) {
      return publicError(
        "validation_request_not_pending",
        "The onchain validation request is not pending.",
        409
      );
    }
    const relayerKey =
      process.env.VEYRA_EVALUATOR_RELAYER_PRIVATE_KEY ||
      process.env.ERC8183_EVALUATOR_RELAYER_PRIVATE_KEY;
    if (!relayerKey || !/^0x[0-9a-f]{64}$/i.test(relayerKey)) {
      return publicError(
        "validation_responder_unavailable",
        "The validation responder is not configured.",
        503
      );
    }
    const responder = privateKeyToAccount(relayerKey as Hex).address;
    if (onchain.validatorAddress.toLowerCase() !== responder.toLowerCase()) {
      return publicError(
        "validation_responder_mismatch",
        "The validation request targets a different validator.",
        409
      );
    }

    const identity = await getCanonicalAgentIdentity(onchain.agentId.toString(), publicClient);
    if (!identity) {
      return publicError("identity_not_found", "Agent identity was not found.", 404);
    }

    const canonical = buildCanonicalValidationResponse({
      evaluation,
      requestHash: requestHash as Hex,
      agentId: onchain.agentId.toString(),
      baseUrl: process.env.NEXT_PUBLIC_APP_URL || "https://agent-commerce-six.vercel.app",
    });

    const row = {
      request_hash: canonical.requestHash,
      agent_id: canonical.agentId,
      evaluation_public_id: canonical.evaluationPublicId,
      canonical_report_hash: canonical.canonicalReportHash,
      response: canonical.response,
      response_hash: canonical.responseHash,
      response_tx: null,
      tag: canonical.tag,
      status: "pending" as const,
      confirmed_at: null,
    };

    const { data: existing, error: existingError } = await supabase
      .from("erc8004_validation_links")
      .select("*")
      .eq("request_hash", requestHash)
      .maybeSingle();
    if (existingError) {
      return publicError(
        "validation_storage_unavailable",
        "The validation request cannot be safely prepared right now.",
        503
      );
    }

    if (existing) {
      const stored = existing as Erc8004ValidationLinkRecord;
      const exactMatch =
        stored.agent_id === row.agent_id &&
        stored.evaluation_public_id === row.evaluation_public_id &&
        stored.canonical_report_hash.toLowerCase() === row.canonical_report_hash.toLowerCase() &&
        stored.response === row.response &&
        stored.response_hash.toLowerCase() === row.response_hash.toLowerCase() &&
        stored.tag === row.tag;
      if (!exactMatch) {
        return publicError(
          "validation_binding_conflict",
          "The validation request is already bound to different evidence.",
          409
        );
      }
      if (stored.status !== "pending") {
        return publicError(
          "validation_request_not_pending",
          "The validation request is not pending.",
          409
        );
      }
    } else {
      const { error: insertError } = await supabase.from("erc8004_validation_links").insert(row);
      if (insertError) {
        return publicError(
          "validation_storage_unavailable",
          "The validation request cannot be safely prepared right now.",
          503
        );
      }
    }

    return NextResponse.json(canonical);
  } catch (error) {
    const code = error instanceof Error ? error.message : "validation_prepare_failed";
    const clientErrors = new Set([
      "invalid_deliverable_hash",
      "invalid_report_hash",
      "evaluation_not_terminal_or_inconsistent",
      "request_evaluation_hash_mismatch",
      "invalid_agent_id",
      "invalid_request_hash",
    ]);
    if (clientErrors.has(code)) {
      return publicError("validation_evidence_mismatch", "Validation evidence does not match the request.", 409);
    }
    console.error("ERC-8004 validation preparation failed", { code });
    return publicError(
      "validation_verification_unavailable",
      "The validation request cannot be safely verified right now.",
      503
    );
  }
}
