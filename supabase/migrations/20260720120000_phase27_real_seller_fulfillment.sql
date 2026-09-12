-- Copyright 2026 Veyra
-- SPDX-License-Identifier: Apache-2.0

alter table public.store_services
  add column if not exists fulfillment_url text not null default '',
  add column if not exists seller_wallet text not null default '',
  add column if not exists expected_network text not null default 'eip155:5042002',
  add column if not exists expected_asset text not null default '0x3600000000000000000000000000000000000000',
  add column if not exists max_timeout_ms integer not null default 15000,
  add column if not exists max_response_size_bytes integer not null default 1048576,
  add column if not exists wallet_verification_status text not null default 'unverified',
  add column if not exists endpoint_verification_status text not null default 'unverified',
  add column if not exists wallet_verification_challenge text not null default '',
  add column if not exists endpoint_verification_nonce text not null default '';

alter table public.store_services
  drop constraint if exists store_services_status_check;

alter table public.store_services
  add constraint store_services_status_check
  check (status in ('draft', 'verifying', 'live', 'disabled', 'coming-soon'));

alter table public.store_services
  drop constraint if exists store_services_source_type_check;

alter table public.store_services
  add constraint store_services_source_type_check
  check (source_type in ('seller_mock', 'external_placeholder', 'external_seller'));

alter table public.store_services
  drop constraint if exists store_services_wallet_verification_status_check;

alter table public.store_services
  add constraint store_services_wallet_verification_status_check
  check (wallet_verification_status in ('unverified', 'verified'));

alter table public.store_services
  drop constraint if exists store_services_endpoint_verification_status_check;

alter table public.store_services
  add constraint store_services_endpoint_verification_status_check
  check (endpoint_verification_status in ('unverified', 'verified'));

drop policy if exists "Allow public read of published services" on public.store_services;
create policy "Allow public read of published services"
  on public.store_services for select
  using (status in ('live', 'verifying', 'coming-soon'));
