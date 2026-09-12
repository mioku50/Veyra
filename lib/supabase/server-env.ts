/**
 * Copyright 2026 Veyra
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getPublicDatabaseDiagnostic,
  type DatabaseProvider,
} from "./env.ts";

// This module is used by Next.js server code and the local Node buyer-agent.
// Do not import it from a Client Component.

type ServerCandidate = {
  name: string;
  value: string | undefined;
  provider: "agent-db" | "legacy";
  credential?: "secret" | "service-role";
};

function firstConfigured(candidates: ServerCandidate[]) {
  return candidates.find((candidate) => Boolean(candidate.value?.trim())) ?? null;
}

function providerFor(
  url: ServerCandidate | null,
  key: ServerCandidate | null,
): DatabaseProvider {
  if (!url || !key) return "unconfigured";
  return url.provider === key.provider ? url.provider : "mixed-transition";
}

function serverCandidates() {
  return {
    url: [
      {
        name: "AGENT_DB_SUPABASE_URL",
        value: process.env.AGENT_DB_SUPABASE_URL,
        provider: "agent-db" as const,
      },
      {
        name: "NEXT_PUBLIC_AGENT_DB_SUPABASE_URL",
        value: process.env.NEXT_PUBLIC_AGENT_DB_SUPABASE_URL,
        provider: "agent-db" as const,
      },
      {
        name: "NEXT_PUBLIC_SUPABASE_URL",
        value: process.env.NEXT_PUBLIC_SUPABASE_URL,
        provider: "legacy" as const,
      },
    ],
    key: [
      {
        name: "AGENT_DB_SUPABASE_SECRET_KEY",
        value: process.env.AGENT_DB_SUPABASE_SECRET_KEY,
        provider: "agent-db" as const,
        credential: "secret" as const,
      },
      {
        name: "AGENT_DB_SUPABASE_SERVICE_ROLE_KEY",
        value: process.env.AGENT_DB_SUPABASE_SERVICE_ROLE_KEY,
        provider: "agent-db" as const,
        credential: "service-role" as const,
      },
      {
        name: "SUPABASE_SERVICE_ROLE_KEY",
        value: process.env.SUPABASE_SERVICE_ROLE_KEY,
        provider: "legacy" as const,
        credential: "service-role" as const,
      },
    ],
    postgres: [
      {
        name: "AGENT_DB_POSTGRES_URL_NON_POOLING",
        value: process.env.AGENT_DB_POSTGRES_URL_NON_POOLING,
        provider: "agent-db" as const,
      },
      {
        name: "POSTGRES_URL_NON_POOLING",
        value: process.env.POSTGRES_URL_NON_POOLING,
        provider: "legacy" as const,
      },
    ],
  };
}

export function getServerSupabaseConfig() {
  const candidates = serverCandidates();
  const url = firstConfigured(candidates.url);
  const key = firstConfigured(candidates.key);

  if (!url?.value || !key?.value) {
    throw new Error(
      "Server Supabase configuration is missing. Configure AGENT_DB_SUPABASE_URL and AGENT_DB_SUPABASE_SECRET_KEY (service-role and legacy fallbacks remain supported).",
    );
  }

  return {
    url: url.value,
    key: key.value,
    diagnostic: {
      provider: providerFor(url, key),
      configured: true,
      urlEnv: url.name,
      keyEnv: key.name,
      credential: key.credential ?? null,
    },
  };
}

export function tryGetServerSupabaseConfig() {
  try {
    return getServerSupabaseConfig();
  } catch {
    return null;
  }
}

export function getServerDatabaseDiagnostic() {
  const candidates = serverCandidates();
  const url = firstConfigured(candidates.url);
  const key = firstConfigured(candidates.key);
  const postgres = firstConfigured(candidates.postgres);

  return {
    provider: providerFor(url, key),
    publicClient: getPublicDatabaseDiagnostic(),
    serverClient: {
      configured: Boolean(url?.value && key?.value),
      urlEnv: url?.name ?? null,
      keyEnv: key?.name ?? null,
      credential: key?.credential ?? null,
    },
    migrations: {
      configured: Boolean(postgres?.value),
      urlEnv: postgres?.name ?? null,
      connectionMode: postgres?.value ? "non-pooling" : null,
    },
  };
}
