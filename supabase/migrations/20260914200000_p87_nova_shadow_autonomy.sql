-- P8.7 -- what Nova would have done, kept where it cannot be mistaken for what
-- it did.
--
-- Shadow autonomy runs the whole unattended path for real: a scheduled pass, a
-- model noticing something, a question written for it, live discovery, a live
-- quote, Veyra's trust decision, and the owner's signed mandate evaluated
-- against all of it. Then it stops, one step before the step that costs money.
--
-- These rows are therefore not executions and must never be counted as any.
-- The table has no payment signature, no clearance, no transaction hash and no
-- settled amount -- not nullable versions of them, none of them -- because a
-- column that can hold a transaction is a column somebody will eventually fill,
-- and the single claim this whole phase rests on is that no money moved. The
-- receipts page reads nova_research; it does not read this table, and the two
-- are joined nowhere.
--
-- `would_spend_usdc` is money that was NOT spent. It is recorded on denials as
-- well as allowances, because "Nova would have spent $0.003 and Veyra stopped
-- three others" is only informative if both halves are counted.

ALTER TABLE public.execution_mandates
    -- v2 fields. Nullable, and null is not a default: a v1 mandate was signed
    -- before either field existed, and inventing a value for it would be
    -- reading a term into somebody's signature. lib/nova/autonomy.ts refuses
    -- to act on a mandate that has no timezone rather than assuming UTC.
    ADD COLUMN IF NOT EXISTS budget_timezone TEXT,
    ADD COLUMN IF NOT EXISTS max_autonomous_attempts_per_day INTEGER
        CHECK (max_autonomous_attempts_per_day IS NULL OR max_autonomous_attempts_per_day >= 0);

COMMENT ON COLUMN public.execution_mandates.budget_timezone IS
    'IANA zone the daily budget resets on, signed as part of an ExecutionMandate v2. NULL on v1 mandates, which do not grant unattended spending at all. Never default this to UTC: the budget day is a term the owner signed.';
COMMENT ON COLUMN public.execution_mandates.max_autonomous_attempts_per_day IS
    'How many times Nova may reach the point of paying in one budget day, whether or not money moves. Signed as part of an ExecutionMandate v2; NULL on v1. Payments are not the only cost -- an endpoint that fails every call is free in USDC and could otherwise be retried all night.';

CREATE TABLE IF NOT EXISTS public.nova_autonomy_decisions (
    decision_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES public.nova_agents (agent_id) ON DELETE CASCADE,
    signal_id UUID NOT NULL REFERENCES public.nova_signals (signal_id) ON DELETE CASCADE,

    -- Which signed statement this was judged against, and its canonical hash.
    -- The hash rather than only the id, because a decision is a function of the
    -- terms and the terms are what the hash names: reading a decision later
    -- without knowing which limits produced it would make the record unusable
    -- for the one question it exists to answer.
    mandate_id TEXT NOT NULL REFERENCES public.execution_mandates (mandate_id) ON DELETE CASCADE,
    mandate_hash TEXT NOT NULL,

    verdict TEXT NOT NULL CHECK (verdict IN ('WOULD_ALLOW', 'WOULD_DENY')),

    -- What Nova wanted, in the words it would have used.
    question TEXT NOT NULL CHECK (char_length(question) BETWEEN 1 AND 400),
    capability TEXT NOT NULL,
    provider TEXT,
    resource TEXT,
    rail TEXT NOT NULL,
    network TEXT,
    trust_score NUMERIC(6, 2),

    -- The live quote. Not an estimate and not a catalogue price: the market
    -- priced this exact request body at this exact moment, which is the only
    -- number a week of this data is worth reading for.
    would_spend_usdc NUMERIC(18, 6) NOT NULL CHECK (would_spend_usdc >= 0),

    -- Every check, passed and failed, in the order it ran. The failures are
    -- also stored flat because the morning brief counts them, and counting them
    -- out of jsonb on every read would make the brief's numbers a query rather
    -- than a fact.
    checks JSONB NOT NULL DEFAULT '[]'::jsonb,
    failed_codes TEXT[] NOT NULL DEFAULT '{}',

    attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
    budget_period_start TIMESTAMPTZ NOT NULL,
    budget_period_end TIMESTAMPTZ NOT NULL,
    budget_timezone TEXT NOT NULL,

    -- What the owner made of it in the morning. The point of the whole exercise
    -- is not only whether the limits were right but whether Nova's judgement is
    -- worth funding, and only a person can say that.
    owner_feedback TEXT CHECK (owner_feedback IS NULL OR owner_feedback IN ('useful', 'not_worth_it')),
    owner_feedback_at TIMESTAMPTZ,

    decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.nova_autonomy_decisions IS
    'Shadow autonomy. What Nova would have bought and what Veyra would have ruled, recorded one step before any payment authorization exists. No money moved for any row here. This table has no payment signature, clearance, transaction or settled-amount column by design; do not add one -- if Nova is ever allowed to pay, that belongs in the execution ledger, not here.';

-- One decision per signal per mandate per budget day.
--
-- The backoff the scheduler needs, expressed as a constraint rather than as a
-- check somebody has to remember. Four passes a night against the same
-- unchanged signal would otherwise write four identical denials and read, in
-- the morning, as four separate refusals.
--
-- Keyed on the mandate hash and not only the signal, so that changing a limit
-- makes the decision fresh again: the old answer was an answer about the old
-- terms, and suppressing a new one would leave a raised limit looking like it
-- did nothing.
CREATE UNIQUE INDEX IF NOT EXISTS nova_autonomy_decisions_once_per_day_idx
    ON public.nova_autonomy_decisions (agent_id, signal_id, mandate_hash, budget_period_start);

CREATE INDEX IF NOT EXISTS nova_autonomy_decisions_agent_period_idx
    ON public.nova_autonomy_decisions (agent_id, budget_period_start DESC);
CREATE INDEX IF NOT EXISTS nova_autonomy_decisions_agent_decided_idx
    ON public.nova_autonomy_decisions (agent_id, decided_at DESC);

ALTER TABLE public.nova_autonomy_decisions ENABLE ROW LEVEL SECURITY;
