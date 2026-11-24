-- Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0
-- Store per-check response latency on arc_offer_checks and monthly
-- reproducible "State of Arc x402" market snapshots for /state and /state.json.

ALTER TABLE public.arc_offer_checks
  ADD COLUMN IF NOT EXISTS latency_ms INTEGER CHECK (latency_ms >= 0);

CREATE TABLE public.arc_state_snapshots (
  snapshot_month DATE PRIMARY KEY CHECK (EXTRACT(DAY FROM snapshot_month) = 1),
  snapshot_at TIMESTAMPTZ NOT NULL,
  window_days INTEGER NOT NULL CHECK (window_days > 0 AND window_days <= 90),
  listings INTEGER NOT NULL CHECK (listings >= 0),
  distinct_hosts INTEGER NOT NULL CHECK (distinct_hosts >= 0),
  checks_in_window INTEGER NOT NULL CHECK (checks_in_window >= 0),
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.arc_state_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.arc_state_snapshots FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.arc_state_snapshots TO service_role;
