/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import { unstable_cache } from "next/cache";
import { readLiveArcStateReport, type ArcStateReport } from "./arc-state.ts";

const loadCachedReport = unstable_cache(
  async (): Promise<ArcStateReport> => {
    const report = await readLiveArcStateReport();
    if (!report) throw new Error("arc_state_report_unavailable");
    return report;
  },
  ["arc-state-report-v1"],
  { revalidate: 600 },
);

export async function getCachedArcStateReport(): Promise<ArcStateReport | null> {
  try {
    return await loadCachedReport();
  } catch {
    return null;
  }
}
