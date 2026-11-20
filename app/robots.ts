/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import type { MetadataRoute } from "next";
import { VEYRA_ORIGIN } from "@/lib/erc8004/veyra-registration";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/internal/", "/console", "/login", "/check?"],
    },
    sitemap: `${VEYRA_ORIGIN}/sitemap.xml`,
  };
}
