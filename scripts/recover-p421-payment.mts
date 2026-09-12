/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { createClient } from "@supabase/supabase-js";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { tryGetServerSupabaseConfig } from "../lib/supabase/server-env.ts";
import { arcTestnetChain } from "../lib/wallet/arc.ts";
import { confirmHostedWorkflowQuoteInput } from "../lib/commerce/workflow-checkout.ts";
import { requireBrowserProject360Quote } from "../lib/project-360/service.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  assert(
    process.argv.includes("--confirm-production"),
    "Pass --confirm-production to scan for an unrecorded acceptance payment.",
  );
  const privateKey =
    process.env.PHASE26_CHECKOUT_PRIVATE_KEY?.trim() ??
    process.env.BUYER_PRIVATE_KEY?.trim();
  assert(privateKey, "Acceptance buyer is not configured.");
  const buyer = privateKeyToAccount(privateKey as `0x${string}`).address;
  const config = tryGetServerSupabaseConfig();
  assert(config, "Production service-role configuration is required.");
  const database = createClient(config.url, config.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const quoteResult = await database
    .from("hosted_workflow_quotes")
    .select("id,treasury_address,created_at,amount_due_usdc")
    .eq("workflow_type", "project_360")
    .ilike("requester_wallet", buyer)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  assert(!quoteResult.error && quoteResult.data, "Latest Project 360 quote is unavailable.");
  const quote = quoteResult.data;

  const rpc = createPublicClient({
    chain: arcTestnetChain,
    transport: http(process.env.ARC_TESTNET_RPC_URL?.trim()),
  });
  const latest = await rpc.getBlockNumber();
  const targetTimestamp = Math.floor((Date.parse(quote.created_at) - 60_000) / 1_000);
  let low = 0n;
  let high = latest;
  while (low < high) {
    const middle = (low + high) >> 1n;
    const block = await rpc.getBlock({ blockNumber: middle });
    if (Number(block.timestamp) < targetTimestamp) low = middle + 1n;
    else high = middle;
  }
  const first = latest - low > 3_000n ? latest - 3_000n : low;
  const transactions: Array<{
    hash: `0x${string}`;
    blockNumber: number;
    timestamp: string;
    matchesQuoteTreasury: boolean;
    valueWei: string;
  }> = [];
  for (let start = first; start <= latest; start += 20n) {
    const end = start + 19n > latest ? latest : start + 19n;
    const blocks = await Promise.all(
      Array.from({ length: Number(end - start + 1n) }, (_, index) =>
        rpc.getBlock({
          blockNumber: start + BigInt(index),
          includeTransactions: true,
        }),
      ),
    );
    for (const block of blocks) {
      for (const transaction of block.transactions) {
        if (
          typeof transaction !== "string" &&
          transaction.from.toLowerCase() === buyer.toLowerCase()
        ) {
          transactions.push({
            hash: transaction.hash,
            blockNumber: Number(block.number),
            timestamp: new Date(Number(block.timestamp) * 1_000).toISOString(),
            matchesQuoteTreasury:
              transaction.to?.toLowerCase() === quote.treasury_address.toLowerCase(),
            valueWei: transaction.value.toString(),
          });
        }
      }
    }
  }
  const matchingPayment = transactions.find(
    (transaction) =>
      transaction.matchesQuoteTreasury &&
      BigInt(transaction.valueWei) === BigInt(Math.round(Number(quote.amount_due_usdc) * 1e6)) * 10n ** 12n,
  );
  let confirmation: Record<string, unknown> | null = null;
  if (process.argv.includes("--confirm-recovered-payment")) {
    assert(matchingPayment, "No exact immutable-quote payment was found.");
    const stored = await requireBrowserProject360Quote({
      quoteId: quote.id,
      ownerWallet: buyer,
    });
    if (process.argv.includes("--diagnose-checkout-rpc")) {
      const checkout = await database.rpc("launch_hosted_workflow_checkout_v1", {
        p_quote_id: quote.id,
        p_idempotency_hash: stored.quote.idempotency_hash,
        p_request_hash: stored.quote.request_hash,
        p_payment_mode: stored.quote.payment_mode,
        p_transaction_hash: matchingPayment.hash,
        p_block_number: matchingPayment.blockNumber,
        p_settled_at: matchingPayment.timestamp,
        p_sponsored_quota: 1,
      });
      confirmation = checkout.error
        ? {
            status: "rpc_failed",
            databaseCode: checkout.error.code,
            message: checkout.error.message.slice(0, 240),
          }
        : { status: "rpc_completed", result: checkout.data };
    } else {
      confirmation = await confirmHostedWorkflowQuoteInput({
        quoteId: quote.id,
        idempotencyHash: stored.quote.idempotency_hash,
        requestHash: stored.quote.request_hash,
        inputText: stored.canonicalInput,
        transactionHash: matchingPayment.hash,
      });
    }
  }
  console.log(JSON.stringify({
    quoteId: quote.id,
    amountDueUsdc: Number(quote.amount_due_usdc),
    scannedBlockRange: [Number(first), Number(latest)],
    transactions,
    confirmation,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    status: "recovery_failed",
    message: error instanceof Error ? error.message.slice(0, 240) : "Unknown failure",
  }));
  process.exitCode = 1;
});
