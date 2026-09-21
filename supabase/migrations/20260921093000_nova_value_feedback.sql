-- Per-result usefulness, separate from spending-policy calibration.
CREATE TABLE public.nova_value_feedback (
  signal_id UUID NOT NULL REFERENCES public.nova_signals(signal_id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES public.nova_agents(agent_id) ON DELETE CASCADE,
  assessment_at TIMESTAMPTZ NOT NULL,
  goal TEXT NOT NULL CHECK (char_length(goal) BETWEEN 1 AND 600),
  feedback TEXT NOT NULL CHECK (feedback IN ('useful','not_interesting')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (signal_id, assessment_at)
);
CREATE INDEX nova_value_feedback_agent_idx ON public.nova_value_feedback(agent_id, updated_at);
ALTER TABLE public.nova_value_feedback ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.nova_value_feedback FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.nova_value_feedback TO service_role;
COMMENT ON TABLE public.nova_value_feedback IS 'Owner feedback on a specific public-source assessment; never inferred from WOULD_ALLOW or a payment.';
