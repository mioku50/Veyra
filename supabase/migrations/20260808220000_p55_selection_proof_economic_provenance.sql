-- P5.5 proof hardening: a selection proof must reuse real economic evidence.
-- No fabricated zero-value AgentCommerceProofRegistry entry is permitted.

ALTER TABLE public.counterparty_selection_proofs
  ADD COLUMN IF NOT EXISTS evidence_source TEXT NOT NULL
    CHECK (evidence_source = 'erc8183_job'),
  ADD COLUMN IF NOT EXISTS evidence_source_id TEXT NOT NULL
    CHECK (evidence_source_id ~ '^[0-9]+$'),
  ADD COLUMN IF NOT EXISTS evidence_amount_usdc NUMERIC(20, 6) NOT NULL
    CHECK (evidence_amount_usdc > 0),
  ADD COLUMN IF NOT EXISTS evidence_tx TEXT NOT NULL
    CHECK (evidence_tx ~ '^0x[0-9a-fA-F]{64}$');
