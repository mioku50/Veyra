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

-- Onchain proof metadata for settled x402 payment receipts.
-- The proof registry is non-custodial and does not replace Circle Gateway.

alter table public.payment_events
  add column if not exists receipt_hash text,
  add column if not exists service_hash text,
  add column if not exists request_hash text,
  add column if not exists response_hash text,
  add column if not exists onchain_contract_address text,
  add column if not exists onchain_chain_id bigint,
  add column if not exists onchain_tx_hash text,
  add column if not exists onchain_status text;

alter table public.payment_events
  drop constraint if exists payment_events_onchain_status_check;

alter table public.payment_events
  add constraint payment_events_onchain_status_check
  check (onchain_status is null or onchain_status in ('pending', 'verified', 'failed'));

create unique index if not exists payment_events_receipt_hash_idx
  on public.payment_events (receipt_hash)
  where receipt_hash is not null;

create index if not exists payment_events_onchain_status_idx
  on public.payment_events (onchain_status, created_at desc);
