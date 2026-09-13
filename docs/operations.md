# Production operations

Veyra monitors the workflow product as four connected but
independently diagnosable layers:

1. workflow execution;
2. provider execution;
3. user checkout and accounting;
4. Arc proof publication.

The aggregate dashboard is available at `/console/operations`. It intentionally
omits prompts, credential identifiers, wallet identifiers, raw provider
payloads, and raw errors.

## Monitor

Vercel invokes `/api/internal/operations/monitor` daily at 04:07 UTC with
`CRON_SECRET`, which is the maximum native cadence supported by the current
Vercel plan. The dashboard calculates a fresh snapshot on every request. The
same monitor endpoint can be called more frequently by an external scheduler
without a code change. The route returns `404` to unauthorized requests.

Threshold alerts are emitted as structured Vercel error logs. If
`OPERATIONS_ALERT_WEBHOOK_URL` is configured, the same aggregate alert payload
is delivered with two transient-network retries. The webhook payload contains
only alert codes, severity, messages, retry policy, environment, and timestamp.

## Trust webhook delivery

Trust alerts use a separate durable delivery queue. Production Supabase Cron
invokes `/api/internal/webhooks/deliver` every minute because the current
Vercel plan only supports daily native cron jobs. The worker is authorized by
the dedicated sensitive `WEBHOOK_DELIVERY_CRON_SECRET`; its URL and bearer
token are stored in Supabase Vault and are not embedded in the migration or
cron command. `CRON_SECRET` remains a supported route fallback for Vercel's
native internal cron calls.

After applying migrations, configure the production scheduler once:

```bash
npx vercel env run -e production -- \
  npm run webhooks:production-configure -- \
  --confirm-production https://agent-commerce-six.vercel.app
```

The worker claims at most 25 due deliveries atomically. Retry timestamps remain
1 minute, 5 minutes, 30 minutes, 2 hours, and 12 hours after successive failed
attempts. Webhook failure never changes the canonical monitoring snapshot.

## Signals

- workflow failure rate and executions stale for at least ten minutes;
- provider failure rate plus measured paid-call p50/p95 latency;
- settled checkouts, credits/refunds, and unresolved paid checkouts;
- verified, failed, and pending Arc proofs plus p95 verification delay.

Provider latency is measured around the paid provider call and stored in the
private operational `raw` field of the purchase step. It is not added to public
receipt or report payloads.

## Retry rules

- Read-only discovery and provider preflight may retry transient network,
  `502`, `503`, and `504` failures with exponential backoff.
- A paid provider call is single-attempt. A timeout does not authorize a blind
  replay because settlement may already have happened.
- Quote and run mutations must reuse the original `Idempotency-Key` after a
  client timeout.
- A paid workflow failure is reconciled against its existing checkout and
  credit record; it must not create a second charge.
- Arc proof recovery reads the existing registry state and transaction receipt
  before resubmitting the proof for the same payment event.
- Workflow recovery requires the original input and matching input hash because
  full private input is not persisted.

Arc uses deterministic finality. One successful block confirmation is
sufficient for proof verification.
