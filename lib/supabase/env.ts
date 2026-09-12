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

export type DatabaseProvider =
  | "agent-db"
  | "legacy"
  | "mixed-transition"
  | "unconfigured";

type EnvCandidate = {
  name: string;
  value: string | undefined;
  provider: Exclude<DatabaseProvider, "mixed-transition" | "unconfigured">;
};

function firstConfigured(candidates: EnvCandidate[]) {
  return candidates.find((candidate) => Boolean(candidate.value?.trim())) ?? null;
}

function providerFor(url: EnvCandidate | null, key: EnvCandidate | null) {
  if (!url || !key) return "unconfigured" as const;
  return url.provider === key.provider ? url.provider : "mixed-transition";
}

function publicCandidates() {
  return {
    url: [
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
        name: "NEXT_PUBLIC_AGENT_DB_SUPABASE_PUBLISHABLE_KEY",
        value: process.env.NEXT_PUBLIC_AGENT_DB_SUPABASE_PUBLISHABLE_KEY,
        provider: "agent-db" as const,
      },
      {
        name: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
        value: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
        provider: "legacy" as const,
      },
    ],
  };
}
export function getPublicSupabaseConfig() {
  const candidates = publicCandidates();
  const url = firstConfigured(candidates.url);
  const key = firstConfigured(candidates.key);

  if (!url?.value || !key?.value) {
    throw new Error(
      "Public Supabase configuration is missing. Configure NEXT_PUBLIC_AGENT_DB_SUPABASE_URL and NEXT_PUBLIC_AGENT_DB_SUPABASE_PUBLISHABLE_KEY (legacy fallback remains supported).",
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
    },
  };
}

export function getPublicDatabaseDiagnostic() {
  const candidates = publicCandidates();
  const url = firstConfigured(candidates.url);
  const key = firstConfigured(candidates.key);

  return {
    provider: providerFor(url, key),
    configured: Boolean(url?.value && key?.value),
    urlEnv: url?.name ?? null,
    keyEnv: key?.name ?? null,
  };
}
