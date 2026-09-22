-- Where "new since your last visit" starts.
--
-- Roadmap item 2 asks the brief to show what is new relative to the previous
-- one. last_opened_at cannot say it: the brief is loaded again after every
-- refresh, reading and goal change, so "since the last load" is "since the
-- owner pressed a button a minute ago", and every mark would vanish on the
-- first press. This moves only when a visit begins -- a gap of more than
-- thirty minutes since the last open -- and moves to the last moment of the
-- visit before. Null until an agent's second visit.
ALTER TABLE public.nova_agents ADD COLUMN seen_through TIMESTAMPTZ;
COMMENT ON COLUMN public.nova_agents.seen_through IS
  'End of the owner''s previous visit. Cards observed after it are new to them. Moves only when a new visit begins.';
