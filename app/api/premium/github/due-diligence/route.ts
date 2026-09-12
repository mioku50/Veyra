/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextRequest, NextResponse } from "next/server";
import { analyzeGitHubDueDiligence } from "@/lib/agent/github-due-diligence";
import { BRAND } from "@/lib/brand";
import type { GitHubRepositorySnapshot } from "@/lib/providers/github-types";
import { withGateway } from "@/lib/x402";

const PRICE_USDC = "0.0005";

const handler = async (req: NextRequest) => {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const snapshot = body.snapshot as GitHubRepositorySnapshot | undefined;
  if (!snapshot || typeof snapshot !== "object" || !snapshot.ref || !snapshot.repository) {
    return NextResponse.json(
      {
        error: "Valid GitHub repository snapshot required in body field 'snapshot'.",
        code: "invalid_snapshot",
      },
      { status: 400 },
    );
  }

  try {
    const assessment = analyzeGitHubDueDiligence(snapshot);

    return NextResponse.json({
      assessment,
      paidAmountUsdc: PRICE_USDC,
      billing: {
        chargedBy: BRAND.name,
        protocol: "x402",
        network: "Arc Testnet",
      },
    });
  } catch (error) {
    console.error("[premium:github-due-diligence] assessment failure:", error);
    return NextResponse.json(
      {
        error: "Failed to perform GitHub due diligence analysis.",
        code: "analysis_error",
      },
      { status: 500 },
    );
  }
};

export const POST = withGateway(
  handler,
  `$${PRICE_USDC}`,
  "/api/premium/github/due-diligence",
);
