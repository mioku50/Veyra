-- P9.2 -- before money moves, Veyra must have decided, and the decision must outlive the request.
--
-- The browser x402 relay authenticated its caller and then took the decision
-- itself from that caller: selection id, selection hash, clearance digest,
-- counterparty, capability and -- worst of all -- whether the purchase needed
-- verifying. The server re-derived none of it. Veyra's own promise, that every
-- payment passes its policy, was a convention the client was trusted to follow.
--
-- It could not do better, because there was nothing to re-derive from.
-- Marketplace selection is computed in memory and returned; nothing is written.
-- That was a deliberate choice, and a defensible one while the verdict was
-- advice about a third-party endpoint. It stops being advice at the moment
-- Veyra's own relay moves money on the strength of it.
--
-- Two envelopes, because they answer two different questions and expire on two
-- different clocks:
--
--   x402_selections -- WHO may be paid, for what, up to how much, under which
--     tier, on which evidence. Immutable. Written when the decision is made.
--
--   x402_quotes -- WHAT exact call will be signed: this body, this price, this
--     payee, this asset, this chain. Single-use. Written when the price is
--     observed, claimed once when the authorization is relayed.
--
-- The clearance SIGNATURE is deliberately absent from both. The digest is
-- evidence and is kept; the signature is authority, and the only thing that
-- needs it is consumeClearance, which this rail never calls -- the browser x402
-- path uses a zero hook. A secret with no consumer is a leak waiting for a
-- reason. When a consumer exists, the column arrives with a retention rule.

-- ---------------------------------------------------------------------------
-- The decision envelope
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.x402_selections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  selection_id TEXT NOT NULL UNIQUE CHECK (selection_id ~ '^vms_[0-9a-f]{16}$'),
  tenant_key TEXT NOT NULL,
  owner_wallet TEXT NOT NULL CHECK (owner_wallet ~ '^0x[0-9a-fA-F]{40}$'),
  requester_agent_id TEXT,

  -- What was chosen, named the way the catalog names it.
  candidate_id TEXT NOT NULL,
  resource TEXT NOT NULL CHECK (resource ~ '^https?://'),
  -- The catalog publishes this per endpoint. The browser used to send POST
  -- unconditionally, so a GET endpoint could be quoted as a POST.
  method TEXT NOT NULL CHECK (method IN ('GET', 'POST')),
  capability TEXT NOT NULL,

  -- Where the money may go, and in what.
  pay_to TEXT NOT NULL CHECK (pay_to ~ '^0x[0-9a-fA-F]{40}$'),
  settlement_network TEXT NOT NULL,
  asset TEXT NOT NULL CHECK (asset ~ '^0x[0-9a-fA-F]{40}$'),
  -- Atomic, never a float: a ceiling compared in USDC decimals is a ceiling
  -- that rounds, and it rounds in the direction of spending more.
  max_exposure_atomic NUMERIC(78, 0) NOT NULL CHECK (max_exposure_atomic >= 0),

  -- The verdict, and what it demands.
  decision TEXT NOT NULL CHECK (decision IN ('ALLOW', 'ALLOW_WITH_LIMITS', 'REQUIRE_EVALUATOR')),
  verification_required BOOLEAN NOT NULL,
  policy_version TEXT NOT NULL,

  -- What it rested on, and what proves it was issued.
  evidence_hash TEXT CHECK (evidence_hash IS NULL OR evidence_hash ~ '^0x[0-9a-fA-F]{64}$'),
  selection_hash TEXT NOT NULL CHECK (selection_hash ~ '^0x[0-9a-fA-F]{64}$'),
  clearance_digest TEXT CHECK (clearance_digest IS NULL OR clearance_digest ~ '^0x[0-9a-fA-F]{64}$'),

  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > created_at)
);

COMMENT ON TABLE public.x402_selections IS
  'Immutable record of a Veyra decision that may authorize a payment: who may be paid, on which endpoint and method, in which asset on which chain, up to what atomic ceiling, under which policy tier, on which evidence. Written when the decision is made, never updated. Holds the clearance digest as evidence and deliberately not the clearance signature, which is authority and has no consumer on this rail.';

