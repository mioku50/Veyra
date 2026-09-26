-- The records a payment is bound to, closed to the Data API's client roles.
--
-- Five tables were created without row-level security:
--   execution_mandates, execution_mandate_usage and execution_attempts (p61);
--   x402_selections and x402_quotes (p92), the decisions a payment is bound to.
-- Supabase's default privileges gave anon and authenticated every right on
-- them. Anyone holding the project's publishable key could therefore read,
-- write or delete them through the Data API. Checked on 26 September under the
-- anon role: every row of all five was visible.
--
-- Eight SECURITY DEFINER functions were open to the same two roles. Such a
-- function runs as its owner, so row-level security alone would not have
-- closed them.
--   * Seven move these tables' state: a quote created, claimed or advanced; a
--     mandate's budget reserved, released or settled.
--   * The eighth spends a use of a trust credit. p70 revoked it from PUBLIC,
--     but anon and authenticated hold grants of their own, which that did not
--     touch.
--
-- The server reaches all of this with the service role only:
-- getServerSupabaseConfig accepts nothing else. That role bypasses row-level
-- security and keeps its grants, and the definer functions run as their
-- owner. No policy is added, because no client role has a reason to see these
-- rows. Every statement is safe to run twice.
ALTER TABLE public.execution_mandates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.execution_mandate_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.execution_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.x402_selections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.x402_quotes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.execution_mandates, public.execution_mandate_usage, public.execution_attempts,
  public.x402_selections, public.x402_quotes FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.execution_mandate_usage_id_seq FROM anon, authenticated;

REVOKE ALL ON FUNCTION public.reserve_mandate_budget(TEXT, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_mandate_budget(TEXT, NUMERIC, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_mandate_budget(TEXT, NUMERIC, NUMERIC, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_execution_budget(TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, NUMERIC, TIMESTAMPTZ, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_x402_quote(TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, TEXT, JSONB, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_x402_quote(TEXT, TEXT, NUMERIC) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.advance_x402_quote(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.redeem_x402_trust_credit_v1(TEXT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.reserve_mandate_budget(TEXT, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_mandate_budget(TEXT, NUMERIC, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_mandate_budget(TEXT, NUMERIC, NUMERIC, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_execution_budget(TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, NUMERIC, TIMESTAMPTZ, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_x402_quote(TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, TEXT, JSONB, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_x402_quote(TEXT, TEXT, NUMERIC) TO service_role;
GRANT EXECUTE ON FUNCTION public.advance_x402_quote(TEXT, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.redeem_x402_trust_credit_v1(TEXT) TO service_role;
