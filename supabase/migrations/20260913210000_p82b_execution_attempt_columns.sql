-- P8.2b: the execution ledger gets the five columns its writer has always sent
-- Version: 20260913210000
-- Description: `saveExecutionAttempt` writes provider_content_uri,
-- provider_content_hash, provider_content_type, provider_submitted_at and
-- x402_context. This database has never had any of them, and no migration in
-- this repository ever declared them.
--
-- The effect was not an error anybody saw. PostgREST rejects an insert naming a
-- column that does not exist, `openBrowserX402Attempt` catches that on purpose
-- -- "a ledger that is down must not stop a purchase the user already signed
-- for" -- logs `execution_attempt_not_opened`, returns null, and the payment
-- proceeds. Correct behaviour for an outage. Except this was not an outage: the
-- insert could never have succeeded, so every browser-signed x402 purchase this
-- product has ever relayed went unrecorded, on /run as well as in Nova.
--
-- Measured before writing this: SELECT COUNT(*) FROM execution_attempts -> 0.
--
-- It matters beyond the audit trail. A Nova learning carries the execution it
-- came from, which is the difference between "Verified by Veyra" being a claim
-- and being a receipt. With no execution id there is no receipt to carry.
--
-- All five are nullable. Nothing backfills, because nothing can: the rows that
-- would have held this were never written.

ALTER TABLE public.execution_attempts
    -- What the provider submitted, for an ERC-8183 job: where it is, what it
    -- hashes to, what kind of thing it is, and when it arrived.
    ADD COLUMN IF NOT EXISTS provider_content_uri TEXT,
    ADD COLUMN IF NOT EXISTS provider_content_hash TEXT,
    ADD COLUMN IF NOT EXISTS provider_content_type TEXT,
    ADD COLUMN IF NOT EXISTS provider_submitted_at TIMESTAMPTZ,
    -- The signed authorization in full: payer, payee, asset, network, amount,
    -- nonce, signature and expiry. Filled completely on purpose, so a
    -- settlement can be reconciled against the chain later independently of
    -- whatever the seller said in its response.
    ADD COLUMN IF NOT EXISTS x402_context JSONB;
