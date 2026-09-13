-- P7.0: Veyra Trust API for external agents (x402-paid)
-- Version: 20260913120000
-- Description: Persists every x402 challenge probe as durable evidence, and adds
-- the ledgers behind the paid Trust API: reported outcomes, the credits they
-- earn, and the calls those credits or USDC pay for.
--
-- Until now every probe was thrown away after one request, which is why
-- statistical evidence was never available and why a counterparty could change
-- its payee without Veyra ever noticing. These tables are that memory.

-- 1. Endpoint observations -------------------------------------------------
-- One row per live x402 challenge probe against an external endpoint. This is
-- deliberately separate from api_quality_observations, which is the seller
-- store's own paid-execution record; mixing externally discovered endpoints
-- into it would corrupt seller quality reports.
CREATE TABLE IF NOT EXISTS public.x402_endpoint_observations (
    observation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- sha256("<METHOD> <normalized url>"), stable across catalog re-listings.
    resource_key TEXT NOT NULL CHECK (resource_key ~ '^[0-9a-f]{64}$'),
    resource_url TEXT NOT NULL,
    method TEXT NOT NULL CHECK (method IN ('GET', 'POST')),
    network TEXT NOT NULL,
    candidate_id TEXT,
    observed_pay_to TEXT CHECK (observed_pay_to IS NULL OR observed_pay_to ~ '^0x[0-9a-fA-F]{40}$'),
    observed_price_usdc NUMERIC(20, 6) CHECK (observed_price_usdc IS NULL OR observed_price_usdc >= 0),
    observed_asset TEXT,
    reachable BOOLEAN NOT NULL DEFAULT false,
    responded_with_402 BOOLEAN NOT NULL DEFAULT false,
    challenge_parseable BOOLEAN NOT NULL DEFAULT false,
    challenge_transport TEXT NOT NULL DEFAULT 'none'
        CHECK (challenge_transport IN ('payment_required_header', 'response_body', 'none')),
    http_status INTEGER,
    http_status_class TEXT NOT NULL
        CHECK (http_status_class IN ('2xx', '4xx', '5xx', 'timeout', 'network_error')),
    latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
    integrity_score INTEGER NOT NULL DEFAULT 0 CHECK (integrity_score BETWEEN 0 AND 100),
    catalog_drift TEXT[] NOT NULL DEFAULT '{}',
    critical_failure TEXT,
    error_category TEXT NOT NULL DEFAULT 'none'
        CHECK (error_category IN (
            'none', 'timeout', 'network', 'invalid_response',
            'payment_failed', 'settlement_failed', 'execution_failed', 'verification_failed'
        )),
    probe_version TEXT NOT NULL,
    probed_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS x402_endpoint_obs_resource_idx
    ON public.x402_endpoint_observations (resource_key, probed_at DESC);
CREATE INDEX IF NOT EXISTS x402_endpoint_obs_payto_idx
    ON public.x402_endpoint_observations (observed_pay_to, probed_at DESC)
    WHERE observed_pay_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS x402_endpoint_obs_probed_idx
    ON public.x402_endpoint_observations (probed_at DESC);

-- 2. Issued clearances ------------------------------------------------------
-- The ledger an outcome report is checked against. Without it, "report what
-- happened and earn a credit" would accept an invented digest, and the credit
-- loop would be farmable by anyone with a random number generator.
CREATE TABLE IF NOT EXISTS public.x402_trust_clearances (
    clearance_digest TEXT PRIMARY KEY CHECK (clearance_digest ~ '^0x[0-9a-f]{64}$'),
    clearance_id TEXT NOT NULL,
    decision_id TEXT NOT NULL,
    resource_key TEXT NOT NULL CHECK (resource_key ~ '^[0-9a-f]{64}$'),
    resource_url TEXT NOT NULL,
    payer TEXT CHECK (payer IS NULL OR payer ~ '^0x[0-9a-fA-F]{40}$'),
    pay_to TEXT CHECK (pay_to IS NULL OR pay_to ~ '^0x[0-9a-fA-F]{40}$'),
    decision TEXT NOT NULL,
    max_exposure_usdc NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (max_exposure_usdc >= 0),
    chain_id INTEGER NOT NULL,
    issued_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS x402_trust_clearances_resource_idx
    ON public.x402_trust_clearances (resource_key, issued_at DESC);

-- 3. Reported outcomes ------------------------------------------------------
-- What actually happened after Veyra cleared a purchase. Only a clearance Veyra
-- itself issued can be reported against, and each one exactly once: that is the
-- whole Sybil defence. You cannot farm credits without first buying clearances.
CREATE TABLE IF NOT EXISTS public.x402_trust_outcomes (
    outcome_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clearance_digest TEXT NOT NULL UNIQUE
        REFERENCES public.x402_trust_clearances(clearance_digest) ON DELETE CASCADE,
    resource_key TEXT NOT NULL CHECK (resource_key ~ '^[0-9a-f]{64}$'),
    resource_url TEXT NOT NULL,
    reporter TEXT CHECK (reporter IS NULL OR reporter ~ '^0x[0-9a-fA-F]{40}$'),
    outcome TEXT NOT NULL CHECK (outcome IN ('fulfilled', 'failed', 'refused', 'drifted')),
    paid_usdc NUMERIC(20, 6) CHECK (paid_usdc IS NULL OR paid_usdc >= 0),
    latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
    settlement_tx TEXT,
    http_status INTEGER,
    detail TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS x402_trust_outcomes_resource_idx
    ON public.x402_trust_outcomes (resource_key, created_at DESC);

-- 4. Credits ----------------------------------------------------------------
-- A single-use bearer grant returned once, at the moment an outcome is accepted.
-- Only the sha256 of the token is stored, so a database reader cannot spend it.
CREATE TABLE IF NOT EXISTS public.x402_trust_credits (
    credit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    outcome_id UUID REFERENCES public.x402_trust_outcomes(outcome_id) ON DELETE SET NULL,
    uses_total INTEGER NOT NULL DEFAULT 1 CHECK (uses_total > 0),
    uses_remaining INTEGER NOT NULL DEFAULT 1 CHECK (uses_remaining >= 0),
    expires_at TIMESTAMPTZ NOT NULL,
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS x402_trust_credits_expiry_idx
    ON public.x402_trust_credits (expires_at) WHERE uses_remaining > 0;

-- Atomic redemption: two concurrent requests presenting the same token must not
-- both be served. The conditional UPDATE is the lock.
CREATE OR REPLACE FUNCTION public.redeem_x402_trust_credit_v1(p_token_hash TEXT)
RETURNS TABLE (credit_id UUID, uses_remaining INTEGER)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    UPDATE public.x402_trust_credits
       SET uses_remaining = uses_remaining - 1,
           last_used_at = NOW()
     WHERE token_hash = p_token_hash
       AND uses_remaining > 0
       AND expires_at > NOW()
    RETURNING x402_trust_credits.credit_id, x402_trust_credits.uses_remaining;
$$;

-- 5. Paid call ledger -------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.x402_trust_api_calls (
    call_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    endpoint TEXT NOT NULL,
    paid_with TEXT NOT NULL CHECK (paid_with IN ('usdc', 'credit')),
    payer TEXT,
    amount_usdc NUMERIC(20, 6) NOT NULL DEFAULT 0 CHECK (amount_usdc >= 0),
    network TEXT,
    settlement_tx TEXT,
    credit_id UUID REFERENCES public.x402_trust_credits(credit_id) ON DELETE SET NULL,
    request_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS x402_trust_api_calls_created_idx
    ON public.x402_trust_api_calls (created_at DESC);

-- 6. Access -----------------------------------------------------------------
ALTER TABLE public.x402_endpoint_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.x402_trust_clearances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.x402_trust_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.x402_trust_credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.x402_trust_api_calls ENABLE ROW LEVEL SECURITY;

-- Observations are the public evidence base: anyone may read them, only the
-- service role writes them.
DROP POLICY IF EXISTS "Public read x402_endpoint_observations" ON public.x402_endpoint_observations;
CREATE POLICY "Public read x402_endpoint_observations"
    ON public.x402_endpoint_observations FOR SELECT USING (true);

DROP POLICY IF EXISTS "Service role writes x402_endpoint_observations" ON public.x402_endpoint_observations;
CREATE POLICY "Service role writes x402_endpoint_observations"
    ON public.x402_endpoint_observations FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role owns x402_trust_clearances" ON public.x402_trust_clearances;
CREATE POLICY "Service role owns x402_trust_clearances"
    ON public.x402_trust_clearances FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role owns x402_trust_outcomes" ON public.x402_trust_outcomes;
CREATE POLICY "Service role owns x402_trust_outcomes"
    ON public.x402_trust_outcomes FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Credits are bearer secrets: no public read at all, not even of the hash.
DROP POLICY IF EXISTS "Service role owns x402_trust_credits" ON public.x402_trust_credits;
CREATE POLICY "Service role owns x402_trust_credits"
    ON public.x402_trust_credits FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role owns x402_trust_api_calls" ON public.x402_trust_api_calls;
CREATE POLICY "Service role owns x402_trust_api_calls"
    ON public.x402_trust_api_calls FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON FUNCTION public.redeem_x402_trust_credit_v1(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_x402_trust_credit_v1(TEXT) TO service_role;
