-- The ERC-8004 identity registry on Arc mainnet, read once a day.
--
-- Nova's brief and Veyra's counterparty selection read Circle's catalogue
-- only, so no seller registered on Arc reached anyone. The owner asked for
-- full Arc discovery on 2026-09-26, and dropped the Coinbase Bazaar from it:
-- it lists almost nothing on Arc.
--
-- Reading the registry takes a minute or more: identities, registration
-- files, the endpoints those declare, and each offer's own unpaid 402
-- challenge. A scheduled job does it once a day and keeps the result here, and
-- discovery reads the latest row.
--
-- One row per read. The offers are Veyra's normalised records (lib/discovery),
-- not the sellers' documents: resource, method, the accepts that passed
-- Veyra's own USDC and GatewayWallet table, and the ERC-8004 identity that
-- declares each one, with whether its endpoint names it back. Nothing here is
-- a price anyone will pay: the terms that can be signed are read from the
-- live challenge for the exact request, as for any other seller.
CREATE TABLE public.arc_registry_snapshots (
    snapshot_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version TEXT NOT NULL,
    registry TEXT NOT NULL,
    taken_at TIMESTAMPTZ NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- False when the time budget stopped the read before every identity, file
    -- and endpoint was reached. What it reached is still kept.
    complete BOOLEAN NOT NULL,
    identities INTEGER NOT NULL CHECK (identities >= 0),
    files_read INTEGER NOT NULL DEFAULT 0 CHECK (files_read >= 0),
    files_unreadable INTEGER NOT NULL DEFAULT 0 CHECK (files_unreadable >= 0),
    declaring_x402 INTEGER[] NOT NULL DEFAULT '{}',
    endpoints_unreadable INTEGER NOT NULL DEFAULT 0 CHECK (endpoints_unreadable >= 0),
    challenges_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (challenges_confirmed >= 0),
    challenges_unconfirmed INTEGER NOT NULL DEFAULT 0 CHECK (challenges_unconfirmed >= 0),
    challenges_not_checked INTEGER NOT NULL DEFAULT 0 CHECK (challenges_not_checked >= 0),
    left_out_templated INTEGER NOT NULL DEFAULT 0 CHECK (left_out_templated >= 0),
    left_out_no_accept INTEGER NOT NULL DEFAULT 0 CHECK (left_out_no_accept >= 0),
    offers JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(offers) = 'array')
);
CREATE INDEX arc_registry_snapshots_taken_idx ON public.arc_registry_snapshots(taken_at DESC);
ALTER TABLE public.arc_registry_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.arc_registry_snapshots FROM anon, authenticated;
GRANT SELECT, INSERT ON public.arc_registry_snapshots TO service_role;
COMMENT ON TABLE public.arc_registry_snapshots IS
  'One row per daily read of the ERC-8004 identity registry on Arc mainnet: counts, and the offers its identities declare, as Veyra normalised them. Read by discovery; never a price to pay.';
