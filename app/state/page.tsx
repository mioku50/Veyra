/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import type { Metadata } from "next";
import Link from "next/link";
import { BRAND } from "@/lib/brand";
import { ARC_STATE_SQL_GITHUB_URL, ARC_STATE_SQL_PATH } from "@/lib/discovery/arc-state";
import { getCachedArcStateReport } from "@/lib/discovery/arc-state-cache";
import { VEYRA_ORIGIN } from "@/lib/erc8004/veyra-registration";

export const dynamic = "force-dynamic";

const title = "State of Arc x402";
const description =
  `Observed Arc Mainnet x402 market metrics from ${BRAND.name}: active listings, live HTTP 402 validity, catalog drift, host concentration, pricing, and latency.`;

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: `${VEYRA_ORIGIN}/state` },
  openGraph: {
    title: `${title} | ${BRAND.name}`,
    description,
    url: `${VEYRA_ORIGIN}/state`,
  },
  twitter: {
    card: "summary_large_image",
    title: `${title} | ${BRAND.name}`,
    description,
  },
};

const integer = new Intl.NumberFormat("en-US");
const utcTimestamp = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

function formatRate(rate: number | null): string {
  return rate === null ? "—" : `${(rate * 100).toFixed(1)}%`;
}

function formatRateDelta(delta: number | null): string {
  if (delta === null) return "—";
  const pct = (delta * 100).toFixed(1);
  return delta > 0 ? `+${pct} pp` : `${pct} pp`;
}

function formatIntDelta(delta: number): string {
  return delta > 0 ? `+${integer.format(delta)}` : integer.format(delta);
}

function widthPercent(share: number | null): string {
  if (share === null || share <= 0) return "0%";
  return `${Math.min(100, Math.max(2, Math.round(share * 1000) / 10))}%`;
}

