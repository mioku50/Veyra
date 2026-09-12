-- Copyright 2026 Veyra
-- SPDX-License-Identifier: Apache-2.0

-- Phase 18 proof lifecycle metadata. Payment settlement remains authoritative;
-- these fields describe the independent post-settlement Arc attestation.

alter table public.payment_events
  add column if not exists onchain_buyer text,
  add column if not exists onchain_seller text,
  add column if not exists onchain_amount_atomic text,
  add column if not exists onchain_block_number bigint,
  add column if not exists onchain_proof_id text,
  add column if not exists onchain_attester text,
  add column if not exists onchain_verified_at timestamptz,
  add column if not exists onchain_last_attempt_at timestamptz,
  add column if not exists onchain_attempt_count integer not null default 0,
  add column if not exists onchain_error text;

alter table public.payment_events
  drop constraint if exists payment_events_onchain_attempt_count_check;

alter table public.payment_events
  add constraint payment_events_onchain_attempt_count_check
  check (onchain_attempt_count >= 0);

create unique index if not exists payment_events_onchain_proof_id_idx
  on public.payment_events (onchain_proof_id)
  where onchain_proof_id is not null;

create unique index if not exists payment_events_onchain_tx_hash_idx
  on public.payment_events (onchain_tx_hash)
  where onchain_tx_hash is not null;

create index if not exists payment_events_onchain_recovery_idx
  on public.payment_events (onchain_status, onchain_last_attempt_at, created_at)
  where onchain_status in ('pending', 'failed');
