/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from "node:crypto";
import { getByoaClient } from "../byoa/service.ts";
import { isMemoryStoreAllowed } from "./db.ts";

/**
 * Single use for a signed-header nonce, decided somewhere both instances can see.
 *
 * This used to be a Map in the Node process. On one server that is correct; on
 * a platform that starts an instance per burst of traffic it is theatre -- the
 * second instance has an empty Map, so the replay it was meant to stop is
 * accepted by whichever instance had not seen it. The signature window is sixty
 * seconds, which is plenty of time to submit the same authorized action twice.
 *
 * A primary key is the cheapest atomic claim available. Two instances racing
 * the same nonce both INSERT, exactly one gets a unique violation, and the
 * database decided rather than whichever process happened to be warm.
 *
 * There is deliberately no "if the database is down, allow it" path. A claim
 * that cannot be made is reported as unavailable and the caller refuses: this
 * gate stands in front of spending, and a replay window that opens exactly when
 * the system is already unhealthy is the one nobody would notice.
 */

/** How long a consumed nonce is remembered. The signed header is only valid for
 *  sixty seconds, so anything past this can no longer protect anything. */
export const AUTH_NONCE_TTL_MS = 300_000;

export type NonceClaim =
  /** Nobody had used it. It is now used. */
  | "claimed"
  /** Somebody already had. */
  | "replayed"
  /** Nothing can be said either way, so nothing may be assumed. */
  | "unavailable";

/* Only reachable when the execution layer is explicitly running on memory
   stores, which is a test-only mode. Named separately from the durable path so
   that reading this file makes it obvious which one is in play. */
const memoryNonces = new Map<string, number>();

export function clearMemoryAuthNonces(): void {
  memoryNonces.clear();
}

/**
 * The key a nonce is claimed under.
 *
 * Scoped to the wallet, which is the part that matters. A nonce is not a secret
 * -- it travels in a request header -- but an unscoped one lets any caller
 * consume a string somebody else was about to use, turning a replay defence
 * into a way to refuse another wallet's requests.
 */
function nonceDigest(wallet: string, nonce: string): string {
  return createHash("sha256").update(`${wallet.toLowerCase()}\n${nonce}`).digest("hex");
}

function claimInMemory(key: string, now: number): NonceClaim {
  for (const [seen, expiry] of memoryNonces.entries()) {
    if (expiry <= now) memoryNonces.delete(seen);
  }
  if (memoryNonces.has(key)) return "replayed";
  memoryNonces.set(key, now + AUTH_NONCE_TTL_MS);
  return "claimed";
}

/**
 * Takes the nonce, or reports that somebody else already did.
 *
 * Call this only after the signature over it has been verified. Claiming first
 * would let anyone burn a nonce with a signature that is not even valid, which
 * costs the legitimate holder their request and costs the attacker nothing.
 */
export async function claimAuthNonce(input: {
  wallet: string;
  nonce: string;
  method: string;
  path: string;
  now?: number;
}): Promise<NonceClaim> {
  const now = input.now ?? Date.now();
  const key = nonceDigest(input.wallet, input.nonce);

  if (isMemoryStoreAllowed()) return claimInMemory(key, now);

  let client: ReturnType<typeof getByoaClient>;
  try {
    client = getByoaClient();
  } catch {
    return "unavailable";
  }

  const { error } = await client.from("execution_auth_nonces").insert({
    nonce_digest: key,
    wallet: input.wallet.toLowerCase(),
    method: input.method,
    path: input.path,
    claimed_at: new Date(now).toISOString(),
    expires_at: new Date(now + AUTH_NONCE_TTL_MS).toISOString(),
  });

  if (!error) {
    await pruneExpired(client, now);
    return "claimed";
  }
  /* 23505 is the unique violation, and it is the whole mechanism: the row was
     already there, so the nonce was already spent. Every other error means the
     claim did not happen and nothing is known about whether it could have. */
  if (error.code === "23505") return "replayed";
  return "unavailable";
}

/**
 * Drops rows that can no longer protect anything.
 *
 * Sampled rather than scheduled, because this table needs no cron: a nonce is
 * worthless five minutes after it was claimed, and a table that is written once
 * per authenticated request is swept often enough by one call in fifty. Failure
 * is ignored -- an unpruned row is wasted space, never a wrong answer.
 */
async function pruneExpired(client: ReturnType<typeof getByoaClient>, now: number): Promise<void> {
  if (Math.random() >= 0.02) return;
  await client
    .from("execution_auth_nonces")
    .delete()
    .lt("expires_at", new Date(now).toISOString())
    .then(() => undefined, () => undefined);
}
