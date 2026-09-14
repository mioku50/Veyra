-- P8.3 -- what a verified purchase means, in words.
--
-- A verified purchase ended at a <pre> full of JSON. Veyra priced it, cleared
-- it, and checked the answer against what the endpoint promised -- and then
-- handed over the raw body, which is where the flow stops looking like an agent
-- doing work and starts looking like a fetch with a receipt.
--
-- The reading is kept beside the result, never inside `verification`. That
-- column holds a check Veyra ran itself; this one holds prose a model wrote
-- about material a seller sold. Collapsing them would make the one fact a
-- reader most needs to trust indistinguishable from the one they should read
-- with their eyes open.
--
-- Nullable, and it stays nullable. The model can be down, unconfigured, or
-- answer in a shape nothing can be made of, and none of that may cost somebody
-- the purchase they already paid for.

ALTER TABLE public.nova_research
    ADD COLUMN IF NOT EXISTS reading JSONB;

COMMENT ON COLUMN public.nova_research.reading IS
    'Model-written reading of a verified result: what changed, why it matters, what to watch next, plus a provenance line Veyra composed from its own facts. Never a substitute for verification.';
