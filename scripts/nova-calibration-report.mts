/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import { createClient } from "@supabase/supabase-js";
import { currentEpoch } from "../lib/nova/calibration.ts";
import { calibrationReport, type CalibrationRow, type CalibrationTerms } from "../lib/nova/calibration-report.ts";
import { getServerSupabaseConfig } from "../lib/supabase/server-env.ts";

// SELECT-only. No scheduler invocation and no questions, bodies, keys or signatures in output.
const hash = process.argv[2] ?? currentEpoch()?.mandateHash;
if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("Expected a canonical mandate hash");
const asOf = new Date();
const config = getServerSupabaseConfig();
const db = createClient(config.url, config.key, { auth: { persistSession: false, autoRefreshToken: false } });
const { data: mandate, error: mandateError } = await db.from("execution_mandates")
  .select("canonical_hash,subject_agent_id,mode,network,budget_timezone,issued_at,expires_at,revoked_at,max_per_transaction_usdc,max_per_day_usdc,max_total_usdc,max_autonomous_attempts_per_day")
  .eq("canonical_hash", hash).single();
if (mandateError || !mandate) throw new Error(`Mandate read failed (${mandateError?.code ?? "missing"})`);
const { data: agent, error: agentError } = await db.from("nova_agents")
  .select("agent_id,last_scheduled_refresh_at").eq("public_id", mandate.subject_agent_id).single();
if (agentError || !agent) throw new Error(`Agent read failed (${agentError?.code ?? "missing"})`);

const rows: CalibrationRow[] = [];
const size = 500;
// Stable order + fixed decision cutoff; fail rather than silently report truncated history.
for (let offset = 0; ; offset += size) {
  const { data, error } = await db.from("nova_autonomy_decisions")
    .select("signal_id,mandate_hash,verdict,would_spend_usdc,failed_codes,owner_feedback,budget_period_start,decided_at")
    .eq("agent_id", agent.agent_id).lte("decided_at", asOf.toISOString())
    .order("decided_at").order("decision_id").range(offset, offset + size - 1);
  if (error) throw new Error(`Decision read failed (${error.code})`);
  rows.push(...(data as CalibrationRow[]));
  if (data.length < size) break;
}
const { subject_agent_id: _subject, ...terms } = mandate;
console.log(JSON.stringify({
  source: "Configured Supabase database (local environment); production identity not independently attested",
  lastScheduledRefreshAt: agent.last_scheduled_refresh_at,
  ...calibrationReport(rows, terms as CalibrationTerms, asOf),
}, null, 2));