-- Immutable means immutable, enforced where the rows live rather than in the
-- one code path that happens to write them today.
CREATE OR REPLACE FUNCTION public.reject_x402_selection_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'x402_selections rows are immutable once written (attempted %)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS x402_selections_immutable ON public.x402_selections;
CREATE TRIGGER x402_selections_immutable
  BEFORE UPDATE OR DELETE ON public.x402_selections
  FOR EACH ROW EXECUTE FUNCTION public.reject_x402_selection_mutation();

CREATE INDEX IF NOT EXISTS x402_selections_owner_created_idx
  ON public.x402_selections (lower(owner_wallet), created_at DESC);

-- ---------------------------------------------------------------------------
-- The spend envelope
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.x402_quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id TEXT NOT NULL UNIQUE CHECK (quote_id ~ '^vq_[0-9a-f]{32}$'),
  selection_id TEXT NOT NULL REFERENCES public.x402_selections(selection_id) ON DELETE RESTRICT,
  owner_wallet TEXT NOT NULL CHECK (owner_wallet ~ '^0x[0-9a-fA-F]{40}$'),

  -- Copied from the selection rather than accepted from a caller, so the two
  -- cannot disagree about which endpoint is being paid.
  resource TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('GET', 'POST')),

  -- The body, as a binding and not as a copy. Raw request bodies are the
  -- caller's data and are never stored: the hash is what proves the body being
  -- paid for is the body that was priced, and nothing here needs more.
  request_body_hash TEXT NOT NULL CHECK (request_body_hash ~ '^0x[0-9a-fA-F]{64}$'),

  -- Exactly what the wallet will be asked to sign.
  amount_atomic NUMERIC(78, 0) NOT NULL CHECK (amount_atomic > 0),
  pay_to TEXT NOT NULL CHECK (pay_to ~ '^0x[0-9a-fA-F]{40}$'),
  asset TEXT NOT NULL CHECK (asset ~ '^0x[0-9a-fA-F]{40}$'),
  network TEXT NOT NULL,
  -- The EIP-712 domain the signature is separated by: the token for a vanilla
  -- accept, Circle's GatewayWallet for a batched one. Recorded because the two
  -- are reconciled by different means and a row that does not say which it was
  -- gets reconciled by the wrong one.
  verifying_contract TEXT NOT NULL CHECK (verifying_contract ~ '^0x[0-9a-fA-F]{40}$'),
  gateway_batched BOOLEAN NOT NULL,
  payment_requirements_hash TEXT CHECK (payment_requirements_hash IS NULL OR payment_requirements_hash ~ '^0x[0-9a-fA-F]{64}$'),
  authorization_nonce TEXT NOT NULL CHECK (authorization_nonce ~ '^0x[0-9a-fA-F]{64}$'),

  /* QUOTED   -- priced and bound, nothing signed yet
     CLAIMED  -- won by exactly one settle, which is about to relay
     DISPATCHED -- the authorization has left Veyra; it may have been redeemed
     then one of the three terminal readings of what came back.

     CLAIMED and DISPATCHED are separate on purpose. A process that dies between
     them leaves a quote nobody may re-send: after F3, "the HTTP call broke" is
     not evidence that no money moved, and re-relaying an authorization because
     a socket closed is how a purchase gets paid for twice. */
  state TEXT NOT NULL DEFAULT 'QUOTED' CHECK (state IN (
    'QUOTED', 'CLAIMED', 'DISPATCHED', 'SETTLED', 'SETTLEMENT_UNVERIFIED', 'SETTLEMENT_FAILED', 'EXPIRED'
  )),
  execution_id TEXT,

  quoted_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > quoted_at),
  claimed_at TIMESTAMPTZ,
  dispatched_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.x402_quotes IS
  'Single-use record of exactly what one wallet signature may pay for: this body (by hash, never stored raw), this amount, this payee, this asset on this chain, under this EIP-712 domain. Claimed by compare-and-swap so two settles cannot relay the same authorization, and CLAIMED is kept distinct from DISPATCHED because a relay that broke mid-flight must never be retried.';

CREATE INDEX IF NOT EXISTS x402_quotes_selection_idx ON public.x402_quotes (selection_id);
CREATE INDEX IF NOT EXISTS x402_quotes_owner_quoted_idx ON public.x402_quotes (lower(owner_wallet), quoted_at DESC);
CREATE INDEX IF NOT EXISTS x402_quotes_open_idx ON public.x402_quotes (expires_at)
  WHERE state IN ('QUOTED', 'CLAIMED');

