-- Copyright 2026 Veyra
-- SPDX-License-Identifier: Apache-2.0

create table if not exists public.hosted_agent_jobs (
  id uuid primary key default gen_random_uuid(),
  idempotency_hash text not null unique
    check (idempotency_hash ~ '^[0-9a-f]{64}$'),
  requester_fingerprint text not null
    check (requester_fingerprint ~ '^[0-9a-f]{64}$'),
  requester_wallet text,
  task text not null check (char_length(task) between 10 and 500),
  budget_usdc numeric(20, 6) not null
    check (budget_usdc >= 0.001 and budget_usdc <= 0.005),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'completed', 'failed')),
  progress_stage text not null default 'queued'
    check (progress_stage in (
      'queued',
      'planning',
      'purchasing',
      'generating_receipt',
      'publishing_onchain_proof',
      'completed',
      'failed'
    )),
  agent_run_id uuid references public.agent_runs(id) on delete set null,
  spent_usdc numeric(20, 6) not null default 0
    check (spent_usdc >= 0 and spent_usdc <= 0.005),
  error text,
  progress_message text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  recovery_count integer not null default 0 check (recovery_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  last_heartbeat_at timestamptz,
  raw jsonb not null default '{}'::jsonb
);

create unique index if not exists hosted_agent_jobs_one_active_idx
  on public.hosted_agent_jobs ((true))
  where status in ('queued', 'running');

create index if not exists hosted_agent_jobs_requester_created_idx
  on public.hosted_agent_jobs (requester_fingerprint, created_at desc);

create index if not exists hosted_agent_jobs_status_created_idx
  on public.hosted_agent_jobs (status, created_at desc);

create index if not exists hosted_agent_jobs_agent_run_idx
  on public.hosted_agent_jobs (agent_run_id)
  where agent_run_id is not null;

create or replace function public.set_hosted_agent_jobs_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_hosted_agent_jobs_updated_at on public.hosted_agent_jobs;
create trigger set_hosted_agent_jobs_updated_at
  before update on public.hosted_agent_jobs
  for each row execute function public.set_hosted_agent_jobs_updated_at();

alter table public.hosted_agent_jobs enable row level security;

drop policy if exists "Allow service access" on public.hosted_agent_jobs;
create policy "Allow service access"
  on public.hosted_agent_jobs for all
  to service_role
  using (true)
  with check (true);

