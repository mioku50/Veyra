-- P8.9 -- a reservation settles into the day it was made in, or not at all.
--
-- Reconciliation ran hours or days after the attempt it was reconciling, and
-- worked out which budget day to settle by asking what day it is now. Across
-- midnight that is a different row: the reservation sits in yesterday holding
-- the budget open forever, while settle_mandate_budget looks in today, finds
-- nothing, and returns USAGE_ROW_NOT_FOUND -- whose boolean nobody read. The
-- attempt was already COMPLETED by then, by a separate statement, so the
-- ledger ended up saying the purchase succeeded and the money was never spent.
--
-- Now the period is written down when the reservation is taken, and it travels
-- with the attempt.

ALTER TABLE public.execution_attempts
    ADD COLUMN IF NOT EXISTS budget_period_start TIMESTAMPTZ;

COMMENT ON COLUMN public.execution_attempts.budget_period_start IS
    'The budget day this attempt reserved against, as computed when the reservation was taken -- in the mandate''s signed timezone for v2, UTC for v1. Reconciliation settles against this and never against the day it happens to run on. NULL on rows written before this column existed.';

-- Both halves of a settlement, in one transaction.
--
-- The state change and the budget change were two round trips, and a process
-- that died between them left a COMPLETED purchase whose money was still
-- reserved, or a settled budget on an attempt still waiting to be reconciled.
-- A plpgsql function is one transaction: either both happen or neither does.
--
-- Idempotent by the state guard rather than by a key. A second reconcile finds
-- the attempt already out of p_expected_state, changes nothing, and says so --
-- which is what makes it safe to retry after a timeout without double-spending
-- the day's budget.
CREATE OR REPLACE FUNCTION public.settle_execution_budget(
    p_execution_id TEXT,
    p_expected_state TEXT,
    p_target_state TEXT,
    p_settled_amount_usdc NUMERIC,
    p_payment_tx TEXT,
    p_complete_tx TEXT,
    p_mandate_id TEXT,
    p_reserved_amount_usdc NUMERIC,
    p_period_start TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE public.execution_attempts
    SET state = p_target_state,
        actual_settled_amount_usdc = p_settled_amount_usdc,
        -- COALESCE so a resolution that proved the money moved without naming a
        -- transaction does not erase a hash an earlier step already recorded.
        payment_tx = COALESCE(p_payment_tx, payment_tx),
        complete_tx = COALESCE(p_complete_tx, complete_tx),
        failure_code = NULL,
        updated_at = NOW()
    WHERE execution_id = p_execution_id
      AND state = p_expected_state;

    IF NOT FOUND THEN
        -- Somebody else reconciled it first, or it was never in that state.
        -- Nothing was written, including no budget movement.
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
            /* Raised rather than returned, because returning would commit the
               state change on its own -- exactly the split this function exists
               to close. The attempt stays where it was and can be reconciled
               again once the reason is understood. */
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
    'Moves an execution attempt to a terminal settled state and turns its reservation into spend, in one transaction. Guarded on the expected current state, so a retried reconcile is a no-op rather than a second settlement.';
