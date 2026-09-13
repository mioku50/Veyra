-- P8.0: Nova, the personal agent
-- Version: 20260913180000
-- Description: The human-facing layer. A person creates Nova with a name and a
-- few interests, and Nova watches the agent economy on their behalf, brings back
-- what changed, and asks before spending anything.
--
-- Veyra already measures the agent economy: it reads Circle's x402 catalog, it
-- probes endpoints, and it stores what it saw. Until now that evidence only
-- existed to serve a purchase someone had already decided to make. These tables
-- turn it into something a person receives: a daily brief of what actually
-- changed, with the payment decision kept where it belongs -- behind an explicit
-- approval.
--
-- Nothing here holds money, keys, or an authorization to spend. A Nova is a
-- watcher and a memory. Every paid step still goes through the existing
-- selection, clearance and settlement path, signed by the person's own wallet.

-- 1. The agent ---------------------------------------------------------------
-- Created with a name and interests, and nothing else. No wallet, no budget, no
-- on-chain identity: those are earned later, after Nova has done something
-- verifiable. An owner is identified by a secret held in their browser and
-- stored here only as a SHA-256 digest, so a lost device cannot be impersonated
-- from this table and this table cannot impersonate an owner.
CREATE TABLE IF NOT EXISTS public.nova_agents (
    agent_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    public_id TEXT NOT NULL UNIQUE CHECK (public_id ~ '^nva_[0-9a-z]{20}$'),
    owner_secret_digest TEXT NOT NULL CHECK (owner_secret_digest ~ '^[0-9a-f]{64}$'),
    name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 40),
    interests TEXT[] NOT NULL CHECK (
        array_length(interests, 1) BETWEEN 1 AND 6
    ),
    -- Bound only when the owner connects a wallet to approve a spend. Until then
    -- Nova is a perfectly usable agent that has never touched money.
    owner_wallet TEXT CHECK (owner_wallet IS NULL OR owner_wallet ~ '^0x[0-9a-fA-F]{40}$'),
    -- Set when the owner registers the agent on Arc. Deliberately nullable: an
    -- identity means something only once there is a history behind it.
    arc_identity_address TEXT CHECK (arc_identity_address IS NULL OR arc_identity_address ~ '^0x[0-9a-fA-F]{40}$'),
    arc_identity_registered_at TIMESTAMPTZ,
    last_brief_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS nova_agents_owner_digest_idx
    ON public.nova_agents (owner_secret_digest);
CREATE INDEX IF NOT EXISTS nova_agents_owner_wallet_idx
    ON public.nova_agents (lower(owner_wallet)) WHERE owner_wallet IS NOT NULL;

-- 2. What Nova watches -------------------------------------------------------
-- Interests are what a person says; subjects are what can actually be observed.
-- "Arc" is an interest. "The x402 resource np.orthogonal.com/serper/search" and
-- "the repository circlefin/arc" are subjects, and only subjects produce
-- evidence. Keeping them apart is what stops the feed from inventing things:
-- every signal traces to a subject, and every subject to something Veyra reads.
CREATE TABLE IF NOT EXISTS public.nova_subjects (
    subject_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES public.nova_agents (agent_id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('x402_resource', 'github_repository')),
    -- Stable identity of the thing watched: the resource key, or "owner/name".
    ref TEXT NOT NULL CHECK (char_length(ref) BETWEEN 1 AND 300),
    label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 120),
    -- Which stated interest put this on the list, so the brief can explain why.
    interest TEXT NOT NULL CHECK (char_length(interest) BETWEEN 1 AND 40),
    -- The last state Nova saw, which is what the next observation is compared
    -- against. Null until the first observation: a first sighting is not news.
    last_digest JSONB,
    last_observed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (agent_id, kind, ref)
);

CREATE INDEX IF NOT EXISTS nova_subjects_agent_idx
    ON public.nova_subjects (agent_id, created_at DESC);

