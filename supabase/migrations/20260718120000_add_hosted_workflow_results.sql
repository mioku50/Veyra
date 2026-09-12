-- Copyright 2026 Veyra
-- SPDX-License-Identifier: Apache-2.0

alter table public.hosted_agent_jobs
  add column if not exists workflow_type text not null default 'custom_task',
  add column if not exists input_text text,
  add column if not exists planner_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists selected_services jsonb not null default '[]'::jsonb,
  add column if not exists structured_result jsonb,
  add column if not exists receipt_ids jsonb not null default '[]'::jsonb,
  add column if not exists proof_transaction_hashes jsonb not null default '[]'::jsonb;

do $$
begin
  alter table public.hosted_agent_jobs
    add constraint hosted_agent_jobs_workflow_type_check
    check (workflow_type in ('sentiment_tone', 'builder_update', 'custom_task'));
exception when duplicate_object then null;
end;
$$;

do $$
begin
  alter table public.hosted_agent_jobs
    add constraint hosted_agent_jobs_input_text_length_check
    check (input_text is null or char_length(input_text) between 1 and 5000);
exception when duplicate_object then null;
end;
$$;

do $$
begin
  alter table public.hosted_agent_jobs
    add constraint hosted_agent_jobs_planner_snapshot_object_check
    check (jsonb_typeof(planner_snapshot) = 'object');
exception when duplicate_object then null;
end;
$$;

do $$
begin
  alter table public.hosted_agent_jobs
    add constraint hosted_agent_jobs_selected_services_array_check
    check (jsonb_typeof(selected_services) = 'array' and jsonb_array_length(selected_services) <= 3);
exception when duplicate_object then null;
end;
$$;

do $$
begin
  alter table public.hosted_agent_jobs
    add constraint hosted_agent_jobs_receipt_ids_array_check
    check (jsonb_typeof(receipt_ids) = 'array');
exception when duplicate_object then null;
end;
$$;

do $$
begin
  alter table public.hosted_agent_jobs
    add constraint hosted_agent_jobs_proof_hashes_array_check
    check (jsonb_typeof(proof_transaction_hashes) = 'array');
exception when duplicate_object then null;
end;
$$;

create index if not exists hosted_agent_jobs_completed_created_idx
  on public.hosted_agent_jobs (created_at desc)
  where status = 'completed';

create or replace function public.launch_hosted_agent_workflow(
  p_idempotency_hash text,
  p_requester_fingerprint text,
  p_requester_wallet text,
  p_workflow_type text,
  p_task text,
  p_input_text text,
  p_budget_usdc numeric,
  p_planner_snapshot jsonb,
  p_selected_services jsonb,
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
  if p_workflow_type not in ('sentiment_tone', 'builder_update', 'custom_task') then
    raise exception 'Invalid hosted workflow type';
  end if;
  if jsonb_typeof(p_planner_snapshot) <> 'object' then
    raise exception 'Planner snapshot must be an object';
  end if;
  if jsonb_typeof(p_selected_services) <> 'array' or jsonb_array_length(p_selected_services) > 3 then
    raise exception 'Selected services must be an array with at most three entries';
  end if;

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
    workflow_type,
    task,
    input_text,
    budget_usdc,
    planner_snapshot,
    selected_services,
    status,
    progress_stage
  ) values (
    p_idempotency_hash,
    p_requester_fingerprint,
    p_requester_wallet,
    p_workflow_type,
    p_task,
    p_input_text,
    p_budget_usdc,
    p_planner_snapshot,
    p_selected_services,
    'queued',
    'queued'
  ) returning id into v_job_id;

  return query select v_job_id, true, 'created'::text, 0;
end;
$$;

revoke all on function public.launch_hosted_agent_workflow(text, text, text, text, text, text, numeric, jsonb, jsonb, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.launch_hosted_agent_workflow(text, text, text, text, text, text, numeric, jsonb, jsonb, integer, integer, integer) to service_role;

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
    select 1 from public.agent_purchase_steps
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
      structured_result = null,
      receipt_ids = '[]'::jsonb,
      proof_transaction_hashes = '[]'::jsonb,
      started_at = null,
      completed_at = null,
      last_heartbeat_at = null,
      recovery_count = recovery_count + 1
  where id = p_job_id;

  return true;
end;
$$;

revoke all on function public.requeue_failed_hosted_agent_job(uuid) from public, anon, authenticated;
grant execute on function public.requeue_failed_hosted_agent_job(uuid) to service_role;
