-- Nova Product Value V1: additive fields; existing histories and signed terms remain.
ALTER TABLE public.nova_agents ADD COLUMN IF NOT EXISTS goal TEXT
  CHECK (goal IS NULL OR char_length(goal) BETWEEN 1 AND 600);
ALTER TABLE public.nova_subjects DROP CONSTRAINT nova_subjects_kind_check;
ALTER TABLE public.nova_subjects ADD CONSTRAINT nova_subjects_kind_check
  CHECK (kind IN ('x402_resource','github_repository','official_publication'));
ALTER TABLE public.nova_signals DROP CONSTRAINT nova_signals_kind_check;
ALTER TABLE public.nova_signals ADD CONSTRAINT nova_signals_kind_check
  CHECK (kind IN ('capability_available','price_changed','payee_changed','endpoint_unreachable',
    'endpoint_recovered','rail_changed','repository_activity','repository_release','official_publication'));
COMMENT ON COLUMN public.nova_agents.goal IS 'Owner-stated research goal. Never an authorization to spend.';
