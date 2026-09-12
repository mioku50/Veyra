-- Copyright 2026 Veyra
-- SPDX-License-Identifier: Apache-2.0

-- P5.3 Agent Reputation Evidence Table
CREATE TABLE IF NOT EXISTS public.agent_reputation_evidence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    tier INT NOT NULL DEFAULT 0,
    source_id TEXT NOT NULL,
    source_hash TEXT,
    score DOUBLE PRECISION,
    positive BOOLEAN NOT NULL DEFAULT TRUE,
    confidence DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    economic_value_usdc DOUBLE PRECISION DEFAULT 0.0,
    counterparty_address TEXT,
    verified_onchain BOOLEAN NOT NULL DEFAULT FALSE,
    arc_proof_verified BOOLEAN NOT NULL DEFAULT FALSE,
    sybil_risk TEXT NOT NULL DEFAULT 'none',
    observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    canonical_hash TEXT NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_agent_evidence_canonical UNIQUE (agent_id, source_id, canonical_hash)
);

CREATE INDEX IF NOT EXISTS idx_reputation_evidence_agent_id ON public.agent_reputation_evidence (agent_id);
CREATE INDEX IF NOT EXISTS idx_reputation_evidence_type ON public.agent_reputation_evidence (evidence_type);
CREATE INDEX IF NOT EXISTS idx_reputation_evidence_observed ON public.agent_reputation_evidence (observed_at DESC);

-- P5.3 Agent Reputation Snapshots Table
CREATE TABLE IF NOT EXISTS public.agent_reputation_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    snapshot_id TEXT UNIQUE NOT NULL,
    agent_id TEXT NOT NULL,
    trust_score INT NOT NULL,
    identity_score INT NOT NULL,
    execution_score INT NOT NULL,
    validation_score INT NOT NULL,
    economic_reliability_score INT NOT NULL,
    service_quality_score INT NOT NULL,
    reputation_score INT NOT NULL,
    coverage DOUBLE PRECISION NOT NULL,
    confidence TEXT NOT NULL,
    status_label TEXT NOT NULL,
    evidence_count INT NOT NULL,
    economic_evidence_count INT NOT NULL,
    canonical_hash TEXT NOT NULL,
    arc_proof_tx TEXT,
    snapshot_payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reputation_snapshots_agent_id ON public.agent_reputation_snapshots (agent_id);
CREATE INDEX IF NOT EXISTS idx_reputation_snapshots_created ON public.agent_reputation_snapshots (created_at DESC);

-- RLS Policies
ALTER TABLE public.agent_reputation_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_reputation_snapshots ENABLE ROW LEVEL SECURITY;

-- Anon/Authenticated no direct raw access; service_role full access
DROP POLICY IF EXISTS "Service role access for evidence" ON public.agent_reputation_evidence;
CREATE POLICY "Service role access for evidence" ON public.agent_reputation_evidence
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role access for snapshots" ON public.agent_reputation_snapshots;
CREATE POLICY "Service role access for snapshots" ON public.agent_reputation_snapshots
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Public read access for snapshots" ON public.agent_reputation_snapshots;
CREATE POLICY "Public read access for snapshots" ON public.agent_reputation_snapshots
    FOR SELECT TO anon, authenticated USING (true);
