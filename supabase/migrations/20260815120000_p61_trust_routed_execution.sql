-- P6.1: Trust-Routed Execution Schema & Atomic Budget Locking
-- Version: 20260815120000
-- Description: Creates execution_mandates, execution_mandate_usage, and execution_attempts tables with atomic budget procedures.

-- 1. Execution Mandates
CREATE TABLE IF NOT EXISTS public.execution_mandates (
    mandate_id TEXT PRIMARY KEY,
    owner_wallet TEXT NOT NULL,
    subject_agent_id TEXT NOT NULL,
    subject_wallet TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('PREVIEW', 'PREPARE', 'AUTOPILOT')),
    network TEXT NOT NULL,
    allowed_capabilities TEXT[] NOT NULL DEFAULT '{}',
    allowed_rails TEXT[] NOT NULL DEFAULT '{}',
    max_per_transaction_usdc NUMERIC(18, 6) NOT NULL CHECK (max_per_transaction_usdc >= 0),
    max_per_day_usdc NUMERIC(18, 6) NOT NULL CHECK (max_per_day_usdc >= 0),
    max_total_usdc NUMERIC(18, 6) NOT NULL CHECK (max_total_usdc >= 0),
    minimum_trust_score NUMERIC(5, 2) NOT NULL DEFAULT 0,
    minimum_confidence NUMERIC(5, 2) NOT NULL DEFAULT 0,
    require_verified_identity BOOLEAN NOT NULL DEFAULT true,
    evaluator_threshold_usdc NUMERIC(18, 6) NOT NULL DEFAULT 0,
    canonical_hash TEXT NOT NULL,
    signature TEXT NOT NULL,
    nonce BIGINT NOT NULL DEFAULT 0,
    version TEXT NOT NULL DEFAULT 'v1',
    issued_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_execution_mandates_owner ON public.execution_mandates(owner_wallet);
CREATE INDEX IF NOT EXISTS idx_execution_mandates_subject ON public.execution_mandates(subject_agent_id);
CREATE INDEX IF NOT EXISTS idx_execution_mandates_active ON public.execution_mandates(owner_wallet, mode) WHERE revoked_at IS NULL;

