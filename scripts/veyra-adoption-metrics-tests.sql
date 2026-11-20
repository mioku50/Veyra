-- Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0
-- Run against a disposable database after applying 20261120090200 only.
BEGIN;

DO $$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.veyra_adoption_callers'::regclass)
    OR has_table_privilege('anon', 'public.veyra_adoption_callers', 'SELECT')
    OR has_table_privilege('authenticated', 'public.veyra_adoption_weekly', 'SELECT')
    OR has_function_privilege('anon',
      'public.record_veyra_adoption_event(text,date,text,timestamptz)', 'EXECUTE')
    OR has_function_privilege('authenticated',
      'public.record_veyra_adoption_event(text,date,text,timestamptz)', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'Metrics are not restricted to the server role';
  END IF;
END;
$$;

SET LOCAL ROLE service_role;

SELECT public.record_veyra_adoption_event('paid_history', '2026-11-16', repeat('a', 64), '2026-11-16 10:20:00Z');
SELECT public.record_veyra_adoption_event('rest_verdict', '2026-11-16', repeat('a', 64), '2026-11-16 10:11:00Z');
SELECT public.record_veyra_adoption_event('mcp_verdict', '2026-11-16', repeat('a', 64), '2026-11-16 10:06:00Z');
SELECT public.record_veyra_adoption_event('rest_verdict', '2026-11-16', repeat('a', 64), '2026-11-16 10:05:00Z');
SELECT public.record_veyra_adoption_event('paid_history', '2026-11-16', repeat('a', 64), '2026-11-16 09:59:00Z');
SELECT public.record_veyra_adoption_event('mcp_verdict', '2026-11-16', repeat('b', 64), '2026-11-16 12:00:00Z');
SELECT public.record_veyra_adoption_event('paid_history', '2026-11-16', repeat('b', 64), '2026-11-16 11:00:00Z');
SELECT public.record_veyra_adoption_event('paid_history', '2026-11-16', repeat('c', 64), '2026-11-16 10:00:00Z');
SELECT public.record_veyra_adoption_event('rest_verdict', '2026-11-16', repeat('d', 64), '2026-11-16 10:00:00Z');
SELECT public.record_veyra_adoption_event('paid_history', '2026-11-23', repeat('d', 64), '2026-11-23 10:00:00Z');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.veyra_adoption_weekly
    WHERE week = '2026-11-16'
      AND rest_verdict_callers = 2 AND mcp_verdict_callers = 2 AND verdict_callers = 3
      AND paid_history_callers = 3 AND verdict_to_paid_history_callers = 1
  ) OR NOT EXISTS (
    SELECT 1 FROM public.veyra_adoption_weekly
    WHERE week = '2026-11-23'
      AND verdict_callers = 0 AND paid_history_callers = 1 AND verdict_to_paid_history_callers = 0
  ) OR NOT EXISTS (
    SELECT 1 FROM public.veyra_adoption_callers
    WHERE week = '2026-11-16' AND caller = repeat('a', 64)
      AND first_rest_verdict_at = '2026-11-16 10:05:00Z'
      AND last_paid_history_at = '2026-11-16 10:20:00Z'
  ) THEN
    RAISE EXCEPTION 'Incorrect weekly adoption aggregates';
  END IF;

  BEGIN
    PERFORM public.record_veyra_adoption_event('tools_list', '2026-11-16',
      repeat('a', 64), '2026-11-16 10:20:00Z');
    RAISE EXCEPTION 'Unexpected metric kind accepted';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;

  BEGIN
    PERFORM public.record_veyra_adoption_event('rest_verdict', '2026-11-16',
      repeat('a', 64), '2026-11-23 00:00:00Z');
    RAISE EXCEPTION 'Unexpected UTC week accepted';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;
END;
$$;

ROLLBACK;
