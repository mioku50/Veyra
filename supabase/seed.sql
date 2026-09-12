-- Copyright 2026 Veyra
-- SPDX-License-Identifier: Apache-2.0

-- Static API Store services live in lib/services/registry.ts. This idempotent
-- seller-created service ensures a fresh database also exercises the dynamic
-- service persistence and seller analytics paths.
insert into public.store_services (
  id,
  name,
  slug,
  short_description,
  long_description,
  category,
  method,
  price_usdc,
  status,
  source_type,
  input_schema,
  output_schema,
  example_request,
  example_response,
  example_use_case,
  agent_reasoning_hint,
  raw
)
values (
  '17100000-0000-4000-8000-000000000001'::uuid,
  'Agent DB Demo Summarizer',
  'agent-db-demo-summarizer',
  'A seeded seller-created service for database and analytics verification.',
  'This deterministic mock service proves that a fresh Veyra database exposes dynamic services through public RLS and seller analytics without proxying an external API.',
  'Compute',
  'POST',
  0.0005,
  'live',
  'seller_mock',
  '{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}'::jsonb,
  '{"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"]}'::jsonb,
  '{"text":"Summarize the Veyra migration."}'::jsonb,
  '{"summary":"Veyra uses the new AGENT_DB Supabase provider."}'::jsonb,
  'Validate dynamic service discovery and seller analytics on a fresh database.',
  'Use for a low-cost database-backed mock service during reviewer validation.',
  '{"seed":"agent-db-v1"}'::jsonb
)
on conflict (slug) do update set
  name = excluded.name,
  short_description = excluded.short_description,
  long_description = excluded.long_description,
  category = excluded.category,
  method = excluded.method,
  price_usdc = excluded.price_usdc,
  status = excluded.status,
  source_type = excluded.source_type,
  input_schema = excluded.input_schema,
  output_schema = excluded.output_schema,
  example_request = excluded.example_request,
  example_response = excluded.example_response,
  example_use_case = excluded.example_use_case,
  agent_reasoning_hint = excluded.agent_reasoning_hint,
  raw = excluded.raw,
  updated_at = now();
