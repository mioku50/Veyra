/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Metadata } from "next";
import { BRAND_TITLE } from "@/lib/brand";
import { NovaClient } from "./nova-client";

export const metadata: Metadata = {
  title: `Nova — ${BRAND_TITLE}`,
  description: "Your personal monitoring agent on Arc that watches sources daily and asks before spending.",
};

export default function NovaPage() {
  return <NovaClient />;
}
