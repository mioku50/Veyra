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

create table if not exists public.agent_profiles (
  wallet text primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  first_seen_at timestamptz,
  last_run_at timestamptz,
  total_runs integer not null default 0,
  completed_runs integer not null default 0,
  failed_runs integer not null default 0,
  stopped_runs integer not null default 0,
  budget_respected_runs integer not null default 0,
  paid_requests integer not null default 0,
  skipped_requests integer not null default 0,
  failed_requests integer not null default 0,
  total_usdc_spent text not null default '0',
  seller_created_services_used integer not null default 0,
  official_services_used integer not null default 0,
  trust_score integer not null default 0 check (trust_score >= 0 and trust_score <= 100),
  raw jsonb
);

create table if not exists public.agent_reputation_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  wallet text not null references public.agent_profiles(wallet) on delete cascade,
  run_id uuid references public.agent_runs(id) on delete set null,
  event_type text not null,
  title text not null,
  description text,
  score_delta integer not null default 0,
  raw jsonb
);

create unique index if not exists agent_reputation_events_wallet_run_type_idx
  on public.agent_reputation_events (wallet, run_id, event_type)
  where run_id is not null;

create index if not exists agent_profiles_trust_score_idx
  on public.agent_profiles (trust_score desc);

create index if not exists agent_profiles_last_run_at_idx
  on public.agent_profiles (last_run_at desc nulls last);

create index if not exists agent_reputation_events_wallet_created_at_idx
  on public.agent_reputation_events (wallet, created_at desc);

create or replace function public.set_agent_profiles_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_agent_profiles_updated_at on public.agent_profiles;

create trigger set_agent_profiles_updated_at
  before update on public.agent_profiles
  for each row
  execute function public.set_agent_profiles_updated_at();

alter table public.agent_profiles enable row level security;
alter table public.agent_reputation_events enable row level security;

drop policy if exists "Allow public read access" on public.agent_profiles;
create policy "Allow public read access"
  on public.agent_profiles for select
  using (true);

drop policy if exists "Allow service inserts" on public.agent_profiles;
create policy "Allow service inserts"
  on public.agent_profiles for insert
  to service_role
  with check (true);

drop policy if exists "Allow service updates" on public.agent_profiles;
create policy "Allow service updates"
  on public.agent_profiles for update
  to service_role
  using (true);

drop policy if exists "Allow service deletes" on public.agent_profiles;
create policy "Allow service deletes"
  on public.agent_profiles for delete
  to service_role
  using (true);

drop policy if exists "Allow public read access" on public.agent_reputation_events;
create policy "Allow public read access"
  on public.agent_reputation_events for select
  using (true);

drop policy if exists "Allow service inserts" on public.agent_reputation_events;
create policy "Allow service inserts"
  on public.agent_reputation_events for insert
  to service_role
  with check (true);

drop policy if exists "Allow service updates" on public.agent_reputation_events;
create policy "Allow service updates"
  on public.agent_reputation_events for update
  to service_role
  using (true);

drop policy if exists "Allow service deletes" on public.agent_reputation_events;
create policy "Allow service deletes"
  on public.agent_reputation_events for delete
  to service_role
  using (true);

do $$
begin
  alter publication supabase_realtime add table public.agent_profiles;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.agent_reputation_events;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;
