-- P5.4.4 — Canonical ERC-8004 Identity Bootstrap & T5 Security Closure
-- SPDX-License-Identifier: Apache-2.0

CREATE TABLE IF NOT EXISTS public.trust_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id TEXT NOT NULL UNIQUE,
  subject_agent_id TEXT NOT NULL,
  subject_wallet TEXT,
  executor_wallet TEXT,
  counterparty_agent_id TEXT,
  counterparty_wallet TEXT,
  action TEXT NOT NULL CHECK (
    action IN ('erc8183_job', 'x402_payment', 'paid_api_call', 'service_purchase')
  ),
  service_id TEXT,
  workflow_type TEXT,
  requested_value_usdc NUMERIC(20, 6) NOT NULL CHECK (requested_value_usdc >= 0),
  decision TEXT NOT NULL CHECK (
    decision IN ('ALLOW', 'ALLOW_WITH_LIMITS', 'REQUIRE_EVALUATOR', 'REVIEW_REQUIRED', 'DENY')
  ),
  max_value_usdc NUMERIC(20, 6) NOT NULL CHECK (max_value_usdc >= 0),
  snapshot_hash TEXT,
  trust_score SMALLINT NOT NULL CHECK (trust_score BETWEEN 0 AND 100),
  confidence DOUBLE PRECISION NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  coverage DOUBLE PRECISION NOT NULL CHECK (coverage BETWEEN 0 AND 1),
  snapshot_age_seconds DOUBLE PRECISION NOT NULL CHECK (snapshot_age_seconds >= 0),
  policy_version TEXT NOT NULL,
  evaluator TEXT,
  evaluator_required BOOLEAN NOT NULL,
  reasons JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(reasons) = 'array'),
  risk_signals JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(risk_signals) = 'array'),
  canonical_hash TEXT NOT NULL UNIQUE CHECK (canonical_hash ~ '^0x[0-9a-fA-F]{64}$'),
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > issued_at),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trust_decisions_subject_created
  ON public.trust_decisions (subject_agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trust_decisions_expires_at
  ON public.trust_decisions (expires_at);

CREATE OR REPLACE FUNCTION public.enforce_erc8004_validation_link_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
     OR NEW.evaluation_public_id IS DISTINCT FROM OLD.evaluation_public_id
     OR NEW.canonical_report_hash IS DISTINCT FROM OLD.canonical_report_hash
     OR NEW.response IS DISTINCT FROM OLD.response
     OR NEW.response_hash IS DISTINCT FROM OLD.response_hash
     OR NEW.tag IS DISTINCT FROM OLD.tag
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'erc8004 validation evidence binding is immutable';
  END IF;

  IF OLD.status = 'pending' AND NEW.status NOT IN ('pending', 'submitted', 'failed') THEN
    RAISE EXCEPTION 'invalid validation status transition';
  ELSIF OLD.status = 'submitted' AND NEW.status NOT IN ('submitted', 'confirmed', 'failed') THEN
    RAISE EXCEPTION 'invalid validation status transition';
  ELSIF OLD.status IN ('confirmed', 'failed') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'terminal validation status is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_erc8004_validation_link_immutability
  ON public.erc8004_validation_links;
CREATE TRIGGER enforce_erc8004_validation_link_immutability
  BEFORE UPDATE ON public.erc8004_validation_links
  FOR EACH ROW EXECUTE FUNCTION public.enforce_erc8004_validation_link_immutability();

CREATE OR REPLACE FUNCTION public.reject_trust_decision_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'trust decisions are immutable';
END;
$$;

DROP TRIGGER IF EXISTS reject_trust_decision_update ON public.trust_decisions;
CREATE TRIGGER reject_trust_decision_update
  BEFORE UPDATE ON public.trust_decisions
  FOR EACH ROW EXECUTE FUNCTION public.reject_trust_decision_mutation();

DROP TRIGGER IF EXISTS reject_trust_decision_delete ON public.trust_decisions;
CREATE TRIGGER reject_trust_decision_delete
  BEFORE DELETE ON public.trust_decisions
  FOR EACH ROW EXECUTE FUNCTION public.reject_trust_decision_mutation();

-- Raw T5/payment tables are internal. Public callers use sanitized server APIs.
DO $$
DECLARE
  policy_row RECORD;
BEGIN
  FOR policy_row IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = ANY (ARRAY[
        'payment_events',
        'erc8183_evaluations',
        'erc8004_validation_links',
        'agent_reputation_evidence',
        'agent_reputation_snapshots',
        'trust_decisions'
      ])
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON %I.%I',
      policy_row.policyname,
      policy_row.schemaname,
      policy_row.tablename
    );
  END LOOP;
END
$$;

ALTER TABLE public.payment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erc8183_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erc8004_validation_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_reputation_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_reputation_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trust_decisions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.payment_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.erc8183_evaluations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.erc8004_validation_links FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.agent_reputation_evidence FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.agent_reputation_snapshots FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.trust_decisions FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public.payment_events TO service_role;
GRANT ALL ON TABLE public.erc8183_evaluations TO service_role;
GRANT ALL ON TABLE public.erc8004_validation_links TO service_role;
GRANT ALL ON TABLE public.agent_reputation_evidence TO service_role;
GRANT ALL ON TABLE public.agent_reputation_snapshots TO service_role;
GRANT ALL ON TABLE public.trust_decisions TO service_role;

CREATE POLICY "Service role access on payment_events"
  ON public.payment_events FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role access on erc8183_evaluations"
  ON public.erc8183_evaluations FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role access on erc8004_validation_links"
  ON public.erc8004_validation_links FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role access on agent_reputation_evidence"
  ON public.agent_reputation_evidence FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role access on agent_reputation_snapshots"
  ON public.agent_reputation_snapshots FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role access on trust_decisions"
  ON public.trust_decisions FOR ALL TO service_role USING (true) WITH CHECK (true);
