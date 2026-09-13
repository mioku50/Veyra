/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Metadata } from "next";
import { NovaClient } from "../nova/nova-client";
import { BRAND_TITLE } from "@/lib/brand";

export const metadata: Metadata = { title: `Arc — ${BRAND_TITLE}` };

/* One client, four destinations. The brief, the agent, what it has learned and
   what it has earned are views of the same agent rather than four products, so
   they share the data, the owner check and the single place that knows how to
   recover an identity from this browser. */
export default function Page() {
  return <NovaClient view="arc" />;
}
