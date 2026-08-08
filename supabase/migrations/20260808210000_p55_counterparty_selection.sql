-- P5.5 — Agent-to-Agent Trust Discovery & Counterparty Selection MVP
-- SPDX-License-Identifier: Apache-2.0

CREATE TABLE IF NOT EXISTS public.counterparty_selections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  selection_id TEXT NOT NULL UNIQUE CHECK (selection_id ~ '^vcs_[0-9a-f]{16}$'),
  public_id TEXT NOT NULL UNIQUE CHECK (public_id ~ '^vcr_[0-9a-f]{16}$'),
  tenant_key TEXT NOT NULL,
  requester_agent_id TEXT,
  requester_wallet TEXT NOT NULL CHECK (requester_wallet ~ '^0x[0-9a-fA-F]{40}$'),
  machine_credential_id UUID REFERENCES public.byoa_agent_credentials(id) ON DELETE RESTRICT,
  capability TEXT NOT NULL CHECK (capability ~ '^[a-z0-9][a-z0-9_:-]{1,79}$'),
  task_hash TEXT NOT NULL CHECK (task_hash ~ '^0x[0-9a-fA-F]{64}$'),
  requested_budget_usdc NUMERIC(20, 6) NOT NULL CHECK (requested_budget_usdc > 0),
  network TEXT NOT NULL CHECK (network = 'eip155:5042002'),
  require_exact_capability BOOLEAN NOT NULL DEFAULT FALSE,
  policy_version TEXT NOT NULL,
  ranking_version TEXT NOT NULL CHECK (ranking_version = 'veyra-counterparty-selection-v1'),
  recommended_agent_id TEXT NOT NULL,
  recommended_wallet TEXT NOT NULL CHECK (recommended_wallet ~ '^0x[0-9a-fA-F]{40}$'),
  recommended_service_id TEXT,
  decision TEXT NOT NULL CHECK (
    decision IN ('ALLOW', 'ALLOW_WITH_LIMITS', 'REQUIRE_EVALUATOR')
  ),
  recommended_max_exposure_usdc NUMERIC(20, 6) NOT NULL CHECK (
    recommended_max_exposure_usdc >= 0
    AND recommended_max_exposure_usdc <= requested_budget_usdc
  ),
  ranking_score SMALLINT NOT NULL CHECK (ranking_score BETWEEN 0 AND 100),
  trust_score SMALLINT NOT NULL CHECK (trust_score BETWEEN 0 AND 100),
  confidence SMALLINT NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  candidate_count SMALLINT NOT NULL CHECK (candidate_count BETWEEN 1 AND 10),
  canonical_hash TEXT NOT NULL UNIQUE CHECK (canonical_hash ~ '^0x[0-9a-fA-F]{64}$'),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^0x[0-9a-fA-F]{64}$'),
  idempotency_key_hash TEXT NOT NULL CHECK (idempotency_key_hash ~ '^0x[0-9a-fA-F]{64}$'),
  selection_payload JSONB NOT NULL CHECK (jsonb_typeof(selection_payload) = 'object'),
  is_public BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > created_at),
  UNIQUE (tenant_key, idempotency_key_hash)
);

CREATE TABLE IF NOT EXISTS public.counterparty_selection_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  selection_id TEXT NOT NULL REFERENCES public.counterparty_selections(selection_id) ON DELETE RESTRICT,
  candidate_agent_id TEXT,
  candidate_wallet TEXT CHECK (candidate_wallet IS NULL OR candidate_wallet ~ '^0x[0-9a-fA-F]{40}$'),
  candidate_service_id TEXT,
  eligibility_status TEXT NOT NULL CHECK (
    eligibility_status IN (
      'ELIGIBLE', 'ELIGIBLE_WITH_LIMITS', 'REQUIRES_EVALUATOR',
      'REVIEW_REQUIRED', 'INELIGIBLE'
    )
  ),
  trust_decision TEXT NOT NULL CHECK (
    trust_decision IN ('ALLOW', 'ALLOW_WITH_LIMITS', 'REQUIRE_EVALUATOR', 'REVIEW_REQUIRED', 'DENY')
  ),
  trust_decision_id TEXT REFERENCES public.trust_decisions(decision_id) ON DELETE RESTRICT,
  trust_score SMALLINT NOT NULL CHECK (trust_score BETWEEN 0 AND 100),
  ranking_score SMALLINT NOT NULL CHECK (ranking_score BETWEEN 0 AND 100),
  confidence SMALLINT NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  recommended_max_exposure_usdc NUMERIC(20, 6) NOT NULL CHECK (recommended_max_exposure_usdc >= 0),
  rank SMALLINT NOT NULL CHECK (rank BETWEEN 1 AND 10),
  capability_match TEXT NOT NULL CHECK (capability_match IN ('exact', 'related', 'generic', 'none')),
  price_kind TEXT NOT NULL CHECK (price_kind IN ('advertised', 'historical', 'unknown')),
  evidence_hash TEXT NOT NULL CHECK (evidence_hash ~ '^0x[0-9a-fA-F]{64}$'),
  rejection_reason TEXT,
  candidate_payload JSONB NOT NULL CHECK (jsonb_typeof(candidate_payload) = 'object'),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (selection_id, evidence_hash)
);

