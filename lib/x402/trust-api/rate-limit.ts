/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A modest ceiling on the free verdict endpoint.
 *
 * This counter lives in one server instance's memory, so on a horizontally
 * scaled deployment it limits per instance rather than globally, and it resets
 * on redeploy. It is stated plainly rather than presented as a security
 * control: its job is to stop one enthusiastic client from turning Veyra into
 * an unpaid probe amplifier, not to stop a determined one. The paid endpoints
 * do not rely on it at all — payment is their limit.
 */
const WINDOW_MS = 60_000;
const buckets = new Map<string, { count: number; windowStart: number }>();

export function consumeFreeCall(key: string, maxPerMinute = 20): {
  allowed: boolean;
  retryAfterSeconds: number;
} {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    buckets.set(key, { count: 1, windowStart: now });
    // Opportunistic sweep: the map must not grow without bound on a long-lived
    // instance just because every caller is unique.
    if (buckets.size > 5_000) {
      for (const [entry, value] of buckets) {
        if (now - value.windowStart >= WINDOW_MS) buckets.delete(entry);
      }
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (bucket.count >= maxPerMinute) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((WINDOW_MS - (now - bucket.windowStart)) / 1000)),
    };
  }
  bucket.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}

/** Best-available caller identity behind a proxy. Spoofable, and only used for
 *  the free tier's courtesy limit. */
export function callerKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}
