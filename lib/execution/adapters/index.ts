/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { Erc8183ExecutionAdapter } from "./erc8183.ts";
import { X402ExecutionAdapter } from "./x402.ts";
import type { ExecutionRailAdapter } from "./types.ts";
import type { ExecutionRail } from "../types.ts";

const erc8183Adapter = new Erc8183ExecutionAdapter();
const x402Adapter = new X402ExecutionAdapter();

export function getRailAdapter(rail: ExecutionRail): ExecutionRailAdapter {
  switch (rail) {
    case "erc8183":
      return erc8183Adapter;
    case "x402":
      return x402Adapter;
    default:
      throw new Error(`Unsupported execution rail: ${rail}`);
  }
}

export * from "./types.ts";
export * from "./erc8183.ts";
export * from "./x402.ts";
