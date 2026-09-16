-- P9.3 -- a per-call ceiling is not a budget.
--
-- A browser x402 purchase carries no mandate, so nothing capped what one wallet
-- could spend in a day. X402_ABSOLUTE_MAX_USDC bounded a single call at five
-- dollars and there was no second number: a hundred calls were a hundred
-- separate five-dollar decisions, each individually within policy.
--
-- The mandate rail has had a daily cap since it existed. This gives the rail
-- without mandates the same kind of limit, enforced where it cannot be raced.
--
-- Two details worth stating rather than discovering.
--
-- It is checked when a quote is CLAIMED, not when it is written. A quote is an
-- opportunity; a claim is the moment Veyra commits to relaying a signature.
-- Checking at quote time would let a wallet mint ten quotes each under the
-- remaining cap and then claim all ten.
--
-- And it takes an advisory lock on the owner first. Two concurrent claims of
-- two different quotes lock two different rows, read the same total, and both
-- pass -- the oldest race there is. The lock makes the read-then-write one
-- serialized step per wallet, exactly as the hosted checkout does.
--
-- The day is UTC. A mandate signs a timezone and its budget day is measured in
-- it; a browser buyer has signed nothing, so there is no zone to honour and
-- inventing one would be a policy Veyra made up on the owner's behalf.

DROP FUNCTION IF EXISTS public.claim_x402_quote(TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.claim_x402_quote(
  p_quote_id TEXT,
  p_owner_wallet TEXT,
  p_daily_cap_atomic NUMERIC DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_quote public.x402_quotes%ROWTYPE;
  v_committed NUMERIC;
BEGIN
  /* One wallet at a time, so the sum below cannot be read twice before either
     write lands. Released with the transaction, whichever way it ends. */
  PERFORM pg_advisory_xact_lock(hashtext('x402_daily_cap:' || lower(p_owner_wallet)));

  SELECT * INTO v_quote FROM public.x402_quotes WHERE quote_id = p_quote_id FOR UPDATE;
  IF v_quote.quote_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'QUOTE_NOT_FOUND');
  END IF;
  IF lower(v_quote.owner_wallet) <> lower(p_owner_wallet) THEN
    RETURN jsonb_build_object('success', false, 'reason', 'QUOTE_NOT_OWNED');
  END IF;
  IF v_quote.state <> 'QUOTED' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'QUOTE_ALREADY_CLAIMED', 'state', v_quote.state);
  END IF;
  IF v_quote.expires_at <= NOW() THEN
    UPDATE public.x402_quotes SET state = 'EXPIRED', closed_at = NOW(), updated_at = NOW()
    WHERE quote_id = p_quote_id;
    RETURN jsonb_build_object('success', false, 'reason', 'QUOTE_EXPIRED');
  END IF;

  IF p_daily_cap_atomic IS NOT NULL THEN
    /* What this wallet has already committed today. CLAIMED counts: its
       signature may already be in a seller's hands, and after F3 a relay whose
       outcome is unknown is not a relay that did not happen. SETTLEMENT_FAILED
       does not count -- the chain said the authorization was never redeemed.
       QUOTED does not count either: nothing has been signed against it. */
    SELECT COALESCE(SUM(amount_atomic), 0) INTO v_committed
    FROM public.x402_quotes
    WHERE lower(owner_wallet) = lower(p_owner_wallet)
      AND state IN ('CLAIMED', 'DISPATCHED', 'SETTLED', 'SETTLEMENT_UNVERIFIED')
      AND quoted_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';

    IF v_committed + v_quote.amount_atomic > p_daily_cap_atomic THEN
      RETURN jsonb_build_object(
        'success', false,
        'reason', 'DAILY_CAP_EXCEEDED',
        'committed_atomic', v_committed::TEXT,
        'cap_atomic', p_daily_cap_atomic::TEXT
      );
    END IF;
  END IF;

  UPDATE public.x402_quotes
  SET state = 'CLAIMED', claimed_at = NOW(), updated_at = NOW()
  WHERE quote_id = p_quote_id AND state = 'QUOTED';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'QUOTE_ALREADY_CLAIMED');
  END IF;

  RETURN jsonb_build_object('success', true, 'quote', to_jsonb(v_quote));
END;
$$;

COMMENT ON FUNCTION public.claim_x402_quote IS
  'Compare-and-swap from QUOTED to CLAIMED so exactly one settle may relay a given authorization, and the point at which one wallet''s committed spend for the UTC day is checked against a cap. Serialized per wallet by an advisory lock, because two concurrent claims of two different quotes would otherwise both read the same total and both pass. A quote already past QUOTED is refused rather than retried: its signature has been handed to a seller, and handing it over again is how one purchase gets paid for twice.';

-- Reading one wallet's committed spend for today must not scan every quote
-- ever written.
CREATE INDEX IF NOT EXISTS x402_quotes_owner_committed_idx
  ON public.x402_quotes (lower(owner_wallet), quoted_at)
  WHERE state IN ('CLAIMED', 'DISPATCHED', 'SETTLED', 'SETTLEMENT_UNVERIFIED');
