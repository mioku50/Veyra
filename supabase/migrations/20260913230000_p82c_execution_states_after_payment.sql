-- P8.2c -- the ledger could not record any outcome where money had moved.
--
-- execution_attempts.state was constrained to the fourteen states that existed
-- when P6.1 was written. The state machine has grown five more since, and every
-- one of them describes a moment after the payment left:
--
--   WAITING_FOR_PROVIDER    asked for, not yet answered
--   SETTLEMENT_UNVERIFIED   no receipt came back, so whether it charged is unknown
--   EVIDENCE_PENDING        answered, evidence still being gathered
--   COMPLETED_UNPROVEN      answered and paid, verification inconclusive
--   SETTLED_SERVICE_FAILED  money gone, goods not delivered
--
-- Because closeBrowserX402Attempt deliberately swallows a ledger failure -- a
-- ledger that is down must not strand a purchase the user already signed for --
-- the constraint violation was invisible. The row simply stayed at EXECUTING
-- with a null amount and a null transaction, while the user's USDC was gone.
--
-- The first real browser-signed x402 payment this product ever settled is one
-- of those rows. The account of record said the payment was still in flight.

ALTER TABLE execution_attempts DROP CONSTRAINT IF EXISTS execution_attempts_state_check;

ALTER TABLE execution_attempts ADD CONSTRAINT execution_attempts_state_check CHECK (state IN (
    'DRAFT',
    'PREPARED',
    'AUTHORIZED',
    'EXECUTING',
    'SUBMITTED',
    'WAITING_FOR_PROVIDER',
    'EVALUATING',
    'SETTLING',
    'SETTLEMENT_UNVERIFIED',
    'EVIDENCE_PENDING',
    'COMPLETED_UNPROVEN',
    'COMPLETED',
    'SETTLED_SERVICE_FAILED',
    'REJECTED',
    'EXPIRED',
    'CANCELLED',
    'FAILED',
    'SETTLEMENT_FAILED',
    'EVALUATION_REJECTED'
));
