-- Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0
-- Run against a disposable database after applying 20261120110000 and 20261124150000.
BEGIN;
DO $$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.arc_state_snapshots'::regclass)
    OR has_table_privilege('anon', 'public.arc_state_snapshots', 'SELECT')
    OR has_table_privilege('anon', 'public.arc_state_snapshots', 'INSERT')
    OR has_table_privilege('authenticated', 'public.arc_state_snapshots', 'SELECT')
    OR has_table_privilege('authenticated', 'public.arc_state_snapshots', 'UPDATE')
  THEN RAISE EXCEPTION 'Snapshot table access is not server-only'; END IF;
END;
$$;

SET LOCAL ROLE service_role;
INSERT INTO public.arc_offer_index(resource_key, resource, hostname, method, sources, listed_amount, listed_payee, listed_rail, listed_at)
VALUES (repeat('c', 64), 'https://latency.example/paid', 'latency.example', 'GET', ARRAY['circle'], '100000',
        '0x' || repeat('3', 40), 'wallet', now());

DO $$
DECLARE
  lease timestamptz;
  entry_ok jsonb := jsonb_build_object(
    'checked_at', now(),
    'http_status', 402,
    'error_category', 'none',
    'arc_challenge', true,
    'live_amount', '100000',
    'live_payee', '0x' || repeat('3', 40),
    'live_rail', 'wallet',
    'listed_amount', '100000',
    'listed_payee', '0x' || repeat('3', 40),
    'drift', ARRAY[]::text[],
    'failed_checks', ARRAY[]::text[],
    'latency_ms', 142
  );
  bad_latency jsonb := jsonb_build_object(
    'checked_at', now() + interval '1 second',
    'http_status', 402,
    'error_category', 'none',
    'arc_challenge', true,
    'live_amount', '100000',
    'live_payee', '0x' || repeat('3', 40),
    'live_rail', 'wallet',
    'listed_amount', '100000',
    'listed_payee', '0x' || repeat('3', 40),
    'drift', ARRAY[]::text[],
    'failed_checks', ARRAY[]::text[],
    'latency_ms', -1
  );
  failed boolean := false;
BEGIN
  PERFORM public.claim_arc_offer_checks();
  SELECT lease_until INTO lease FROM public.arc_offer_index WHERE resource_key = repeat('c', 64);
  IF NOT public.save_arc_offer_check(repeat('c', 64), lease, entry_ok) THEN
    RAISE EXCEPTION 'save_arc_offer_check did not persist check with latency_ms';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.arc_offer_checks WHERE resource_key = repeat('c', 64) AND latency_ms = 142
  ) THEN
    RAISE EXCEPTION 'latency_ms was not saved on arc_offer_checks';
  END IF;

  UPDATE public.arc_offer_index
     SET last_checked_at = NULL, lease_until = now() + interval '5 minutes'
   WHERE resource_key = repeat('c', 64)
  RETURNING lease_until INTO lease;

  BEGIN
    PERFORM public.save_arc_offer_check(repeat('c', 64), lease, bad_latency);
  EXCEPTION WHEN check_violation THEN
    failed := true;
  END;
  IF NOT failed THEN
    RAISE EXCEPTION 'Negative latency_ms must fail CHECK constraint';
  END IF;

  INSERT INTO public.arc_state_snapshots(
    snapshot_month, snapshot_at, window_days, listings, distinct_hosts, checks_in_window, payload
  ) VALUES (
    DATE '2026-11-01', now(), 30, 1, 1, 1, jsonb_build_object('listings', 1)
  );

  failed := false;
  BEGIN
    INSERT INTO public.arc_state_snapshots(
      snapshot_month, snapshot_at, window_days, listings, distinct_hosts, checks_in_window, payload
    ) VALUES (
      DATE '2026-11-15', now(), 30, 1, 1, 1, jsonb_build_object('listings', 1)
    );
  EXCEPTION WHEN check_violation THEN
    failed := true;
  END;
  IF NOT failed THEN
    RAISE EXCEPTION 'Non-first-of-month snapshot_month must fail CHECK constraint';
  END IF;
END;
$$;
ROLLBACK;
