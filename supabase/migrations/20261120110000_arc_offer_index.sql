-- Public-catalogue listings and sanitized, unpaid x402 observations.
CREATE TABLE public.arc_offer_index (
    resource_key TEXT PRIMARY KEY CHECK (resource_key ~ '^[0-9a-f]{64}$'),
    resource TEXT NOT NULL,
    hostname TEXT NOT NULL,
    method TEXT NOT NULL CHECK (method IN ('GET', 'POST')),
    sources TEXT[] NOT NULL CHECK (cardinality(sources) > 0 AND sources <@ ARRAY['circle', 'bazaar', 'erc8004']),
    listed_amount TEXT NOT NULL CHECK (listed_amount ~ '^[0-9]{1,30}$'),
    listed_payee TEXT NOT NULL CHECK (listed_payee ~ '^0x[0-9a-f]{40}$'),
    listed_rail TEXT NOT NULL CHECK (listed_rail IN ('wallet', 'gateway_deposit')),
    listed_at TIMESTAMPTZ NOT NULL,
    last_checked_at TIMESTAMPTZ,
    lease_until TIMESTAMPTZ
);
CREATE INDEX arc_offer_index_due_idx ON public.arc_offer_index (last_checked_at NULLS FIRST, resource_key);
CREATE INDEX arc_offer_index_listed_idx ON public.arc_offer_index (listed_at DESC, resource_key);

CREATE TABLE public.arc_offer_checks (
    resource_key TEXT NOT NULL REFERENCES public.arc_offer_index(resource_key) ON DELETE CASCADE,
    checked_at TIMESTAMPTZ NOT NULL,
    http_status INTEGER CHECK (http_status BETWEEN 100 AND 599),
    error_category TEXT NOT NULL,
    arc_challenge BOOLEAN NOT NULL,
    live_amount TEXT CHECK (live_amount ~ '^[0-9]{1,30}$'),
    live_payee TEXT CHECK (live_payee ~ '^0x[0-9a-f]{40}$'),
    live_rail TEXT CHECK (live_rail IN ('wallet', 'gateway_deposit')),
    listed_amount TEXT NOT NULL,
    listed_payee TEXT NOT NULL,
    drift TEXT[] NOT NULL,
    failed_checks TEXT[] NOT NULL,
    PRIMARY KEY (resource_key, checked_at)
);
CREATE INDEX arc_offer_checks_checked_idx ON public.arc_offer_checks (checked_at);
ALTER TABLE public.arc_offer_index ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.arc_offer_checks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.arc_offer_index, public.arc_offer_checks FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.arc_offer_index TO service_role;
GRANT SELECT, INSERT, DELETE ON public.arc_offer_checks TO service_role;

-- Start a fresh check when the current terms change. A pending probe of the
-- previous terms cannot complete against the new listing.
CREATE FUNCTION public.requeue_changed_arc_offer()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF NEW.listed_at < OLD.listed_at THEN RETURN OLD; END IF;
    IF (OLD.listed_amount, OLD.listed_payee, OLD.listed_rail) IS DISTINCT FROM
       (NEW.listed_amount, NEW.listed_payee, NEW.listed_rail) THEN
        NEW.last_checked_at := NULL;
        NEW.lease_until := NULL;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.requeue_changed_arc_offer() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER arc_offer_terms_changed BEFORE UPDATE ON public.arc_offer_index
    FOR EACH ROW EXECUTE FUNCTION public.requeue_changed_arc_offer();

-- Limit the number of siblings from any one host. Row locks and the lease
-- keep overlapping workers from sending the same batch. Interrupted batches
-- become due after the lease, and failed HTTP checks still advance the queue.
CREATE FUNCTION public.claim_arc_offer_checks()
RETURNS SETOF public.arc_offer_index LANGUAGE sql SET search_path = '' AS $$
    WITH ranked AS (
        SELECT resource_key, last_checked_at,
               row_number() OVER (PARTITION BY hostname ORDER BY last_checked_at NULLS FIRST, resource_key) AS host_rank
        FROM public.arc_offer_index
        WHERE listed_at >= now() - interval '7 days'
          AND (last_checked_at IS NULL OR last_checked_at < now() - interval '72 hours')
          AND (lease_until IS NULL OR lease_until <= now())
    ), locked AS (
        SELECT offers.resource_key
        FROM public.arc_offer_index offers JOIN ranked USING (resource_key)
        WHERE ranked.host_rank <= 24
          AND (offers.last_checked_at IS NULL OR offers.last_checked_at < now() - interval '72 hours')
          AND (offers.lease_until IS NULL OR offers.lease_until <= now())
        ORDER BY ranked.last_checked_at NULLS FIRST, ranked.host_rank, offers.resource_key
        LIMIT 72
        FOR UPDATE OF offers SKIP LOCKED
    )
    UPDATE public.arc_offer_index offers
       SET lease_until = now() + interval '5 minutes'
      FROM locked
     WHERE offers.resource_key = locked.resource_key
    RETURNING offers.*;
$$;
REVOKE ALL ON FUNCTION public.claim_arc_offer_checks() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_arc_offer_checks() TO service_role;

CREATE FUNCTION public.save_arc_offer_check(p_key TEXT, p_lease TIMESTAMPTZ, p_check JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
    checked public.arc_offer_checks;
BEGIN
    checked := jsonb_populate_record(NULL::public.arc_offer_checks, p_check);
    UPDATE public.arc_offer_index
       SET last_checked_at = checked.checked_at, lease_until = NULL
     WHERE resource_key = p_key AND lease_until = p_lease AND lease_until > now();
    IF NOT FOUND THEN
        RETURN false;
    END IF;
    checked.resource_key := p_key;
    INSERT INTO public.arc_offer_checks SELECT (checked).*;
    RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.save_arc_offer_check(TEXT, TIMESTAMPTZ, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_arc_offer_check(TEXT, TIMESTAMPTZ, JSONB) TO service_role;
