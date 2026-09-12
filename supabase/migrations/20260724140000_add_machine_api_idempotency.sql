-- Copyright 2026 Veyra
-- SPDX-License-Identifier: Apache-2.0

create table if not exists public.machine_api_idempotency (
  id uuid primary key default gen_random_uuid(),
  credential_id text not null,
  agent_id text not null,
  route text not null,
  idempotency_key_hash text not null,
  request_hash text not null,
  response_status integer,
  response_body jsonb,
  resource_type text,
  resource_id text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint idx_machine_idempotency_unique unique (credential_id, route, idempotency_key_hash)
);

create index if not exists idx_machine_idempotency_expires_at
  on public.machine_api_idempotency (expires_at);

alter table public.machine_api_idempotency enable row level security;
