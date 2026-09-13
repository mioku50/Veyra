-- P8.1: Nova keeps watching while nobody is looking
-- Version: 20260913194500
-- Description: Turns Nova from something that looks when asked into something
-- that looks on a schedule. Three columns, because a scheduler needs to answer
-- three questions a manual refresh never had to:
--
--   when did this agent last get a scheduled pass   -> is it due?
--   when did a person last actually open the brief  -> is anyone still there?
--   when did we stop                                -> and can we say so?
--
-- The middle one is the important one. A Nova is remembered by a secret in one
-- browser, so an agent whose owner cleared their browser is unreachable
-- forever -- and a scheduler that does not know this will keep spending
-- GitHub and Circle requests on it every few hours, for as long as the table
-- exists. Dormancy is what stops the daily loop from becoming a daily leak.

ALTER TABLE public.nova_agents
    -- Set by the brief endpoint: the last time a person, holding the secret,
    -- actually read this agent's brief. Distinct from last_brief_at, which
    -- moves on every refresh including the ones nobody witnessed.
    ADD COLUMN IF NOT EXISTS last_opened_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_scheduled_refresh_at TIMESTAMPTZ,
    -- Non-null means the scheduler has stopped visiting. Cleared the moment the
    -- owner comes back, so waking an agent costs a visit and nothing else.
    ADD COLUMN IF NOT EXISTS dormant_since TIMESTAMPTZ;

-- Existing agents were created by someone who was present at the time, so
-- creation is the honest lower bound for "last seen by a person". Leaving it
-- NULL would make every agent that predates this migration look abandoned and
-- go dormant on the scheduler's first tick.
UPDATE public.nova_agents
   SET last_opened_at = COALESCE(last_opened_at, last_brief_at, created_at)
 WHERE last_opened_at IS NULL;

-- The claim query orders by this and filters on dormancy, so the partial index
-- matches the query exactly: awake agents, oldest pass first, nulls first
-- because an agent that has never had a scheduled pass is the most due of all.
CREATE INDEX IF NOT EXISTS nova_agents_scheduler_due_idx
    ON public.nova_agents (last_scheduled_refresh_at NULLS FIRST)
    WHERE dormant_since IS NULL;

COMMENT ON COLUMN public.nova_agents.last_opened_at IS
    'Last time the owner read the brief. Drives dormancy: no reader, no scheduled work.';
COMMENT ON COLUMN public.nova_agents.last_scheduled_refresh_at IS
    'Last scheduled pass. Null means never, which the scheduler treats as most due.';
COMMENT ON COLUMN public.nova_agents.dormant_since IS
    'When the scheduler stopped visiting. Cleared when the owner opens the brief.';
