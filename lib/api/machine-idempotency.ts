/**
 * Copyright 2026 Circle Internet Group, Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { tryGetServerSupabaseConfig } from "../supabase/server-env.ts";

export interface IdempotencyCheckResult<T = unknown> {
  ok: boolean;
  conflict: boolean;
  pending?: boolean;
  unavailable?: boolean;
  reservationToken?: string;
  cachedResponse?: {
    status: number;
    body: T;
  } | null;
  cached: boolean;
  result?: T;
}

export function isMemoryFallbackAllowed(): boolean {
  return (
    process.env.NODE_ENV === "test" ||
    process.env.MACHINE_API_ALLOW_MEMORY_IDEMPOTENCY === "true"
  );
}

export interface ResolveMachineIdempotencyOptions {
  key: string;
  credentialId: string;
  agentId?: string;
  route?: string;
  payload: unknown;
}

export interface SaveMachineIdempotencyOptions {
  key: string;
  credentialId: string;
  agentId?: string;
  route?: string;
  payload: unknown;
  responseStatus?: number;
  responseBody: unknown;
  resourceType?: string;
  resourceId?: string;
  reservationToken?: string;
}

interface MemoryStoredRecord {
  key: string;
  credentialId: string;
  agentId: string;
  route: string;
  keyHash: string;
  requestHash: string;
  responseStatus?: number;
  responseBody?: unknown;
  resourceType?: string;
  resourceId?: string;
  createdAt: number;
  reservationToken: string;
}

const memoryStore = new Map<string, MemoryStoredRecord>();
const MAX_STORE_SIZE = 1000;
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const PENDING_LEASE_MS = 5 * 60 * 1000;

let customClient: SupabaseClient | null | undefined;

export function setMachineIdempotencyClientForTesting(
  client: SupabaseClient | null,
): void {
  customClient = client;
}

function getSupabaseClient(): SupabaseClient | null {
  if (customClient !== undefined) return customClient;
  const config = tryGetServerSupabaseConfig();
  if (!config) return null;
  return createClient(config.url, config.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function canonicalizeJson(val: unknown): string {
  if (val === undefined) return "null";
  if (val === null || typeof val !== "object") {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return `[${val.map((item) => canonicalizeJson(item)).join(",")}]`;
  }
  const obj = val as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const entries = sortedKeys.map(
    (key) => `${JSON.stringify(key)}:${canonicalizeJson(obj[key])}`,
  );
  return `{${entries.join(",")}}`;
}

export function computeCanonicalRequestHash(payload: unknown): string {
  const json = canonicalizeJson(payload ?? {});
  return createHash("sha256").update(json).digest("hex");
}

export function computePayloadHash(payload: unknown): string {
  return computeCanonicalRequestHash(payload);
}

export function buildIdempotencyCompositeKey(
  key: string,
  credentialId: string,
  route = "/api/agent/v1",
): string {
  const keyHash = createHash("sha256").update(key.trim()).digest("hex");
  return `${credentialId}:${route}:${keyHash}`;
}

export async function inspectMachineIdempotency<T = unknown>(
  keyOrOptions: string | ResolveMachineIdempotencyOptions,
  credentialIdArg?: string,
  payloadArg?: unknown,
  routeArg = "/api/agent/v1",
  _agentIdArg?: string,
): Promise<IdempotencyCheckResult<T>> {
  let key: string;
  let credentialId: string;
  let route: string;
  let payload: unknown;

  if (typeof keyOrOptions === "object" && keyOrOptions !== null) {
    key = keyOrOptions.key;
    credentialId = keyOrOptions.credentialId;
    route = keyOrOptions.route || "/api/agent/v1";
    payload = keyOrOptions.payload;
  } else {
    key = keyOrOptions;
    credentialId = credentialIdArg!;
    route = routeArg;
    payload = payloadArg;
  }

  if (!key || !key.trim()) {
    return {
      ok: true,
      conflict: false,
      cached: false,
      cachedResponse: null,
      result: undefined,
    };
  }

  const idempotencyKeyHash = createHash("sha256").update(key.trim()).digest("hex");
  const requestHash = computeCanonicalRequestHash(payload);
  const allowMemoryFallback = isMemoryFallbackAllowed();
  const supabase = getSupabaseClient();

  if (supabase) {
    try {
      const { data: existing, error } = await supabase
        .from("machine_api_idempotency")
        .select("request_hash,response_status,response_body,created_at,expires_at")
        .eq("credential_id", credentialId)
        .eq("route", route)
        .eq("idempotency_key_hash", idempotencyKeyHash)
        .maybeSingle();

      if (error) {
        console.warn("[machine-idempotency] DB inspection error:", error);
        if (!allowMemoryFallback) {
          return {
            ok: false,
            unavailable: true,
            conflict: false,
            cached: false,
          };
        }
      } else {
        if (!existing || Date.parse(existing.expires_at) <= Date.now()) {
          return {
            ok: true,
            conflict: false,
            cached: false,
            cachedResponse: null,
            result: undefined,
          };
        }
        const completed =
          existing.response_status !== null &&
          existing.response_status !== undefined;
        if (!completed && Date.parse(existing.created_at) <= Date.now() - PENDING_LEASE_MS) {
          // The reservation RPC can atomically reclaim this expired lease,
          // including for a new payload bound to the same caller key.
          return {
            ok: true,
            conflict: false,
            cached: false,
            cachedResponse: null,
            result: undefined,
          };
        }
        if (existing.request_hash !== requestHash) {
          return {
            ok: false,
            conflict: true,
            cached: false,
            cachedResponse: null,
            result: undefined,
          };
        }
        if (completed) {
          return {
            ok: true,
            conflict: false,
            cached: true,
            cachedResponse: {
              status: existing.response_status,
              body: existing.response_body as T,
            },
            result: existing.response_body as T,
          };
        }
        return {
          ok: false,
          pending: true,
          conflict: false,
          cached: false,
          cachedResponse: null,
          result: undefined,
        };
      }
    } catch (err) {
      console.warn("[machine-idempotency] DB inspection failed:", err);
      if (!allowMemoryFallback) {
        return {
          ok: false,
          unavailable: true,
          conflict: false,
          cached: false,
        };
      }
    }
  } else if (!allowMemoryFallback) {
    return {
      ok: false,
      unavailable: true,
      conflict: false,
      cached: false,
    };
  }

  const compositeKey = `${credentialId}:${route}:${idempotencyKeyHash}`;
  const existing = memoryStore.get(compositeKey);

  if (!existing) {
    return {
      ok: true,
      conflict: false,
      cached: false,
      cachedResponse: null,
      result: undefined,
    };
  }
  if (
    Date.now() - existing.createdAt > TTL_MS ||
    (existing.responseStatus === undefined &&
      Date.now() - existing.createdAt > PENDING_LEASE_MS)
  ) {
    memoryStore.delete(compositeKey);
    return {
      ok: true,
      conflict: false,
      cached: false,
      cachedResponse: null,
      result: undefined,
    };
  }
  if (existing.requestHash !== requestHash) {
    return {
      ok: false,
      conflict: true,
      cached: false,
      cachedResponse: null,
      result: undefined,
    };
  }
  if (
    existing.responseStatus !== undefined &&
    existing.responseStatus !== null
  ) {
    return {
      ok: true,
      conflict: false,
      cached: true,
      cachedResponse: {
        status: existing.responseStatus,
        body: existing.responseBody as T,
      },
      result: existing.responseBody as T,
    };
  }
  return {
    ok: false,
    pending: true,
    conflict: false,
    cached: false,
    cachedResponse: null,
    result: undefined,
  };
}

export async function resolveMachineIdempotency<T = unknown>(
  keyOrOptions: string | ResolveMachineIdempotencyOptions,
  credentialIdArg?: string,
  payloadArg?: unknown,
  routeArg = "/api/agent/v1",
  agentIdArg?: string,
): Promise<IdempotencyCheckResult<T>> {
  let key: string;
  let credentialId: string;
  let agentId: string;
  let route: string;
  let payload: unknown;

  if (typeof keyOrOptions === "object" && keyOrOptions !== null) {
    key = keyOrOptions.key;
    credentialId = keyOrOptions.credentialId;
    agentId = keyOrOptions.agentId || keyOrOptions.credentialId;
    route = keyOrOptions.route || "/api/agent/v1";
    payload = keyOrOptions.payload;
  } else {
    key = keyOrOptions;
    credentialId = credentialIdArg!;
    agentId = agentIdArg || credentialIdArg!;
    route = routeArg;
    payload = payloadArg;
  }

  if (!key || !key.trim()) {
    return {
      ok: true,
      conflict: false,
      cached: false,
      cachedResponse: null,
      result: undefined,
    };
  }

  const idempotencyKeyHash = createHash("sha256").update(key.trim()).digest("hex");
  const requestHash = computeCanonicalRequestHash(payload);
  const expiresAt = new Date(Date.now() + TTL_MS).toISOString();
  const allowMemoryFallback = isMemoryFallbackAllowed();

  const supabase = getSupabaseClient();
  if (supabase) {
    try {
      const { data, error } = await supabase.rpc(
        "reserve_machine_api_idempotency_v1",
        {
          p_credential_id: credentialId,
          p_agent_id: agentId,
          p_route: route,
          p_idempotency_key_hash: idempotencyKeyHash,
          p_request_hash: requestHash,
          p_expires_at: expiresAt,
        },
      );

      if (error) {
        console.warn("[machine-idempotency] DB reservation error:", error);
        if (!allowMemoryFallback) {
          return {
            ok: false,
            unavailable: true,
            conflict: false,
            cached: false,
          };
        }
      } else {
        const record = (
          data as Array<{
            reservation_outcome?: string;
            cached_status?: number | null;
            cached_body?: T | null;
            reservation_token?: string | null;
          }> | null
        )?.[0];

        if (!record?.reservation_outcome) {
          if (!allowMemoryFallback) {
            return {
              ok: false,
              unavailable: true,
              conflict: false,
              cached: false,
            };
          }
        } else if (record.reservation_outcome === "reserved") {
          if (!record.reservation_token) {
            return {
              ok: false,
              unavailable: true,
              conflict: false,
              cached: false,
            };
          }
          return {
            ok: true,
            conflict: false,
            cached: false,
            cachedResponse: null,
            result: undefined,
            reservationToken: record.reservation_token,
          };
        } else if (record.reservation_outcome === "conflict") {
          return {
            ok: false,
            conflict: true,
            cached: false,
            cachedResponse: null,
            result: undefined,
          };
        } else if (record.reservation_outcome === "pending") {
          return {
            ok: false,
            pending: true,
            conflict: false,
            cached: false,
            cachedResponse: null,
            result: undefined,
          };
        } else if (
          record.reservation_outcome === "cached" &&
          record.cached_status !== null &&
          record.cached_status !== undefined
        ) {
          return {
            ok: true,
            conflict: false,
            cached: true,
            cachedResponse: {
              status: record.cached_status,
              body: record.cached_body as T,
            },
            result: record.cached_body as T,
          };
        } else if (!allowMemoryFallback) {
          return {
            ok: false,
            unavailable: true,
            conflict: false,
            cached: false,
          };
        }
      }
    } catch (err) {
      console.warn(
        "[machine-idempotency] DB lookup error:",
        err,
      );
      if (!allowMemoryFallback) {
        return {
          ok: false,
          unavailable: true,
          conflict: false,
          cached: false,
        };
      }
    }
  } else {
    if (!allowMemoryFallback) {
      return {
        ok: false,
        unavailable: true,
        conflict: false,
        cached: false,
      };
    }
  }

  const compositeKey = `${credentialId}:${route}:${idempotencyKeyHash}`;
  const existing = memoryStore.get(compositeKey);

  if (existing) {
    if (
      Date.now() - existing.createdAt > TTL_MS ||
      (existing.responseStatus === undefined &&
        Date.now() - existing.createdAt > PENDING_LEASE_MS)
    ) {
      memoryStore.delete(compositeKey);
    } else {
      if (existing.requestHash !== requestHash) {
        return {
          ok: false,
          conflict: true,
          cached: false,
          cachedResponse: null,
          result: undefined,
        };
      }
      if (
        existing.responseStatus !== undefined &&
        existing.responseStatus !== null
      ) {
        return {
          ok: true,
          conflict: false,
          cached: true,
          cachedResponse: {
            status: existing.responseStatus,
            body: existing.responseBody as T,
          },
          result: existing.responseBody as T,
        };
      }
      return {
        ok: false,
        pending: true,
        conflict: false,
        cached: false,
        cachedResponse: null,
        result: undefined,
      };
    }
  }

  if (memoryStore.size >= MAX_STORE_SIZE) {
    const oldestKey = memoryStore.keys().next().value;
    if (oldestKey) memoryStore.delete(oldestKey);
  }

  const reservationToken = randomUUID();
  memoryStore.set(compositeKey, {
    key: key.trim(),
    credentialId,
    agentId,
    route,
    keyHash: idempotencyKeyHash,
    requestHash,
    responseStatus: undefined,
    responseBody: undefined,
    createdAt: Date.now(),
    reservationToken,
  });

  return {
    ok: true,
    conflict: false,
    cached: false,
    cachedResponse: null,
    result: undefined,
    reservationToken,
  };
}

export async function saveMachineIdempotency<T = unknown>(
  keyOrOptions: string | SaveMachineIdempotencyOptions,
  credentialIdArg?: string,
  payloadArg?: unknown,
  resultArg?: T,
  optionsArg?: {
    agentId?: string;
    route?: string;
    responseStatus?: number;
    resourceType?: string;
    resourceId?: string;
    reservationToken?: string;
  },
): Promise<void> {
  let key: string;
  let credentialId: string;
  let agentId: string;
  let route: string;
  let payload: unknown;
  let responseStatus: number;
  let responseBody: unknown;
  let resourceType: string | undefined;
  let resourceId: string | undefined;
  let reservationToken: string | undefined;

  if (typeof keyOrOptions === "object" && keyOrOptions !== null) {
    key = keyOrOptions.key;
    credentialId = keyOrOptions.credentialId;
    agentId = keyOrOptions.agentId || keyOrOptions.credentialId;
    route = keyOrOptions.route || "/api/agent/v1";
    payload = keyOrOptions.payload;
    responseStatus = keyOrOptions.responseStatus ?? 200;
    responseBody = keyOrOptions.responseBody;
    resourceType = keyOrOptions.resourceType;
    resourceId = keyOrOptions.resourceId;
    reservationToken = keyOrOptions.reservationToken;
  } else {
    key = keyOrOptions;
    credentialId = credentialIdArg!;
    agentId = optionsArg?.agentId || credentialIdArg!;
    route = optionsArg?.route || "/api/agent/v1";
    payload = payloadArg;
    responseStatus = optionsArg?.responseStatus ?? 200;
    responseBody = resultArg;
    resourceType = optionsArg?.resourceType;
    resourceId = optionsArg?.resourceId;
    reservationToken = optionsArg?.reservationToken;
  }

  if (!key || !key.trim()) return;

  const idempotencyKeyHash = createHash("sha256").update(key.trim()).digest("hex");
  const requestHash = computeCanonicalRequestHash(payload);
  const expiresAt = new Date(Date.now() + TTL_MS).toISOString();
  const allowMemoryFallback = isMemoryFallbackAllowed();

  const supabase = getSupabaseClient();
  if (supabase) {
    try {
      if (!reservationToken) {
        console.warn(
          "[machine-idempotency] Completion skipped without a reservation token.",
        );
        return;
      }
      const { data, error } = await supabase.rpc(
        "complete_machine_api_idempotency_v1",
        {
          p_credential_id: credentialId,
          p_route: route,
          p_idempotency_key_hash: idempotencyKeyHash,
          p_request_hash: requestHash,
          p_reservation_token: reservationToken,
          p_response_status: responseStatus,
          p_response_body: responseBody as any,
          p_resource_type: resourceType || null,
          p_resource_id: resourceId || null,
          p_expires_at: expiresAt,
        },
      );
      if (!error && data === true) return;
      console.warn(
        "[machine-idempotency] DB completion error:",
        error || "reservation lease no longer belongs to this invocation",
      );
      if (!allowMemoryFallback) return;
    } catch (err) {
      console.warn(
        "[machine-idempotency] DB completion failed:",
        err,
      );
      if (!allowMemoryFallback) return;
    }
  } else {
    if (!allowMemoryFallback) return;
  }

  const compositeKey = `${credentialId}:${route}:${idempotencyKeyHash}`;
  const existing = memoryStore.get(compositeKey);
  if (!existing || existing.reservationToken !== reservationToken) return;
  memoryStore.set(compositeKey, {
    key: key.trim(),
    credentialId,
    agentId,
    route,
    keyHash: idempotencyKeyHash,
    requestHash,
    responseStatus,
    responseBody,
    resourceType,
    resourceId,
    createdAt: existing.createdAt,
    reservationToken: existing.reservationToken,
  });
}

export async function releaseMachineIdempotency(
  key: string,
  credentialId: string,
  payload: unknown,
  route = "/api/agent/v1",
  reservationToken?: string,
): Promise<void> {
  if (!key || !key.trim() || !reservationToken) return;

  const idempotencyKeyHash = createHash("sha256").update(key.trim()).digest("hex");
  const requestHash = computeCanonicalRequestHash(payload);
  const allowMemoryFallback = isMemoryFallbackAllowed();
  const supabase = getSupabaseClient();

  if (supabase) {
    try {
      const { data, error } = await supabase.rpc(
        "release_machine_api_idempotency_v1",
        {
          p_credential_id: credentialId,
          p_route: route,
          p_idempotency_key_hash: idempotencyKeyHash,
          p_request_hash: requestHash,
          p_reservation_token: reservationToken,
        },
      );
      if (!error && data === true) return;
      console.warn(
        "[machine-idempotency] DB release error:",
        error || "reservation lease no longer belongs to this invocation",
      );
      if (!allowMemoryFallback) return;
    } catch (error) {
      console.warn("[machine-idempotency] DB release failed:", error);
      if (!allowMemoryFallback) return;
    }
  } else if (!allowMemoryFallback) {
    return;
  }

  const compositeKey = `${credentialId}:${route}:${idempotencyKeyHash}`;
  const existing = memoryStore.get(compositeKey);
  if (
    existing?.requestHash === requestHash &&
    existing.reservationToken === reservationToken &&
    existing.responseStatus === undefined
  ) {
    memoryStore.delete(compositeKey);
  }
}

export function clearMachineIdempotencyStore(): void {
  memoryStore.clear();
}
