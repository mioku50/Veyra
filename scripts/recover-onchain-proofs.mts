/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { createClient } from "@supabase/supabase-js";
import {
  onchainPaymentEventColumns,
  publishStoredProof,
  type OnchainPaymentEventRecord,
} from "../lib/commerce/onchain-proof.ts";
import { getServerSupabaseConfig } from "../lib/supabase/server-env.ts";

type Options = {
  limit: number;
  paymentEventId: string | null;
  dryRun: boolean;
};

function parseOptions(): Options {
  const args = process.argv.slice(2);
  let limit = 25;
  let paymentEventId: string | null = null;
  let dryRun = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--limit" && args[index + 1]) {
      limit = Number(args[++index]);
    } else if (arg === "--payment-event" && args[index + 1]) {
      paymentEventId = args[++index];
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("--limit must be an integer from 1 to 100");
  }
  if (
    paymentEventId &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      paymentEventId,
    )
  ) {
    throw new Error("--payment-event must be a UUID");
  }

  return { limit, paymentEventId, dryRun };
}

async function main() {
  const options = parseOptions();
  const config = getServerSupabaseConfig();
  const supabase = createClient(config.url, config.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let query = supabase
    .from("payment_events")
    .select(onchainPaymentEventColumns)
    .order("created_at", { ascending: true })
    .limit(options.limit);

  query = options.paymentEventId
    ? query.eq("id", options.paymentEventId)
    : query.in("onchain_status", ["pending", "failed"]);

  const { data, error } = await query;
  if (error) throw new Error("Unable to load recoverable proof records");

  const records = (data ?? []) as unknown as OnchainPaymentEventRecord[];
  console.log(
    `[proof-recovery] provider=${config.diagnostic.provider} candidates=${records.length} dryRun=${options.dryRun}`,
  );

  if (options.dryRun) {
    for (const record of records) {
      console.log(
        `[proof-recovery] candidate=${record.id} status=${record.onchain_status ?? "unavailable"} attempts=${record.onchain_attempt_count ?? 0}`,
      );
    }
    return;
  }

  let verified = 0;
  let failed = 0;
  for (const record of records) {
    const result = await publishStoredProof({ supabase, record });
    if (result.status === "verified") verified++;
    else failed++;

    console.log(
      `[proof-recovery] paymentEvent=${record.id} status=${result.status} tx=${result.transactionHash ?? "n/a"} block=${result.blockNumber ?? "n/a"}`,
    );
  }

  console.log(
    `[proof-recovery] complete verified=${verified} failed=${failed}`,
  );
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(
    `[proof-recovery] failed: ${error instanceof Error ? error.name : "UnknownError"}`,
  );
  process.exitCode = 1;
});
