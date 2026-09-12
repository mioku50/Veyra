/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse } from "next/server";
import type { EvaluatorMetadata } from "@/lib/erc8183/types.ts";

export async function GET() {
  const evaluatorAddress = (process.env.NEXT_PUBLIC_VEYRA_ERC8183_EVALUATOR_ADDRESS ||
    "0x0d2c04580e081e222bbe5bf9818af337e2633eb7") as `0x${string}`;
  const commerceAddress = (process.env.NEXT_PUBLIC_ARC_ERC8183_COMMERCE_ADDRESS ||
    "0x0747EEf0706327138c69792bF28Cd525089e4583") as `0x${string}`;

  const metadata: EvaluatorMetadata = {
    standard: "ERC-8183",
    network: "arc-testnet",
    chainId: 5042002,
    status: "active",
    evaluatorAddress,
    commerceAddress,
    policy: "structured-deliverable-v1",
  };

  return NextResponse.json(metadata, {
    headers: {
      "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
    },
  });
}
