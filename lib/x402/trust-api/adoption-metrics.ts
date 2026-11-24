/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { after } from "next/server.js";
import { getByoaClient } from "../../byoa/service.ts";

export type AdoptionEvent = "rest_verdict" | "mcp_verdict" | "web_verdict" | "paid_history";

export const WEB_VERDICT_SOURCE_HEADER = "x-veyra-source";
export const WEB_VERDICT_SOURCE_VALUE = "web";

/** Classify first-party web verdict checks without changing the request body schema. */
export function verdictAdoptionChannel(headers: Headers): "web_verdict" | "rest_verdict" {
  return headers.get(WEB_VERDICT_SOURCE_HEADER)?.trim().toLowerCase() === WEB_VERDICT_SOURCE_VALUE
    ? "web_verdict"
    : "rest_verdict";
}

export function makeAdoptionEvent(
  headers: Headers,
  event: AdoptionEvent,
  config: { secret: string | undefined; environment: string | undefined },
  now: Date,
) {
  if (config.environment !== "production" || !config.secret || !/^[\da-f]{64}$/i.test(config.secret)) {
    return null;
  }
  if (headers.get("sec-gpc") === "1") return null;

  // Use Vercel's own forwarded address. Ignore untrusted fallback headers
  // and ambiguous forwarding chains.
  const address = headers.get("x-vercel-forwarded-for")?.trim() ?? "";
  const version = isIP(address);
  if (!version || address.includes("%")) return null;
  const canonicalAddress = version === 6 ? new URL("http://[" + address + "]").hostname : address;

  const monday = new Date(now);
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  const week = monday.toISOString().slice(0, 10);
  const pseudonym = createHmac("sha256", Buffer.from(config.secret, "hex"))
    .update("veyra-adoption-v1\n")
    .update(week)
    .update("\n")
    .update(canonicalAddress)
    .digest("hex");

  return { p_event: event, p_week: week, p_caller: pseudonym, p_occurred_at: now.toISOString() };
}

export function recordAdoptionEvent(headers: Headers, event: AdoptionEvent): void {
  try {
    const metrics = makeAdoptionEvent(headers, event, {
      secret: process.env.VEYRA_ADOPTION_METRICS_SECRET,
      environment: process.env.VERCEL_ENV,
    }, new Date());
    if (!metrics) return;

    // Only the four computed metrics fields survive into the callback.
    after(async () => {
      try {
        const db = getByoaClient();
        const { error } = await db.rpc("record_veyra_adoption_event", metrics);
        if (error?.code === "22023" && event === "web_verdict") {
          const fallback = await db.rpc("record_veyra_adoption_event", {
            ...metrics,
            p_event: "rest_verdict",
          });
          if (!fallback.error) return;
        }
        if (error) console.warn("veyra_adoption_event_not_recorded");
      } catch {
        console.warn("veyra_adoption_event_not_recorded");
      }
    });
  } catch {
    // Observability failures cannot prevent a verdict or an already-paid result.
    console.warn("veyra_adoption_event_not_recorded");
  }
}
