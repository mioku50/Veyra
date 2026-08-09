-- Machine API read limits must be atomic across serverless instances.

alter table public.machine_api_idempotency
  add column if not exists reservation_token uuid;

-- Pending idempotency records are leases. A token prevents an invocation that
-- outlived its lease from completing or releasing a newer invocation's work.
drop function if exists public.reserve_machine_api_idempotency_v1(
  text,
  text,
  text,
  text,
  text,
  timestamptz
);

create function public.reserve_machine_api_idempotency_v1(
  p_credential_id text,
  p_agent_id text,
  p_route text,
  p_idempotency_key_hash text,
  p_request_hash text,
  p_expires_at timestamptz
)
returns table (
  reservation_outcome text,
  cached_status integer,
  cached_body jsonb,
  reservation_token uuid
)
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_record public.machine_api_idempotency%rowtype;
  v_token uuid := gen_random_uuid();
begin
  insert into public.machine_api_idempotency (
    credential_id,
    agent_id,
    route,
    idempotency_key_hash,
    request_hash,
    reservation_token,
    expires_at
  )
  values (
    p_credential_id,
    p_agent_id,
    p_route,
    p_idempotency_key_hash,
    p_request_hash,
    v_token,
    p_expires_at
  )
  on conflict (credential_id, route, idempotency_key_hash) do nothing
  returning * into v_record;

  if found then
    return query select 'reserved'::text, null::integer, null::jsonb, v_token;
    return;
  end if;

  select *
    into v_record
    from public.machine_api_idempotency
   where credential_id = p_credential_id
     and route = p_route
     and idempotency_key_hash = p_idempotency_key_hash
   for update;

  if not found then
    raise exception 'Machine API idempotency reservation disappeared.';
  end if;

  if v_record.expires_at <= now()
     or (
       v_record.response_status is null
       and v_record.created_at <= now() - interval '5 minutes'
     ) then
    update public.machine_api_idempotency
       set agent_id = p_agent_id,
           request_hash = p_request_hash,
           response_status = null,
           response_body = null,
           resource_type = null,
           resource_id = null,
           reservation_token = v_token,
           created_at = now(),
           expires_at = p_expires_at
     where id = v_record.id;

    return query select 'reserved'::text, null::integer, null::jsonb, v_token;
    return;
  end if;

  if v_record.request_hash <> p_request_hash then
    return query select 'conflict'::text, null::integer, null::jsonb, null::uuid;
    return;
  end if;

  if v_record.response_status is not null then
    return query
      select
        'cached'::text,
        v_record.response_status,
        v_record.response_body,
        null::uuid;
    return;
  end if;

  return query select 'pending'::text, null::integer, null::jsonb, null::uuid;
end;
$$;

revoke all on function public.reserve_machine_api_idempotency_v1(
  text,
  text,
  text,
  text,
  text,
  timestamptz
) from public, anon, authenticated;
grant execute on function public.reserve_machine_api_idempotency_v1(
  text,
  text,
  text,
  text,
  text,
  timestamptz
) to service_role;

create or replace function public.complete_machine_api_idempotency_v1(
  p_credential_id text,
  p_route text,
  p_idempotency_key_hash text,
  p_request_hash text,
  p_reservation_token uuid,
  p_response_status integer,
  p_response_body jsonb,
  p_resource_type text,
  p_resource_id text,
  p_expires_at timestamptz
)
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  update public.machine_api_idempotency
     set response_status = p_response_status,
         response_body = p_response_body,
         resource_type = p_resource_type,
         resource_id = p_resource_id,
         expires_at = p_expires_at
   where credential_id = p_credential_id
     and route = p_route
     and idempotency_key_hash = p_idempotency_key_hash
     and request_hash = p_request_hash
     and reservation_token = p_reservation_token
     and response_status is null;
  return found;
end;
$$;

create or replace function public.release_machine_api_idempotency_v1(
  p_credential_id text,
  p_route text,
  p_idempotency_key_hash text,
  p_request_hash text,
  p_reservation_token uuid
)
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  delete from public.machine_api_idempotency
   where credential_id = p_credential_id
     and route = p_route
     and idempotency_key_hash = p_idempotency_key_hash
     and request_hash = p_request_hash
     and reservation_token = p_reservation_token
     and response_status is null;
  return found;
end;
$$;

