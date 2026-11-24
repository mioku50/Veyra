/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import type { MetadataRoute } from "next";
import { sitemapArcOffers } from "@/lib/discovery/arc-offer-index";
import { VEYRA_ORIGIN } from "@/lib/erc8004/veyra-registration";

export const revalidate = 3_600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  return [
    ...["/", "/check", "/nova", "/trust"].map((path) => ({ url: new URL(path, VEYRA_ORIGIN).href })),
    ...(await sitemapArcOffers()).map((offer) => ({
      url: `${VEYRA_ORIGIN}/check/${offer.resource_key}`,
      lastModified: offer.last_checked_at,
    })),
  ];
}
