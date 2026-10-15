-- Prepare before deploying the matching Nova reader. Historical rows remain
-- NULL: aggregate failures cannot be reconstructed as individual attempts.
ALTER TABLE public.nova_refreshes
  ADD COLUMN reliability JSONB DEFAULT NULL
  CHECK (reliability IS NULL OR (
    jsonb_typeof(reliability) = 'object'
    AND reliability ?& ARRAY['version', 'readings', 'github']
    AND reliability->>'version' = '1'
    AND jsonb_typeof(reliability->'readings') = 'array'
    AND jsonb_typeof(reliability->'github') = 'array'
  ));

COMMENT ON COLUMN public.nova_refreshes.reliability IS
  'Versioned reading attempts (event/source IDs, model, rules, parser, outcome/code) and GitHub request outcomes. No prompts, raw responses, source text or credentials. NULL means not recorded, not zero attempts.';
