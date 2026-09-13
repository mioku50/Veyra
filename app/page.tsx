/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Metadata } from "next";
import { NovaClient } from "./nova/nova-client";
import { BRAND, BRAND_TITLE } from "@/lib/brand";

/**
 * The front door is the product.
 *
 * This page used to be the pitch: a hero, six numbered stages, a row of
 * workflow cards, a repository analyser, and three competing calls to action.
 * It described what Veyra could do rather than doing anything, and a visitor
 * had to learn the architecture before they could use it.
 *
 * Now the first screen creates a personal agent, and the second is that agent's
 * brief. Everything the old page claimed is still true and still reachable --
 * it is just underneath, where infrastructure belongs, instead of in front of
 * the person who has not yet been given a reason to care about it.
 */

/* The shared description, not a page-specific one. A link to Veyra should
   preview as Veyra wherever it is pasted, and the front door is the link people
   paste. */
export const metadata: Metadata = {
  title: { absolute: BRAND_TITLE },
  description: BRAND.description,
  openGraph: { title: BRAND_TITLE, description: BRAND.description },
};

export default function HomePage() {
  return <NovaClient />;
}
