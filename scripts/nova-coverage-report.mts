/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import { createClient } from "@supabase/supabase-js";
import { coverageReport } from "../lib/nova/coverage-report.ts";
import { getServerSupabaseConfig } from "../lib/supabase/server-env.ts";

/* SELECT-only. Counts and source labels; no article text, no question, no
   quote body, no key. Usage:
     npm run --silent nova:coverage:report                 -- last 7 days
     npm run --silent nova:coverage:report 2026-09-15 2026-09-22 */
const to = process.argv[3] ? new Date(process.argv[3]) : new Date();
const from = process.argv[2] ? new Date(process.argv[2]) : new Date(to.getTime() - 7 * 86_400_000);
if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new Error("Expected ISO dates: <from> <to>");
if (from >= to) throw new Error("The window starts after it ends.");

const config = getServerSupabaseConfig();
const db = createClient(config.url, config.key, { auth: { persistSession: false, autoRefreshToken: false } });
console.log(JSON.stringify(await coverageReport(db, { from: from.toISOString(), to: to.toISOString() }), null, 2));
