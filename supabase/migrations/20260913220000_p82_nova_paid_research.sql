-- P8.2: what Nova was told it would cost, kept, so approval can be checked
-- Version: 20260913220000
-- Description: One row per investigation a person was offered, from the moment
-- the price appeared on their brief through to a settled, verified result -- or
-- an honest account of why it is neither.
--
-- The reason this is a table and not a field on nova_signals is the middle of
-- that sentence. A brief is read at breakfast and acted on at lunch, and in
-- between a listing can be re-priced, re-pointed at a different payee, or
-- withdrawn. Approval therefore has to be checked against what the card
-- actually said, which means what the card said has to still exist. Holding it
-- in the browser would mean trusting the screen to report its own terms
-- honestly back to the server that is about to authorise them.
--
-- The status values carry the distinction the product is for:
--
--   proposed         priced, shown, nothing authorised
--   approved         terms re-read and matched, clearance signed, awaiting
--                    the owner's signature and the relay
--   verified         paid, and the answer passed the check its tier demanded
--   paid_unverified  the money left and the answer did not pass
--   unpaid           attempted, nothing transferred
--
-- `paid_unverified` is the one that matters. A product that files a failed
-- verification under "completed" has told somebody their research succeeded
-- while holding evidence that it did not.

CREATE TABLE IF NOT EXISTS public.nova_research (
    research_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES public.nova_agents (agent_id) ON DELETE CASCADE,
    signal_id UUID NOT NULL REFERENCES public.nova_signals (signal_id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'proposed'
        CHECK (status IN ('proposed', 'approved', 'verified', 'paid_unverified', 'unpaid')),

    -- What Nova would ask, in the words the card showed.
    question TEXT NOT NULL CHECK (char_length(question) BETWEEN 1 AND 400),

    -- The seven facts a person agreed to: provider, resource, capability,
    -- price, payee, network, rail. Compared field by field before anything is
    -- signed, and the hash is what a re-confirmation is bound to -- without it,
    -- "they confirmed the new price" only means "they pressed a button once",
    -- and a price that moved twice would be approved by a click that saw one.
    terms JSONB NOT NULL,
    terms_hash TEXT NOT NULL,

    -- x402 charges per call, so the request body is part of the price. Pinned
    -- here at proposal time: quoting one shape and paying for another would
    -- make the number on the card a number about a different request.
    request_body JSONB NOT NULL DEFAULT '{}'::jsonb,
    request_method TEXT NOT NULL DEFAULT 'POST' CHECK (request_method IN ('GET', 'POST')),
    input_schema JSONB,
    output_schema JSONB,
    -- Whether the tier demands the answer be checked after the money moves.
    verification_required BOOLEAN NOT NULL DEFAULT FALSE,

    -- The whole card as it was rendered, so a result can be shown under the
    -- proposal that produced it rather than under a fresh guess at one.
    proposal JSONB NOT NULL,

    -- Filled at approval. Null while nothing has been authorised, which is the
    -- normal state of most rows and the only correct one for a brief nobody
    -- acted on.
    payer_wallet TEXT,
    clearance_digest TEXT,
    selection_id TEXT,
    approved_at TIMESTAMPTZ,

    -- Filled after the relay.
    execution_public_id TEXT,
    paid_usdc NUMERIC(18, 6) CHECK (paid_usdc IS NULL OR paid_usdc >= 0),
    transaction_hash TEXT,
    verification JSONB,
    result JSONB,
    -- Why this ended where it did, in words a person can read. Set on every
    -- terminal state that is not `verified`.
    failure TEXT CHECK (failure IS NULL OR char_length(failure) <= 600),
    settled_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS nova_research_agent_idx
    ON public.nova_research (agent_id, created_at DESC);
-- The brief loads every open proposal for its signals in one read, and the
-- approval path loads the newest one for a single signal.
CREATE INDEX IF NOT EXISTS nova_research_signal_idx
    ON public.nova_research (signal_id, created_at DESC);

-- Same rule as every other Nova table: reached only through the server, which
-- checks the owner secret first. Nobody reads another person's research, what
-- it cost them, or what it returned.
ALTER TABLE public.nova_research ENABLE ROW LEVEL SECURITY;
