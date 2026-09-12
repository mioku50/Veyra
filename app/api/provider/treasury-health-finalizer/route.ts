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
  validateTreasuryHealthReportPayload,
} from "@/lib/reports/canonical-report-hash";
import { TREASURY_HEALTH_FINALIZER_PRICE_USDC } from "@/lib/services/constants";

const PRICE_USDC = TREASURY_HEALTH_FINALIZER_PRICE_USDC;
const ENDPOINT = "/api/provider/treasury-health-finalizer";

const handler = async (request: NextRequest) => {
  const body = (await request.json().catch(() => ({}))) as {
    report?: unknown;
    [key: string]: unknown;
  };

  const rawReport = body.report ?? body;

  if (!validateTreasuryHealthReportPayload(rawReport)) {
    return NextResponse.json(
      {
        error:
          "Invalid Treasury Health report payload structure. Report must include valid workflowType, reportId, targetWallet, usdcFlowOverview, and treasuryHealthScore.",
        code: "invalid_report_payload",
      },
      { status: 400 },
    );
  }

  const reportObj = {
    ...rawReport,
    workflowType: rawReport.workflowType ?? rawReport.workflow ?? "treasury_health",
    workflow: rawReport.workflow ?? rawReport.workflowType ?? "treasury_health",
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
        purpose: "treasury_health_canonical_hash_attestation",
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
