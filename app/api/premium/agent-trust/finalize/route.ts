/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextRequest, NextResponse } from "next/server";
import type { AgentTrustReport } from "@/lib/agent-trust/types";
import { BRAND } from "@/lib/brand";
import { sellerAddress, withGateway } from "@/lib/x402";

const PRICE_USDC = "0.0001";
const ENDPOINT = "/api/premium/agent-trust/finalize";

function validPendingReport(value: unknown): value is AgentTrustReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const report = value as Partial<AgentTrustReport>;
  return (
    report.kind === "agent_trust_report" &&
    report.workflowType === "agent_trust_report" &&
    typeof report.reportId === "string" &&
    report.verification?.status === "verification_pending" &&
    report.verification.verifiedOnArc === false &&
    typeof report.verification.reportHash === "string" &&
    /^0x[0-9a-f]{64}$/i.test(report.verification.reportHash)
  );
}

const handler = async (request: NextRequest) => {
  const body = (await request.json().catch(() => ({}))) as {
    report?: unknown;
  };
  if (!validPendingReport(body.report)) {
    return NextResponse.json(
      {
        error: "A canonical pending Agent Trust Report is required.",
        code: "invalid_agent_trust_report",
      },
      { status: 400 },
    );
  }

  return NextResponse.json(
    {
      report: body.report,
      paidAmountUsdc: PRICE_USDC,
      billing: {
        chargedBy: BRAND.name,
        protocol: "x402",
        network: "Arc Testnet",
        purpose: "canonical_report_hash_attestation",
      },
    },
    {
      headers: {
        "X-Veyra-Canonical-Response-Hash":
          body.report.verification.reportHash,
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
