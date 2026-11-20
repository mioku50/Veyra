/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import { createClient } from "@supabase/supabase-js";
import { getServerSupabaseConfig } from "../supabase/server-env.ts";

const staleAfterMinutes = 180; // Three expected hourly scheduler ticks.

type NovaScheduleHealth = {
  status: "healthy" | "degraded" | "stale" | "no_data" | "error";
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  staleAfterMinutes: number;
};

function noTick(status: "no_data" | "error"): NovaScheduleHealth {
  return { status, lastStartedAt: null, lastCompletedAt: null, staleAfterMinutes };
}

export async function getNovaScheduleHealth(now?: Date): Promise<NovaScheduleHealth> {
  try {
    const config = getServerSupabaseConfig();
    const db = createClient(config.url, config.key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await db
      .from("nova_ticks")
      .select("started_at,finished_at,failed,stopped_early")
      .order("started_at", { ascending: false })
      .limit(1)
      .abortSignal(AbortSignal.timeout(2_000))
      .maybeSingle();
    if (error) return noTick("error");
    if (!data) return noTick("no_data");

    const started = new Date(data.started_at);
    const completed = new Date(data.finished_at);
    const observedAt = now?.getTime() ?? Date.now();
    if (!(started.getTime() <= completed.getTime() && completed.getTime() <= observedAt)) {
      return noTick("error");
    }
    const ageMinutes = (observedAt - completed.getTime()) / 60_000;
    const status = ageMinutes >= staleAfterMinutes
      ? "stale"
      : data.failed > 0 || data.stopped_early ? "degraded" : "healthy";

    return {
      status,
      lastStartedAt: started.toISOString(),
      lastCompletedAt: completed.toISOString(),
      staleAfterMinutes,
    };
  } catch {
    // This remains a public status response even if no database is reachable.
    return noTick("error");
  }
}
