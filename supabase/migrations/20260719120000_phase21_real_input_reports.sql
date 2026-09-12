-- Copyright 2026 Veyra
-- SPDX-License-Identifier: Apache-2.0

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

alter table public.hosted_agent_jobs
  add column if not exists request_hash text,
  add column if not exists input_preview text,
  add column if not exists input_hash text;

create or replace function public.hosted_input_sha256(p_input text)
returns text
language sql
immutable
set search_path = public, extensions
as $$
  select encode(extensions.digest(convert_to(coalesce(p_input, ''), 'UTF8'), 'sha256'), 'hex');
$$;

create or replace function public.hosted_safe_input_preview(p_input text)
returns text
language sql
immutable
set search_path = public
as $$
  select left(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            trim(regexp_replace(coalesce(p_input, ''), E'\\s+', ' ', 'g')),
            E'0x[0-9a-fA-F]{64}',
            '[redacted-hex]',
            'g'
          ),
          E'(sk-(proj-)?|ghp_|github_pat_|AKIA)[A-Za-z0-9_-]{12,}',
          '[redacted-token]',
          'gi'
        ),
        E'[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}',
        '[redacted-email]',
        'gi'
      ),
      E'-----BEGIN (EC |RSA |OPENSSH )?PRIVATE KEY-----',
      '[redacted-private-key]',
      'gi'
    ),
    240
  );
$$;

update public.hosted_agent_jobs
set request_hash = coalesce(request_hash, idempotency_hash),
    input_preview = public.hosted_safe_input_preview(coalesce(input_text, '')),
    input_hash = public.hosted_input_sha256(coalesce(input_text, '')),
    input_text = null
where request_hash is null
   or input_preview is null
   or input_hash is null
   or input_text is not null;

alter table public.hosted_agent_jobs
  alter column request_hash set default repeat('0', 64),
  alter column request_hash set not null,
  alter column input_preview set default '',
  alter column input_preview set not null,
  alter column input_hash set default 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  alter column input_hash set not null;

alter table public.hosted_agent_jobs
  drop constraint if exists hosted_agent_jobs_workflow_type_check,
  drop constraint if exists hosted_agent_jobs_input_text_length_check;

alter table public.hosted_agent_jobs
  add constraint hosted_agent_jobs_workflow_type_check
    check (workflow_type in ('sentiment_tone', 'builder_update', 'market_context', 'custom_task')),
  add constraint hosted_agent_jobs_input_text_not_stored_check
    check (input_text is null),
  add constraint hosted_agent_jobs_input_preview_length_check
    check (char_length(input_preview) <= 240),
  add constraint hosted_agent_jobs_input_hash_check
    check (input_hash ~ '^[0-9a-f]{64}$'),
  add constraint hosted_agent_jobs_request_hash_check
    check (request_hash ~ '^[0-9a-f]{64}$');

create index if not exists hosted_agent_jobs_workflow_created_idx
  on public.hosted_agent_jobs (workflow_type, created_at desc);

create or replace function public.launch_hosted_agent_workflow_v2(
  p_idempotency_hash text,
  p_request_hash text,
  p_requester_fingerprint text,
  p_requester_wallet text,
  p_workflow_type text,
  p_task text,
  p_input_preview text,
  p_input_hash text,
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
  v_existing_request_hash text;
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
  if p_workflow_type not in ('sentiment_tone', 'builder_update', 'market_context', 'custom_task') then
    raise exception 'Invalid hosted workflow type';
  end if;
  if p_idempotency_hash !~ '^[0-9a-f]{64}$'
    or p_request_hash !~ '^[0-9a-f]{64}$'
    or p_input_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Hosted request hashes must be lowercase SHA-256 values';
  end if;
  if char_length(p_input_preview) > 240 then
    raise exception 'Hosted input preview is too long';
  end if;
  if jsonb_typeof(p_planner_snapshot) <> 'object' then
    raise exception 'Planner snapshot must be an object';
  end if;
  if jsonb_typeof(p_selected_services) <> 'array' or jsonb_array_length(p_selected_services) > 3 then
    raise exception 'Selected services must be an array with at most three entries';
  end if;

  perform pg_advisory_xact_lock(hashtext('hosted_agent_jobs_launch_v1'));

  select id, request_hash
    into v_existing_id, v_existing_request_hash
  from public.hosted_agent_jobs
  where idempotency_hash = p_idempotency_hash;

  if v_existing_id is not null then
    if v_existing_request_hash <> p_request_hash then
      return query select null::uuid, false, 'idempotency_conflict'::text, 0;
    else
      return query select v_existing_id, false, 'idempotent'::text, 0;
    end if;
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
    request_hash,
    requester_fingerprint,
    requester_wallet,
    workflow_type,
    task,
    input_text,
    input_preview,
    input_hash,
    budget_usdc,
    planner_snapshot,
    selected_services,
    status,
    progress_stage
  ) values (
    p_idempotency_hash,
    p_request_hash,
    p_requester_fingerprint,
    p_requester_wallet,
    p_workflow_type,
    p_task,
    null,
    p_input_preview,
    p_input_hash,
    p_budget_usdc,
    p_planner_snapshot,
    p_selected_services,
    'queued',
    'queued'
  ) returning id into v_job_id;

  return query select v_job_id, true, 'created'::text, 0;
end;
$$;

revoke all on function public.launch_hosted_agent_workflow_v2(text, text, text, text, text, text, text, text, numeric, jsonb, jsonb, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.launch_hosted_agent_workflow_v2(text, text, text, text, text, text, text, text, numeric, jsonb, jsonb, integer, integer, integer) to service_role;

-- Keep the Phase 20 RPC during rollout, but make it privacy-safe: it derives
-- metadata and never persists p_input_text.
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
language sql
security definer
set search_path = public, extensions
as $$
  select *
  from public.launch_hosted_agent_workflow_v2(
    p_idempotency_hash,
    p_idempotency_hash,
    p_requester_fingerprint,
    p_requester_wallet,
    p_workflow_type,
    p_task,
    public.hosted_safe_input_preview(p_input_text),
    public.hosted_input_sha256(p_input_text),
    p_budget_usdc,
    p_planner_snapshot,
    p_selected_services,
    p_cooldown_seconds,
    p_rate_window_seconds,
    p_rate_max_runs
  );
$$;

revoke all on function public.launch_hosted_agent_workflow(text, text, text, text, text, text, numeric, jsonb, jsonb, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.launch_hosted_agent_workflow(text, text, text, text, text, text, numeric, jsonb, jsonb, integer, integer, integer) to service_role;

revoke all on function public.hosted_input_sha256(text) from public, anon, authenticated;
revoke all on function public.hosted_safe_input_preview(text) from public, anon, authenticated;
grant execute on function public.hosted_input_sha256(text) to service_role;
grant execute on function public.hosted_safe_input_preview(text) to service_role;

comment on column public.hosted_agent_jobs.input_text is
  'Deprecated compatibility column. Phase 21 enforces NULL so full user input is never persisted.';
comment on column public.hosted_agent_jobs.input_preview is
  'Redacted public preview capped at 240 characters.';
comment on column public.hosted_agent_jobs.input_hash is
  'SHA-256 of the normalized ephemeral workflow input.';
comment on column public.hosted_agent_jobs.request_hash is
  'Server-keyed fingerprint binding an idempotency key to workflow, input hash, task, and budget.';