revoke all on function public.complete_machine_api_idempotency_v1(
  text, text, text, text, uuid, integer, jsonb, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.complete_machine_api_idempotency_v1(
  text, text, text, text, uuid, integer, jsonb, text, text, timestamptz
) to service_role;

revoke all on function public.release_machine_api_idempotency_v1(
  text, text, text, text, uuid
) from public, anon, authenticated;
grant execute on function public.release_machine_api_idempotency_v1(
  text, text, text, text, uuid
) to service_role;

create table if not exists public.machine_api_read_rate_limits (
  credential_id uuid not null references public.byoa_agent_credentials(id) on delete cascade,
  route text not null check (char_length(route) between 1 and 160),
  window_started_at timestamptz not null,
  request_count integer not null check (request_count between 1 and 10000),
  primary key (credential_id, route, window_started_at)
);

create index if not exists machine_api_read_rate_limits_window_idx
  on public.machine_api_read_rate_limits (window_started_at);

alter table public.machine_api_read_rate_limits enable row level security;

drop policy if exists "Allow service access" on public.machine_api_read_rate_limits;
create policy "Allow service access"
  on public.machine_api_read_rate_limits
  for all
  to service_role
  using (true)
  with check (true);

revoke all on public.machine_api_read_rate_limits from public, anon, authenticated;
grant select, insert, update, delete on public.machine_api_read_rate_limits to service_role;

create or replace function public.consume_machine_api_read_limit_v1(
  p_credential_id uuid,
  p_route text,
  p_max_per_minute integer
)
returns table (
  allowed boolean,
  retry_after_seconds integer
)
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_window timestamptz := date_trunc('minute', clock_timestamp());
  v_count integer;
  v_limit integer := greatest(1, least(p_max_per_minute, 1000));
begin
  if p_route is null or char_length(p_route) not between 1 and 160 then
    raise exception 'Invalid Machine API rate-limit route.';
  end if;

  insert into public.machine_api_read_rate_limits (
    credential_id,
    route,
    window_started_at,
    request_count
  ) values (
    p_credential_id,
    p_route,
    v_window,
    1
  )
  on conflict (credential_id, route, window_started_at)
  do update set request_count = public.machine_api_read_rate_limits.request_count + 1
    where public.machine_api_read_rate_limits.request_count < v_limit
  returning request_count into v_count;

  if v_count is null then
    return query select false, greatest(
      1,
      ceil(extract(epoch from (v_window + interval '1 minute' - clock_timestamp())))::integer
    );
    return;
  end if;

  -- Bounded opportunistic cleanup; rows carry no user payload.
  delete from public.machine_api_read_rate_limits
   where window_started_at < v_window - interval '10 minutes';

  return query select true, 0;
end;
$$;

revoke all on function public.consume_machine_api_read_limit_v1(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.consume_machine_api_read_limit_v1(uuid, text, integer)
  to service_role;

comment on table public.machine_api_read_rate_limits is
  'Internal credential-scoped fixed-window counters for distributed Machine API read limits.';

-- Enforce Machine API quote spending inside the quote insert transaction. The
-- application preflight remains useful for friendly errors, while this trigger
-- closes the parallel-request check/insert race across Vercel instances.
create or replace function public.enforce_machine_quote_spending_policy_v1()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_policy public.byoa_agent_policies%rowtype;
  v_reserved numeric(20, 6);
begin
  if new.byoa_agent_id is null or new.machine_credential_id is null then
    return new;
  end if;

  if not exists (
    select 1
      from public.byoa_agent_credentials credential
     where credential.id::text = new.machine_credential_id
       and credential.agent_id = new.byoa_agent_id
       and credential.revoked_at is null
       and credential.expires_at > now()
  ) then
    raise exception 'machine_quote_credential_invalid';
  end if;

  perform pg_advisory_xact_lock(
    pg_catalog.hashtextextended('machine-quote-spend:' || new.byoa_agent_id::text, 0)
  );

  select * into v_policy
    from public.byoa_agent_policies
   where agent_id = new.byoa_agent_id;
  if not found then
    raise exception 'machine_quote_policy_missing';
  end if;

  if new.estimated_provider_cost_usdc > v_policy.max_price_per_run_usdc then
    raise exception 'machine_quote_spending_limit_exceeded';
  end if;

  select coalesce(sum(estimated_provider_cost_usdc), 0)
    into v_reserved
    from public.hosted_workflow_quotes
   where byoa_agent_id = new.byoa_agent_id
     and created_at >= date_trunc('day', now())
     and status not in ('expired', 'cancelled', 'credited');

  if v_reserved + new.estimated_provider_cost_usdc > v_policy.daily_spend_limit_usdc then
    raise exception 'machine_quote_spending_limit_exceeded';
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_machine_quote_spending_policy
  on public.hosted_workflow_quotes;
create trigger enforce_machine_quote_spending_policy
  before insert on public.hosted_workflow_quotes
  for each row
  execute function public.enforce_machine_quote_spending_policy_v1();

revoke all on function public.enforce_machine_quote_spending_policy_v1()
  from public, anon, authenticated;
grant execute on function public.enforce_machine_quote_spending_policy_v1()
  to service_role;