-- 3. The brief ---------------------------------------------------------------
-- One row per thing Nova thinks is worth a person's attention, plus the ones it
-- decided were noise. The noise is kept on purpose: "4 ignored as noise" is only
-- an honest thing to show if the four are real rows someone could inspect.
CREATE TABLE IF NOT EXISTS public.nova_signals (
    signal_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES public.nova_agents (agent_id) ON DELETE CASCADE,
    subject_id UUID REFERENCES public.nova_subjects (subject_id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK (kind IN (
        'capability_available',  -- a paid endpoint matching an interest, found
                                 -- on the first look. Deliberately not called
                                 -- "new": the catalog's own lastUpdated is too
                                 -- coarse to support that claim (measured: no
                                 -- entry of 1139 was fresher than 11.9 days),
                                 -- and calling a month-old listing new would be
                                 -- the first thing Nova ever told someone that
                                 -- was not true.
        'price_changed',         -- the same endpoint now costs something else
        'payee_changed',         -- the address being paid changed: a trust event
        'endpoint_unreachable',  -- it stopped answering
        'endpoint_recovered',
        'rail_changed',          -- it moved between the wallet rail and a
                                 -- Circle Gateway deposit, which decides
                                 -- whether this wallet can pay it at all
        'repository_activity',   -- commits, contributors, a release
        'repository_release'
    )),
    headline TEXT NOT NULL CHECK (char_length(headline) BETWEEN 1 AND 160),
    detail TEXT NOT NULL CHECK (char_length(detail) <= 600),
    -- What this is worth to THIS person, given their stated interests. "noise"
    -- is a first-class outcome, not an absence of one.
    relevance TEXT NOT NULL CHECK (relevance IN ('high', 'medium', 'low', 'noise')),
    relevance_reason TEXT NOT NULL CHECK (char_length(relevance_reason) <= 300),
    -- The observation behind the sentence, so the claim can be checked.
    evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'new'
        CHECK (status IN ('new', 'seen', 'dismissed', 'investigating', 'investigated')),
    -- Set once the owner pays to have Nova look deeper. Links the brief to the
    -- existing execution ledger rather than duplicating it.
    execution_public_id TEXT,
    observed_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS nova_signals_agent_idx
    ON public.nova_signals (agent_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS nova_signals_agent_status_idx
    ON public.nova_signals (agent_id, status, relevance);
-- The same change must not be reported twice on two refreshes.
-- Plain columns, not an expression: the writer upserts with ON CONFLICT naming
-- these four, and Postgres will not match that against an index over
-- COALESCE(subject_id, ...) -- every signal write would fail instead of
-- de-duplicating. Rows written without a subject are rare and are allowed to
-- repeat rather than making the common path depend on a matching expression.
CREATE UNIQUE INDEX IF NOT EXISTS nova_signals_dedupe_idx
    ON public.nova_signals (agent_id, kind, subject_id, observed_at);

-- 4. What Nova knows ---------------------------------------------------------
-- Two different things share this table because they are both "what Nova knows
-- about you", and a person reads them as one list:
--   preference  learned from what was opened and what was dismissed
--   learning    the result of an investigation the person paid for
-- A learning carries the execution it came from, so "Verified by Veyra" is a
-- claim with a receipt behind it rather than a badge.
CREATE TABLE IF NOT EXISTS public.nova_memory (
    memory_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES public.nova_agents (agent_id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('preference', 'learning')),
    -- For a preference: 'cares_about' | 'usually_ignores'.
    facet TEXT NOT NULL CHECK (char_length(facet) BETWEEN 1 AND 40),
    summary TEXT NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 600),
    evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
    signal_id UUID REFERENCES public.nova_signals (signal_id) ON DELETE SET NULL,
    execution_public_id TEXT,
    -- How many observations support a preference. A preference asserted from one
    -- click is a guess; this is what keeps the "what Nova knows" list honest.
    support_count INTEGER NOT NULL DEFAULT 1 CHECK (support_count >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS nova_memory_agent_idx
    ON public.nova_memory (agent_id, kind, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS nova_memory_preference_idx
    ON public.nova_memory (agent_id, facet, summary) WHERE kind = 'preference';

-- 5. Refresh runs ------------------------------------------------------------
-- "While you were away: 7 signals checked, 4 ignored as noise, 3 worth your
-- attention." That sentence needs a row, or it is decoration.
CREATE TABLE IF NOT EXISTS public.nova_refreshes (
    refresh_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES public.nova_agents (agent_id) ON DELETE CASCADE,
    trigger TEXT NOT NULL CHECK (trigger IN ('creation', 'manual', 'scheduled')),
    subjects_checked INTEGER NOT NULL DEFAULT 0 CHECK (subjects_checked >= 0),
    signals_found INTEGER NOT NULL DEFAULT 0 CHECK (signals_found >= 0),
    signals_kept INTEGER NOT NULL DEFAULT 0 CHECK (signals_kept >= 0),
    signals_as_noise INTEGER NOT NULL DEFAULT 0 CHECK (signals_as_noise >= 0),
    -- A refresh that could not read a source must say so rather than present a
    -- quiet day. "Nothing changed" and "I could not look" are different facts.
    sources_unavailable TEXT[] NOT NULL DEFAULT '{}',
    duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS nova_refreshes_agent_idx
    ON public.nova_refreshes (agent_id, started_at DESC);

-- 6. Access ------------------------------------------------------------------
-- Every one of these tables is reached only through the server, which checks the
-- owner secret first. No anonymous client may read another person's agent, their
-- brief, or what their agent has learned about them.
ALTER TABLE public.nova_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nova_subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nova_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nova_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nova_refreshes ENABLE ROW LEVEL SECURITY;
