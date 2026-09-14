-- P8.5 -- a verified purchase becomes a record on Arc.
--
-- The Arc page said Nova is not an identity on Arc yet, and it was right in a
-- way nobody had noticed: the proof registry has been deployed, verified and
-- configured on Arc this whole time, and not one Nova row ever reached it.
-- Every verified purchase lived only in Postgres, where Veyra is the sole
-- witness -- the one arrangement a trust product cannot defend, because the
-- party making the claim also owns the record.
--
-- This column holds the receipt for the other half: the registry, the chain,
-- the attester and the transaction that recorded who paid whom, how much, and
-- the hashes of what was asked and what came back.
--
-- Nullable, and it stays nullable. Arc can be down, the attester can be
-- unfunded, the transaction can revert, and none of that may take away a
-- result somebody already paid for. Same rule as the reading beside it.

ALTER TABLE public.nova_research
    ADD COLUMN IF NOT EXISTS arc_proof JSONB;

COMMENT ON COLUMN public.nova_research.arc_proof IS
    'Where this purchase was recorded on Arc: {receiptId, transaction, chainId, registry, attester, explorerUrl, registeredAt}. Written only for a verified purchase, and never at the cost of one.';
