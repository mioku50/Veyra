-- Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0
-- Reproducible query for every metric published on /state and /state.json.
-- Observed by Veyra (single unpaid HTTP requests; post-payment delivery is not tested).
--
-- Live calculation:
--   psql "$DATABASE_URL" -f docs/state-of-arc-x402.sql
--
-- Exact historical reproduction for a saved snapshot timestamp:
--   psql "$DATABASE_URL" -c "SET veyra.snapshot_at = '2026-11-24T12:00:00.000Z';" -f docs/state-of-arc-x402.sql

WITH
params AS (
  SELECT
    COALESCE(NULLIF(current_setting('veyra.snapshot_at', true), '')::timestamptz, now()) AS snapshot_at
),
windows AS (
  SELECT
    snapshot_at,
    date_trunc('month', snapshot_at AT TIME ZONE 'UTC')::date AS snapshot_month,
    snapshot_at - interval '7 days' AS listings_cutoff,
    snapshot_at - interval '30 days' AS checks_cutoff
  FROM params
),
active_listings AS (
  SELECT
    l.resource_key,
    l.hostname,
    l.method,
    l.sources,
    l.listed_amount,
    l.listed_amount::numeric AS amount_atomic
  FROM public.arc_offer_index l
  CROSS JOIN windows w
  WHERE l.listed_at >= w.listings_cutoff
    AND l.listed_at <= w.snapshot_at
),
checks_window AS (
  SELECT
    c.resource_key,
    c.checked_at,
    c.http_status,
    c.arc_challenge,
    c.live_amount,
    c.live_payee,
    c.drift,
    c.latency_ms
  FROM public.arc_offer_checks c
  CROSS JOIN windows w
  WHERE c.checked_at >= w.checks_cutoff
    AND c.checked_at <= w.snapshot_at
),
listing_totals AS (
  SELECT
    COUNT(*)::integer AS listings,
    COUNT(DISTINCT hostname) FILTER (WHERE hostname <> '')::integer AS distinct_hosts,
    COUNT(*) FILTER (WHERE method = 'GET')::integer AS get_count,
    COUNT(*) FILTER (WHERE method = 'POST')::integer AS post_count,
    COUNT(*) FILTER (WHERE listed_amount = '100000')::integer AS exact_ten_cents_count,
    COUNT(*) FILTER (WHERE amount_atomic = 0)::integer AS bucket_zero,
    COUNT(*) FILTER (WHERE amount_atomic > 0 AND amount_atomic < 10000)::integer AS bucket_under_0_01,
    COUNT(*) FILTER (WHERE amount_atomic >= 10000 AND amount_atomic < 100000)::integer AS bucket_0_01_to_under_0_10,
    COUNT(*) FILTER (WHERE amount_atomic = 100000)::integer AS bucket_exact_0_10,
    COUNT(*) FILTER (WHERE amount_atomic > 100000 AND amount_atomic <= 1000000)::integer AS bucket_over_0_10_to_1_00,
    COUNT(*) FILTER (WHERE amount_atomic > 1000000)::integer AS bucket_over_1_00,
    COUNT(*) FILTER (WHERE 'circle' = ANY(sources))::integer AS source_circle,
    COUNT(*) FILTER (WHERE 'bazaar' = ANY(sources))::integer AS source_bazaar,
    COUNT(*) FILTER (WHERE 'erc8004' = ANY(sources))::integer AS source_erc8004,
    COUNT(*) FILTER (WHERE cardinality(sources) > 1)::integer AS multi_source_count
  FROM active_listings
),
host_counts AS (
  SELECT
    hostname,
    COUNT(*)::integer AS listings,
    ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC, hostname ASC) AS rn
  FROM active_listings
  WHERE hostname <> ''
  GROUP BY hostname
),
top_hosts AS (
  SELECT
    hostname,
    listings,
    rn
  FROM host_counts
  WHERE rn <= 5
  ORDER BY rn ASC
),
check_totals AS (
  SELECT
    COUNT(*)::integer AS checks_in_window,
    COUNT(DISTINCT resource_key)::integer AS distinct_checked_endpoints,
    COUNT(*) FILTER (WHERE http_status IS NOT NULL)::integer AS reachable_count,
    COUNT(*) FILTER (WHERE http_status = 402)::integer AS http_402_count,
    COUNT(*) FILTER (WHERE arc_challenge IS TRUE)::integer AS arc_challenge_count,
    COUNT(*) FILTER (WHERE cardinality(drift) > 0)::integer AS drift_any_count,
    COUNT(*) FILTER (WHERE 'payto_changed' = ANY(drift))::integer AS drift_payto_count,
    COUNT(*) FILTER (WHERE 'price_changed' = ANY(drift))::integer AS drift_price_count,
    COUNT(*) FILTER (WHERE 'rail_changed' = ANY(drift))::integer AS drift_rail_count
  FROM checks_window
),
rates AS (
  SELECT
    ROUND(ct.reachable_count::numeric / NULLIF(ct.checks_in_window, 0), 4) AS reachable_rate,
    ROUND(ct.http_402_count::numeric / NULLIF(ct.checks_in_window, 0), 4) AS http_402_rate,
    ROUND(ct.arc_challenge_count::numeric / NULLIF(ct.checks_in_window, 0), 4) AS arc_challenge_rate,
    ROUND(ct.drift_any_count::numeric / NULLIF(ct.checks_in_window, 0), 4) AS drift_any_rate,
    ROUND(ct.drift_payto_count::numeric / NULLIF(ct.checks_in_window, 0), 4) AS drift_payto_rate,
    ROUND(ct.drift_price_count::numeric / NULLIF(ct.checks_in_window, 0), 4) AS drift_price_rate,
    ROUND(ct.drift_rail_count::numeric / NULLIF(ct.checks_in_window, 0), 4) AS drift_rail_rate
  FROM check_totals ct
),
endpoint_check_counts AS (
  SELECT resource_key
  FROM checks_window
  GROUP BY resource_key
  HAVING COUNT(*) >= 2
),
payee_transitions AS (
  SELECT
    resource_key,
    checked_at,
    lower(live_payee) AS current_payee,
    LAG(lower(live_payee)) OVER (PARTITION BY resource_key ORDER BY checked_at ASC) AS previous_payee
  FROM checks_window
  WHERE live_payee IS NOT NULL AND live_payee <> ''
),
payee_changes AS (
  SELECT resource_key, checked_at
  FROM payee_transitions
  WHERE previous_payee IS NOT NULL AND current_payee <> previous_payee
),
price_transitions AS (
  SELECT
    resource_key,
    checked_at,
    live_amount AS current_amount,
    LAG(live_amount) OVER (PARTITION BY resource_key ORDER BY checked_at ASC) AS previous_amount
  FROM checks_window
  WHERE live_amount IS NOT NULL AND live_amount <> '0'
),
price_changes AS (
  SELECT resource_key, checked_at
  FROM price_transitions
  WHERE previous_amount IS NOT NULL AND current_amount <> previous_amount
),
prior_snapshot AS (
  SELECT
    s.snapshot_month,
    s.snapshot_at,
    s.payload
  FROM public.arc_state_snapshots s
  CROSS JOIN windows w
  WHERE s.snapshot_month < w.snapshot_month
  ORDER BY s.snapshot_month DESC
  LIMIT 1
),
check_latency AS (
  SELECT
    COUNT(*)::integer AS sample_size,
    ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms))::numeric, 1) AS median_ms
  FROM checks_window
  WHERE latency_ms IS NOT NULL AND latency_ms >= 0
),
fallback_latency AS (
  SELECT
    COUNT(*)::integer AS sample_size,
    ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY o.latency_ms))::numeric, 1) AS median_ms
  FROM public.x402_endpoint_observations o
  CROSS JOIN windows w
  WHERE o.network = 'eip155:5042'
    AND o.latency_ms IS NOT NULL
    AND o.latency_ms >= 0
    AND o.probed_at >= w.checks_cutoff
    AND o.probed_at <= w.snapshot_at
)
SELECT jsonb_build_object(
  'schemaVersion', 1,
  'snapshotMonth', to_char(w.snapshot_month, 'YYYY-MM-DD'),
  'snapshotAt', to_char(w.snapshot_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'windows', jsonb_build_object('listingsDays', 7, 'checksDays', 30),
  'overview', jsonb_build_object(
    'listings', lt.listings,
    'distinctHosts', lt.distinct_hosts,
    'checksInWindow', ct.checks_in_window,
    'distinctCheckedEndpoints', ct.distinct_checked_endpoints
  ),
  'liveness', jsonb_build_object(
    'reachableCount', ct.reachable_count,
    'reachableRate', r.reachable_rate,
    'http402Count', ct.http_402_count,
    'http402Rate', r.http_402_rate,
    'arcChallengeCount', ct.arc_challenge_count,
    'arcChallengeRate', r.arc_challenge_rate
  ),
  'drift', jsonb_build_object(
    'anyCount', ct.drift_any_count,
    'anyRate', r.drift_any_rate,
    'paytoChangedCount', ct.drift_payto_count,
    'paytoChangedRate', r.drift_payto_rate,
    'priceChangedCount', ct.drift_price_count,
    'priceChangedRate', r.drift_price_rate,
    'railChangedCount', ct.drift_rail_count,
    'railChangedRate', r.drift_rail_rate
  ),
  'changes', jsonb_build_object(
    'withinWindow', jsonb_build_object(
      'endpointsWithMultipleChecks', (SELECT COUNT(*)::integer FROM endpoint_check_counts),
      'payeeChangeEvents', (SELECT COUNT(*)::integer FROM payee_changes),
      'endpointsWithPayeeChange', (SELECT COUNT(DISTINCT resource_key)::integer FROM payee_changes),
      'priceChangeEvents', (SELECT COUNT(*)::integer FROM price_changes),
      'endpointsWithPriceChange', (SELECT COUNT(DISTINCT resource_key)::integer FROM price_changes)
    ),
    'sincePriorSnapshot', (
      SELECT jsonb_build_object(
        'priorSnapshotMonth', to_char(p.snapshot_month, 'YYYY-MM-DD'),
        'priorSnapshotAt', to_char(p.snapshot_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'listingsDelta', lt.listings - COALESCE((p.payload -> 'overview' ->> 'listings')::integer, 0),
        'distinctHostsDelta', lt.distinct_hosts - COALESCE((p.payload -> 'overview' ->> 'distinctHosts')::integer, 0),
        'checksInWindowDelta', ct.checks_in_window - COALESCE((p.payload -> 'overview' ->> 'checksInWindow')::integer, 0),
        'arcChallengeRateDelta', CASE
          WHEN r.arc_challenge_rate IS NULL OR (p.payload -> 'liveness' ->> 'arcChallengeRate') IS NULL THEN NULL
          ELSE ROUND((r.arc_challenge_rate - (p.payload -> 'liveness' ->> 'arcChallengeRate')::numeric), 4)
        END,
        'driftAnyRateDelta', CASE
          WHEN r.drift_any_rate IS NULL OR (p.payload -> 'drift' ->> 'anyRate') IS NULL THEN NULL
          ELSE ROUND((r.drift_any_rate - (p.payload -> 'drift' ->> 'anyRate')::numeric), 4)
        END,
        'payeeChangeEventsSincePrior', (SELECT COUNT(*)::integer FROM payee_changes pc WHERE pc.checked_at > p.snapshot_at),
        'priceChangeEventsSincePrior', (SELECT COUNT(*)::integer FROM price_changes prc WHERE prc.checked_at > p.snapshot_at),
        'paytoDriftChecksSincePrior', (SELECT COUNT(*)::integer FROM checks_window cw WHERE cw.checked_at > p.snapshot_at AND 'payto_changed' = ANY(cw.drift)),
        'priceDriftChecksSincePrior', (SELECT COUNT(*)::integer FROM checks_window cw WHERE cw.checked_at > p.snapshot_at AND 'price_changed' = ANY(cw.drift))
      )
      FROM prior_snapshot p
    )
  ),
  'concentration', jsonb_build_object(
    'top1Host', (SELECT hostname FROM top_hosts WHERE rn = 1),
    'top1Share', ROUND(COALESCE((SELECT listings FROM top_hosts WHERE rn = 1), 0)::numeric / NULLIF(lt.listings, 0), 4),
    'top5Share', ROUND(COALESCE((SELECT SUM(listings) FROM top_hosts), 0)::numeric / NULLIF(lt.listings, 0), 4),
    'top5Hosts', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'hostname', th.hostname,
          'listings', th.listings,
          'share', ROUND(th.listings::numeric / NULLIF(lt.listings, 0), 4)
        )
        ORDER BY th.rn ASC
      )
      FROM top_hosts th
    ), '[]'::jsonb)
  ),
  'methods', jsonb_build_object(
    'GET', jsonb_build_object(
      'count', lt.get_count,
      'share', ROUND(lt.get_count::numeric / NULLIF(lt.listings, 0), 4)
    ),
    'POST', jsonb_build_object(
      'count', lt.post_count,
      'share', ROUND(lt.post_count::numeric / NULLIF(lt.listings, 0), 4)
    )
  ),
  'pricing', jsonb_build_object(
    'exactTenCentsCount', lt.exact_ten_cents_count,
    'exactTenCentsShare', ROUND(lt.exact_ten_cents_count::numeric / NULLIF(lt.listings, 0), 4),
    'buckets', jsonb_build_array(
      jsonb_build_object(
        'id', 'zero_or_dynamic',
        'label', '0 USDC (dynamic / per-request)',
        'count', lt.bucket_zero,
        'share', ROUND(lt.bucket_zero::numeric / NULLIF(lt.listings, 0), 4)
      ),
      jsonb_build_object(
        'id', 'under_0_01',
        'label', 'Under $0.01 USDC',
        'count', lt.bucket_under_0_01,
        'share', ROUND(lt.bucket_under_0_01::numeric / NULLIF(lt.listings, 0), 4)
      ),
      jsonb_build_object(
        'id', '0_01_to_under_0_10',
        'label', '$0.01 to <$0.10 USDC',
        'count', lt.bucket_0_01_to_under_0_10,
        'share', ROUND(lt.bucket_0_01_to_under_0_10::numeric / NULLIF(lt.listings, 0), 4)
      ),
      jsonb_build_object(
        'id', 'exact_0_10',
        'label', 'Exactly $0.10 USDC',
        'count', lt.bucket_exact_0_10,
        'share', ROUND(lt.bucket_exact_0_10::numeric / NULLIF(lt.listings, 0), 4)
      ),
      jsonb_build_object(
        'id', 'over_0_10_to_1_00',
        'label', '>$0.10 to $1.00 USDC',
        'count', lt.bucket_over_0_10_to_1_00,
        'share', ROUND(lt.bucket_over_0_10_to_1_00::numeric / NULLIF(lt.listings, 0), 4)
      ),
      jsonb_build_object(
        'id', 'over_1_00',
        'label', 'Over $1.00 USDC',
        'count', lt.bucket_over_1_00,
        'share', ROUND(lt.bucket_over_1_00::numeric / NULLIF(lt.listings, 0), 4)
      )
    )
  ),
  'sources', jsonb_build_object(
    'circle', jsonb_build_object(
      'count', lt.source_circle,
      'share', ROUND(lt.source_circle::numeric / NULLIF(lt.listings, 0), 4)
    ),
    'bazaar', jsonb_build_object(
      'count', lt.source_bazaar,
      'share', ROUND(lt.source_bazaar::numeric / NULLIF(lt.listings, 0), 4)
    ),
    'erc8004', jsonb_build_object(
      'count', lt.source_erc8004,
      'share', ROUND(lt.source_erc8004::numeric / NULLIF(lt.listings, 0), 4)
    ),
    'multiSourceCount', lt.multi_source_count
  ),
  'latency', jsonb_build_object(
    'medianMs', CASE
      WHEN cl.sample_size > 0 THEN cl.median_ms
      WHEN fl.sample_size > 0 THEN fl.median_ms
      ELSE NULL
    END,
    'sampleSize', CASE
      WHEN cl.sample_size > 0 THEN cl.sample_size
      ELSE fl.sample_size
    END,
    'source', CASE
      WHEN cl.sample_size > 0 THEN 'arc_offer_checks'
      WHEN fl.sample_size > 0 THEN 'x402_endpoint_observations'
      ELSE 'none'
    END
  )
) AS state_of_arc_x402
FROM windows w
CROSS JOIN listing_totals lt
CROSS JOIN check_totals ct
CROSS JOIN rates r
CROSS JOIN check_latency cl
CROSS JOIN fallback_latency fl;