create or replace function public.launch_hosted_agent_job(
  p_idempotency_hash text,
  p_requester_fingerprint text,
  p_requester_wallet text,
  p_task text,
  p_budget_usdc numeric,
  p_cooldown_seconds integer,
  p_rate_window_seconds integer,
  p_rate_max_runs integer
)
returns table (
  job_id uuid,
  created boolean,
  reason text,
  retry_after_seconds integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing_id uuid;
  v_active_id uuid;
  v_latest_created timestamptz;
  v_oldest_in_window timestamptz;
  v_rate_count integer;
  v_job_id uuid;
  v_retry integer;
  v_cooldown integer := greatest(30, least(p_cooldown_seconds, 3600));
  v_window integer := greatest(300, least(p_rate_window_seconds, 86400));
  v_rate_max integer := greatest(1, least(p_rate_max_runs, 10));
begin
  perform pg_advisory_xact_lock(hashtext('hosted_agent_jobs_launch_v1'));

  select id into v_existing_id
  from public.hosted_agent_jobs
  where idempotency_hash = p_idempotency_hash;

  if v_existing_id is not null then
    return query select v_existing_id, false, 'idempotent'::text, 0;
    return;
  end if;

  select id into v_active_id
  from public.hosted_agent_jobs
  where status in ('queued', 'running')
  order by created_at asc
  limit 1;

  if v_active_id is not null then
    return query select null::uuid, false, 'active_job'::text, 5;
    return;
  end if;

  select created_at into v_latest_created
  from public.hosted_agent_jobs
  where requester_fingerprint = p_requester_fingerprint
  order by created_at desc
  limit 1;

  if v_latest_created is not null and v_latest_created + make_interval(secs => v_cooldown) > now() then
    v_retry := greatest(
      1,
      ceil(extract(epoch from (v_latest_created + make_interval(secs => v_cooldown) - now())))::integer
    );
    return query select null::uuid, false, 'cooldown'::text, v_retry;
    return;
  end if;

  select count(*), min(created_at)
    into v_rate_count, v_oldest_in_window
  from public.hosted_agent_jobs
  where requester_fingerprint = p_requester_fingerprint
    and created_at >= now() - make_interval(secs => v_window);

  if v_rate_count >= v_rate_max then
    v_retry := greatest(
      1,
      ceil(extract(epoch from (v_oldest_in_window + make_interval(secs => v_window) - now())))::integer
    );
    return query select null::uuid, false, 'rate_limited'::text, v_retry;
    return;
  end if;

  insert into public.hosted_agent_jobs (
    idempotency_hash,
    requester_fingerprint,
    requester_wallet,
    task,
    budget_usdc,
    status,
    progress_stage
  ) values (
    p_idempotency_hash,
    p_requester_fingerprint,
    p_requester_wallet,
    p_task,
    p_budget_usdc,
    'queued',
    'queued'
  ) returning id into v_job_id;

  return query select v_job_id, true, 'created'::text, 0;
end;
$$;

create or replace function public.claim_hosted_agent_job(p_job_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed uuid;
begin
  perform pg_advisory_xact_lock(hashtext('hosted_agent_jobs_claim_v1'));

  update public.hosted_agent_jobs
  set status = 'running',
      progress_stage = 'planning',
      progress_message = 'Planning an allowlisted Arc Testnet purchase.',
      started_at = coalesce(started_at, now()),
      completed_at = null,
      last_heartbeat_at = now(),
      attempt_count = attempt_count + 1,
      error = null
  where id = p_job_id and status = 'queued'
  returning id into v_claimed;

  return v_claimed is not null;
end;
$$;

create or replace function public.requeue_failed_hosted_agent_job(p_job_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.hosted_agent_jobs%rowtype;
begin
  perform pg_advisory_xact_lock(hashtext('hosted_agent_jobs_launch_v1'));

  select * into v_job
  from public.hosted_agent_jobs
  where id = p_job_id
  for update;

  if v_job.id is null or v_job.status <> 'failed' then
    return false;
  end if;

  if exists (
    select 1 from public.hosted_agent_jobs
    where status in ('queued', 'running') and id <> p_job_id
  ) then
    return false;
  end if;

  if v_job.spent_usdc > 0 or exists (
    select 1
    from public.agent_purchase_steps
    where run_id = v_job.agent_run_id and status = 'paid'
  ) then
    return false;
  end if;

  update public.hosted_agent_jobs
  set status = 'queued',
      progress_stage = 'queued',
      progress_message = 'Recovered safely before any payment; queued again.',
      agent_run_id = null,
      spent_usdc = 0,
      error = null,
      started_at = null,
      completed_at = null,
      last_heartbeat_at = null,
      recovery_count = recovery_count + 1
  where id = p_job_id;

  return true;
end;
$$;

revoke all on function public.launch_hosted_agent_job(text, text, text, text, numeric, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.claim_hosted_agent_job(uuid) from public, anon, authenticated;
revoke all on function public.requeue_failed_hosted_agent_job(uuid) from public, anon, authenticated;

grant execute on function public.launch_hosted_agent_job(text, text, text, text, numeric, integer, integer, integer) to service_role;
grant execute on function public.claim_hosted_agent_job(uuid) to service_role;
grant execute on function public.requeue_failed_hosted_agent_job(uuid) to service_role;

do $$
begin
  alter publication supabase_realtime add table public.hosted_agent_jobs;
exception
  when duplicate_object then null;
  when undefined_object then null;
end;
$$;
