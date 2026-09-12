/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextRequest, NextResponse } from "next/server";
import { BRAND } from "@/lib/brand";
import { sellerAddress, withGateway } from "@/lib/x402";
import {
  computeCanonicalReportHash,
  stripInternalKeys,
  validateApiQualityReportPayload,
} from "@/lib/reports/canonical-report-hash";
import { API_QUALITY_FINALIZER_PRICE_USDC } from "@/lib/services/constants";

const PRICE_USDC = API_QUALITY_FINALIZER_PRICE_USDC;
const ENDPOINT = "/api/provider/api-quality-finalizer";

const handler = async (request: NextRequest) => {
  const body = (await request.json().catch(() => ({}))) as {
    report?: unknown;
    [key: string]: unknown;
  };

  const rawReport = body.report ?? body;

  if (!validateApiQualityReportPayload(rawReport)) {
    return NextResponse.json(
      {
        error:
          "Invalid API Quality report payload structure. Report must include valid workflowType, reportId, servicesCompared, availability, and qualityScoreAndConfidence.",
        code: "invalid_report_payload",
      },
      { status: 400 },
    );
  }

  const reportObj = {
    ...rawReport,
    workflowType: rawReport.workflowType ?? rawReport.workflow ?? "paid_api_quality",
    workflow: rawReport.workflow ?? rawReport.workflowType ?? "paid_api_quality",
  };

  const cleanReport = stripInternalKeys(reportObj) as Record<string, unknown>;
  const { canonicalHash, canonicalizationVersion } = computeCanonicalReportHash(cleanReport);

  return NextResponse.json(
    {
      report: cleanReport,
      paidAmountUsdc: PRICE_USDC,
      billing: {
        chargedBy: BRAND.name,
        protocol: "x402",
        network: "Arc Testnet",
        purpose: "api_quality_canonical_hash_attestation",
      },
      canonicalHash,
      canonicalizationVersion,
    },
    {
      headers: {
        "X-Veyra-Canonical-Response-Hash": canonicalHash,
      },
    },
  );
};

export const POST = withGateway(
  handler,
  `$${PRICE_USDC}`,
  ENDPOINT,
  sellerAddress,
  {
    requiredPayer:
      process.env.HOSTED_AGENT_ADDRESS ?? "hosted-payer-not-configured",
    allowCanonicalResponseHash: true,
  },
);
