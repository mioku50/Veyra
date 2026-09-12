/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { Client as PostgresClient } from "pg";
import { getPublicSupabaseConfig } from "../lib/supabase/env.ts";
import { tryGetServerSupabaseConfig } from "../lib/supabase/server-env.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function verifyProductionMonitoringSchema() {
  console.log("[verify-monitoring-schema] Starting production verification...");
  const serverConfig = tryGetServerSupabaseConfig();
  assert(
    serverConfig,
    "Server Supabase configuration is required for production verification.",
  );
  const server = createClient(serverConfig.url, serverConfig.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const postgresUrl =
    process.env.AGENT_DB_POSTGRES_URL_NON_POOLING ??
    process.env.POSTGRES_URL_NON_POOLING;
  assert(postgresUrl, "A non-pooling PostgreSQL connection is required.");
  const connectionUrl = new URL(postgresUrl);
  connectionUrl.searchParams.delete("sslmode");
  connectionUrl.searchParams.delete("sslrootcert");
  const postgres = new PostgresClient({
    connectionString: connectionUrl.toString(),
    ssl: { rejectUnauthorized: false },
  });
  await postgres.connect();

  try {
    const tableChecks = await Promise.all([
      server
        .from("trust_profiles")
        .select(
          "id,public_id,canonical_subject_key,subject_type,canonical_subject_input,display_name,created_at,updated_at",
        )
        .limit(0),
      server
        .from("trust_watchlists")
        .select(
          "id,public_id,owner_wallet,label,subject_hash,subject_input,profile_id,visibility,cadence,status,next_recheck_at,last_recheck_at,last_snapshot_id,last_job_id,last_error_code,last_error_at,byoa_agent_id,machine_credential_id,created_at,updated_at",
        )
        .limit(0),
      server
        .from("trust_monitoring_rechecks")
        .select(
          "id,public_id,watchlist_id,trigger,status,idempotency_hash,quote_id,job_id,byoa_agent_id,machine_credential_id,scheduled_for,error_code,error_message,created_at,started_at,completed_at,updated_at",
        )
        .limit(0),
      server
        .from("trust_monitoring_snapshots")
        .select(
          "id,public_id,watchlist_id,recheck_id,job_id,sequence_number,trust_score,trust_status,report_hash,verification_status,proof_transaction_hash,report_snapshot,delta_snapshot,observed_at,created_at",
        )
        .limit(0),
      server
        .from("hosted_workflow_user_payments")
        .select("id,sponsorship_source")
        .limit(0),
      server
        .from("trust_alert_events")
        .select(
          "id,public_id,owner_wallet,profile_id,snapshot_id,event_type,event_fingerprint,message,payload,byoa_agent_id,machine_credential_id,created_at",
        )
        .limit(0),
      server
        .from("trust_alert_states")
        .select(
          "alert_event_id,owner_wallet,state,read_at,archived_at,created_at,updated_at",
        )
        .limit(0),
      server
        .from("webhook_subscriptions")
        .select(
          "id,public_id,owner_wallet,name,endpoint_url,endpoint_domain,profile_ids,event_types,status,secret_ciphertext,previous_secret_ciphertext,previous_secret_expires_at,byoa_agent_id,machine_credential_id,last_success_at,last_failure_at,created_at,updated_at",
        )
        .limit(0),
      server
        .from("webhook_events")
        .select(
          "id,public_id,owner_wallet,alert_event_id,event_type,payload,created_at",
        )
        .limit(0),
      server
        .from("webhook_deliveries")
        .select(
          "id,public_id,owner_wallet,subscription_id,event_id,status,attempt_count,next_attempt_at,http_status,duration_ms,error_category,delivered_at,created_at,updated_at",
        )
        .limit(0),
    ]);
    const tableFailure = tableChecks.find((result) => result.error)?.error;
    assert(
      !tableFailure,
      `Monitoring tables or required columns are missing: ${tableFailure?.message}`,
    );
    console.log(
      "  ✓ Profiles, monitoring history, alerts, webhook queue, and sponsorship source exist.",
    );

    const schemaMetadata = await postgres.query<{
      rls_enabled: boolean;
      index_names: string[];
      constraint_names: string[];
    }>(`
      select
        profile.relrowsecurity as rls_enabled,
        coalesce((
          select array_agg(indexname order by indexname)
          from pg_indexes
          where schemaname = 'public'
            and indexname in (
              'trust_profiles_canonical_subject_key_key',
              'trust_watchlists_owner_profile_tenant_idx',
              'trust_watchlists_public_profile_idx',
              'trust_alert_events_profile_id_event_type_event_fingerprint_key',
              'webhook_deliveries_due_idx',
              'webhook_deliveries_subscription_id_event_id_key'
            )
        ), array[]::text[]) as index_names,
        coalesce((
          select array_agg(constraint_name order by constraint_name)
          from information_schema.table_constraints
          where table_schema = 'public'
            and (
              (table_name = 'trust_profiles' and constraint_type in ('PRIMARY KEY', 'UNIQUE', 'CHECK'))
              or (
                table_name = 'trust_watchlists'
                and constraint_name = 'trust_watchlists_visibility_check'
              )
            )
        ), array[]::text[]) as constraint_names
      from pg_class profile
      join pg_namespace namespace on namespace.oid = profile.relnamespace
      where namespace.nspname = 'public'
        and profile.relname = 'trust_profiles'
    `);
    const metadata = schemaMetadata.rows[0];
    assert(metadata?.rls_enabled, "RLS is not enabled on trust_profiles.");
    for (const index of [
      "trust_profiles_canonical_subject_key_key",
      "trust_watchlists_owner_profile_tenant_idx",
      "trust_watchlists_public_profile_idx",
      "trust_alert_events_profile_id_event_type_event_fingerprint_key",
      "webhook_deliveries_due_idx",
      "webhook_deliveries_subscription_id_event_id_key",
    ]) {
      assert(
        metadata.index_names.includes(index),
        `Required monitoring index is missing: ${index}`,
      );
    }
    assert(
      metadata.constraint_names.includes("trust_watchlists_visibility_check"),
      "The trust watchlist visibility constraint is missing.",
    );
    const rlsMetadata = await postgres.query<{
      relname: string;
      relrowsecurity: boolean;
    }>(`
      select relation.relname, relation.relrowsecurity
      from pg_class relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public'
        and relation.relname in (
          'trust_profiles',
          'trust_watchlists',
          'trust_monitoring_rechecks',
          'trust_monitoring_snapshots',
          'trust_alert_events',
          'trust_alert_states',
          'webhook_subscriptions',
          'webhook_events',
          'webhook_deliveries'
        )
      order by relation.relname
    `);
    assert(
      rlsMetadata.rows.length === 9 &&
        rlsMetadata.rows.every((row) => row.relrowsecurity),
      "RLS is not enabled on every monitoring, alert, and webhook table.",
    );
    const credentialConstraint = await postgres.query<{ definition: string }>(`
      select pg_get_constraintdef(credential_constraint.oid) as definition
      from pg_constraint credential_constraint
      join pg_class relation on relation.oid = credential_constraint.conrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public'
        and relation.relname = 'byoa_agent_credentials'
        and credential_constraint.conname = 'byoa_agent_credentials_scopes_check'
    `);
    const scopeDefinition = credentialConstraint.rows[0]?.definition ?? "";
    for (const scope of [
      "alerts:read",
      "alerts:write",
      "webhooks:read",
      "webhooks:write",
    ]) {
      assert(scopeDefinition.includes(scope), `Credential constraint is missing ${scope}.`);
    }
    console.log("  ✓ P3.3 indexes, opt-in scopes, constraints, and RLS are active.");

    const noopClaim = await server.rpc("claim_due_trust_watchlists_v1", {
      p_limit: 0,
    });
    assert(
      !noopClaim.error && Array.isArray(noopClaim.data) && noopClaim.data.length === 0,
      `No-op scheduler claim RPC failed: ${noopClaim.error?.message ?? "unexpected rows"}`,
    );
    const missingLaunch = await server.rpc("launch_trust_monitoring_checkout_v1", {
      p_quote_id: randomUUID(),
      p_recheck_id: randomUUID(),
    });
    const missingLaunchRow = (
      missingLaunch.data as Array<{ reason?: string }> | null
    )?.[0];
    assert(
      !missingLaunch.error && missingLaunchRow?.reason === "not_found",
      `Scheduled checkout RPC failed its non-mutating probe: ${missingLaunch.error?.message ?? "unexpected result"}`,
    );
    const noopWebhookClaim = await server.rpc(
      "claim_due_webhook_deliveries_v1",
      { p_limit: 0 },
    );
    assert(
      !noopWebhookClaim.error &&
        Array.isArray(noopWebhookClaim.data) &&
        noopWebhookClaim.data.length === 0,
      `No-op webhook claim RPC failed: ${noopWebhookClaim.error?.message ?? "unexpected rows"}`,
    );
    console.log("  ✓ Monitoring and webhook queue claim RPCs are callable server-side.");

    const marker = randomUUID();
    const publicId = `wtl_${digest(marker).slice(0, 20)}`;
    const profilePublicId = `vtr_${digest(`${marker}:profile`).slice(0, 20)}`;
    const recheckPublicId = `trc_${digest(`${marker}:recheck`).slice(0, 20)}`;
    const ownerWallet = `0x${digest(`${marker}:wallet`).slice(0, 40)}`;
    const subject = { repositoryUrl: "https://github.com/openai/openai-node" };
    const subjectDigest = digest(JSON.stringify(subject));
    const canonicalKey = `github:production-schema-probe/${digest(marker).slice(0, 12)}`;
    const idempotencyDigest = digest(`${marker}:idempotency`);
    let watchlistId: string | null = null;
    let profileId: string | null = null;
    let alertId: string | null = null;
    let webhookId: string | null = null;

    try {
      const profile = await server
        .from("trust_profiles")
        .insert({
          public_id: profilePublicId,
          canonical_subject_key: canonicalKey,
          subject_type: "github_repository",
          canonical_subject_input: subject,
          display_name: "Production schema probe",
        })
        .select("id")
        .single();
      assert(
        !profile.error && profile.data,
        `Server write access to trust_profiles failed: ${profile.error?.message}`,
      );
      profileId = profile.data.id as string;

      const duplicateProfile = await server.from("trust_profiles").insert({
        canonical_subject_key: canonicalKey,
        subject_type: "github_repository",
        canonical_subject_input: subject,
        display_name: "Duplicate profile probe",
      });
      assert(
        Boolean(duplicateProfile.error),
        "Canonical subject uniqueness was not enforced.",
      );

      const watchlist = await server
        .from("trust_watchlists")
        .insert({
          public_id: publicId,
          owner_wallet: ownerWallet,
          label: "Production schema probe",
          subject_hash: subjectDigest,
          subject_input: subject,
          profile_id: profileId,
          visibility: "private",
          cadence: "manual",
          status: "active",
        })
        .select("id")
        .single();
    assert(
      !watchlist.error && watchlist.data,
      `Server write access to trust_watchlists failed: ${watchlist.error?.message}`,
    );
    watchlistId = watchlist.data.id as string;

      const invalidCadence = await server.from("trust_watchlists").insert({
        owner_wallet: ownerWallet,
        label: "Invalid cadence probe",
        subject_hash: digest(`${marker}:invalid`),
        subject_input: subject,
        profile_id: profileId,
        cadence: "hourly",
        status: "active",
      });
      assert(
        Boolean(invalidCadence.error),
        "Cadence check constraint did not reject an unsupported value.",
      );
      const invalidVisibility = await server.from("trust_watchlists").insert({
        owner_wallet: ownerWallet,
        label: "Invalid visibility probe",
        subject_hash: digest(`${marker}:invalid-visibility`),
        subject_input: subject,
        profile_id: profileId,
        visibility: "unlisted",
        cadence: "manual",
        status: "active",
      });
      assert(
        Boolean(invalidVisibility.error),
        "Visibility check constraint did not reject an unsupported value.",
      );
      const duplicateWatchlist = await server.from("trust_watchlists").insert({
        owner_wallet: ownerWallet,
        label: "Duplicate canonical subject probe",
        subject_hash: digest(`${marker}:different-format`),
        subject_input: { repositoryUrl: "github.com/openai/openai-node/tree/main" },
        profile_id: profileId,
        visibility: "private",
        cadence: "manual",
        status: "active",
      });
      assert(
        Boolean(duplicateWatchlist.error),
        "Unique owner/profile tenant constraint was not enforced.",
      );

    const recheck = await server.from("trust_monitoring_rechecks").insert({
      public_id: recheckPublicId,
      watchlist_id: watchlistId,
      trigger: "manual",
      status: "quoted",
      idempotency_hash: idempotencyDigest,
    });
    assert(
      !recheck.error,
      `Server write access to trust_monitoring_rechecks failed: ${recheck.error?.message}`,
    );

    const duplicateRecheck = await server
      .from("trust_monitoring_rechecks")
      .insert({
        watchlist_id: watchlistId,
        trigger: "manual",
        status: "quoted",
        idempotency_hash: idempotencyDigest,
      });
    assert(
      Boolean(duplicateRecheck.error),
      "Unique watchlist/idempotency constraint was not enforced.",
    );
    const alert = await server
      .from("trust_alert_events")
      .insert({
        public_id: `evt_${digest(`${marker}:alert`).slice(0, 24)}`,
        owner_wallet: ownerWallet,
        profile_id: profileId,
        snapshot_id: null,
        event_type: "recheck_failed",
        event_fingerprint: digest(`${marker}:alert-fingerprint`),
        message: "The scheduled trust recheck could not be completed.",
        payload: { recheckStatus: "failed" },
      })
      .select("id")
      .single();
    assert(!alert.error && alert.data, `Alert insert failed: ${alert.error?.message}`);
    alertId = alert.data.id as string;
    const alertState = await server.from("trust_alert_states").insert({
      alert_event_id: alertId,
      owner_wallet: ownerWallet,
      state: "unread",
    });
    assert(!alertState.error, `Alert state insert failed: ${alertState.error?.message}`);
    const duplicateFailure = await server.from("trust_alert_events").insert({
      owner_wallet: ownerWallet,
      profile_id: profileId,
      snapshot_id: null,
      event_type: "recheck_failed",
      event_fingerprint: digest(`${marker}:alert-fingerprint`),
      message: "Duplicate alert probe.",
      payload: { recheckStatus: "failed" },
    });
    assert(
      Boolean(duplicateFailure.error),
      "Failure alert fingerprint uniqueness was not enforced.",
    );

    const webhook = await server
      .from("webhook_subscriptions")
      .insert({
        public_id: `whk_${digest(`${marker}:webhook`).slice(0, 24)}`,
        owner_wallet: ownerWallet,
        name: "Production schema probe",
        endpoint_url: "https://example.com/veyra",
        endpoint_domain: "example.com",
        profile_ids: [profileId],
        event_types: ["recheck_failed"],
        secret_ciphertext: "schema-probe-encrypted-material",
      })
      .select("id")
      .single();
    assert(!webhook.error && webhook.data, `Webhook insert failed: ${webhook.error?.message}`);
    webhookId = webhook.data.id as string;
    const webhookEvent = await server
      .from("webhook_events")
      .insert({
        public_id: `evt_${digest(`${marker}:webhook-event`).slice(0, 24)}`,
        owner_wallet: ownerWallet,
        alert_event_id: alertId,
        event_type: "recheck_failed",
        payload: { id: `evt_${digest(`${marker}:alert`).slice(0, 24)}`, type: "recheck_failed" },
      })
      .select("id")
      .single();
    assert(
      !webhookEvent.error && webhookEvent.data,
      `Webhook event insert failed: ${webhookEvent.error?.message}`,
    );
    const delivery = await server.from("webhook_deliveries").insert({
      owner_wallet: ownerWallet,
      subscription_id: webhookId,
      event_id: webhookEvent.data.id,
      status: "pending",
      next_attempt_at: new Date(Date.now() + 60_000).toISOString(),
    });
    assert(!delivery.error, `Webhook delivery insert failed: ${delivery.error?.message}`);
    console.log("  ✓ Idempotency, alert fingerprint, and delivery constraints are enforced.");

      const publicConfig = getPublicSupabaseConfig();
      const anonymous = createClient(publicConfig.url, publicConfig.key, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const anonymousReads = await Promise.all([
        anonymous.from("trust_profiles").select("id").limit(1),
        anonymous.from("trust_watchlists").select("id").limit(1),
        anonymous.from("trust_monitoring_rechecks").select("id").limit(1),
        anonymous.from("trust_monitoring_snapshots").select("id").limit(1),
        anonymous.from("trust_alert_events").select("id").limit(1),
        anonymous.from("trust_alert_states").select("alert_event_id").limit(1),
        anonymous.from("webhook_subscriptions").select("id").limit(1),
        anonymous.from("webhook_events").select("id").limit(1),
        anonymous.from("webhook_deliveries").select("id").limit(1),
      ]);
    assert(
      anonymousReads.every(
        (result) => !result.data || result.data.length === 0,
      ),
      "Anonymous access exposed private monitoring rows.",
    );
      const anonymousInsert = await anonymous.from("trust_profiles").insert({
        canonical_subject_key: `${canonicalKey}:anonymous`,
        subject_type: "github_repository",
        canonical_subject_input: subject,
        display_name: "Anonymous probe",
      });
    if (!anonymousInsert.error) {
      await server
        .from("trust_profiles")
        .delete()
        .eq("canonical_subject_key", `${canonicalKey}:anonymous`);
      throw new Error("Anonymous monitoring writes unexpectedly bypassed RLS.");
    }
    console.log("  ✓ Anonymous reads and writes are denied by RLS.");
    } finally {
      if (webhookId) {
        const cleanup = await server
          .from("webhook_subscriptions")
          .delete()
          .eq("id", webhookId);
        assert(
          !cleanup.error,
          `Production webhook probe cleanup failed: ${cleanup.error?.message}`,
        );
      }
      if (alertId) {
        const cleanup = await server
          .from("trust_alert_events")
          .delete()
          .eq("id", alertId);
        assert(
          !cleanup.error,
          `Production alert probe cleanup failed: ${cleanup.error?.message}`,
        );
      }
      if (watchlistId) {
        const cleanup = await server
          .from("trust_watchlists")
          .delete()
          .eq("id", watchlistId);
        assert(
          !cleanup.error,
          `Production watchlist probe cleanup failed: ${cleanup.error?.message}`,
        );
      }
      if (profileId) {
        const cleanup = await server
          .from("trust_profiles")
          .delete()
          .eq("id", profileId);
        assert(
          !cleanup.error,
          `Production profile probe cleanup failed: ${cleanup.error?.message}`,
        );
      }
    }

    console.log("[verify-monitoring-schema] All production checks PASSED.");
  } finally {
    await postgres.end();
  }
}

verifyProductionMonitoringSchema().catch((error) => {
  console.error(
    `[verify-monitoring-schema] Verification FAILED: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
});
