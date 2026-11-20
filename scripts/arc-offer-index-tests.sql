-- Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0
-- Run against a disposable database after applying 20261120110000.
BEGIN;
DO $$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.arc_offer_checks'::regclass)
    OR has_table_privilege('anon', 'public.arc_offer_index', 'SELECT')
    OR has_table_privilege('authenticated', 'public.arc_offer_checks', 'SELECT')
    OR has_function_privilege('anon', 'public.claim_arc_offer_checks()', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.save_arc_offer_check(text,timestamptz,jsonb)', 'EXECUTE')
  THEN RAISE EXCEPTION 'Index access is not server-only'; END IF;
END;
$$;

SET LOCAL ROLE service_role;
INSERT INTO public.arc_offer_index(resource_key, resource, hostname, method, sources, listed_amount, listed_payee, listed_rail, listed_at)
SELECT lpad(i::text, 64, '0'), 'https://sample.example/' || i, 'sample.example', 'GET',
       ARRAY['circle'], '12000', '0x' || repeat('1', 40), 'wallet', now()
FROM generate_series(1, 26) i;
INSERT INTO public.arc_offer_index(resource_key, resource, hostname, method, sources, listed_amount, listed_payee, listed_rail, listed_at)
VALUES (repeat('a', 64), 'https://other.example/', 'other.example', 'POST', ARRAY['bazaar'], '100',
        '0x' || repeat('2', 40), 'wallet', now()),
       (repeat('b', 64), 'https://stale.example/', 'stale.example', 'POST', ARRAY['bazaar'], '100',
        '0x' || repeat('2', 40), 'wallet', now() - interval '8 days');

DO $$
DECLARE
  first_batch integer;
  second_batch integer;
  lease timestamptz;
  entry jsonb := jsonb_build_object('checked_at', now(), 'http_status', 402, 'error_category', 'none',
    'arc_challenge', true, 'live_amount', '13000', 'live_payee', '0x' || repeat('2', 40), 'live_rail', 'wallet',
    'listed_amount', '100', 'listed_payee', '0x' || repeat('2', 40), 'drift', ARRAY['price_changed'],
    'failed_checks', ARRAY['accepts_matches_catalog']);
BEGIN
  SELECT count(*) INTO first_batch FROM public.claim_arc_offer_checks();
  SELECT count(*) INTO second_batch FROM public.claim_arc_offer_checks();
  IF first_batch <> 25 OR second_batch <> 2 OR EXISTS (
    SELECT 1 FROM public.arc_offer_index WHERE resource_key = repeat('b', 64) AND lease_until IS NOT NULL
  ) THEN RAISE EXCEPTION 'Lease distribution or stale-listing filter failed'; END IF;
  SELECT lease_until INTO lease FROM public.arc_offer_index WHERE resource_key = repeat('a', 64);
  IF public.save_arc_offer_check(repeat('a', 64), lease - interval '1 minute', entry)
    OR NOT public.save_arc_offer_check(repeat('a', 64), lease, entry)
    OR public.save_arc_offer_check(repeat('a', 64), lease, entry)
  THEN RAISE EXCEPTION 'Lease validation or replay protection failed'; END IF;

  IF NOT EXISTS (SELECT 1 FROM public.arc_offer_checks WHERE resource_key = repeat('a', 64) AND live_amount = '13000')
    OR NOT EXISTS (SELECT 1 FROM public.arc_offer_index WHERE resource_key = repeat('a', 64)
      AND lease_until IS NULL AND last_checked_at = now())
    OR EXISTS (SELECT 1 FROM public.claim_arc_offer_checks())
  THEN RAISE EXCEPTION 'Checked row or recheck timing is incorrect'; END IF;

  SELECT lease_until INTO lease FROM public.arc_offer_index WHERE resource_key = lpad('1', 64, '0');
  UPDATE public.arc_offer_index SET listed_amount = '14000' WHERE resource_key = lpad('1', 64, '0');
  IF public.save_arc_offer_check(lpad('1', 64, '0'), lease, entry)
    OR NOT EXISTS (SELECT 1 FROM public.claim_arc_offer_checks() WHERE resource_key = lpad('1', 64, '0') AND listed_amount = '14000')
  THEN RAISE EXCEPTION 'Changed terms did not invalidate the old lease'; END IF;
END;
$$;
ROLLBACK;
