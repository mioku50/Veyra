/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextRequest, NextResponse } from "next/server";
import { BRAND } from "@/lib/brand";
import { isProviderError, ProviderError } from "@/lib/providers/errors";
import { parseGitHubRepositoryInput, InvalidGitHubRepositoryError } from "@/lib/providers/github-repository-ref";
import { fetchGitHubRepositorySnapshot } from "@/lib/providers/github";
import { withGateway } from "@/lib/x402";

const PRICE_USDC = "0.0015";

const handler = async (req: NextRequest) => {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  let repositoryInput = "";
  if (typeof body.owner === "string" && (typeof body.repository === "string" || typeof body.name === "string")) {
    const repoName = typeof body.repository === "string" ? body.repository : body.name;
    repositoryInput = `${body.owner}/${repoName}`;
  } else if (typeof body.repository === "string") {
    repositoryInput = body.repository;
  } else if (typeof body.url === "string") {
    repositoryInput = body.url;
  } else if (typeof body.input === "string") {
    repositoryInput = body.input;
  }

  try {
    const ref = parseGitHubRepositoryInput(repositoryInput);
    const snapshot = await fetchGitHubRepositorySnapshot(ref);

    return NextResponse.json({
      ...snapshot,
      paidAmountUsdc: PRICE_USDC,
      billing: {
        chargedBy: BRAND.name,
        protocol: "x402",
        network: "Arc Testnet",
      },
      attribution:
        `Sourced live from GitHub REST API v3. The x402 payment is made to ${BRAND.name}, not to GitHub.`,
    });
  } catch (error) {
    if (error instanceof InvalidGitHubRepositoryError) {
      return NextResponse.json(
        {
          error: error.message,
          code: "invalid_github_repository",
          reason: "invalid_github_repository",
          provider: "GitHub REST API v3",
          sourceStatus: "unavailable",
          retryable: false,
        },
        { status: 400 },
      );
    }

    if (!isProviderError(error)) {
      console.error("[provider:github] unexpected failure:", error);
      return NextResponse.json(
        {
          error: "GitHub repository intelligence is temporarily unavailable.",
          code: "upstream_error",
          provider: "GitHub REST API v3",
          sourceStatus: "unavailable",
          retryable: true,
        },
        { status: 502 },
      );
    }

    console.warn(
      `[provider:github] request failed code=${error.code} upstreamStatus=${error.upstreamStatus ?? "none"} retryable=${error.retryable ? "yes" : "no"}`,
    );

    return NextResponse.json(
      {
        error: error.message,
        code: error.code,
        provider: "GitHub REST API v3",
        sourceStatus: "unavailable",
        retryable: error.retryable,
      },
      { status: error.httpStatus },
    );
  }
};

export const POST = withGateway(
  handler,
  `$${PRICE_USDC}`,
  "/api/provider/github/repository-intelligence",
);
