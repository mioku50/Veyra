-- Questions the owner asks Nova directly.
--
-- A question is the owner's own need, so no reading has to establish it. Nova
-- first reads Arc's and Circle's documentation for it, at no charge. Only when
-- that does not answer it does Nova look for a paid tool on Arc. What was
-- checked, and what it said, is kept here. A paid tool, once proposed, is a
-- nova_research row pointing at the question.
CREATE TABLE public.nova_questions (
    question_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES public.nova_agents(agent_id) ON DELETE CASCADE,
    question TEXT NOT NULL CHECK (char_length(question) BETWEEN 8 AND 400),
    -- The English words the documentation index and the market were searched
    -- with. The question itself is what a seller is sent.
    search_terms TEXT[] NOT NULL DEFAULT '{}',
    -- The pages checked, whether they answer the question, the answer, and
    -- the passages it stands on.
    docs JSONB NOT NULL CHECK (jsonb_typeof(docs) = 'object'),
    -- The last time Veyra looked for a paid tool and put none in front of the
    -- owner, and why. Cleared when a tool is proposed.
    refusal JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX nova_questions_agent_idx ON public.nova_questions(agent_id, created_at DESC);
ALTER TABLE public.nova_questions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.nova_questions FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.nova_questions TO service_role;
COMMENT ON TABLE public.nova_questions IS
  'Questions the owner asked Nova, with the free documentation lookup made for each. A paid tool for one is a nova_research row with question_id set.';

-- A paid tool for a question is proposed, approved and settled exactly like
-- one for a card. Its row points at the question instead of a signal, and
-- never at both. Existing rows all point at a signal, so the check holds for
-- them as they are.
ALTER TABLE public.nova_research ALTER COLUMN signal_id DROP NOT NULL;
ALTER TABLE public.nova_research
    ADD COLUMN question_id UUID REFERENCES public.nova_questions(question_id) ON DELETE CASCADE;
ALTER TABLE public.nova_research
    ADD CONSTRAINT nova_research_one_subject CHECK ((signal_id IS NULL) <> (question_id IS NULL));
CREATE INDEX nova_research_question_idx
    ON public.nova_research(question_id, created_at DESC)
    WHERE question_id IS NOT NULL;
COMMENT ON COLUMN public.nova_research.question_id IS
  'The owner''s question this purchase answers, when it was not proposed from a card. Exactly one of signal_id and question_id is set.';
