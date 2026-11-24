/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import { ImageResponse } from "next/og";
import { BRAND } from "@/lib/brand";
import { getCachedArcStateReport } from "@/lib/discovery/arc-state-cache";

export const dynamic = "force-dynamic";
export const alt = `State of Arc x402 · Observed by ${BRAND.name}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const integer = new Intl.NumberFormat("en-US");

function formatRate(rate: number | null | undefined): string {
  return rate === null || rate === undefined ? "—" : `${(rate * 100).toFixed(1)}%`;
}

export default async function StateOpenGraphImage() {
  const report = await getCachedArcStateReport();
  const listings = report ? integer.format(report.overview.listings) : "—";
  const hosts = report ? integer.format(report.overview.distinctHosts) : "—";
  const validRate = formatRate(report?.liveness.arcChallengeRate);
  const driftRate = formatRate(report?.drift.anyRate);
  const top5Share = formatRate(report?.concentration.top5Share);

  return new ImageResponse(
    <div style={{
      width: "100%", height: "100%", display: "flex", flexDirection: "column",
      justifyContent: "space-between", padding: 72, backgroundColor: "#0c0f19", color: "#faf6ff",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 18, fontSize: 34, fontWeight: 700 }}>
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "center", width: 60, height: 60,
            backgroundColor: "#7c5cff", borderRadius: 14,
          }}>
            {BRAND.monogram}
          </div>
          {BRAND.name}
        </div>
        <div style={{ display: "flex", fontSize: 22, color: "#7dd3fc", fontWeight: 600 }}>
          Arc Mainnet · State of Arc x402
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
        <div style={{ display: "flex", fontSize: 54, fontWeight: 700, lineHeight: 1.1 }}>
          State of Arc x402
        </div>
        <div style={{ display: "flex", gap: 20 }}>
          <div style={{
            display: "flex", flexDirection: "column", flex: 1, padding: 24,
            borderRadius: 16, border: "1px solid rgba(255,255,255,0.14)", backgroundColor: "rgba(255,255,255,0.04)",
          }}>
            <div style={{ display: "flex", fontSize: 20, color: "#94a3b8" }}>Active listings</div>
            <div style={{ display: "flex", fontSize: 44, fontWeight: 700, marginTop: 8 }}>{listings}</div>
            <div style={{ display: "flex", fontSize: 18, color: "#cbd5e1", marginTop: 6 }}>{hosts} hosts</div>
          </div>
          <div style={{
            display: "flex", flexDirection: "column", flex: 1, padding: 24,
            borderRadius: 16, border: "1px solid rgba(255,255,255,0.14)", backgroundColor: "rgba(255,255,255,0.04)",
          }}>
            <div style={{ display: "flex", fontSize: 20, color: "#94a3b8" }}>Valid Arc 402</div>
            <div style={{ display: "flex", fontSize: 44, fontWeight: 700, marginTop: 8 }}>{validRate}</div>
            <div style={{ display: "flex", fontSize: 18, color: "#cbd5e1", marginTop: 6 }}>Unpaid checks</div>
          </div>
          <div style={{
            display: "flex", flexDirection: "column", flex: 1, padding: 24,
            borderRadius: 16, border: "1px solid rgba(255,255,255,0.14)", backgroundColor: "rgba(255,255,255,0.04)",
          }}>
            <div style={{ display: "flex", fontSize: 20, color: "#94a3b8" }}>Catalog drift</div>
            <div style={{ display: "flex", fontSize: 44, fontWeight: 700, marginTop: 8 }}>{driftRate}</div>
            <div style={{ display: "flex", fontSize: 18, color: "#cbd5e1", marginTop: 6 }}>Live vs listed</div>
          </div>
          <div style={{
            display: "flex", flexDirection: "column", flex: 1, padding: 24,
            borderRadius: 16, border: "1px solid rgba(255,255,255,0.14)", backgroundColor: "rgba(255,255,255,0.04)",
          }}>
            <div style={{ display: "flex", fontSize: 20, color: "#94a3b8" }}>Top 5 hosts</div>
            <div style={{ display: "flex", fontSize: 44, fontWeight: 700, marginTop: 8 }}>{top5Share}</div>
            <div style={{ display: "flex", fontSize: 18, color: "#cbd5e1", marginTop: 6 }}>Listing share</div>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 22, color: "#94a3b8" }}>
        <span>Observed by {BRAND.name} · Unpaid HTTP 402 checks</span>
        <span>/state.json</span>
      </div>
    </div>,
    size,
  );
}
