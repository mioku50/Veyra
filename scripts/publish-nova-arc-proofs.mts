/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 *
 * Puts verified Nova purchases on Arc.
 *
 * The proof registry has been deployed, verified and configured on Arc the
 * whole time, and no Nova row ever reached it -- so every verified purchase
 * lived only in Postgres, where Veyra is the sole witness. New purchases now
 * publish as they settle. This backfills the ones that settled before that.
 *
 * One wrinkle it does not hide. Going forward the response hash is the one
 * verifyPostCall computed over the bytes the endpoint actually sent, and it is
 * stored on the row. Rows that settled before that was kept have only the
 * parsed result, so their hash is derived from what Veyra retained instead.
 * That is recorded on the row as `responseHashSource`, because a proof whose
 * derivation is ambiguous is worse than one that says which rule it used.
 *
 *   npm run nova:arc:publish            -- dry run
 *   npm run nova:arc:publish -- --apply -- writes to Arc
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import { keccak256, toBytes } from "viem";
import { db } from "../lib/nova/service.ts";
import { novaRequestHash, recordPurchaseOnArc } from "../lib/nova/arc-proof.ts";

const apply = process.argv.includes("--apply");

const { data } = await db().from("nova_research")
  .select("research_id, status, question, terms, request_body, request_method, payer_wallet, paid_usdc, execution_public_id, verification, result, arc_proof")
  .eq("status", "verified");

let published = 0;
for (const row of (data ?? []) as any[]) {
  const tag = `${row.execution_public_id} (${row.terms?.provider})`;
  if (row.arc_proof) { console.log(`[skip] ${tag}: already on Arc`); continue; }
  if (!row.payer_wallet) { console.log(`[skip] ${tag}: no payer on the row`); continue; }

  const stored = row.verification?.responseHash as string | undefined;
  const responseHash = (stored ?? keccak256(toBytes(
    typeof row.result === "string" ? row.result : JSON.stringify(row.result),
  ))) as `0x${string}`;
  const responseHashSource = stored ? "delivered_bytes" : "retained_result";

  const requestHash = novaRequestHash({
    method: row.request_method ?? "POST",
    resource: row.terms.resource,
    body: row.request_body,
  });
  const amountAtomic = BigInt(Math.round(Number(row.paid_usdc ?? 0) * 1_000_000));

  console.log(`[publish] ${tag}  $${row.paid_usdc}`);
  console.log(`          buyer  ${row.payer_wallet}`);
  console.log(`          seller ${row.terms.payTo}`);
  console.log(`          request  ${requestHash}`);
  console.log(`          response ${responseHash}  (${responseHashSource})`);
  if (!apply) { published += 1; continue; }

  const proof = await recordPurchaseOnArc({
    executionPublicId: row.execution_public_id ?? row.research_id,
    resource: row.terms.resource,
    buyer: row.payer_wallet,
    seller: row.terms.payTo,
    amountAtomic,
    requestHash,
    responseHash,
  });
  if (!proof) { console.log(`          -> Arc could not record it; the receipt stands`); continue; }

  /* Written, recovered or merely present -- all three are on Arc, and all
     three get stored. Only the first is a transaction this run sent. */
  await db().from("nova_research")
    .update({ arc_proof: { ...proof, responseHashSource } })
    .eq("research_id", row.research_id);
  console.log(`          -> ${proof.source}: ${proof.explorerUrl}`);
  published += 1;
}

console.log(`\n${apply ? "published" : "would publish"} ${published} proof(s) on Arc`);
