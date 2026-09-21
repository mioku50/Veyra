-- What the owner says is already true about the work.
--
-- A goal says where somebody is going; this says where they are. Without it a
-- reading can only report that a thing exists, which is how "Arc supports
-- sponsored transactions" reaches a person who shipped against it in July.
--
-- Nova may propose a row and may never confirm one. A proposed statement is
-- the model's inference about the owner's project, and an inference that
-- writes itself into the project's state would be indistinguishable, one week
-- later, from something the owner said. Only 'confirmed' rows are read back
-- into an analysis.
CREATE TABLE public.nova_project_context (
    context_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES public.nova_agents(agent_id) ON DELETE CASCADE,
    statement TEXT NOT NULL CHECK (char_length(statement) BETWEEN 1 AND 200),
    status TEXT NOT NULL CHECK (status IN ('confirmed', 'proposed', 'dismissed')),
    origin TEXT NOT NULL CHECK (origin IN ('owner', 'nova_reading', 'nova_result')),
    -- For a proposal: what Nova read that suggested it. Never a citation the
    -- owner has not seen.
    evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    confirmed_at TIMESTAMPTZ,
    CONSTRAINT nova_project_context_confirmation_is_recorded
      CHECK ((status = 'confirmed') = (confirmed_at IS NOT NULL))
);
CREATE UNIQUE INDEX nova_project_context_statement_idx
  ON public.nova_project_context(agent_id, lower(statement));
CREATE INDEX nova_project_context_agent_idx
  ON public.nova_project_context(agent_id, status, updated_at DESC);
ALTER TABLE public.nova_project_context ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.nova_project_context FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.nova_project_context TO service_role;
COMMENT ON TABLE public.nova_project_context IS
  'Owner-confirmed state of the work a goal is pursued in. Nova proposes; only the owner confirms, and only confirmed rows reach an analysis.';
