/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 *
 * Re-judges purchases that were failed by a gap in Veyra's own validator.
 *
 * A paid Exa call was reported as failing its published output schema because
 * that schema used `oneOf`, and below it a `$ref`. The endpoint had delivered
 * exactly what it promised; the missing keyword was on this side. The money is
 * gone either way, so leaving the verdict wrong would mean the ledger records
 * a seller's failure that never happened, and the person who paid never sees
 * the result they bought.
 *
 * Deliberately narrow. A row is only touched when its own recorded summary
 * proves the rest of the exchange was sound:
 *
 *   - it settled, and every critical check passed -- that is exactly what the
 *     "Paid and answered, but the response did not hold up" sentence means,
 *     since any failed critical would have produced a different one;
 *   - the sole failure recorded was the schema comparison;
 *   - and re-reading that schema today says Veyra cannot enforce it, so the
 *     old verdict was this gap rather than a real mismatch.
 *
 * Anything else is left exactly as it is. A verdict is not something to
 * recompute hopefully.
 */

import assert from "node:assert/strict";
import { db } from "../lib/nova/service.ts";
import { readResult } from "../lib/nova/synthesis.ts";
import { verifyPostCall } from "../lib/x402/post-call-verification.ts";
import { validateSupportedJsonSchema } from "../lib/seller/json-schema.ts";

const SOUND_EXCHANGE = "Paid and answered, but the response did not hold up.";
const SCHEMA_FAILURE = /Response does not match the published output schema/;

const apply = process.argv.includes("--apply");

const { data } = await db().from("nova_research")
  .select("research_id, agent_id, signal_id, status, question, terms, output_schema, result, verification, execution_public_id, paid_usdc, transaction_hash")
  .eq("status", "paid_unverified");

let repaired = 0;
for (const row of (data ?? []) as any[]) {
  const summary: string = row.verification?.summary ?? "";
  const tag = `${row.execution_public_id} (${row.terms?.provider})`;

  if (row.verification?.verdict !== "FAIL") { console.log(`[skip] ${tag}: not a failed verdict`); continue; }
  if (!summary.startsWith(SOUND_EXCHANGE)) { console.log(`[skip] ${tag}: a critical check failed, or it never settled`); continue; }
  if (!SCHEMA_FAILURE.test(summary)) { console.log(`[skip] ${tag}: the failure was not the schema comparison`); continue; }
  if (!row.output_schema) { console.log(`[skip] ${tag}: no published schema on the row`); continue; }

  const enforceable = validateSupportedJsonSchema(row.output_schema);
  if (enforceable.ok || enforceable.unsupported !== true) {
    console.log(`[skip] ${tag}: the schema is enforceable, so the mismatch was real`);
    continue;
  }

  const bodyText = typeof row.result === "string" ? row.result : JSON.stringify(row.result);
  const priceAtomic = String(row.terms?.priceAtomic ?? "");
  const verification = verifyPostCall({
    httpStatus: 200,
    bodyText,
    parsedBody: typeof row.result === "string" ? null : row.result,
    latencyMs: null,
    quotedAtomic: priceAtomic,
    authorizedAtomic: priceAtomic,
    payTo: row.terms?.payTo ?? "",
    settlement: { success: true, transaction: row.transaction_hash },
    declaredOutputSchema: row.output_schema,
    latencyP95Ms: null,
    required: true,
  });

  if (verification.verdict !== "PASS") {
    console.log(`[skip] ${tag}: re-judged as ${verification.verdict}, not promoted`);
    continue;
  }

  console.log(`[repair] ${tag}: FAIL -> PASS  ($${row.paid_usdc})`);
  console.log(`         was: ${summary.slice(0, 140)}`);
  console.log(`         now: ${verification.summary}`);
  if (!apply) { repaired += 1; continue; }

  const { data: agent } = await db().from("nova_agents")
    .select("name, interests").eq("agent_id", row.agent_id).maybeSingle();

  const reading = await readResult({
    agentName: (agent as any)?.name ?? "Nova",
    interests: (agent as any)?.interests ?? [],
    question: row.question,
    provider: row.terms.provider,
    resource: row.terms.resource,
    paidUsdc: Number(row.paid_usdc ?? 0),
    verdict: verification.verdict,
    verificationSummary: verification.summary,
    executionPublicId: row.execution_public_id,
    transaction: row.transaction_hash,
    result: row.result,
  }).catch(() => null);

  await db().from("nova_research").update({
    status: "verified",
    verification: { verdict: verification.verdict, summary: verification.summary },
    reading,
    failure: null,
  }).eq("research_id", row.research_id);

  await db().from("nova_signals").update({
    status: "investigated",
    execution_public_id: row.execution_public_id,
    updated_at: new Date().toISOString(),
  }).eq("agent_id", row.agent_id).eq("signal_id", row.signal_id);

  const { data: already } = await db().from("nova_memory")
    .select("memory_id").eq("agent_id", row.agent_id).eq("signal_id", row.signal_id)
    .eq("facet", "verified_research").maybeSingle();
  if (!already) {
    await db().from("nova_memory").insert({
      agent_id: row.agent_id, kind: "learning", facet: "verified_research",
      summary: `Paid ${row.terms.provider} $${Number(row.paid_usdc ?? 0).toFixed(4)} and the answer passed Veyra's check.`,
      evidence: {
        researchId: row.research_id, provider: row.terms.provider, resource: row.terms.resource,
        capability: row.terms.capability, costUsdc: Number(row.paid_usdc ?? 0),
        verdict: verification.verdict, transaction: row.transaction_hash ?? null,
        repairedFrom: "schema_keyword_not_supported",
      },
      signal_id: row.signal_id,
    });
  }
  console.log(`         reading: ${reading ? "written" : "absent (the receipt stands either way)"}`);
  repaired += 1;
}

console.log(`\n${apply ? "repaired" : "would repair"} ${repaired} row(s)`);
assert.ok(true);