-- 2. Execution Mandate Usage (Daily / Aggregate tracking)
CREATE TABLE IF NOT EXISTS public.execution_mandate_usage (
    id BIGSERIAL PRIMARY KEY,
    mandate_id TEXT NOT NULL REFERENCES public.execution_mandates(mandate_id) ON DELETE CASCADE,
    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,
    used_usdc NUMERIC(18, 6) NOT NULL DEFAULT 0 CHECK (used_usdc >= 0),
    reserved_usdc NUMERIC(18, 6) NOT NULL DEFAULT 0 CHECK (reserved_usdc >= 0),
    execution_count INTEGER NOT NULL DEFAULT 0 CHECK (execution_count >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_mandate_period UNIQUE (mandate_id, period_start)
);

CREATE INDEX IF NOT EXISTS idx_execution_mandate_usage_mandate ON public.execution_mandate_usage(mandate_id);

-- 3. Execution Attempts
CREATE TABLE IF NOT EXISTS public.execution_attempts (
    execution_id TEXT PRIMARY KEY,
    mandate_id TEXT REFERENCES public.execution_mandates(mandate_id) ON DELETE SET NULL,
    selection_id TEXT NOT NULL,
    clearance_id TEXT,
    rail TEXT NOT NULL CHECK (rail IN ('erc8183', 'x402')),
    counterparty_agent_id TEXT NOT NULL,
    counterparty_wallet TEXT NOT NULL,
    capability TEXT NOT NULL,
    requested_amount_usdc NUMERIC(18, 6) NOT NULL CHECK (requested_amount_usdc >= 0),
    authorized_amount_usdc NUMERIC(18, 6) NOT NULL CHECK (authorized_amount_usdc >= 0),
    actual_settled_amount_usdc NUMERIC(18, 6) CHECK (actual_settled_amount_usdc >= 0),
    state TEXT NOT NULL CHECK (state IN (
        'DRAFT',
        'PREPARED',
        'AUTHORIZED',
        'EXECUTING',
        'SUBMITTED',
        'EVALUATING',
        'SETTLING',
        'COMPLETED',
        'REJECTED',
        'EXPIRED',
        'CANCELLED',
        'FAILED',
        'SETTLEMENT_FAILED',
        'EVALUATION_REJECTED'
    )),
    failure_code TEXT,
    create_tx TEXT,
    complete_tx TEXT,
    payment_tx TEXT,
    evaluation_id TEXT,
    selection_hash TEXT NOT NULL,
    clearance_digest TEXT,
    evidence_hash TEXT,
    idempotency_key TEXT,
    canonical_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_execution_attempts_selection ON public.execution_attempts(selection_id);
CREATE INDEX IF NOT EXISTS idx_execution_attempts_mandate ON public.execution_attempts(mandate_id);
CREATE INDEX IF NOT EXISTS idx_execution_attempts_idempotency ON public.execution_attempts(mandate_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_execution_attempts_state ON public.execution_attempts(state);

-- 4. Atomic Budget Reservation Function
CREATE OR REPLACE FUNCTION public.reserve_mandate_budget(
    p_mandate_id TEXT,
    p_amount_usdc NUMERIC,
    p_period_start TIMESTAMPTZ,
    p_period_end TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_mandate RECORD;
    v_daily_used NUMERIC := 0;
    v_daily_reserved NUMERIC := 0;
    v_total_used NUMERIC := 0;
    v_total_reserved NUMERIC := 0;
    v_available_daily NUMERIC;
    v_available_total NUMERIC;
BEGIN
    -- Lock mandate row for update
    SELECT * INTO v_mandate
    FROM public.execution_mandates
    WHERE mandate_id = p_mandate_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'reason', 'MANDATE_NOT_FOUND');
    END IF;

    IF v_mandate.revoked_at IS NOT NULL THEN
        RETURN jsonb_build_object('success', false, 'reason', 'MANDATE_REVOKED');
    END IF;

    IF v_mandate.expires_at < NOW() THEN
        RETURN jsonb_build_object('success', false, 'reason', 'MANDATE_EXPIRED');
    END IF;

    IF p_amount_usdc > v_mandate.max_per_transaction_usdc THEN
        RETURN jsonb_build_object(
            'success', false,
            'reason', 'PER_TRANSACTION_LIMIT_EXCEEDED',
            'max_allowed', v_mandate.max_per_transaction_usdc,
            'requested', p_amount_usdc
        );
    END IF;

    -- Calculate total lifetime usage and reservation across all periods
    SELECT COALESCE(SUM(used_usdc), 0), COALESCE(SUM(reserved_usdc), 0)
    INTO v_total_used, v_total_reserved
    FROM public.execution_mandate_usage
    WHERE mandate_id = p_mandate_id;

    v_available_total := v_mandate.max_total_usdc - (v_total_used + v_total_reserved);
    IF p_amount_usdc > v_available_total THEN
        RETURN jsonb_build_object(
            'success', false,
            'reason', 'TOTAL_BUDGET_EXCEEDED',
            'available', v_available_total,
            'requested', p_amount_usdc
        );
    END IF;

    -- Insert or fetch daily usage row and lock it
    INSERT INTO public.execution_mandate_usage (
        mandate_id, period_start, period_end, used_usdc, reserved_usdc, execution_count, updated_at
    ) VALUES (
        p_mandate_id, p_period_start, p_period_end, 0, 0, 0, NOW()
    )
    ON CONFLICT (mandate_id, period_start) DO UPDATE
    SET updated_at = NOW()
    RETURNING used_usdc, reserved_usdc INTO v_daily_used, v_daily_reserved;

    -- Re-fetch current locked values
    SELECT used_usdc, reserved_usdc
    INTO v_daily_used, v_daily_reserved
    FROM public.execution_mandate_usage
    WHERE mandate_id = p_mandate_id AND period_start = p_period_start
    FOR UPDATE;

    v_available_daily := v_mandate.max_per_day_usdc - (v_daily_used + v_daily_reserved);
    IF p_amount_usdc > v_available_daily THEN
        RETURN jsonb_build_object(
            'success', false,
            'reason', 'DAILY_BUDGET_EXCEEDED',
            'available_daily', v_available_daily,
            'requested', p_amount_usdc
        );
    END IF;

    -- Atomically increase reserved amount
    UPDATE public.execution_mandate_usage
    SET reserved_usdc = reserved_usdc + p_amount_usdc,
        updated_at = NOW()
    WHERE mandate_id = p_mandate_id AND period_start = p_period_start;

    RETURN jsonb_build_object(
        'success', true,
        'reserved_amount', p_amount_usdc,
        'remaining_daily', v_available_daily - p_amount_usdc,
        'remaining_total', v_available_total - p_amount_usdc
    );
END;
$$;

-- 5. Atomic Budget Release Function (on failure before irreversible action)
CREATE OR REPLACE FUNCTION public.release_mandate_budget(
    p_mandate_id TEXT,
    p_amount_usdc NUMERIC,
    p_period_start TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE public.execution_mandate_usage
    SET reserved_usdc = GREATEST(0, reserved_usdc - p_amount_usdc),
        updated_at = NOW()
    WHERE mandate_id = p_mandate_id AND period_start = p_period_start;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'reason', 'USAGE_ROW_NOT_FOUND');
    END IF;

    RETURN jsonb_build_object('success', true, 'released_amount', p_amount_usdc);
END;
$$;

-- 6. Atomic Budget Settlement Function (on successful terminal settlement)
CREATE OR REPLACE FUNCTION public.settle_mandate_budget(
    p_mandate_id TEXT,
    p_reserved_amount_usdc NUMERIC,
    p_settled_amount_usdc NUMERIC,
    p_period_start TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE public.execution_mandate_usage
    SET reserved_usdc = GREATEST(0, reserved_usdc - p_reserved_amount_usdc),
        used_usdc = used_usdc + p_settled_amount_usdc,
        execution_count = execution_count + 1,
        updated_at = NOW()
    WHERE mandate_id = p_mandate_id AND period_start = p_period_start;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'reason', 'USAGE_ROW_NOT_FOUND');
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'settled_amount', p_settled_amount_usdc,
        'released_reservation', p_reserved_amount_usdc
    );
END;
$$;
