/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createClient } from "@supabase/supabase-js";
import { tryGetServerSupabaseConfig } from "../lib/supabase/server-env.ts";

const baseUrl = (
  process.env.VEYRA_PRODUCTION_URL ?? "https://agent-commerce-six.vercel.app"
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
    redirect: "manual",
    headers: {
      Origin: baseUrl,
      ...(input.body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(input.headers ?? {}),
    },
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json")
    ? await response.json()
    : contentType.startsWith("image/")
      ? null
      : await response.text();
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
  const challenge = (challengeResult.body as {
    challenge?: { id?: string; message?: string };
  }).challenge;
  assert(challenge?.id && challenge.message, "Owner challenge is incomplete.");
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
  return cookie;
}

function collectKeys(value: unknown, keys = new Set<string>()) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
    return keys;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      keys.add(key.replaceAll("_", "").toLowerCase());
      collectKeys(item, keys);
    }
  }
  return keys;
}

async function main() {
  console.log(`[p31-smoke] Target=${baseUrl}`);
  const config = tryGetServerSupabaseConfig();
  assert(config, "Production server Supabase configuration is required.");
  const server = createClient(config.url, config.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const source = await server
    .from("trust_watchlists")
    .select("public_id,profile_id")
    .eq("visibility", "public")
    .not("last_snapshot_id", "is", null)
    .order("last_recheck_at", { ascending: false })
    .limit(1)
    .single();
  assert(
    !source.error && source.data,
    `No published production trust history is available: ${source.error?.message}`,
  );
  const profile = await server
    .from("trust_profiles")
    .select("public_id")
    .eq("id", source.data.profile_id)
    .single();
  assert(
    !profile.error && profile.data,
    `Canonical profile lookup failed: ${profile.error?.message}`,
  );
  const publicId = profile.data.public_id as string;
  assert(/^vtr_[0-9a-f]{20}$/.test(publicId), "Canonical vtr ID is invalid.");

  const publicApi = await request(`/api/monitoring/public/${publicId}`);
  assert(
    publicApi.response.ok,
    `Public profile API failed with HTTP ${publicApi.response.status}.`,
  );
  const payload = publicApi.body as {
    profile?: {
      id?: string;
      currentScore?: number | null;
      snapshotCount?: number;
    };
    snapshots?: Array<{
      score?: number | null;
      observedAt?: string;
      verificationStatus?: string;
      proofTransactionHash?: string | null;
      proofUrl?: string | null;
    }>;
  };
  assert(payload.profile?.id === publicId, "Public profile identity mismatch.");
  assert(
    (payload.snapshots?.length ?? 0) >= 2 &&
      payload.profile.snapshotCount === payload.snapshots?.length,
    "The production profile does not contain a real multi-snapshot history.",
  );
  assert(
    payload.snapshots?.every(
      (snapshot) =>
        (snapshot.score === null || typeof snapshot.score === "number") &&
        typeof snapshot.observedAt === "string",
    ),
    "Trust Score history is not backed by real snapshot values.",
  );
  const verified = payload.snapshots?.find(
    (snapshot) => snapshot.verificationStatus === "verified",
  );
  assert(
    verified &&
      /^0x[0-9a-f]{64}$/i.test(verified.proofTransactionHash ?? "") &&
      verified.proofUrl ===
        `https://testnet.arcscan.app/tx/${verified.proofTransactionHash}`,
    "A snapshot is missing its exact Arc proof.",
  );
  const publicKeys = collectKeys(payload);
  for (const forbidden of [
    "ownerwallet",
    "machinecredentialid",
    "byoaagentid",
    "watchlistid",
    "jobid",
    "cadence",
    "nextrecheckat",
    "scheduledfor",
    "cronsecret",
    "quoteid",
    "paymentid",
    "idempotencyhash",
  ]) {
    assert(!publicKeys.has(forbidden), `Public payload leaked ${forbidden}.`);
  }
  console.log(
    `[p31-smoke] PublicProfile=${publicId} snapshots=${payload.snapshots?.length} privacy=passed`,
  );

  const page = await request(`/trust/${publicId}`);
  assert(
    page.response.ok &&
      typeof page.body === "string" &&
      page.body.includes("Meaningful Change Timeline") &&
      page.body.includes(publicId),
    "The public Trust Profile page did not render its real history.",
  );
  const image = await request(`/trust/${publicId}/opengraph-image`);
  assert(
    image.response.ok &&
      image.response.headers.get("content-type")?.startsWith("image/png"),
    "The dynamic Open Graph image did not render.",
  );
  const legacyApi = await request(
    `/api/monitoring/public/${source.data.public_id}`,
  );
  const legacyPage = await request(`/trust/${source.data.public_id}`);
  assert(
    legacyApi.response.status === 404 && legacyPage.response.status === 404,
    "Legacy watchlist IDs still resolve as public Trust Profile identities.",
  );
  console.log("[p31-smoke] Page, metadata image, and stable vtr route=passed");

  const cookie = await ownerSession();
  const marker = crypto.randomUUID().replaceAll("-", "");
  const endpointA = `https://example.com/health?z=${marker}&a=1#first`;
  const endpointB = `https://EXAMPLE.com/health?a=1&z=${marker}#second`;
  const first = await request(
    "/api/monitoring/watchlists",
    {
      method: "POST",
      body: JSON.stringify({
        label: "P3.1 privacy smoke",
        input: { serviceEndpoint: endpointA },
        cadence: "manual",
        visibility: "private",
      }),
    },
    cookie,
  );
  assert(
    first.response.status === 201,
    `Private watchlist creation failed with HTTP ${first.response.status}.`,
  );
  const watchlist = (first.body as {
    watchlist?: { id?: string; profileId?: string; visibility?: string };
  }).watchlist;
  assert(
    watchlist?.id &&
      watchlist.profileId &&
      watchlist.visibility === "private",
    "Private watchlist response is incomplete.",
  );

  try {
    const replay = await request(
      "/api/monitoring/watchlists",
      {
        method: "POST",
        body: JSON.stringify({
          label: "P3.1 canonical replay",
          input: { serviceEndpoint: endpointB },
          cadence: "weekly",
          visibility: "public",
        }),
      },
      cookie,
    );
    const replayBody = replay.body as {
      created?: boolean;
      watchlist?: { id?: string; profileId?: string };
    };
    assert(
      replay.response.status === 200 &&
        replayBody.created === false &&
        replayBody.watchlist?.id === watchlist.id &&
        replayBody.watchlist.profileId === watchlist.profileId,
      "Canonical endpoint variants created duplicate profiles or watchlists.",
    );

    const privateProfile = await request(
      `/api/monitoring/public/${watchlist.profileId}`,
    );
    const unknownProfile = await request(
      "/api/monitoring/public/vtr_00000000000000000000",
    );
    assert(
      privateProfile.response.status === 404 &&
        unknownProfile.response.status === 404 &&
        JSON.stringify(privateProfile.body) === JSON.stringify(unknownProfile.body),
      "Private and unknown trust profiles are distinguishable.",
    );

    const publish = await request(
      `/api/monitoring/watchlists/${watchlist.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ visibility: "public" }),
      },
      cookie,
    );
    assert(publish.response.ok, "Publishing the trust profile failed.");
    const published = await request(
      `/api/monitoring/public/${watchlist.profileId}`,
    );
    assert(
      published.response.ok &&
        (published.body as { profile?: { id?: string } }).profile?.id ===
          watchlist.profileId,
      "An explicitly published trust profile is not discoverable.",
    );

    const hide = await request(
      `/api/monitoring/watchlists/${watchlist.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ visibility: "private" }),
      },
      cookie,
    );
    assert(hide.response.ok, "Making the trust profile private failed.");
    const hidden = await request(
      `/api/monitoring/public/${watchlist.profileId}`,
    );
    assert(hidden.response.status === 404, "Private profile did not fail closed.");
    console.log("[p31-smoke] Canonical identity and privacy fail-closed=passed");
  } finally {
    const deleted = await request(
      `/api/monitoring/watchlists/${watchlist.id}`,
      { method: "DELETE" },
      cookie,
    );
    assert(deleted.response.ok, "Production smoke watchlist cleanup failed.");
  }

  const deletedProfile = await request(
    `/api/monitoring/public/${watchlist.profileId}`,
  );
  assert(
    deletedProfile.response.status === 404,
    "Deleted watchlist still publishes a trust profile.",
  );
  console.log("[p31-smoke] Delete lifecycle=passed");
  console.log(`[p31-smoke] URL=${baseUrl}/trust/${publicId}`);
  console.log("[p31-smoke] PASSED");
}

main().catch((error) => {
  console.error(
    `[p31-smoke] FAILED: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
