-- P8.8 -- a single-use nonce that is actually single-use.
--
-- The signed-header path for execution routes proves a wallet signed a message
-- naming the method, the path, a nonce and a timestamp. Single use was enforced
-- by a Map in the Node process, which on a platform that runs many serverless
-- instances is not enforcement: the same signature replayed a second later
-- lands on a different instance with an empty Map and is accepted. Sixty
-- seconds of that is enough to submit the same authorized action twice.
--
-- A primary key is the cheapest atomic claim there is. Two instances racing the
-- same nonce both INSERT; exactly one gets 23505, and it is the database that
-- decided, not a process that happened to be warm.
--
-- The nonce is not a secret -- it travels in a request header -- but it is
-- stored as a digest and scoped to the wallet it was signed by. Scoping is the
-- part that matters: without it one caller's choice of nonce string could
-- consume another caller's, which turns a replay defence into a way to refuse
-- somebody else's requests.

CREATE TABLE IF NOT EXISTS public.execution_auth_nonces (
    -- sha256(lowercased wallet || '\n' || nonce). Fixed width, caller-chosen
    -- text never stored, and the wallet folded in so two callers cannot collide.
    nonce_digest TEXT PRIMARY KEY,

    -- Kept for support questions only. Never read by the claim, which is the
    -- INSERT itself.
    wallet TEXT NOT NULL,
    method TEXT,
    path TEXT,

    claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- A signed header is valid for sixty seconds, so a row older than the
    -- window can no longer protect anything and only costs space. Pruned
    -- opportunistically by lib/execution/auth-nonce.ts; the index is what makes
    -- that a range scan rather than a table scan.
    expires_at TIMESTAMPTZ NOT NULL
);

COMMENT ON TABLE public.execution_auth_nonces IS
    'Consumed single-use nonces from signed execution-auth headers. A row exists because a valid signature was verified and the nonce was claimed; the primary key is the atomicity. Rows are worthless after expires_at and are pruned, so this table is not an audit log and must not be read as one.';

CREATE INDEX IF NOT EXISTS execution_auth_nonces_expiry_idx
    ON public.execution_auth_nonces (expires_at);

ALTER TABLE public.execution_auth_nonces ENABLE ROW LEVEL SECURITY;
