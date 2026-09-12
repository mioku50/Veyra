-- Copyright 2026 Veyra
-- SPDX-License-Identifier: Apache-2.0

alter table public.hosted_agent_jobs
  add column if not exists machine_credential_id text;

create index if not exists hosted_agent_jobs_machine_credential_idx
  on public.hosted_agent_jobs (machine_credential_id)
  where machine_credential_id is not null;

alter table public.hosted_workflow_quotes
  add column if not exists machine_credential_id text;

create index if not exists hosted_workflow_quotes_machine_credential_idx
  on public.hosted_workflow_quotes (machine_credential_id)
  where machine_credential_id is not null;

