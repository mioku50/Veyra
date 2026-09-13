/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { createClient } from "@supabase/supabase-js";
import { tryGetServerSupabaseConfig } from "../lib/supabase/server-env.ts";

const baseUrl = (
  process.env.VEYRA_PRODUCTION_URL ?? "https://veyras.vercel.app"
).replace(/\/+$/, "");
const watchlistId = process.argv[2];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function json(path: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function main() {
  assert(
    /^wtl_[0-9a-f]{20}$/.test(watchlistId ?? ""),
    "Pass the production smoke watchlist ID as the first argument.",
  );
  const config = tryGetServerSupabaseConfig();
  assert(config, "Production server Supabase configuration is required.");
  const cronSecret = process.env.CRON_SECRET;
  const server = createClient(config.url, config.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const watchlist = await server
    .from("trust_watchlists")
    .select("id,public_id,profile_id")
    .eq("public_id", watchlistId)
    .single();
  assert(
    !watchlist.error && watchlist.data,
    `Production watchlist lookup failed: ${watchlist.error?.message}`,
  );
  const profile = await server
    .from("trust_profiles")
    .select("public_id")
    .eq("id", watchlist.data.profile_id)
    .single();
  assert(
    !profile.error && profile.data,
    `Production trust profile lookup failed: ${profile.error?.message}`,
  );
  const profileId = profile.data.public_id as string;

  const before = await json(`/api/monitoring/public/${profileId}`);
  const previousSnapshot = (
    before.body.snapshots as Array<{ snapshotId?: string }> | undefined
  )?.[0]?.snapshotId;
  assert(previousSnapshot, "The scheduler smoke requires an existing baseline snapshot.");

  try {
    const due = await server
      .from("trust_watchlists")
      .update({
        cadence: "daily",
        status: "active",
        next_recheck_at: "2000-01-01T00:00:00.000Z",
      })
      .eq("id", watchlist.data.id);
    assert(!due.error, `Unable to mark the smoke watchlist due: ${due.error?.message}`);

    let jobId: string;
    if (cronSecret) {
      const cron = await json("/api/internal/monitoring/recheck", {
        headers: { Authorization: `Bearer ${cronSecret}` },
      });
      assert(
        cron.response.status === 202 &&
          cron.body.launched === true &&
          cron.body.watchlistId === watchlistId &&
          typeof cron.body.jobId === "string",
        `Production scheduler did not launch the expected watchlist (HTTP ${cron.response.status}).`,
      );
      jobId = cron.body.jobId as string;
      console.log("[p30-scheduler-smoke] LaunchMode=authenticated-cron-route");
    } else {
      const unauthorized = await json("/api/internal/monitoring/recheck");
      assert(
        unauthorized.response.status === 404,
        "The scheduler route did not fail closed without CRON_SECRET.",
      );
      const {
        claimAndLaunchScheduledTrustRecheck,
        executeTrustMonitoringJob,
      } = await import("../lib/monitoring/service.ts");
      const launched = await claimAndLaunchScheduledTrustRecheck();
      assert(
        launched?.watchlist.public_id === watchlistId,
        "Production scheduler core did not claim the expected watchlist.",
      );
      jobId = launched.jobId;
      await executeTrustMonitoringJob({
        jobId,
        reportInput: launched.watchlist.subject_input,
      });
      console.log(
        "[p30-scheduler-smoke] LaunchMode=production-core (Sensitive CRON_SECRET is non-exportable)",
      );
    }
    console.log(`[p30-scheduler-smoke] Job=${jobId}`);

    let history:
      | {
          currentDelta?: { previousSnapshotId?: string | null };
          snapshots?: Array<{
            snapshotId?: string;
            reportHash?: string;
            verificationStatus?: string;
            proofTransactionHash?: string | null;
          }>;
      }
      | undefined;
    let privateSnapshotId: string | null = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      const persisted = await server
        .from("trust_monitoring_snapshots")
        .select("public_id,verification_status,proof_transaction_hash")
        .eq("job_id", jobId)
        .maybeSingle();
      assert(
        !persisted.error,
        `Scheduled snapshot lookup failed: ${persisted.error?.message}`,
      );
      privateSnapshotId = persisted.data?.public_id ?? null;
      const result = await json(`/api/monitoring/public/${profileId}`);
      assert(
        result.response.ok,
        `Public trust history failed with HTTP ${result.response.status}.`,
      );
      history = result.body;
      if (
        privateSnapshotId &&
        history.snapshots?.[0]?.snapshotId === privateSnapshotId &&
        history.snapshots[0].verificationStatus === "verified" &&
        history.snapshots[0].proofTransactionHash
      ) {
        break;
      }
    }
    const snapshot = history?.snapshots?.[0];
    assert(
      privateSnapshotId && snapshot?.snapshotId === privateSnapshotId,
      "Scheduled snapshot was not persisted.",
    );
    assert(
      history?.currentDelta?.previousSnapshotId === previousSnapshot,
      "Scheduled delta is not linked to the previous immutable snapshot.",
    );
    assert(
      snapshot.verificationStatus === "verified" &&
        /^0x[0-9a-f]{64}$/i.test(snapshot.proofTransactionHash ?? ""),
      "Scheduled snapshot did not receive an Arc proof.",
    );
    console.log(
      `[p30-scheduler-smoke] Snapshot=${snapshot.snapshotId} ArcProof=${snapshot.proofTransactionHash}`,
    );
    console.log("[p30-scheduler-smoke] PASSED");
  } finally {
    const reset = await server
      .from("trust_watchlists")
      .update({
        cadence: "manual",
        next_recheck_at: null,
      })
      .eq("id", watchlist.data.id);
    assert(
      !reset.error,
      `Unable to reset the smoke watchlist schedule: ${reset.error?.message}`,
    );
  }
}

main().catch((error) => {
  console.error(
    `[p30-scheduler-smoke] FAILED: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
});
