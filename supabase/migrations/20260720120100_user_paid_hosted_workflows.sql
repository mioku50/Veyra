-- Copyright 2026 Veyra
-- SPDX-License-Identifier: Apache-2.0

create table if not exists public.hosted_workflow_quotes (
  id uuid primary key default gen_random_uuid(),
  idempotency_hash text not null unique check (idempotency_hash ~ '^[0-9a-f]{64}$'),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  requester_fingerprint text not null check (requester_fingerprint ~ '^[0-9a-f]{64}$'),
  requester_wallet text not null check (requester_wallet ~ '^0x[0-9a-fA-F]{40}$'),
  workflow_type text not null check (workflow_type in ('sentiment_tone', 'builder_update', 'market_context', 'custom_task')),
  task text not null check (char_length(task) between 10 and 500),
  input_preview text not null check (char_length(input_preview) <= 240),
  input_hash text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  budget_usdc numeric(20, 6) not null check (budget_usdc between 0.001 and 0.005),
  planner_snapshot jsonb not null check (jsonb_typeof(planner_snapshot) = 'object'),
  selected_services jsonb not null check (jsonb_typeof(selected_services) = 'array' and jsonb_array_length(selected_services) <= 3),
  estimated_provider_cost_usdc numeric(20, 6) not null check (estimated_provider_cost_usdc >= 0),
  platform_fee_usdc numeric(20, 6) not null check (platform_fee_usdc >= 0),
  list_price_usdc numeric(20, 6) not null check (list_price_usdc >= estimated_provider_cost_usdc),
  payment_mode text not null check (payment_mode in ('sponsored', 'paid')),
  amount_due_usdc numeric(20, 6) not null check (amount_due_usdc >= 0),
  treasury_address text not null check (treasury_address ~ '^0x[0-9a-fA-F]{40}$'),
  chain_id bigint not null default 5042002 check (chain_id = 5042002),
  asset text not null default 'native_usdc' check (asset = 'native_usdc'),
  status text not null default 'quoted' check (status in ('quoted', 'consumed', 'completed', 'failed', 'expired', 'credited', 'cancelled')),
  job_id uuid references public.hosted_agent_jobs(id) on delete set null,
  user_payment_id uuid,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  consumed_at timestamptz
);

create table if not exists public.hosted_workflow_user_payments (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null unique references public.hosted_workflow_quotes(id) on delete restrict,
  job_id uuid references public.hosted_agent_jobs(id) on delete set null,
  requester_wallet text not null check (requester_wallet ~ '^0x[0-9a-fA-F]{40}$'),
  payment_mode text not null check (payment_mode in ('sponsored', 'paid')),
  status text not null check (status in ('sponsored', 'settled', 'credit_issued', 'refund_pending', 'refunded')),
  gross_amount_usdc numeric(20, 6) not null check (gross_amount_usdc >= 0),
  estimated_provider_cost_usdc numeric(20, 6) not null check (estimated_provider_cost_usdc >= 0),
  provider_cost_usdc numeric(20, 6) not null default 0 check (provider_cost_usdc >= 0),
  platform_fee_usdc numeric(20, 6) not null check (platform_fee_usdc >= 0),
  net_revenue_usdc numeric(20, 6) not null default 0,
  credit_amount_usdc numeric(20, 6) not null default 0 check (credit_amount_usdc >= 0),
  chain_id bigint not null default 5042002 check (chain_id = 5042002),
  asset text not null default 'native_usdc' check (asset = 'native_usdc'),
  treasury_address text not null check (treasury_address ~ '^0x[0-9a-fA-F]{40}$'),
  transaction_hash text unique check (transaction_hash is null or transaction_hash ~ '^0x[0-9a-fA-F]{64}$'),
  block_number bigint check (block_number is null or block_number >= 0),
  settled_at timestamptz,
  credited_at timestamptz,
  completed_at timestamptz,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (payment_mode = 'sponsored' and gross_amount_usdc = 0 and transaction_hash is null)
    or
    (payment_mode = 'paid' and gross_amount_usdc > 0 and transaction_hash is not null)
  )
);

