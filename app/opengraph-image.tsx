/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import { ImageResponse } from "next/og";
import { BRAND } from "@/lib/brand";

export const alt = `${BRAND.name} · Trust for Arc x402 payments`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    <div style={{
      width: "100%", height: "100%", display: "flex", flexDirection: "column",
      justifyContent: "center", padding: 80, backgroundColor: "#110d1c", color: "#faf6ff",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 18, fontSize: 40, fontWeight: 700 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 70, height: 70,
          backgroundColor: "#9347f2", borderRadius: 18 }}>
          {BRAND.monogram}
        </div>
        {BRAND.name}
      </div>
      <div style={{ display: "flex", marginTop: 28, fontSize: 76, fontWeight: 700 }}>
        Trust for Arc x402 payments
      </div>
      <div style={{ display: "flex", marginTop: 18, fontSize: 28, color: "#c6b8d8" }}>
        Check the endpoint, USDC price and payee before spending.
      </div>
    </div>,
    size,
  );
}
