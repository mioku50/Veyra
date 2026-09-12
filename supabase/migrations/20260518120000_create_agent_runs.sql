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

create table if not exists public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  task text not null,
  mode text not null default 'scripted',
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed', 'stopped')),
  base_url text,
  agent_wallet text,
  budget_usdc text not null,
  spent_usdc text not null default '0',
  summary text,
  error text,
  raw jsonb
);

create table if not exists public.agent_purchase_steps (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  run_id uuid not null references public.agent_runs(id) on delete cascade,
  step_index integer not null,
  service_id text,
  service_slug text,
  service_name text,
  endpoint text,
  method text,
  price_usdc text,
  status text not null
    check (status in ('discovered', 'selected', 'payment_required', 'paid', 'skipped', 'failed')),
  reasoning text,
  request_id text,
  payment_event_id uuid references public.payment_events(id) on delete set null,
  response_preview jsonb,
  error text,
  raw jsonb
);

create unique index if not exists agent_purchase_steps_run_step_index_idx
  on public.agent_purchase_steps (run_id, step_index);

create index if not exists agent_runs_created_at_idx
  on public.agent_runs (created_at desc);

create index if not exists agent_runs_status_idx
  on public.agent_runs (status);

create index if not exists agent_purchase_steps_run_id_created_at_idx
  on public.agent_purchase_steps (run_id, step_index);

create index if not exists agent_purchase_steps_payment_event_id_idx
  on public.agent_purchase_steps (payment_event_id);

create or replace function public.set_agent_runs_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_agent_runs_updated_at on public.agent_runs;

create trigger set_agent_runs_updated_at
  before update on public.agent_runs
  for each row
  execute function public.set_agent_runs_updated_at();

alter table public.agent_runs enable row level security;
alter table public.agent_purchase_steps enable row level security;

drop policy if exists "Allow public read access" on public.agent_runs;
create policy "Allow public read access"
  on public.agent_runs for select
  using (true);

drop policy if exists "Allow service inserts" on public.agent_runs;
create policy "Allow service inserts"
  on public.agent_runs for insert
  to service_role
  with check (true);

drop policy if exists "Allow service updates" on public.agent_runs;
create policy "Allow service updates"
  on public.agent_runs for update
  to service_role
  using (true);

drop policy if exists "Allow service deletes" on public.agent_runs;
create policy "Allow service deletes"
  on public.agent_runs for delete
  to service_role
  using (true);

drop policy if exists "Allow public read access" on public.agent_purchase_steps;
create policy "Allow public read access"
  on public.agent_purchase_steps for select
  using (true);

drop policy if exists "Allow service inserts" on public.agent_purchase_steps;
create policy "Allow service inserts"
  on public.agent_purchase_steps for insert
  to service_role
  with check (true);

drop policy if exists "Allow service updates" on public.agent_purchase_steps;
create policy "Allow service updates"
  on public.agent_purchase_steps for update
  to service_role
  using (true);

drop policy if exists "Allow service deletes" on public.agent_purchase_steps;
create policy "Allow service deletes"
  on public.agent_purchase_steps for delete
  to service_role
  using (true);

do $$
begin
  alter publication supabase_realtime add table public.agent_runs;
exception
  when duplicate_object then null;
  when undefined_object then null;
end;
$$;

do $$
begin
  alter publication supabase_realtime add table public.agent_purchase_steps;
exception
  when duplicate_object then null;
  when undefined_object then null;
end;
$$;