create table if not exists public.hosted_workflow_credits (
  id uuid primary key default gen_random_uuid(),
  user_payment_id uuid not null unique references public.hosted_workflow_user_payments(id) on delete restrict,
  requester_wallet text not null check (requester_wallet ~ '^0x[0-9a-fA-F]{40}$'),
  amount_usdc numeric(20, 6) not null check (amount_usdc > 0),
  reason text not null check (char_length(reason) between 1 and 800),
  status text not null default 'issued' check (status in ('issued', 'redeemed', 'refund_pending', 'refunded')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  redeemed_at timestamptz,
  refunded_at timestamptz
);

-- The only statement in this file that was not re-runnable. ADD CONSTRAINT has
-- no IF NOT EXISTS for a foreign key, so a second pass aborted here under
-- ON_ERROR_STOP and took the rest of the migration with it.
do $$
begin
  alter table public.hosted_workflow_quotes
    add constraint hosted_workflow_quotes_user_payment_fk
    foreign key (user_payment_id) references public.hosted_workflow_user_payments(id) on delete set null;
exception when duplicate_object then null;
end;
$$;

alter table public.hosted_agent_jobs
  add column if not exists workflow_quote_id uuid references public.hosted_workflow_quotes(id) on delete set null,
  add column if not exists user_payment_id uuid references public.hosted_workflow_user_payments(id) on delete set null,
  add column if not exists payment_mode text not null default 'legacy_sponsored'
    check (payment_mode in ('legacy_sponsored', 'sponsored', 'paid'));

create unique index if not exists hosted_agent_jobs_quote_unique_idx
  on public.hosted_agent_jobs (workflow_quote_id)
  where workflow_quote_id is not null;

create unique index if not exists hosted_agent_jobs_user_payment_unique_idx
  on public.hosted_agent_jobs (user_payment_id)
  where user_payment_id is not null;

create index if not exists hosted_workflow_quotes_wallet_created_idx
  on public.hosted_workflow_quotes (lower(requester_wallet), created_at desc);

create index if not exists hosted_workflow_quotes_status_expiry_idx
  on public.hosted_workflow_quotes (status, expires_at);

create index if not exists hosted_workflow_user_payments_wallet_created_idx
  on public.hosted_workflow_user_payments (lower(requester_wallet), created_at desc);

create index if not exists hosted_workflow_user_payments_status_created_idx
  on public.hosted_workflow_user_payments (status, created_at desc);

create or replace function public.set_hosted_checkout_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_hosted_workflow_quotes_updated_at on public.hosted_workflow_quotes;
create trigger set_hosted_workflow_quotes_updated_at
  before update on public.hosted_workflow_quotes
  for each row execute function public.set_hosted_checkout_updated_at();

drop trigger if exists set_hosted_workflow_user_payments_updated_at on public.hosted_workflow_user_payments;
create trigger set_hosted_workflow_user_payments_updated_at
  before update on public.hosted_workflow_user_payments
  for each row execute function public.set_hosted_checkout_updated_at();

drop trigger if exists set_hosted_workflow_credits_updated_at on public.hosted_workflow_credits;
create trigger set_hosted_workflow_credits_updated_at
  before update on public.hosted_workflow_credits
  for each row execute function public.set_hosted_checkout_updated_at();

alter table public.hosted_workflow_quotes enable row level security;
alter table public.hosted_workflow_user_payments enable row level security;
alter table public.hosted_workflow_credits enable row level security;

drop policy if exists "Allow service access" on public.hosted_workflow_quotes;
create policy "Allow service access" on public.hosted_workflow_quotes
  for all to service_role using (true) with check (true);

drop policy if exists "Allow service access" on public.hosted_workflow_user_payments;
create policy "Allow service access" on public.hosted_workflow_user_payments
  for all to service_role using (true) with check (true);

drop policy if exists "Allow service access" on public.hosted_workflow_credits;
create policy "Allow service access" on public.hosted_workflow_credits
  for all to service_role using (true) with check (true);

create or replace function public.launch_hosted_workflow_checkout_v1(
  p_quote_id uuid,
  p_idempotency_hash text,
  p_request_hash text,
  p_payment_mode text,
  p_transaction_hash text,
  p_block_number bigint,
  p_settled_at timestamptz,
  p_sponsored_quota integer
)
returns table (
  job_id uuid,
  user_payment_id uuid,
  created boolean,
  reason text,
  retry_after_seconds integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote public.hosted_workflow_quotes%rowtype;
  v_existing_payment public.hosted_workflow_user_payments%rowtype;
  v_active_id uuid;
  v_payment_id uuid;
  v_job_id uuid;
  v_sponsored_count integer;
  v_credit_id uuid;
  v_credit_reason text;
begin
  perform pg_advisory_xact_lock(hashtext('hosted_agent_jobs_launch_v1'));

  select * into v_quote
  from public.hosted_workflow_quotes
  where id = p_quote_id
  for update;

  if v_quote.id is null then
    return query select null::uuid, null::uuid, false, 'quote_not_found'::text, 0;
    return;
  end if;

  if v_quote.idempotency_hash <> p_idempotency_hash or v_quote.request_hash <> p_request_hash then
    return query select null::uuid, null::uuid, false, 'idempotency_conflict'::text, 0;
    return;
  end if;

  if v_quote.payment_mode <> p_payment_mode then
    return query select null::uuid, null::uuid, false, 'payment_mode_conflict'::text, 0;
    return;
  end if;

  if v_quote.job_id is not null and v_quote.user_payment_id is not null then
    return query select v_quote.job_id, v_quote.user_payment_id, false, 'idempotent'::text, 0;
    return;
  end if;

  select * into v_existing_payment
  from public.hosted_workflow_user_payments
  where quote_id = v_quote.id;

  if v_existing_payment.id is not null then
    return query select v_existing_payment.job_id, v_existing_payment.id, false,
      case when v_existing_payment.status = 'credit_issued' then 'credit_issued' else 'idempotent' end,
      0;
    return;
  end if;

  if p_payment_mode = 'sponsored' then
    if now() > v_quote.expires_at then
      update public.hosted_workflow_quotes set status = 'expired' where id = v_quote.id;
      return query select null::uuid, null::uuid, false, 'quote_expired'::text, 0;
      return;
    end if;
    select count(*) into v_sponsored_count
    from public.hosted_workflow_user_payments
    where lower(requester_wallet) = lower(v_quote.requester_wallet)
      and payment_mode = 'sponsored';
    if v_sponsored_count >= greatest(1, least(p_sponsored_quota, 3)) then
      return query select null::uuid, null::uuid, false, 'sponsored_quota_exhausted'::text, 0;
      return;
    end if;
  else
    if p_transaction_hash is null or p_transaction_hash !~ '^0x[0-9a-fA-F]{64}$'
      or p_block_number is null or p_settled_at is null then
      return query select null::uuid, null::uuid, false, 'payment_invalid'::text, 0;
      return;
    end if;
    if p_settled_at < v_quote.created_at - interval '30 seconds' then
      return query select null::uuid, null::uuid, false, 'payment_invalid'::text, 0;
      return;
    end if;
    if p_settled_at > v_quote.expires_at + interval '60 seconds' then
      v_credit_reason := 'The Arc payment settled after the immutable workflow quote expired.';
    end if;
  end if;

  if p_transaction_hash is not null and exists (
    select 1 from public.hosted_workflow_user_payments
    where lower(transaction_hash) = lower(p_transaction_hash)
  ) then
    return query select null::uuid, null::uuid, false, 'payment_reused'::text, 0;
    return;
  end if;

  select id into v_active_id
  from public.hosted_agent_jobs
  where status in ('queued', 'running')
  order by created_at asc
  limit 1;

  if v_active_id is not null then
    if p_payment_mode = 'sponsored' then
      return query select null::uuid, null::uuid, false, 'active_job'::text, 5;
      return;
    end if;

    v_credit_reason := coalesce(
      v_credit_reason,
      'The hosted payer already had an active workflow when settlement completed.'
    );
  end if;

  if v_credit_reason is not null then
    insert into public.hosted_workflow_user_payments (
      quote_id, requester_wallet, payment_mode, status, gross_amount_usdc,
      estimated_provider_cost_usdc, provider_cost_usdc, platform_fee_usdc,
      net_revenue_usdc, credit_amount_usdc, chain_id, asset, treasury_address,
      transaction_hash, block_number, settled_at, credited_at, failure_reason
    ) values (
      v_quote.id, v_quote.requester_wallet, 'paid', 'credit_issued', v_quote.amount_due_usdc,
      v_quote.estimated_provider_cost_usdc, 0, v_quote.platform_fee_usdc,
      0, v_quote.amount_due_usdc, v_quote.chain_id, v_quote.asset, v_quote.treasury_address,
      p_transaction_hash, p_block_number, p_settled_at, now(),
      v_credit_reason
    ) returning id into v_payment_id;

    insert into public.hosted_workflow_credits (user_payment_id, requester_wallet, amount_usdc, reason)
    values (v_payment_id, v_quote.requester_wallet, v_quote.amount_due_usdc,
      v_credit_reason)
    returning id into v_credit_id;

    update public.hosted_workflow_quotes
    set status = 'credited', user_payment_id = v_payment_id, consumed_at = now()
    where id = v_quote.id;

    return query select null::uuid, v_payment_id, false, 'credit_issued'::text, 0;
    return;
  end if;

  insert into public.hosted_workflow_user_payments (
    quote_id, requester_wallet, payment_mode, status, gross_amount_usdc,
    estimated_provider_cost_usdc, provider_cost_usdc, platform_fee_usdc,
    net_revenue_usdc, credit_amount_usdc, chain_id, asset, treasury_address,
    transaction_hash, block_number, settled_at
  ) values (
    v_quote.id,
    v_quote.requester_wallet,
    p_payment_mode,
    case when p_payment_mode = 'sponsored' then 'sponsored' else 'settled' end,
    case when p_payment_mode = 'sponsored' then 0 else v_quote.amount_due_usdc end,
    v_quote.estimated_provider_cost_usdc,
    0,
    case when p_payment_mode = 'sponsored' then 0 else v_quote.platform_fee_usdc end,
    0,
    0,
    v_quote.chain_id,
    v_quote.asset,
    v_quote.treasury_address,
    p_transaction_hash,
    p_block_number,
    case when p_payment_mode = 'sponsored' then now() else p_settled_at end
  ) returning id into v_payment_id;

  insert into public.hosted_agent_jobs (
    idempotency_hash, request_hash, requester_fingerprint, requester_wallet,
    workflow_type, task, input_text, input_preview, input_hash, budget_usdc,
    planner_snapshot, selected_services, status, progress_stage,
    workflow_quote_id, user_payment_id, payment_mode, raw
  ) values (
    v_quote.idempotency_hash, v_quote.request_hash, v_quote.requester_fingerprint,
    v_quote.requester_wallet, v_quote.workflow_type, v_quote.task, null,
    v_quote.input_preview, v_quote.input_hash, v_quote.budget_usdc,
    v_quote.planner_snapshot, v_quote.selected_services, 'queued', 'queued',
    v_quote.id, v_payment_id, p_payment_mode,
    jsonb_build_object('checkoutQuoteId', v_quote.id, 'userPaymentId', v_payment_id)
  ) returning id into v_job_id;

  update public.hosted_workflow_user_payments set job_id = v_job_id where id = v_payment_id;
  update public.hosted_workflow_quotes
  set status = 'consumed', job_id = v_job_id, user_payment_id = v_payment_id, consumed_at = now()
  where id = v_quote.id;

  return query select v_job_id, v_payment_id, true, 'created'::text, 0;
end;
$$;

create or replace function public.finalize_hosted_workflow_user_payment_v1(
  p_job_id uuid,
  p_provider_cost_usdc numeric,
  p_succeeded boolean,
  p_failure_reason text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment public.hosted_workflow_user_payments%rowtype;
  v_credit numeric(20, 6);
begin
  select p.* into v_payment
  from public.hosted_workflow_user_payments p
  where p.job_id = p_job_id
  for update;

  if v_payment.id is null then
    return false;
  end if;

  -- Completion/credit is terminal. A background retry must never move settled
  -- accounting or issue a second credit for the same user payment.
  if v_payment.completed_at is not null then
    return true;
  end if;

  if p_succeeded then
    update public.hosted_workflow_user_payments
    set provider_cost_usdc = greatest(0, p_provider_cost_usdc),
        net_revenue_usdc = gross_amount_usdc - greatest(0, p_provider_cost_usdc),
        completed_at = now(),
        failure_reason = null
    where id = v_payment.id;
    update public.hosted_workflow_quotes set status = 'completed' where id = v_payment.quote_id;
    return true;
  end if;

  v_credit := case when v_payment.payment_mode = 'paid' then v_payment.gross_amount_usdc else 0 end;

  update public.hosted_workflow_user_payments
  set provider_cost_usdc = greatest(0, p_provider_cost_usdc),
      credit_amount_usdc = v_credit,
      net_revenue_usdc = gross_amount_usdc - greatest(0, p_provider_cost_usdc) - v_credit,
      status = case when v_credit > 0 then 'credit_issued' else status end,
      credited_at = case when v_credit > 0 then now() else credited_at end,
      completed_at = now(),
      failure_reason = left(coalesce(p_failure_reason, 'Hosted workflow failed.'), 800)
  where id = v_payment.id;

  if v_credit > 0 then
    insert into public.hosted_workflow_credits (user_payment_id, requester_wallet, amount_usdc, reason)
    values (v_payment.id, v_payment.requester_wallet, v_credit,
      left(coalesce(p_failure_reason, 'Hosted workflow failed after user settlement.'), 800))
    on conflict (user_payment_id) do nothing;
    update public.hosted_workflow_quotes set status = 'credited' where id = v_payment.quote_id;
  else
    update public.hosted_workflow_quotes set status = 'failed' where id = v_payment.quote_id;
  end if;

  return true;
end;
$$;

revoke all on function public.launch_hosted_workflow_checkout_v1(uuid, text, text, text, text, bigint, timestamptz, integer) from public, anon, authenticated;
revoke all on function public.finalize_hosted_workflow_user_payment_v1(uuid, numeric, boolean, text) from public, anon, authenticated;
grant execute on function public.launch_hosted_workflow_checkout_v1(uuid, text, text, text, text, bigint, timestamptz, integer) to service_role;
grant execute on function public.finalize_hosted_workflow_user_payment_v1(uuid, numeric, boolean, text) to service_role;

do $$
begin
  alter publication supabase_realtime add table public.hosted_workflow_quotes;
exception when duplicate_object then null; when undefined_object then null;
end;
$$;

do $$
begin
  alter publication supabase_realtime add table public.hosted_workflow_user_payments;
exception when duplicate_object then null; when undefined_object then null;
end;
$$;

comment on table public.hosted_workflow_quotes is
  'Immutable server-priced checkout quotes. Full workflow input is never persisted.';
comment on table public.hosted_workflow_user_payments is
  'User-facing hosted workflow settlements, separate from downstream x402 payment_events.';
comment on table public.hosted_workflow_credits is
  'Recoverable credits issued when a paid hosted workflow cannot start or complete.';
