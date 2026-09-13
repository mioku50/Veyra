-- P8.2a: the approved terms stay on the server
-- Version: 20260913223000
-- Description: Holds the payment challenge Veyra actually cleared, so the relay
-- does not have to take the browser's word for what it was.
--
-- Without this the sequence is: the server quotes, hands the challenge to the
-- page, the page signs it, and the page hands back both the signature and the
-- challenge it claims to have signed. Every field is checked for internal
-- consistency, which catches a broken client -- and misses a tampered one, or a
-- bug, substituting a coherent challenge for the cleared one somewhere between
-- the two calls.
--
-- Keeping it here removes the question. The page sends a signature; the accept
-- it is relayed with is the one this row already held.

ALTER TABLE public.nova_research
    -- The cleared challenge, its nonce and the descriptor to echo back, plus
    -- the identifiers the decision log files the purchase under.
    ADD COLUMN IF NOT EXISTS approval JSONB;
