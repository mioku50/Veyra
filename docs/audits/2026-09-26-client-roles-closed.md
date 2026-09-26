# Payment records closed to the Data API's client roles

Found on 26 September, in a read-only check after the Ask Nova migration.

## What was open

**Five tables had no row-level security.** Supabase's default privileges
gave `anon` and `authenticated` every right on them: read, insert, update,
delete and truncate.

| Table | Created by | Holds | Rows visible as `anon` |
| --- | --- | --- | --- |
| `x402_selections` | p92, 16 September | the decision a payment is bound to: who may be paid, where, up to what | 1 |
| `x402_quotes` | p92 | each quote bound to a decision, and its settlement state | 1 |
| `execution_mandates` | p61, 15 August | an owner's signed spend mandates and their caps | 2 |
| `execution_mandate_usage` | p61 | the budget each mandate has used | 0 |
| `execution_attempts` | p61 | each execution: counterparty, amounts, state | 8 |

The one sequence in `public`, which numbers `execution_mandate_usage`, was
open to the same roles.

**Eight SECURITY DEFINER functions could be run by `anon` and
`authenticated`.** A definer runs as its owner, so row-level security alone
would not have closed them.
- Seven move these tables' state:
  - `create_x402_quote`, `claim_x402_quote` and `advance_x402_quote`;
  - `reserve_mandate_budget`, `release_mandate_budget`,
    `settle_mandate_budget` and `settle_execution_budget`.
- The eighth, `redeem_x402_trust_credit_v1`, spends a use of a trust credit.
  p70 revoked it from `PUBLIC`, but `anon` and `authenticated` hold grants of
  their own, and that revoke did not touch them.

The other 31 definer functions were already revoked from all three.

## How far it reached

- **The Data API is on and serves `public`.** The server itself reads and
  writes through it.
- **The site does not advertise it.** The 21 scripts on `/`, `/nova`, `/run`
  and `/agent` name no Supabase project and carry no key. Reaching these
  tables needed the project's URL and its publishable key. Supabase does not
  treat that key as a secret.
- **Whether anyone used it was not checked.** The Data API's request logs
  would show it.

## The fix

Migration `20260926140000_close_payment_records_to_clients`:
- enables row-level security on the five tables, with no policy;
- revokes every right from `anon` and `authenticated` on them and on the
  sequence;
- revokes the eight functions from `PUBLIC`, `anon` and `authenticated`, and
  grants them to `service_role`.

Why nothing breaks:
- The server reaches all of this with the service role only;
  `getServerSupabaseConfig` accepts nothing else. That role bypasses row-level
  security and keeps its grants.
- The definer functions run as their owner, which bypasses row-level security
  too.
- Before the commit, every function signature and relation the migration
  names was resolved against production, read-only. All fourteen exist as
  written.

## So it does not happen again

A new release gate step, "Migrations Leave No Table Or Definer Function
Open", replays every migration in order and fails if either is still open at
the end:
- a public table without row-level security;
- a definer function that `PUBLIC`, `anon` or `authenticated` may run.

It was checked against production:
- Replayed up to `20260926120000`, it finds exactly the five tables and eight
  functions above.
- It tracks the same 83 tables production has.

What it does not see:
- a table created or secured through dynamic SQL of another shape than the
  ones in use. It does read a `DO` block that enables row-level security by
  name, or by `format()` over a literal array of names, as p55 and phase28 do;
- whether a policy lets a client role in.

## Not done

- **The other tables' policies were not reviewed.** Some grant client roles
  access on purpose.
- **The four p61 functions have no pinned `search_path`.** Only the service
  role can run them now.
- **Whether the opening was used.** See above.

## Production, in order

1. **The owner applies the migration** with `npm run db:migrate`. No code
   depends on it, so it can go before or after the deploy.
2. **A read-only check afterwards**, run as `anon`: every table shows no rows
   or refuses, and no definer function runs.
