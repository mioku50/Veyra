/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Metadata } from "next";
import { RunClient } from "./run-client";

export const metadata: Metadata = {
  title: "Run | Veyra",
  description:
    "Before an agent spends USDC, Veyra decides whether it should pay, whom, and how much.",
};

export default function RunPage() {
  return <RunClient />;
}
