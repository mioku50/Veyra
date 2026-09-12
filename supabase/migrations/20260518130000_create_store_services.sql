-- Copyright 2026 Veyra
--
-- Licensed under the Apache License, Version 2.0 (the "License");
-- you may not use this file except in compliance with the License.
-- You may obtain a copy of the License at
--
--     http://www.apache.org/licenses/LICENSE-2.0
--
-- Unless required by applicable law or agreed to in writing, software
-- distributed under the License is distributed on an "AS IS" BASIS,
-- WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
-- See the License for the specific language governing permissions and
-- limitations under the License.
--
-- SPDX-License-Identifier: Apache-2.0

create table if not exists public.store_services (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  name text not null,
  slug text not null unique,
  short_description text not null,
  long_description text not null,
  category text not null,
  method text not null
    check (method in ('GET', 'POST')),
  price_usdc numeric(18, 6) not null default 0
    check (price_usdc >= 0),
  status text not null default 'draft'
    check (status in ('draft', 'live', 'disabled', 'coming-soon')),
  source_type text not null default 'seller_mock'
    check (source_type in ('seller_mock', 'external_placeholder')),
  input_schema jsonb not null default '{}'::jsonb,
  output_schema jsonb not null default '{}'::jsonb,
  example_request jsonb not null default '{}'::jsonb,
  example_response jsonb not null default '{}'::jsonb,
  example_use_case text not null default '',
  agent_reasoning_hint text not null default '',
  raw jsonb
);

alter table public.agent_purchase_steps
  add column if not exists service_source_type text;

create index if not exists store_services_status_idx
  on public.store_services (status);

create index if not exists store_services_slug_idx
  on public.store_services (slug);

create index if not exists store_services_category_idx
  on public.store_services (category);

create index if not exists store_services_source_type_idx
  on public.store_services (source_type);

create or replace function public.set_store_services_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_store_services_updated_at on public.store_services;

create trigger set_store_services_updated_at
  before update on public.store_services
  for each row
  execute function public.set_store_services_updated_at();

alter table public.store_services enable row level security;

drop policy if exists "Allow public read of published services" on public.store_services;
create policy "Allow public read of published services"
  on public.store_services for select
  using (status in ('live', 'coming-soon'));

drop policy if exists "Allow service inserts" on public.store_services;
create policy "Allow service inserts"
  on public.store_services for insert
  to service_role
  with check (true);

drop policy if exists "Allow service updates" on public.store_services;
create policy "Allow service updates"
  on public.store_services for update
  to service_role
  using (true);

drop policy if exists "Allow service deletes" on public.store_services;
create policy "Allow service deletes"
  on public.store_services for delete
  to service_role
  using (true);
