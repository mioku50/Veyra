-- P9.0 -- where the claim that money moved came from.
--
-- A settled purchase was recorded from the seller's own PAYMENT-RESPONSE
-- header: the browser path read settlement.success out of it, the server
-- adapter declared settlement the moment it contained something shaped like a
-- transaction hash. Both produced COMPLETED, a spend figure, and reputation
-- evidence about that seller -- derived from that seller's account of itself.
--
-- The grade does not change whether a purchase is settled. It records which of
-- two very different facts the row is holding, so that a reader, and the
-- reputation engine, can tell them apart.

ALTER TABLE public.execution_attempts
    ADD COLUMN IF NOT EXISTS settlement_proof TEXT
        CHECK (settlement_proof IS NULL OR settlement_proof IN (
            'seller_reported',
            'facilitator_accepted',
            'onchain_final'
        ));

COMMENT ON COLUMN public.execution_attempts.settlement_proof IS
    'Where the claim that this payment settled comes from: seller_reported is the endpoint''s own word, facilitator_accepted is an acknowledged authorization with no onchain reference yet (batched Gateway settlement), onchain_final is the chain agreeing. Only onchain_final may become economic reputation evidence. NULL on rows written before the column.';

CREATE INDEX IF NOT EXISTS execution_attempts_settlement_proof_idx
    ON public.execution_attempts (settlement_proof)
    WHERE settlement_proof IS NOT NULL;

-- settle_execution_budget carries the grade through the same transaction that
-- records the settlement, so a reconciled purchase cannot end up marked
-- complete with no account of where the proof came from.
--
-- Dropped and recreated rather than CREATE OR REPLACE: adding a parameter makes
-- a new signature, and leaving the old one behind would give PostgREST two
-- overloads to choose between. Nothing has called it in production yet.
DROP FUNCTION IF EXISTS public.settle_execution_budget(
    TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, NUMERIC, TIMESTAMPTZ
);

CREATE OR REPLACE FUNCTION public.settle_execution_budget(
    p_execution_id TEXT,
    p_expected_state TEXT,
    p_target_state TEXT,
    p_settled_amount_usdc NUMERIC,
    p_payment_tx TEXT,
    p_complete_tx TEXT,
    p_mandate_id TEXT,
    p_reserved_amount_usdc NUMERIC,
    p_period_start TIMESTAMPTZ,
    p_settlement_proof TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE public.execution_attempts
    SET state = p_target_state,
        actual_settled_amount_usdc = p_settled_amount_usdc,
        payment_tx = COALESCE(p_payment_tx, payment_tx),
        complete_tx = COALESCE(p_complete_tx, complete_tx),
        settlement_proof = COALESCE(p_settlement_proof, settlement_proof),
        failure_code = NULL,
        updated_at = NOW()
    WHERE execution_id = p_execution_id
      AND state = p_expected_state;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'reason', 'STATE_MISMATCH');
    END IF;

    IF p_mandate_id IS NOT NULL THEN
        UPDATE public.execution_mandate_usage
        SET reserved_usdc = GREATEST(0, reserved_usdc - p_reserved_amount_usdc),
            used_usdc = used_usdc + p_settled_amount_usdc,
            execution_count = execution_count + 1,
            updated_at = NOW()
        WHERE mandate_id = p_mandate_id
          AND period_start = p_period_start;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'USAGE_ROW_NOT_FOUND for mandate % in period %',
                p_mandate_id, p_period_start
                USING ERRCODE = 'no_data_found';
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'settled_amount', p_settled_amount_usdc,
        'released_reservation', p_reserved_amount_usdc
    );
END;
$$;

COMMENT ON FUNCTION public.settle_execution_budget IS
    'Moves an execution attempt to a terminal settled state, records where the proof of settlement came from, and turns its reservation into spend -- in one transaction. Guarded on the expected current state, so a retried reconcile is a no-op rather than a second settlement.';