CREATE TABLE IF NOT EXISTS public.counterparty_selection_proofs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  selection_id TEXT NOT NULL UNIQUE REFERENCES public.counterparty_selections(selection_id) ON DELETE RESTRICT,
  canonical_hash TEXT NOT NULL UNIQUE CHECK (canonical_hash ~ '^0x[0-9a-fA-F]{64}$'),
  proof_tx TEXT NOT NULL UNIQUE CHECK (proof_tx ~ '^0x[0-9a-fA-F]{64}$'),
  block_number BIGINT NOT NULL CHECK (block_number > 0),
  proof_status TEXT NOT NULL CHECK (proof_status = 'verified'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.counterparty_selection_clearances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clearance_id TEXT NOT NULL UNIQUE CHECK (clearance_id ~ '^vcl_[0-9a-f]{16}$'),
  selection_id TEXT NOT NULL UNIQUE REFERENCES public.counterparty_selections(selection_id) ON DELETE RESTRICT,
  decision_id TEXT NOT NULL UNIQUE REFERENCES public.trust_decisions(decision_id) ON DELETE RESTRICT,
  clearance_digest TEXT NOT NULL UNIQUE CHECK (clearance_digest ~ '^0x[0-9a-fA-F]{64}$'),
  selection_hash TEXT NOT NULL CHECK (selection_hash ~ '^0x[0-9a-fA-F]{64}$'),
  subject_wallet TEXT NOT NULL CHECK (subject_wallet ~ '^0x[0-9a-fA-F]{40}$'),
  executor_wallet TEXT NOT NULL CHECK (executor_wallet ~ '^0x[0-9a-fA-F]{40}$'),
  counterparty_wallet TEXT NOT NULL CHECK (counterparty_wallet ~ '^0x[0-9a-fA-F]{40}$'),
  max_amount_usdc NUMERIC(20, 6) NOT NULL CHECK (max_amount_usdc >= 0),
  clearance_message JSONB NOT NULL CHECK (jsonb_typeof(clearance_message) = 'object'),
  signature TEXT NOT NULL CHECK (signature ~ '^0x[0-9a-fA-F]+$'),
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > issued_at),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_counterparty_selections_tenant_created
  ON public.counterparty_selections (tenant_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_counterparty_selections_public
  ON public.counterparty_selections (public_id) WHERE is_public;
CREATE INDEX IF NOT EXISTS idx_counterparty_selection_candidates_selection_rank
  ON public.counterparty_selection_candidates (selection_id, rank);
CREATE INDEX IF NOT EXISTS idx_counterparty_selection_candidates_agent
  ON public.counterparty_selection_candidates (candidate_agent_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.reject_counterparty_selection_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'counterparty selection records are immutable';
END;
$$;

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'counterparty_selections',
    'counterparty_selection_candidates',
    'counterparty_selection_proofs',
    'counterparty_selection_clearances'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS reject_%I_update ON public.%I', table_name, table_name);
    EXECUTE format(
      'CREATE TRIGGER reject_%I_update BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.reject_counterparty_selection_mutation()',
      table_name,
      table_name
    );
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', table_name);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', table_name);
    EXECUTE format(
      'DROP POLICY IF EXISTS "Service role access on %s" ON public.%I',
      table_name,
      table_name
    );
    EXECUTE format(
      'CREATE POLICY "Service role access on %s" ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
      table_name,
      table_name
    );
  END LOOP;
END
$$;

CREATE OR REPLACE FUNCTION public.create_counterparty_selection(
  p_selection JSONB,
  p_candidates JSONB,
  p_decisions JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  candidate JSONB;
  decision_row JSONB;
BEGIN
  IF jsonb_typeof(p_selection) <> 'object'
     OR jsonb_typeof(p_candidates) <> 'array'
     OR jsonb_typeof(p_decisions) <> 'array'
     OR jsonb_array_length(p_candidates) < 1
     OR jsonb_array_length(p_candidates) > 10 THEN
    RAISE EXCEPTION 'invalid counterparty selection payload';
  END IF;

  FOR decision_row IN SELECT value FROM jsonb_array_elements(p_decisions)
  LOOP
    INSERT INTO public.trust_decisions (
      decision_id, subject_agent_id, subject_wallet, executor_wallet,
      counterparty_agent_id, counterparty_wallet, action, service_id,
      workflow_type, requested_value_usdc, decision, max_value_usdc,
      snapshot_hash, trust_score, confidence, coverage, snapshot_age_seconds,
      policy_version, evaluator, evaluator_required, reasons, risk_signals,
      canonical_hash, issued_at, expires_at
    ) VALUES (
      decision_row->>'decision_id', decision_row->>'subject_agent_id',
      NULLIF(decision_row->>'subject_wallet', ''), NULLIF(decision_row->>'executor_wallet', ''),
      NULLIF(decision_row->>'counterparty_agent_id', ''), NULLIF(decision_row->>'counterparty_wallet', ''),
      decision_row->>'action', NULLIF(decision_row->>'service_id', ''),
      NULLIF(decision_row->>'workflow_type', ''), (decision_row->>'requested_value_usdc')::NUMERIC,
      decision_row->>'decision', (decision_row->>'max_value_usdc')::NUMERIC,
      NULLIF(decision_row->>'snapshot_hash', ''), (decision_row->>'trust_score')::SMALLINT,
      (decision_row->>'confidence')::DOUBLE PRECISION, (decision_row->>'coverage')::DOUBLE PRECISION,
      (decision_row->>'snapshot_age_seconds')::DOUBLE PRECISION, decision_row->>'policy_version',
      NULLIF(decision_row->>'evaluator', ''), (decision_row->>'evaluator_required')::BOOLEAN,
      decision_row->'reasons', decision_row->'risk_signals', decision_row->>'canonical_hash',
      (decision_row->>'issued_at')::TIMESTAMPTZ, (decision_row->>'expires_at')::TIMESTAMPTZ
    );
  END LOOP;

  INSERT INTO public.counterparty_selections (
    selection_id, public_id, tenant_key, requester_agent_id, requester_wallet,
    machine_credential_id, capability, task_hash, requested_budget_usdc,
    network, require_exact_capability, policy_version, ranking_version,
    recommended_agent_id, recommended_wallet, recommended_service_id, decision,
    recommended_max_exposure_usdc, ranking_score, trust_score, confidence,
    candidate_count, canonical_hash, request_hash, idempotency_key_hash,
    selection_payload, is_public, created_at, expires_at
  ) VALUES (
    p_selection->>'selection_id',
    p_selection->>'public_id',
    p_selection->>'tenant_key',
    NULLIF(p_selection->>'requester_agent_id', ''),
    p_selection->>'requester_wallet',
    NULLIF(p_selection->>'machine_credential_id', '')::UUID,
    p_selection->>'capability',
    p_selection->>'task_hash',
    (p_selection->>'requested_budget_usdc')::NUMERIC,
    p_selection->>'network',
    (p_selection->>'require_exact_capability')::BOOLEAN,
    p_selection->>'policy_version',
    p_selection->>'ranking_version',
    p_selection->>'recommended_agent_id',
    p_selection->>'recommended_wallet',
    NULLIF(p_selection->>'recommended_service_id', ''),
    p_selection->>'decision',
    (p_selection->>'recommended_max_exposure_usdc')::NUMERIC,
    (p_selection->>'ranking_score')::SMALLINT,
    (p_selection->>'trust_score')::SMALLINT,
    (p_selection->>'confidence')::SMALLINT,
    (p_selection->>'candidate_count')::SMALLINT,
    p_selection->>'canonical_hash',
    p_selection->>'request_hash',
    p_selection->>'idempotency_key_hash',
    p_selection->'selection_payload',
    (p_selection->>'is_public')::BOOLEAN,
    (p_selection->>'created_at')::TIMESTAMPTZ,
    (p_selection->>'expires_at')::TIMESTAMPTZ
  );

  FOR candidate IN SELECT value FROM jsonb_array_elements(p_candidates)
  LOOP
    INSERT INTO public.counterparty_selection_candidates (
      selection_id, candidate_agent_id, candidate_wallet, candidate_service_id,
      eligibility_status, trust_decision, trust_decision_id, trust_score,
      ranking_score, confidence, recommended_max_exposure_usdc, rank,
      capability_match, price_kind, evidence_hash, rejection_reason,
      candidate_payload, created_at
    ) VALUES (
      p_selection->>'selection_id',
      NULLIF(candidate->>'candidate_agent_id', ''),
      NULLIF(candidate->>'candidate_wallet', ''),
      NULLIF(candidate->>'candidate_service_id', ''),
      candidate->>'eligibility_status',
      candidate->>'trust_decision',
      NULLIF(candidate->>'trust_decision_id', ''),
      (candidate->>'trust_score')::SMALLINT,
      (candidate->>'ranking_score')::SMALLINT,
      (candidate->>'confidence')::SMALLINT,
      (candidate->>'recommended_max_exposure_usdc')::NUMERIC,
      (candidate->>'rank')::SMALLINT,
      candidate->>'capability_match',
      candidate->>'price_kind',
      candidate->>'evidence_hash',
      NULLIF(candidate->>'rejection_reason', ''),
      candidate->'candidate_payload',
      (p_selection->>'created_at')::TIMESTAMPTZ
    );
  END LOOP;

  RETURN jsonb_build_object(
    'selectionId', p_selection->>'selection_id',
    'canonicalHash', p_selection->>'canonical_hash'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.create_counterparty_selection_clearance(
  p_decision JSONB,
  p_clearance JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.trust_decisions (
    decision_id, subject_agent_id, subject_wallet, executor_wallet,
    counterparty_agent_id, counterparty_wallet, action, service_id,
    workflow_type, requested_value_usdc, decision, max_value_usdc,
    snapshot_hash, trust_score, confidence, coverage, snapshot_age_seconds,
    policy_version, evaluator, evaluator_required, reasons, risk_signals,
    canonical_hash, issued_at, expires_at
  ) VALUES (
    p_decision->>'decision_id',
    p_decision->>'subject_agent_id',
    NULLIF(p_decision->>'subject_wallet', ''),
    NULLIF(p_decision->>'executor_wallet', ''),
    NULLIF(p_decision->>'counterparty_agent_id', ''),
    NULLIF(p_decision->>'counterparty_wallet', ''),
    p_decision->>'action',
    NULLIF(p_decision->>'service_id', ''),
    NULLIF(p_decision->>'workflow_type', ''),
    (p_decision->>'requested_value_usdc')::NUMERIC,
    p_decision->>'decision',
    (p_decision->>'max_value_usdc')::NUMERIC,
    NULLIF(p_decision->>'snapshot_hash', ''),
    (p_decision->>'trust_score')::SMALLINT,
    (p_decision->>'confidence')::DOUBLE PRECISION,
    (p_decision->>'coverage')::DOUBLE PRECISION,
    (p_decision->>'snapshot_age_seconds')::DOUBLE PRECISION,
    p_decision->>'policy_version',
    NULLIF(p_decision->>'evaluator', ''),
    (p_decision->>'evaluator_required')::BOOLEAN,
    p_decision->'reasons',
    p_decision->'risk_signals',
    p_decision->>'canonical_hash',
    (p_decision->>'issued_at')::TIMESTAMPTZ,
    (p_decision->>'expires_at')::TIMESTAMPTZ
  );

  INSERT INTO public.counterparty_selection_clearances (
    clearance_id, selection_id, decision_id, clearance_digest, selection_hash,
    subject_wallet, executor_wallet, counterparty_wallet, max_amount_usdc,
    clearance_message, signature, issued_at, expires_at
  ) VALUES (
    p_clearance->>'clearance_id',
    p_clearance->>'selection_id',
    p_clearance->>'decision_id',
    p_clearance->>'clearance_digest',
    p_clearance->>'selection_hash',
    p_clearance->>'subject_wallet',
    p_clearance->>'executor_wallet',
    p_clearance->>'counterparty_wallet',
    (p_clearance->>'max_amount_usdc')::NUMERIC,
    p_clearance->'clearance_message',
    p_clearance->>'signature',
    (p_clearance->>'issued_at')::TIMESTAMPTZ,
    (p_clearance->>'expires_at')::TIMESTAMPTZ
  );

  RETURN jsonb_build_object(
    'clearanceId', p_clearance->>'clearance_id',
    'decisionId', p_clearance->>'decision_id',
    'clearanceDigest', p_clearance->>'clearance_digest'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_counterparty_selection(JSONB, JSONB, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_counterparty_selection(JSONB, JSONB, JSONB)
  TO service_role;
REVOKE ALL ON FUNCTION public.create_counterparty_selection_clearance(JSONB, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_counterparty_selection_clearance(JSONB, JSONB)
  TO service_role;
