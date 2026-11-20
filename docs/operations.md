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

## Arc Trust API adoption

The database owner applies migration `20261120090200_veyra_adoption_metrics.sql`.
Enable measurement on the next Vercel production deployment by setting the
server-only `VEYRA_ADOPTION_METRICS_SECRET` to a random 32-byte key encoded as 64
hex characters. Collection also requires Vercel to expose its `VERCEL_ENV`
system variable. Leave the key unset to disable collection. Changing it during
a UTC week can split that week's counts.

Read the weekly aggregates as the database owner or server role:

```sql
SELECT * FROM public.veyra_adoption_weekly ORDER BY week DESC LIMIT 5;
```

- `rest_verdict_callers` and `mcp_verdict_callers` count distinct weekly
  pseudonyms that got a free verdict. `verdict_callers` deduplicates across the
  two channels. MCP discovery, tool listing, and the history preview are excluded.
- `paid_history_callers` counts distinct weekly pseudonyms whose Arc mainnet
  history payment the Circle facilitator reported as successful. Payment
  confirmation is recorded separately from successful delivery.
- `verdict_to_paid_history_callers` counts pseudonyms with a successful history
  payment after a free verdict in the same Monday-to-Sunday UTC week. Divide by
  `verdict_callers` for the observed same-week conversion rate when it is nonzero.

The server derives the pseudonym from Vercel's forwarded network address and
the UTC week using a keyed hash. The telemetry table stores one row per
pseudonym per week with first verdict and latest paid-history timestamps. It
stores no raw address, request content, payment data, cookies, or wallet
identifiers. The table and report are private to the server role and database
administrators. Requests with `Sec-GPC: 1` are omitted. Send this header on
operator smoke checks to omit them from the measurement.

Counts measure network addresses. Shared addresses can merge different callers,
while network changes or a week boundary can split one caller. Owner activity and
bots can be included. Check the deployment setting and
`veyra_adoption_event_not_recorded` warnings before interpreting absent rows.
Collection runs after responding and starts when enabled, with no historical
backfill.

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

## Arc offer index

Apply `supabase/migrations/20261120110000_arc_offer_index.sql` before enabling the index in a deployment. The GitHub Actions workflow **Arc Offer Index** uses the scheduler's existing `CRON_SECRET` and `VEYRA_BASE_URL`. It runs a nightly catalogue read and requests hourly verification batches. After rollout, dispatch **listings** followed by **checks** to fill the index and verify that a result reaches `/check`.

Circle Discovery, Coinbase Bazaar and the current Arc ERC-8004 snapshot supply public Arc Mainnet listings. The nightly summary counts indexed endpoints and reports each source as complete, partial or unavailable. A partial read preserves earlier listings until they age out after seven days. Bazaar feeds the public index. The buyer's discovery configuration is separate.

Each batch leases at most 72 endpoints and sends one unpaid request per listing, using the listed HTTP method. The schedule is best effort, and an interrupted lease expires after five minutes. Checked endpoints become eligible again after 72 hours, or when the listed terms change. Actual coverage depends on completed batches and the source inventory. Check results are retained for 30 days. An Arc USDC challenge shows the terms the endpoint advertised for that request. It provides no settlement or delivery evidence.

`/api/status` includes Nova's last persisted scheduler tick. A stale status warrants checking the **Nova Scheduler** workflow and its latest run. Due briefs can refresh in two concurrent workers within the shared tick budget.
