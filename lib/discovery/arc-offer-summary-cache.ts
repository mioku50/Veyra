/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import { unstable_cache } from "next/cache";
import { readArcOfferIndexSummary, type ArcOfferIndexSummary } from "./arc-offer-index.ts";

const loadCachedSummary = unstable_cache(
  async (): Promise<ArcOfferIndexSummary> => {
    const summary = await readArcOfferIndexSummary();
    if (!summary) throw new Error("arc_offer_index_summary_unavailable");
    return summary;
  },
  ["arc-offer-index-summary-v1"],
  { revalidate: 600 },
);

export async function getCachedArcOfferIndexSummary(): Promise<ArcOfferIndexSummary | null> {
  try {
    return await loadCachedSummary();
  } catch {
    return null;
  }
}
