/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { Client as PostgresClient } from "pg";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const postgresUrl =
    process.env.AGENT_DB_POSTGRES_URL_NON_POOLING ??
    process.env.POSTGRES_URL_NON_POOLING;
  assert(postgresUrl, "A non-pooling production PostgreSQL connection is required.");
  const connectionUrl = new URL(postgresUrl);
  connectionUrl.searchParams.delete("sslmode");
  connectionUrl.searchParams.delete("sslrootcert");
  const postgres = new PostgresClient({
    connectionString: connectionUrl.toString(),
    ssl: { rejectUnauthorized: false },
  });
  await postgres.connect();
  try {
    const result = await postgres.query<{
      watchlist_count: string;
      duplicate_tenant_subjects: string;
      unsupported_subjects: string;
      migration_applied: boolean;
    }>(`
      with canonical_watchlists as (
        select
          lower(watchlist.owner_wallet) as owner_wallet,
          coalesce(watchlist.machine_credential_id::text, '') as credential_id,
          case
            when watchlist.subject_input ? 'agentId'
              then 'agent:' || lower(watchlist.subject_input ->> 'agentId')
            when watchlist.subject_input ? 'repositoryUrl'
              then 'github:' || lower(
                trim(trailing '/' from regexp_replace(
                  watchlist.subject_input ->> 'repositoryUrl',
                  '^https://github\\.com/',
                  ''
                ))
              )
            when watchlist.subject_input ? 'agentWallet'
              then 'wallet:' || lower(watchlist.subject_input ->> 'agentWallet')
            when watchlist.subject_input ? 'contractAddress'
              then 'arc-testnet-contract:' ||
                lower(watchlist.subject_input ->> 'contractAddress')
            when watchlist.subject_input ? 'serviceEndpoint'
              then 'endpoint:' || regexp_replace(
                watchlist.subject_input ->> 'serviceEndpoint',
                '#.*$',
                ''
              )
            else null
          end as canonical_key
        from public.trust_watchlists watchlist
      ),
      duplicates as (
        select owner_wallet, credential_id, canonical_key
        from canonical_watchlists
        where canonical_key is not null
        group by owner_wallet, credential_id, canonical_key
        having count(*) > 1
      )
      select
        (select count(*)::text from canonical_watchlists) as watchlist_count,
        (select count(*)::text from duplicates) as duplicate_tenant_subjects,
        (
          select count(*)::text
          from canonical_watchlists
          where canonical_key is null
        ) as unsupported_subjects,
        exists (
          select 1
          from supabase_migrations.schema_migrations
          where version = '20260730230000'
        ) as migration_applied
    `);
    const row = result.rows[0];
    assert(row, "Production preflight did not return a result.");
    assert(
      Number(row.duplicate_tenant_subjects) === 0,
      "Production contains duplicate tenant/canonical-subject watchlists.",
    );
    assert(
      Number(row.unsupported_subjects) === 0,
      "Production contains a watchlist without a supported canonical identity.",
    );
    console.log(
      `[p31-preflight] watchlists=${row.watchlist_count} canonicalDuplicates=0 unsupportedSubjects=0 migrationApplied=${row.migration_applied}`,
    );
    console.log("[p31-preflight] PASSED");
  } finally {
    await postgres.end();
  }
}

main().catch((error) => {
  console.error(
    `[p31-preflight] FAILED: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