-- ---------------------------------------------------------------------------
-- Writing a quote is the act of binding it
-- ---------------------------------------------------------------------------

-- There is no way to insert an unbound quote, because inserting one is this
-- function and this function reads the selection first. resource and method are
-- copied from the decision rather than taken as parameters: a caller that
-- cannot name them cannot get them wrong.
CREATE OR REPLACE FUNCTION public.create_x402_quote(
  p_quote_id TEXT,
  p_selection_id TEXT,
  p_owner_wallet TEXT,
  p_request_body_hash TEXT,
  p_amount_atomic NUMERIC,
  p_pay_to TEXT,
  p_asset TEXT,
  p_network TEXT,
  p_verifying_contract TEXT,
  p_gateway_batched BOOLEAN,
  p_payment_requirements_hash TEXT,
  p_authorization_nonce TEXT,
  p_expires_at TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_selection public.x402_selections%ROWTYPE;
  v_now TIMESTAMPTZ := NOW();
BEGIN
  SELECT * INTO v_selection FROM public.x402_selections WHERE selection_id = p_selection_id;
  IF v_selection.selection_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'SELECTION_NOT_FOUND');
  END IF;

  IF lower(v_selection.owner_wallet) <> lower(p_owner_wallet) THEN
    RETURN jsonb_build_object('success', false, 'reason', 'SELECTION_NOT_OWNED');
  END IF;

  /* An expired decision is not a decision. Re-deciding is cheap; a stale
     permission to spend is not, and the whole point of a short-lived selection
     is that the evidence under it was fresh. */
  IF v_selection.expires_at <= v_now THEN
    RETURN jsonb_build_object('success', false, 'reason', 'SELECTION_EXPIRED');
  END IF;

  IF lower(v_selection.pay_to) <> lower(p_pay_to) THEN
    RETURN jsonb_build_object('success', false, 'reason', 'PAYEE_NOT_DECIDED');
  END IF;
  IF lower(v_selection.asset) <> lower(p_asset) THEN
    RETURN jsonb_build_object('success', false, 'reason', 'ASSET_NOT_DECIDED');
  END IF;
  IF v_selection.settlement_network <> p_network THEN
    RETURN jsonb_build_object('success', false, 'reason', 'NETWORK_NOT_DECIDED');
  END IF;
  IF p_amount_atomic > v_selection.max_exposure_atomic THEN
    RETURN jsonb_build_object('success', false, 'reason', 'AMOUNT_ABOVE_DECIDED_CEILING');
  END IF;

  /* Veyra's willingness to relay cannot outlive the decision that authorized
     it. This is not the authorization's own validity window -- Circle's batched
     rail requires that to be a week -- it is how long this server will still
     carry the signature. */
  IF p_expires_at > v_selection.expires_at THEN
    RETURN jsonb_build_object('success', false, 'reason', 'QUOTE_OUTLIVES_SELECTION');
  END IF;

  INSERT INTO public.x402_quotes (
    quote_id, selection_id, owner_wallet, resource, method, request_body_hash,
    amount_atomic, pay_to, asset, network, verifying_contract, gateway_batched,
    payment_requirements_hash, authorization_nonce, state, quoted_at, expires_at
  ) VALUES (
    p_quote_id, p_selection_id, p_owner_wallet, v_selection.resource, v_selection.method,
    p_request_body_hash, p_amount_atomic, p_pay_to, p_asset, p_network,
    p_verifying_contract, p_gateway_batched, p_payment_requirements_hash,
    p_authorization_nonce, 'QUOTED', v_now, p_expires_at
  );

  RETURN jsonb_build_object(
    'success', true,
    'quote_id', p_quote_id,
    'resource', v_selection.resource,
    'method', v_selection.method,
    'verification_required', v_selection.verification_required,
    'decision', v_selection.decision,
    'expires_at', p_expires_at
  );
END;
$$;

COMMENT ON FUNCTION public.create_x402_quote IS
  'Writes a quote only if it is bound to a live decision owned by the same wallet, paying the decided payee in the decided asset on the decided chain, at or below the decided atomic ceiling, and expiring no later than the decision does. Copies resource and method from the decision so no caller can name them.';

