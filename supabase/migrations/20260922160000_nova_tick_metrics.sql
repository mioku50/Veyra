-- What a scheduled tick did, kept after the tick.
--
-- The metrics existed already. They were aggregated per tick into
-- ShadowMetrics, returned in the cron response, written to the scheduler log
-- and then gone. Closing the D0 PREVIEW epoch needed the unpriced reasons for
-- the whole epoch and there was no way to get them: runtime logs do not reach
-- back a week, and nothing else had ever held the number. A capture item was
-- recorded as unanswerable rather than answered.
--
-- One row per tick. Counts only -- no question, no endpoint, no quote body and
-- no credential -- because this table is written by the scheduler and read by
-- whoever is auditing a calibration epoch, and neither needs the contents of a
-- proposal to count how many there were.
CREATE TABLE public.nova_ticks (
    tick_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    started_at TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    duration_ms INTEGER NOT NULL,
    -- The queue this tick faced and what it got through. stopped_early
    -- distinguishes a short queue from a clock that ran out, which is the
    -- difference between "nothing was due" and "coverage was truncated".
    due INTEGER NOT NULL DEFAULT 0,
    refreshed INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    went_dormant INTEGER NOT NULL DEFAULT 0,
    signals_kept INTEGER NOT NULL DEFAULT 0,
    stopped_early BOOLEAN NOT NULL DEFAULT FALSE,
    -- Shadow rehearsal. would_spend_usdc is hypothetical by construction: a
    -- PREVIEW decision never signs and never sends, and this column is not
    -- evidence that anything was spent or could have been.
    shadow_passes INTEGER NOT NULL DEFAULT 0,
    shadow_failed INTEGER NOT NULL DEFAULT 0,
    shadow_skipped_for_time INTEGER NOT NULL DEFAULT 0,
    shadow_considered INTEGER NOT NULL DEFAULT 0,
    shadow_skipped INTEGER NOT NULL DEFAULT 0,
    shadow_deadline_hits INTEGER NOT NULL DEFAULT 0,
    shadow_decided INTEGER NOT NULL DEFAULT 0,
    shadow_would_allow INTEGER NOT NULL DEFAULT 0,
    shadow_would_spend_usdc NUMERIC(18, 6) NOT NULL DEFAULT 0,
    -- {reason: count}. The two that could not be answered for D0.
    shadow_blocked JSONB NOT NULL DEFAULT '{}'::jsonb,
    shadow_unpriced JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX nova_ticks_started_idx ON public.nova_ticks(started_at DESC);
ALTER TABLE public.nova_ticks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.nova_ticks FROM anon, authenticated;
GRANT SELECT, INSERT ON public.nova_ticks TO service_role;
COMMENT ON TABLE public.nova_ticks IS
  'One row per scheduled tick: queue, coverage and shadow-rehearsal counts. Aggregates only, kept so a calibration epoch can be audited after its logs are gone.';

-- Three failures that were one number.
--
-- sources_unavailable held any of them as prose. A publication host that did
-- not answer, an article fetched successfully whose date could not be parsed,
-- and a reading model that returned nothing are three different problems with
-- three different responses, and the middle one is not an availability
-- problem at all -- the page was read. LangChain announcements reported
-- "some articles unavailable" on all twelve passes of the D0 epoch, from one
-- undated article out of ten, and the owner was told the source could not be
-- reached every time.
ALTER TABLE public.nova_refreshes
  -- Read, but not understood: {label: count}. Not a coverage failure.
  ADD COLUMN articles_unreadable JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Readings attempted by the model, and {reason: count} for those that
  -- produced nothing -- timeout, rate_limited, invalid_response, ungrounded.
  -- The model invalid-output rate the roadmap asks for.
  ADD COLUMN readings_attempted INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN reading_failures JSONB NOT NULL DEFAULT '{}'::jsonb;
COMMENT ON COLUMN public.nova_refreshes.articles_unreadable IS
  'Articles fetched but not parseable, by feed. Distinct from sources_unavailable, which is failure to reach a host.';
COMMENT ON COLUMN public.nova_refreshes.reading_failures IS
  'Reading attempts that produced no assessment, by named cause. See READING_FAILURE_DETAIL.';
