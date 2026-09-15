-- P9.1 -- a spend that nothing corroborates, and the rule that a grade only rises.
--
-- Circle's batched Gateway rail settles many purchases as one netted onchain
-- transaction. A single purchase in a batch has no transfer of its own, its
-- nonce was signed against the GatewayWallet rather than the token so
-- authorizationState knows nothing about it, and Gateway publishes no
-- per-authorization status -- /v1/x402/verify validates the signed message and
-- short-circuits on expiry before it would reach a nonce.
--
-- So when a batched purchase's response goes missing, no record anywhere can
-- say whether the money left. Once the authorization expires it never will.
-- The spend is booked anyway, because a mandate is a promise about a ceiling:
-- releasing a reservation for money that really left lets the buyer's own cap
-- be exceeded by real funds, while booking one that did not leave under-uses a
-- single day that resets at midnight. presumed_spent is the grade that says the
-- row rests on that argument rather than on any record, and it is ranked below
-- every other grade, so it can never become reputation evidence.

-- Dropped by what it constrains rather than by name. The original was declared
-- inline on ADD COLUMN, so Postgres named it, and guessing that name wrongly
-- would leave the old three-value check in place next to the new one --
-- rejecting presumed_spent while every migration log said it had been allowed.
DO $$
DECLARE
    v_name TEXT;
BEGIN
    FOR v_name IN
        SELECT con.conname
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
        WHERE nsp.nspname = 'public'
          AND rel.relname = 'execution_attempts'
          AND con.contype = 'c'
          AND pg_get_constraintdef(con.oid) LIKE '%settlement_proof%'
    LOOP
        EXECUTE format('ALTER TABLE public.execution_attempts DROP CONSTRAINT %I', v_name);
    END LOOP;
END;
$$;

ALTER TABLE public.execution_attempts
    ADD CONSTRAINT execution_attempts_settlement_proof_check
        CHECK (settlement_proof IS NULL OR settlement_proof IN (
            'presumed_spent',
            'seller_reported',
            'facilitator_accepted',
            'onchain_final'
        ));

COMMENT ON COLUMN public.execution_attempts.settlement_proof IS
    'Where the claim that this payment settled comes from, weakest first: presumed_spent is nothing at all -- the rail publishes no per-payment status and the authorization has expired, so the spend is booked to keep a signed cap honest; seller_reported is the endpoint''s own word; facilitator_accepted is an acknowledged authorization with no onchain reference yet (batched Gateway settlement); onchain_final is the chain agreeing. Only onchain_final may become economic reputation evidence. NULL on rows written before the column.';

-- The grade is a high-water mark.
--
-- It used to be COALESCE, which takes whatever the caller passed whenever the
-- caller passed something -- so a later, weaker account of the same payment
-- would quietly overwrite a stronger one. No path does that today. The
-- invariant is written into the function rather than left as a property of the
-- callers, because the whole point of the column is that a reader can trust
-- what it says without auditing everything that ever wrote to it.
--
-- Dropped and recreated rather than replaced in place: the signature is
-- unchanged, but CREATE OR REPLACE on a plpgsql function whose body changes is
-- clearer to read as a pair.
DROP FUNCTION IF EXISTS public.settle_execution_budget(
    TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, NUMERIC, TIMESTAMPTZ, TEXT
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
DECLARE
    v_rank CONSTANT JSONB := jsonb_build_object(
        'presumed_spent', 0,
        'seller_reported', 1,
        'facilitator_accepted', 2,
        'onchain_final', 3
    );
BEGIN
    UPDATE public.execution_attempts
    SET state = p_target_state,
        actual_settled_amount_usdc = p_settled_amount_usdc,
        payment_tx = COALESCE(p_payment_tx, payment_tx),
        complete_tx = COALESCE(p_complete_tx, complete_tx),
        settlement_proof = CASE
            WHEN p_settlement_proof IS NULL THEN settlement_proof
            WHEN settlement_proof IS NULL THEN p_settlement_proof
            WHEN (v_rank ->> p_settlement_proof)::INT
                 > (v_rank ->> settlement_proof)::INT THEN p_settlement_proof
            ELSE settlement_proof
        END,
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
    'Moves an execution attempt to a terminal settled state, records where the proof of settlement came from, and turns its reservation into spend -- in one transaction. Guarded on the expected current state, so a retried reconcile is a no-op rather than a second settlement. The proof grade only ever rises: a weaker later account cannot overwrite a stronger earlier one.';

-- Attempts waiting on reconciliation, which the hourly sweep reads oldest
-- first. Without this it is a sequential scan of every execution ever made,
-- once an hour, to find the handful that are still open.
CREATE INDEX IF NOT EXISTS execution_attempts_unverified_idx
    ON public.execution_attempts (created_at)
    WHERE state = 'SETTLEMENT_UNVERIFIED';
