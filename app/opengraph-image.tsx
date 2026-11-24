/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import { ImageResponse } from "next/og";
import { BRAND } from "@/lib/brand";
import { HOME_HEADLINE } from "@/lib/home-metadata";

export const alt = `${BRAND.name} · ${HOME_HEADLINE}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    <div style={{
      width: "100%", height: "100%", display: "flex", flexDirection: "column",
      justifyContent: "space-between", padding: 76, backgroundColor: "#0c0f19", color: "#faf6ff",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 18, fontSize: 38, fontWeight: 700 }}>
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "center", width: 68, height: 68,
            backgroundColor: "#7c5cff", borderRadius: 16,
          }}>
            {BRAND.monogram}
          </div>
          {BRAND.name}
        </div>
        <div style={{ fontSize: 24, color: "#7dd3fc", fontWeight: 600 }}>
          Arc Mainnet · x402
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <div style={{ display: "flex", fontSize: 64, fontWeight: 700, lineHeight: 1.1 }}>
          {HOME_HEADLINE}.
        </div>
        <div style={{ display: "flex", fontSize: 28, color: "#c6b8d8", lineHeight: 1.35 }}>
          Live Arc Mainnet USDC payment challenge, price, and payee inspection before spending funds.
        </div>
      </div>

      <div style={{ display: "flex", fontSize: 24, color: "#94a3b8" }}>
        Free web check · REST API · MCP
      </div>
    </div>,
    size,
  );
}