-- ---------------------------------------------------------------------------
-- Claiming it is the act of spending it
-- ---------------------------------------------------------------------------

-- Compare-and-swap, so exactly one settle wins a quote. Guarded on the state
-- rather than on an idempotency key: the second caller finds the quote already
-- moved, writes nothing, and is told which state it is in.
CREATE OR REPLACE FUNCTION public.claim_x402_quote(
  p_quote_id TEXT,
  p_owner_wallet TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_quote public.x402_quotes%ROWTYPE;
BEGIN
  SELECT * INTO v_quote FROM public.x402_quotes WHERE quote_id = p_quote_id FOR UPDATE;
  IF v_quote.quote_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'QUOTE_NOT_FOUND');
  END IF;
  IF lower(v_quote.owner_wallet) <> lower(p_owner_wallet) THEN
    RETURN jsonb_build_object('success', false, 'reason', 'QUOTE_NOT_OWNED');
  END IF;
  IF v_quote.state <> 'QUOTED' THEN
    /* Deliberately not an error and deliberately not a retry. A quote past
       QUOTED has already had its authorization handed to a seller, or is being
       handed to one right now. */
    RETURN jsonb_build_object('success', false, 'reason', 'QUOTE_ALREADY_CLAIMED', 'state', v_quote.state);
  END IF;
  IF v_quote.expires_at <= NOW() THEN
    UPDATE public.x402_quotes SET state = 'EXPIRED', closed_at = NOW(), updated_at = NOW()
    WHERE quote_id = p_quote_id;
    RETURN jsonb_build_object('success', false, 'reason', 'QUOTE_EXPIRED');
  END IF;

  UPDATE public.x402_quotes
  SET state = 'CLAIMED', claimed_at = NOW(), updated_at = NOW()
  WHERE quote_id = p_quote_id AND state = 'QUOTED';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'QUOTE_ALREADY_CLAIMED');
  END IF;

  RETURN jsonb_build_object('success', true, 'quote', to_jsonb(v_quote));
END;
$$;

COMMENT ON FUNCTION public.claim_x402_quote IS
  'Compare-and-swap from QUOTED to CLAIMED so exactly one settle may relay a given authorization. A quote already past QUOTED is refused rather than retried: its signature has been handed to a seller, and handing it over again is how one purchase gets paid for twice.';

-- Advancing a claimed quote. Every transition is named, so a state cannot be
-- reached by a caller that simply passed the string it wanted.
CREATE OR REPLACE FUNCTION public.advance_x402_quote(
  p_quote_id TEXT,
  p_expected_state TEXT,
  p_target_state TEXT,
  p_execution_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (
    (p_expected_state = 'CLAIMED' AND p_target_state IN ('DISPATCHED', 'QUOTED'))
    OR (p_expected_state = 'DISPATCHED' AND p_target_state IN ('SETTLED', 'SETTLEMENT_UNVERIFIED', 'SETTLEMENT_FAILED'))
  ) THEN
    RETURN jsonb_build_object('success', false, 'reason', 'ILLEGAL_TRANSITION');
  END IF;

  UPDATE public.x402_quotes
  SET state = p_target_state,
      execution_id = COALESCE(p_execution_id, execution_id),
      dispatched_at = CASE WHEN p_target_state = 'DISPATCHED' THEN NOW() ELSE dispatched_at END,
      claimed_at = CASE WHEN p_target_state = 'QUOTED' THEN NULL ELSE claimed_at END,
      closed_at = CASE
        WHEN p_target_state IN ('SETTLED', 'SETTLEMENT_UNVERIFIED', 'SETTLEMENT_FAILED') THEN NOW()
        ELSE closed_at
      END,
      updated_at = NOW()
  WHERE quote_id = p_quote_id AND state = p_expected_state;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'STATE_MISMATCH');
  END IF;
  RETURN jsonb_build_object('success', true);
END;
$$;

COMMENT ON FUNCTION public.advance_x402_quote IS
  'Moves a claimed quote along its lifecycle under a state guard. CLAIMED may return to QUOTED only when the relay is known not to have been dispatched -- a network failure before any byte left; anything less certain stays CLAIMED, because after F3 a broken HTTP call is not evidence that no money moved.';