export default async function StateOfArcX402Page() {
  const report = await getCachedArcStateReport();

  return (
    <main className="mx-auto w-full max-w-4xl space-y-8 px-4 py-8 sm:px-6 sm:py-10">
      <header className="space-y-3">
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-sky-300">
          Arc Mainnet · Observed by {BRAND.name}
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
          State of Arc x402
        </h1>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-base">
          Public snapshot of x402 endpoints catalogued for Arc Mainnet and tested via unpaid HTTP
          402 requests without sending USDC.
        </p>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
          {report ? (
            <span>
              Snapshot at{" "}
              <time dateTime={report.snapshotAt} className="font-mono text-foreground">
                {utcTimestamp.format(new Date(report.snapshotAt))} UTC
              </time>
            </span>
          ) : null}
          <a
            href="/state.json"
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            Download JSON (/state.json)
          </a>
          <a
            href={ARC_STATE_SQL_GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="underline-offset-4 hover:text-foreground hover:underline"
          >
            Reproducible SQL ({ARC_STATE_SQL_PATH})
          </a>
          <Link href="/check" className="underline-offset-4 hover:text-foreground hover:underline">
            Browse endpoint index
          </Link>
        </div>
      </header>

      {!report ? (
        <section
          role="status"
          className="rounded-2xl border border-white/10 bg-[#0b0f19]/60 p-5 text-sm text-muted-foreground"
        >
          Live Arc x402 state metrics are temporarily unavailable. The methodology below remains in
          effect once the index store responds.
        </section>
      ) : (
        <>
          <section aria-labelledby="state-overview-heading" className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="state-overview-heading" className="text-base font-semibold text-foreground">
                Index &amp; unpaid probe summary
              </h2>
              <p className="text-xs text-muted-foreground">
                {report.windows.listingsDays}d active index · {report.windows.checksDays}d unpaid checks
              </p>
            </div>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="min-w-0 rounded-xl border border-white/10 bg-[#0b0f19]/60 p-4">
                <dt className="text-xs text-muted-foreground">Active listings (7d)</dt>
                <dd data-testid="state-listings" className="mt-1 font-mono text-2xl font-semibold text-foreground">
                  {integer.format(report.overview.listings)}
                </dd>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  Across {integer.format(report.overview.distinctHosts)} distinct hosts
                </p>
              </div>
              <div className="min-w-0 rounded-xl border border-white/10 bg-[#0b0f19]/60 p-4">
                <dt className="text-xs text-muted-foreground">Unpaid checks (30d)</dt>
                <dd data-testid="state-checks" className="mt-1 font-mono text-2xl font-semibold text-foreground">
                  {integer.format(report.overview.checksInWindow)}
                </dd>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {integer.format(report.overview.distinctCheckedEndpoints)} distinct endpoints
                </p>
              </div>
              <div className="min-w-0 rounded-xl border border-white/10 bg-[#0b0f19]/60 p-4">
                <dt className="text-xs text-muted-foreground">Valid Arc 402</dt>
                <dd data-testid="state-arc-challenge-rate" className="mt-1 font-mono text-2xl font-semibold text-foreground">
                  {formatRate(report.liveness.arcChallengeRate)}
                </dd>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {integer.format(report.liveness.arcChallengeCount)} of {integer.format(report.overview.checksInWindow)} checks
                </p>
              </div>
              <div className="min-w-0 rounded-xl border border-white/10 bg-[#0b0f19]/60 p-4">
                <dt className="text-xs text-muted-foreground">Median latency</dt>
                <dd data-testid="state-latency" className="mt-1 font-mono text-2xl font-semibold text-foreground">
                  {report.latency.medianMs !== null ? `${report.latency.medianMs} ms` : "—"}
                </dd>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {report.latency.source === "arc_offer_checks"
                    ? `n = ${integer.format(report.latency.sampleSize)} unpaid checks`
                    : report.latency.source === "x402_endpoint_observations"
                      ? `Fallback: n = ${integer.format(report.latency.sampleSize)} Arc probes`
                      : "No latency samples yet"}
                </p>
              </div>
            </dl>

            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="min-w-0 rounded-xl border border-white/10 bg-background/60 p-3.5">
                <dt className="text-xs text-muted-foreground">Reachable HTTP response</dt>
                <dd className="mt-1 flex items-baseline justify-between gap-2 font-mono text-lg font-semibold text-foreground">
                  <span>{formatRate(report.liveness.reachableRate)}</span>
                  <span className="text-xs font-normal text-muted-foreground">
                    {integer.format(report.liveness.reachableCount)} / {integer.format(report.overview.checksInWindow)}
                  </span>
                </dd>
              </div>
              <div className="min-w-0 rounded-xl border border-white/10 bg-background/60 p-3.5">
                <dt className="text-xs text-muted-foreground">Returned HTTP 402</dt>
                <dd className="mt-1 flex items-baseline justify-between gap-2 font-mono text-lg font-semibold text-foreground">
                  <span>{formatRate(report.liveness.http402Rate)}</span>
                  <span className="text-xs font-normal text-muted-foreground">
                    {integer.format(report.liveness.http402Count)} / {integer.format(report.overview.checksInWindow)}
                  </span>
                </dd>
              </div>
              <div className="min-w-0 rounded-xl border border-white/10 bg-background/60 p-3.5">
                <dt className="text-xs text-muted-foreground">Listed at exactly 0.10 USDC</dt>
                <dd data-testid="state-exact-ten-cents" className="mt-1 flex items-baseline justify-between gap-2 font-mono text-lg font-semibold text-foreground">
                  <span>{formatRate(report.pricing.exactTenCentsShare)}</span>
                  <span className="text-xs font-normal text-muted-foreground">
                    {integer.format(report.pricing.exactTenCentsCount)} / {integer.format(report.overview.listings)}
                  </span>
                </dd>
              </div>
            </dl>
          </section>

          <section
            aria-labelledby="state-drift-heading"
            className="space-y-4 rounded-2xl border border-white/10 bg-[#0b0f19]/60 p-5"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="state-drift-heading" className="text-base font-semibold text-foreground">
                Catalog drift &amp; observed term changes
              </h2>
              <span className="text-xs text-muted-foreground">Live 402 vs catalogued terms</span>
            </div>

            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="min-w-0 rounded-xl border border-white/10 bg-background/60 p-3.5">
                <dt className="text-xs text-muted-foreground">Any catalog drift</dt>
                <dd data-testid="state-drift-any" className="mt-1 font-mono text-xl font-semibold text-foreground">
                  {formatRate(report.drift.anyRate)}
                </dd>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {integer.format(report.drift.anyCount)} checks
                </p>
              </div>
              <div className="min-w-0 rounded-xl border border-white/10 bg-background/60 p-3.5">
                <dt className="text-xs text-muted-foreground">Payee mismatch</dt>
                <dd data-testid="state-drift-payee" className="mt-1 font-mono text-xl font-semibold text-foreground">
                  {formatRate(report.drift.paytoChangedRate)}
                </dd>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {integer.format(report.drift.paytoChangedCount)} checks
                </p>
              </div>
              <div className="min-w-0 rounded-xl border border-white/10 bg-background/60 p-3.5">
                <dt className="text-xs text-muted-foreground">Price mismatch</dt>
                <dd data-testid="state-drift-price" className="mt-1 font-mono text-xl font-semibold text-foreground">
                  {formatRate(report.drift.priceChangedRate)}
                </dd>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {integer.format(report.drift.priceChangedCount)} checks
                </p>
              </div>
              <div className="min-w-0 rounded-xl border border-white/10 bg-background/60 p-3.5">
                <dt className="text-xs text-muted-foreground">Rail mismatch</dt>
                <dd className="mt-1 font-mono text-xl font-semibold text-foreground">
                  {formatRate(report.drift.railChangedRate)}
                </dd>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {integer.format(report.drift.railChangedCount)} checks
                </p>
              </div>
            </dl>

            <div className="grid grid-cols-1 gap-3 border-t border-white/10 pt-4 sm:grid-cols-2">
              <div className="min-w-0 space-y-1.5 rounded-xl border border-white/10 bg-background/50 p-3.5">
                <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Within 30d window (repeat checks)
                </h3>
                <p className="text-sm text-foreground">
                  <span className="font-mono font-semibold">
                    {integer.format(report.changes.withinWindow.payeeChangeEvents)}
                  </span>{" "}
                  payee transitions across{" "}
                  <span className="font-mono">
                    {integer.format(report.changes.withinWindow.endpointsWithPayeeChange)}
                  </span>{" "}
                  endpoints
                </p>
                <p className="text-sm text-foreground">
                  <span className="font-mono font-semibold">
                    {integer.format(report.changes.withinWindow.priceChangeEvents)}
                  </span>{" "}
                  price transitions across{" "}
                  <span className="font-mono">
                    {integer.format(report.changes.withinWindow.endpointsWithPriceChange)}
                  </span>{" "}
                  endpoints
                </p>
                <p className="text-xs text-muted-foreground">
                  {integer.format(report.changes.withinWindow.endpointsWithMultipleChecks)} endpoints
                  checked more than once in this window.
                </p>
              </div>

              <div className="min-w-0 space-y-1.5 rounded-xl border border-white/10 bg-background/50 p-3.5">
                <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Since prior monthly snapshot
                </h3>
                {report.changes.sincePriorSnapshot ? (
                  <>
                    <p className="text-xs text-muted-foreground">
                      Compared against {report.changes.sincePriorSnapshot.priorSnapshotMonth} snapshot
                    </p>
                    <p className="text-sm text-foreground">
                      Listings:{" "}
                      <span className="font-mono font-semibold">
                        {formatIntDelta(report.changes.sincePriorSnapshot.listingsDelta)}
                      </span>{" "}
                      · Hosts:{" "}
                      <span className="font-mono font-semibold">
                        {formatIntDelta(report.changes.sincePriorSnapshot.distinctHostsDelta)}
                      </span>{" "}
                      · Drift rate:{" "}
                      <span className="font-mono font-semibold">
                        {formatRateDelta(report.changes.sincePriorSnapshot.driftAnyRateDelta)}
                      </span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Since snapshot:{" "}
                      {integer.format(report.changes.sincePriorSnapshot.payeeChangeEventsSincePrior)}{" "}
                      payee transitions,{" "}
                      {integer.format(report.changes.sincePriorSnapshot.priceChangeEventsSincePrior)}{" "}
                      price transitions.
                    </p>
                  </>
                ) : (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Initial snapshot month ({report.snapshotMonth}). Month-over-month deltas against
                    the previous saved snapshot will appear once a prior month exists in{" "}
                    <code className="font-mono text-foreground">arc_state_snapshots</code>.
                  </p>
                )}
              </div>
            </div>
          </section>

          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <section
              aria-labelledby="state-concentration-heading"
              className="min-w-0 space-y-4 rounded-2xl border border-white/10 bg-[#0b0f19]/60 p-5"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 id="state-concentration-heading" className="text-base font-semibold text-foreground">
                  Host concentration
                </h2>
                <span className="font-mono text-xs text-muted-foreground">
                  Top 1: {formatRate(report.concentration.top1Share)} · Top 5:{" "}
                  {formatRate(report.concentration.top5Share)}
                </span>
              </div>
              {report.concentration.top5Hosts.length ? (
                <ul className="space-y-3">
                  {report.concentration.top5Hosts.map((host) => (
                    <li key={host.hostname} className="space-y-1">
                      <div className="flex items-baseline justify-between gap-2 text-xs">
                        <span className="min-w-0 break-all font-mono text-foreground">
                          {host.hostname}
                        </span>
                        <span className="shrink-0 font-mono text-muted-foreground">
                          {integer.format(host.listings)} ({formatRate(host.share)})
                        </span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-white/5">
                        <div
                          className="h-full rounded-full bg-sky-400/80"
                          style={{ width: widthPercent(host.share) }}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">No active hosts in window.</p>
              )}
            </section>

            <section
              aria-labelledby="state-methods-sources-heading"
              className="min-w-0 space-y-4 rounded-2xl border border-white/10 bg-[#0b0f19]/60 p-5"
            >
              <h2 id="state-methods-sources-heading" className="text-base font-semibold text-foreground">
                Methods &amp; index sources
              </h2>
              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  HTTP method split
                </p>
                <div className="grid grid-cols-2 gap-3">
                  {(["GET", "POST"] as const).map((method) => (
                    <div key={method} className="rounded-xl border border-white/10 bg-background/60 p-3">
                      <p className="font-mono text-xs text-muted-foreground">{method}</p>
                      <p className="mt-1 font-mono text-lg font-semibold text-foreground">
                        {formatRate(report.methods[method].share)}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        {integer.format(report.methods[method].count)} listings
                      </p>
                    </div>
                  ))}
                </div>
              </div>
              <div className="space-y-2 border-t border-white/10 pt-3">
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Catalog sources (listings may appear in multiple)
                </p>
                <dl className="grid grid-cols-3 gap-2 text-xs">
                  {(["circle", "bazaar", "erc8004"] as const).map((source) => (
                    <div key={source} className="rounded-xl border border-white/10 bg-background/60 p-2.5">
                      <dt className="font-mono text-muted-foreground">{source}</dt>
                      <dd className="mt-1 font-mono text-sm font-semibold text-foreground">
                        {integer.format(report.sources[source].count)}
                      </dd>
                      <p className="text-[11px] text-muted-foreground">
                        {formatRate(report.sources[source].share)}
                      </p>
                    </div>
                  ))}
                </dl>
                <p className="text-xs text-muted-foreground">
                  Multi-source listings:{" "}
                  <span className="font-mono text-foreground">
                    {integer.format(report.sources.multiSourceCount)}
                  </span>
                </p>
              </div>
            </section>
          </div>

          <section
            aria-labelledby="state-pricing-heading"
            className="space-y-4 rounded-2xl border border-white/10 bg-[#0b0f19]/60 p-5"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="state-pricing-heading" className="text-base font-semibold text-foreground">
                Listed price distribution (Arc Mainnet USDC)
              </h2>
              <span className="text-xs text-muted-foreground">
                Exact 0.10 USDC cluster: {formatRate(report.pricing.exactTenCentsShare)}
              </span>
            </div>
            <ul className="space-y-2.5">
              {report.pricing.buckets.map((bucket) => (
                <li key={bucket.id} className="space-y-1">
                  <div className="flex items-baseline justify-between gap-2 text-xs">
                    <span className="text-foreground">{bucket.label}</span>
                    <span className="shrink-0 font-mono text-muted-foreground">
                      {integer.format(bucket.count)} ({formatRate(bucket.share)})
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-white/5">
                    <div
                      className="h-full rounded-full bg-primary/80"
                      style={{ width: widthPercent(bucket.share) }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      <section
        id="methodology"
        aria-labelledby="state-methodology-heading"
        className="space-y-4 rounded-2xl border border-white/10 bg-[#0b0f19]/60 p-5"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="state-methodology-heading" className="text-base font-semibold text-foreground">
            Methodology &amp; reproducibility
          </h2>
          <span className="rounded-full border border-sky-400/30 bg-sky-400/10 px-2.5 py-0.5 text-xs font-medium text-sky-300">
            Observed by {BRAND.name}
          </span>
        </div>

        <p className="text-sm leading-relaxed text-muted-foreground">
          All figures on this page are <strong className="font-semibold text-foreground">observed by {BRAND.name}</strong>{" "}
          from public catalog listings and unpaid endpoint checks. Each check sends{" "}
          <strong className="font-semibold text-foreground">one unpaid HTTP request</strong> using
          the catalogued method, without payment credentials and without spending USDC. An unpaid
          check inspects only the live HTTP 402 payment challenge and{" "}
          <strong className="font-semibold text-foreground">
            says nothing about whether the seller delivers the result after payment
          </strong>
          .
        </p>

        <dl className="grid grid-cols-1 gap-4 text-xs sm:grid-cols-2">
          <div className="space-y-1.5">
            <dt className="font-semibold text-foreground">Sources &amp; windows</dt>
            <dd className="leading-relaxed text-muted-foreground">
              Index sources recorded verbatim as <code className="font-mono text-foreground">circle</code>,{" "}
              <code className="font-mono text-foreground">bazaar</code>, and{" "}
              <code className="font-mono text-foreground">erc8004</code>. Active listings cover a
              rolling 7-day catalog window; unpaid checks cover a rolling 30-day window.
            </dd>
          </div>
          <div className="space-y-1.5">
            <dt className="font-semibold text-foreground">Exclusions</dt>
            <dd className="leading-relaxed text-muted-foreground">
              Templated URLs, query-bearing URLs, IP literals, non-HTTPS endpoints, private hosts,
              non-Arc-Mainnet offers, and zero-address payees are excluded. Empty-request live
              quotes of 0 atomic units are recorded as dynamic quotes rather than price drift.
            </dd>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <dt className="font-semibold text-foreground">Known limitations</dt>
            <dd className="leading-relaxed text-muted-foreground">
              Unpaid checks run in leased batches (up to 72 endpoints per worker run, max 24 per host,
              72-hour recheck cadence), so check coverage lags catalog ingestion. Catalog drift
              indicates disagreement between catalogued terms and the live 402 response, which can
              come from stale catalog metadata or endpoint changes. Per-check latency collection on{" "}
              <code className="font-mono text-foreground">arc_offer_checks</code> starts in November
              2026; when that column has zero samples in the window, median latency falls back to{" "}
              <code className="font-mono text-foreground">x402_endpoint_observations</code>.
            </dd>
          </div>
        </dl>

        <div className="space-y-2 border-t border-white/10 pt-3 text-xs text-muted-foreground">
          <p>
            Every metric above matches the published SQL query at{" "}
            <a
              href={ARC_STATE_SQL_GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-foreground underline underline-offset-4"
            >
              {ARC_STATE_SQL_PATH}
            </a>{" "}
            and the machine-readable payload at{" "}
            <a href="/state.json" className="font-mono text-foreground underline underline-offset-4">
              /state.json
            </a>
            . Monthly snapshots in <code className="font-mono text-foreground">arc_state_snapshots</code>{" "}
            preserve <code className="font-mono text-foreground">snapshotAt</code> so figures can be
            recalculated deterministically.
          </p>
        </div>
      </section>
    </main>
  );
}
