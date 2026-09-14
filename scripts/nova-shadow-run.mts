/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 *
 * One shadow pass, by hand, against whatever is in the database.
 *
 * The same function the scheduler calls per agent. It exists because an agent
 * that was refreshed twenty minutes ago is not due for six hours, and the first
 * pass after somebody signs their limits should not have to wait for that --
 * resetting the scheduler's own clock to force it would be lying to the part of
 * the system whose whole job is knowing when it last looked.
 *
 * Nothing here can spend. runShadowPass stops one step before any payment
 * authorization exists.
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import { createClient } from "@supabase/supabase-js";
import { getServerSupabaseConfig } from "../lib/supabase/server-env.ts";
import { runShadowPass } from "../lib/nova/shadow-run.ts";
import { shadowDecisionsFor } from "../lib/nova/autonomy-db.ts";

const only = process.argv[2] ?? null;

const config = getServerSupabaseConfig();
const db = createClient(config.url, config.key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { data, error } = await db
  .from("nova_agents")
  .select("agent_id, public_id, name, interests, owner_wallet")
  .not("owner_wallet", "is", null);
if (error) throw new Error(`could not list agents: ${error.message}`);

const agents = (data ?? []).filter((row) => !only || row.public_id === only);
if (agents.length === 0) {
  console.log("[shadow] no agent with a wallet, so nothing has limits to be judged against");
  process.exit(0);
}

for (const row of agents) {
  const pass = await runShadowPass({
    agent: {
      agentId: row.agent_id as string,
      publicId: row.public_id as string,
      name: row.name as string,
      interests: (row.interests as string[]) ?? [],
      ownerWallet: row.owner_wallet as string,
    },
    now: new Date(),
  });

  console.log(`[shadow] ${row.public_id}`, JSON.stringify(pass));
  if (!pass.ran) continue;

  for (const entry of await shadowDecisionsFor(row.agent_id as string, 5)) {
    console.log(`\n  ${entry.verdict}  $${entry.wouldSpendUsdc.toFixed(4)}  ${entry.provider ?? "?"}`);
    console.log(`  ${entry.question}`);
    for (const check of entry.checks) {
      console.log(`   ${check.ok ? "✓" : "✕"} ${check.detail}`);
    }
  }
}
