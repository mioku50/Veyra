-- P8.4 -- a refusal is an answer, and answers survive a reload.
--
-- Asking what a card would cost probes live endpoints, and Veyra often comes
-- back with "none of these can be paid": the subject is not on a rail this
-- wallet can settle, or it publishes no field a question fits in, or its price
-- moved past the ceiling. The route already returns that as a 200, and the
-- route's own comment calls it the most useful answer the product gives.
--
-- Then it was thrown away. The refusal lived in React state, so refreshing the
-- page put the card back exactly as it was, with the same button offering the
-- same probe to reach the same no. Measured on the live agent: thirteen signals
-- marked investigating, five with a proposal, eight carrying nothing at all.
--
-- Kept on the signal rather than in nova_research, because nova_research is the
-- money ledger. A refusal has no question, no terms and no approval -- writing
-- a row there to represent one would mean the ledger no longer answers "what
-- was priced" without a filter.

ALTER TABLE public.nova_signals
    ADD COLUMN IF NOT EXISTS refusal JSONB;

COMMENT ON COLUMN public.nova_signals.refusal IS
    'Why Veyra would not price this signal: {reason, detail, at}. Cleared when a later attempt produces a proposal. Never a payment record -- nothing was spent to learn this.';
