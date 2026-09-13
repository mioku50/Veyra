/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const baseUrl = (
  process.env.VEYRA_PRODUCTION_URL ?? "https://veyras.vercel.app"
).replace(/\/+$/, "");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function request(
  path: string,
  input: RequestInit = {},
  cookie?: string,
) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...input,
    headers: {
      Origin: baseUrl,
      ...(input.body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(input.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function ownerSession() {
  const account = privateKeyToAccount(generatePrivateKey());
  const challengeResult = await request("/api/byoa/management/challenges", {
    method: "POST",
    body: JSON.stringify({ wallet: account.address }),
  });
  assert(
    challengeResult.response.status === 201,
    `Owner challenge failed with HTTP ${challengeResult.response.status}.`,
  );
  const challenge = challengeResult.body.challenge as
    | { id?: string; message?: string }
    | undefined;
  assert(challenge?.id && challenge.message, "Owner challenge payload is incomplete.");
  const signature = await account.signMessage({ message: challenge.message });
  const sessionResult = await request("/api/byoa/management/session", {
    method: "POST",
    body: JSON.stringify({
      challengeId: challenge.id,
      message: challenge.message,
      signature,
    }),
  });
  assert(
    sessionResult.response.ok,
    `Owner session failed with HTTP ${sessionResult.response.status}.`,
  );
  const cookie = sessionResult.response.headers.get("set-cookie")?.split(";")[0];
  assert(cookie, "Owner session cookie was not issued.");
  return { account, cookie };
}

async function main() {
  console.log(`[p30-smoke] Target=${baseUrl}`);
  const ownerA = await ownerSession();
  const watchlistResult = await request(
    "/api/monitoring/watchlists",
    {
      method: "POST",
      body: JSON.stringify({
        label: "Veyra P3.0 Production Trust Monitor",
        cadence: "manual",
        input: {
          repositoryUrl: "https://github.com/mioku50/Agent-Commerce",
        },
      }),
    },
    ownerA.cookie,
  );
  assert(
    watchlistResult.response.ok,
    `Watchlist creation failed with HTTP ${watchlistResult.response.status}.`,
  );
  const watchlist = watchlistResult.body.watchlist as
    | { id?: string; profileId?: string; publicHistoryUrl?: string }
    | undefined;
  assert(
    watchlist?.id && watchlist.profileId && watchlist.publicHistoryUrl,
    "Watchlist response is incomplete.",
  );
  console.log(`[p30-smoke] Watchlist=${watchlist.id}`);

  const ownerB = await ownerSession();
  const isolatedList = await request(
    "/api/monitoring/watchlists",
    { method: "GET" },
    ownerB.cookie,
  );
  assert(isolatedList.response.ok, "Second owner could not list its watchlists.");
  const ownerBWatchlists = isolatedList.body.watchlists as
    | Array<{ id?: string }>
    | undefined;
  assert(
    !ownerBWatchlists?.some((item) => item.id === watchlist.id),
    "Tenant isolation failed: a different owner can see the watchlist.",
  );
  console.log("[p30-smoke] Owner isolation=passed");

  const idempotencyKey = `p30-smoke-${crypto.randomUUID()}`;
  const quotePath = `/api/monitoring/watchlists/${watchlist.id}/rechecks`;
  const firstQuote = await request(
    quotePath,
    {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: "{}",
    },
    ownerA.cookie,
  );
  assert(
    firstQuote.response.status === 201,
    `Recheck quote failed with HTTP ${firstQuote.response.status}.`,
  );
  const replayQuote = await request(
    quotePath,
    {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: "{}",
    },
    ownerA.cookie,
  );
  assert(
    replayQuote.response.ok &&
      replayQuote.body.recheckId === firstQuote.body.recheckId &&
      (replayQuote.body.quote as { id?: string } | undefined)?.id ===
        (firstQuote.body.quote as { id?: string } | undefined)?.id,
    "Recheck quote idempotent replay did not return the original resources.",
  );
  const quote = firstQuote.body.quote as
    | { id?: string; paymentMode?: string }
    | undefined;
  const authorizationMessage = firstQuote.body.sponsoredAuthorizationMessage;
  assert(
    quote?.id &&
      quote.paymentMode === "sponsored" &&
      typeof authorizationMessage === "string",
    "The production smoke expected an immutable sponsored quote.",
  );
  console.log(`[p30-smoke] Quote=${quote.id} idempotentReplay=passed`);

  const signature = await ownerA.account.signMessage({
    message: authorizationMessage,
  });
  const confirm = await request(
    `/api/monitoring/rechecks/${String(firstQuote.body.recheckId)}/confirm`,
    {
      method: "POST",
      body: JSON.stringify({ signature }),
    },
    ownerA.cookie,
  );
  assert(
    confirm.response.ok && typeof confirm.body.jobId === "string",
    `Recheck confirmation failed with HTTP ${confirm.response.status}.`,
  );
  const jobId = confirm.body.jobId as string;
  console.log(`[p30-smoke] Job=${jobId}`);

  let completed = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const job = await request(`/api/hosted-agent/jobs/${jobId}`);
    const status = (job.body.job as { status?: string } | undefined)?.status;
    if (status === "failed") throw new Error("Production monitoring job failed.");
    if (status === "completed") {
      completed = true;
      break;
    }
  }
  assert(completed, "Production monitoring job did not complete in time.");

  let verifiedHistory:
    | {
        currentReport?: {
          verification?: { reportHash?: string; verifiedOnArc?: boolean };
        };
        currentDelta?: {
          previousSnapshotId?: string | null;
        };
        snapshots?: Array<{
          snapshotId?: string;
          reportHash?: string;
          verificationStatus?: string;
          proofTransactionHash?: string | null;
          proofUrl?: string | null;
        }>;
      }
    | undefined;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const history = await request(
      `/api/monitoring/public/${watchlist.profileId}`,
    );
    assert(
      history.response.ok,
      `Public trust history failed with HTTP ${history.response.status}.`,
    );
    verifiedHistory = history.body;
    if (
      verifiedHistory.snapshots?.[0]?.verificationStatus === "verified" &&
      verifiedHistory.snapshots[0].proofTransactionHash
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  const snapshot = verifiedHistory?.snapshots?.[0];
  const privateHistory = await request(
    `/api/monitoring/watchlists/${watchlist.id}`,
    { method: "GET" },
    ownerA.cookie,
  );
  const privateSnapshot = (
    privateHistory.body.history as
      | Array<{ snapshotId?: string; jobId?: string }>
      | undefined
  )?.[0];
  assert(
    privateHistory.response.ok &&
      privateSnapshot?.jobId === jobId &&
      privateSnapshot.snapshotId === snapshot?.snapshotId,
    "The owner-only monitoring history is not linked to the smoke job.",
  );
  assert(
    snapshot.reportHash ===
      verifiedHistory?.currentReport?.verification?.reportHash,
    "Snapshot proof hash does not match the canonical report hash.",
  );
  assert(
    snapshot.verificationStatus === "verified" &&
      verifiedHistory?.currentReport?.verification?.verifiedOnArc === true &&
      /^0x[0-9a-f]{64}$/i.test(snapshot.proofTransactionHash ?? ""),
    "The baseline snapshot was not verified on Arc.",
  );
  assert(
    verifiedHistory?.currentDelta?.previousSnapshotId === null,
    "The first monitoring snapshot must be a baseline delta.",
  );
  console.log(
    `[p30-smoke] Snapshot=${snapshot.snapshotId} ArcProof=${snapshot.proofTransactionHash}`,
  );
  console.log(`[p30-smoke] PublicHistory=${baseUrl}${watchlist.publicHistoryUrl}`);
  console.log("[p30-smoke] PASSED");
}

main().catch((error) => {
  console.error(
    `[p30-smoke] FAILED: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
