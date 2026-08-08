/**
 * Copyright 2026 Circle Internet Group, Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createWalletClient, http, isHex, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import {
  ARC_ERC8004_VALIDATION_REGISTRY,
  fetchValidationStatusOnchain,
  getArcPublicClient,
  getCanonicalAgentIdentity,
} from "@/lib/erc8004/client.ts";
import {
  buildCanonicalValidationResponse,
  isPendingValidationStatus,
  isTerminalValidationStatus,
} from "@/lib/erc8004/validation.ts";
import { getByoaClient } from "@/lib/byoa/service.ts";
import type { Erc8183EvaluationRecord } from "@/lib/erc8183/types.ts";
import type { Erc8004ValidationLinkRecord } from "@/lib/erc8004/types.ts";

const RESPONSE_ABI = parseAbi([
  "function validationResponse(bytes32 requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag)",
]);

function publicError(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}

function secretMatches(header: string | null, expectedSecret: string) {
  const supplied = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const expectedDigest = createHash("sha256").update(expectedSecret).digest();
  const suppliedDigest = createHash("sha256").update(supplied).digest();
  return timingSafeEqual(expectedDigest, suppliedDigest) && supplied.length === expectedSecret.length;
}

function exactStoredBinding(
  stored: Erc8004ValidationLinkRecord,
  canonical: ReturnType<typeof buildCanonicalValidationResponse>
) {
  return (
    stored.request_hash.toLowerCase() === canonical.requestHash.toLowerCase() &&
    stored.agent_id === canonical.agentId &&
    stored.evaluation_public_id === canonical.evaluationPublicId &&
    stored.canonical_report_hash.toLowerCase() === canonical.canonicalReportHash.toLowerCase() &&
    stored.response === canonical.response &&
    stored.response_hash.toLowerCase() === canonical.responseHash.toLowerCase() &&
    stored.tag === canonical.tag
  );
}

export async function POST(request: Request) {
  const expectedSecret = process.env.ERC8004_VALIDATION_RESPOND_SECRET;
  if (!expectedSecret) {
    return publicError(
      "validation_responder_unavailable",
      "The validation responder is not configured.",
      503
    );
  }
  if (!secretMatches(request.headers.get("authorization"), expectedSecret)) {
    return publicError("unauthorized", "Unauthorized.", 401);
  }

  try {
    const body = await request.json();
    const bodyKeys = body && typeof body === "object" ? Object.keys(body) : [];
    const requestHash = typeof body?.requestHash === "string" ? body.requestHash : "";
    if (
      bodyKeys.length !== 1 ||
      bodyKeys[0] !== "requestHash" ||
      !isHex(requestHash) ||
      requestHash.length !== 66 ||
      /^0x0{64}$/i.test(requestHash)
    ) {
      return publicError(
        "invalid_validation_request",
        "Only a valid requestHash may be submitted.",
        400
      );
    }

    const privateKey =
      process.env.VEYRA_EVALUATOR_RELAYER_PRIVATE_KEY ||
      process.env.ERC8183_EVALUATOR_RELAYER_PRIVATE_KEY;
    if (!privateKey || !/^0x[0-9a-f]{64}$/i.test(privateKey)) {
      return publicError(
        "validation_responder_unavailable",
        "The validation responder is not configured.",
        503
      );
    }

    const account = privateKeyToAccount(privateKey as Hex);
    const supabase = getByoaClient();
    const { data: linkData, error: linkError } = await supabase
      .from("erc8004_validation_links")
      .select("*")
      .eq("request_hash", requestHash)
      .maybeSingle();
    if (linkError) {
      return publicError(
        "validation_storage_unavailable",
        "The validation response cannot be safely processed right now.",
        503
      );
    }
    if (!linkData) {
      return publicError("validation_not_found", "Validation request not found.", 404);
    }
    const stored = linkData as Erc8004ValidationLinkRecord;
    if (!stored.evaluation_public_id) {
      return publicError(
        "validation_binding_invalid",
        "The validation request is not bound to verified evidence.",
        409
      );
    }

    const { data: evaluationData, error: evaluationError } = await supabase
      .from("erc8183_evaluations")
      .select("*")
      .eq("public_id", stored.evaluation_public_id)
      .maybeSingle();
    if (evaluationError) {
      return publicError(
        "validation_storage_unavailable",
        "The validation response cannot be safely processed right now.",
        503
      );
    }
    if (!evaluationData) {
      return publicError("evaluation_not_found", "Evaluation not found.", 404);
    }

    const publicClient = getArcPublicClient();
    const onchainBefore = await fetchValidationStatusOnchain(
      requestHash as Hex,
      ARC_ERC8004_VALIDATION_REGISTRY,
      publicClient
    );
    if (onchainBefore.validatorAddress.toLowerCase() !== account.address.toLowerCase()) {
      return publicError(
        "validation_responder_mismatch",
        "The validation request targets a different validator.",
        409
      );
    }
    if (onchainBefore.agentId.toString() !== stored.agent_id) {
      return publicError(
        "validation_binding_invalid",
        "The validation request does not match the stored agent identity.",
        409
      );
    }
    const identity = await getCanonicalAgentIdentity(stored.agent_id, publicClient);
    if (!identity) {
      return publicError("identity_not_found", "Agent identity was not found.", 404);
    }

    const canonical = buildCanonicalValidationResponse({
      evaluation: evaluationData as Erc8183EvaluationRecord,
      requestHash: requestHash as Hex,
      agentId: onchainBefore.agentId.toString(),
      baseUrl: process.env.NEXT_PUBLIC_APP_URL || "https://agent-commerce-six.vercel.app",
    });
    if (!exactStoredBinding(stored, canonical)) {
      return publicError(
        "validation_binding_invalid",
        "The stored validation binding does not match verified evidence.",
        409
      );
    }

    if (isTerminalValidationStatus(onchainBefore)) {
      return publicError(
        "validation_already_terminal",
        "The onchain validation request is already terminal.",
        409
      );
    }
    if (!isPendingValidationStatus(onchainBefore) || stored.status !== "pending") {
      return publicError(
        "validation_not_pending",
        "The validation request is not pending.",
        409
      );
    }

    const { data: lockedRows, error: lockError } = await supabase
      .from("erc8004_validation_links")
      .update({ status: "submitted" })
      .eq("request_hash", requestHash)
      .eq("status", "pending")
      .select("request_hash");
    if (lockError || !lockedRows || lockedRows.length !== 1) {
      return publicError(
        "validation_storage_unavailable",
        "The validation response cannot be safely reserved right now.",
        503
      );
    }

    const walletClient = createWalletClient({
      account,
      chain: arcTestnet,
      transport: http(process.env.ARC_TESTNET_RPC_URL || "https://rpc.testnet.arc.network"),
    });
    let txHash: Hex;
    try {
      txHash = await walletClient.writeContract({
        address: ARC_ERC8004_VALIDATION_REGISTRY,
        abi: RESPONSE_ABI,
        functionName: "validationResponse",
        args: [
          canonical.requestHash,
          canonical.response,
          canonical.responseURI,
          canonical.responseHash,
          canonical.tag,
        ],
      });
    } catch (error) {
      await supabase
        .from("erc8004_validation_links")
        .update({ status: "failed" })
        .eq("request_hash", requestHash)
        .eq("status", "submitted");
      throw error;
    }

    const { error: txStoreError } = await supabase
      .from("erc8004_validation_links")
      .update({ response_tx: txHash })
      .eq("request_hash", requestHash)
      .eq("status", "submitted");
    if (txStoreError) {
      console.error("ERC-8004 validation transaction persistence failed", {
        code: txStoreError.code,
        requestHash,
      });
    }

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 30_000 });
    if (receipt.status !== "success") {
      await supabase
        .from("erc8004_validation_links")
        .update({ status: "failed", response_tx: txHash })
        .eq("request_hash", requestHash);
      return publicError("validation_transaction_failed", "The validation transaction failed.", 502);
    }

    const onchainAfter = await fetchValidationStatusOnchain(
      requestHash as Hex,
      ARC_ERC8004_VALIDATION_REGISTRY,
      publicClient
    );
    const exactOnchain =
      onchainAfter.validatorAddress.toLowerCase() === account.address.toLowerCase() &&
      onchainAfter.agentId.toString() === canonical.agentId &&
      onchainAfter.response === canonical.response &&
      onchainAfter.responseHash.toLowerCase() === canonical.responseHash.toLowerCase() &&
      onchainAfter.tag === canonical.tag &&
      isTerminalValidationStatus(onchainAfter);
    if (!exactOnchain) {
      await supabase
        .from("erc8004_validation_links")
        .update({ status: "failed", response_tx: txHash })
        .eq("request_hash", requestHash);
      return publicError(
        "validation_onchain_mismatch",
        "The onchain validation response could not be verified.",
        502
      );
    }

    const confirmedAt = new Date().toISOString();
    const { data: confirmedRows, error: confirmError } = await supabase
      .from("erc8004_validation_links")
      .update({
        status: "confirmed",
        response_tx: txHash,
        confirmed_at: confirmedAt,
      })
      .eq("request_hash", requestHash)
      .eq("status", "submitted")
      .select("request_hash");
    if (confirmError || !confirmedRows || confirmedRows.length !== 1 || txStoreError) {
      return publicError(
        "validation_storage_unavailable",
        "The confirmed validation response could not be safely persisted.",
        503
      );
    }

    return NextResponse.json({
      success: true,
      requestHash: canonical.requestHash,
      response: canonical.response,
      responseHash: canonical.responseHash,
      txHash,
      blockNumber: receipt.blockNumber.toString(),
      arcscanUrl: `https://testnet.arcscan.app/tx/${txHash}`,
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "validation_response_failed";
    console.error("ERC-8004 validation response failed", { code });
    return publicError(
      "validation_response_failed",
      "The validation response could not be safely submitted.",
      503
    );
  }
}
