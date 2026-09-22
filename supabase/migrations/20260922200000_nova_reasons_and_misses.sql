-- Why, with the rating; and what Nova did not show.
--
-- Gate V asks the owner to rate findings "and the reason". There was nowhere
-- to put one: by 2026-09-22 the owner had rated three readings and given no
-- reason, because the page offered no way to. The reasons are the review's own
-- categories, so a review counts them rather than interpreting prose. They are
-- recorded for that review and change no ranking.
ALTER TABLE public.nova_value_feedback
  ADD COLUMN reason TEXT,
  -- The owner's own words. Stored for the review, never sent to a model.
  ADD COLUMN note TEXT CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500),
  -- A reason belongs to its verdict. "Good to know" is not why something was
  -- useless, and a changed verdict must bring its own reason or none.
  ADD CONSTRAINT nova_value_feedback_reason_check CHECK (
    reason IS NULL
    OR (feedback = 'useful' AND reason IN ('acted', 'informed'))
    OR (feedback = 'not_interesting' AND reason IN ('off_goal', 'known', 'unneeded_work', 'wrong', 'duplicate'))
  );
COMMENT ON COLUMN public.nova_value_feedback.reason IS
  'Why, in the review''s categories. Recorded for gate V; no ranking reads it.';

-- A missed event can only be established by the owner naming it: nothing
-- records an event that was never observed. Roadmap item 3 extends coverage
-- from these, not from raw item volume.
--
-- The link is parsed and never fetched, and what Nova found is kept with it:
-- that it had the article (a ranking miss), reads where it came from but has
-- no card for it (a reading miss), or reads nothing there (a coverage gap).
-- Only the last is fixed by adding a source.
CREATE TABLE public.nova_misses (
    miss_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES public.nova_agents(agent_id) ON DELETE CASCADE,
    url TEXT NOT NULL CHECK (char_length(url) BETWEEN 8 AND 2048),
    host TEXT NOT NULL CHECK (char_length(host) BETWEEN 1 AND 253),
    note TEXT CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500),
    finding TEXT NOT NULL CHECK (finding IN ('observed', 'covered', 'not_covered')),
    signal_id UUID REFERENCES public.nova_signals(signal_id) ON DELETE SET NULL,
    detail JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- The same link reported twice is one miss, reclassified.
    UNIQUE (agent_id, url)
);
CREATE INDEX nova_misses_created_idx ON public.nova_misses(created_at DESC);
ALTER TABLE public.nova_misses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.nova_misses FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.nova_misses TO service_role;
COMMENT ON TABLE public.nova_misses IS
  'Events the owner says Nova should have shown, with what Nova found at the time: observed, covered or not_covered. Links are never fetched.';
