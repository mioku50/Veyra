/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Metadata } from "next";
import { NovaClient } from "./nova-client";

export const metadata: Metadata = {
  title: "Your agent | Veyra",
  description:
    "A personal agent that watches the agent economy for you, brings back what changed, and never spends anything without asking.",
};

export default function NovaPage() {
  return <NovaClient />;
}
