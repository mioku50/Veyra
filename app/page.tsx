/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Metadata } from "next";
import Link from "next/link";
import { ConnectAgent } from "@/components/home/connect-agent";
import { EndpointChecker } from "@/components/home/endpoint-checker";
import { NovaReturnBanner } from "@/components/home/nova-return-banner";
import { getCachedArcOfferIndexSummary } from "@/lib/discovery/arc-offer-summary-cache";
import { VEYRA_ORIGIN } from "@/lib/erc8004/veyra-registration";
import { HOME_DESCRIPTION, HOME_HEADLINE, HOME_TITLE } from "@/lib/home-metadata";
import { ARC_OPENAPI_PATH } from "@/lib/x402/trust-api/arc-mainnet";
import { TRUST_API_MAX_BUDGET_USDC } from "@/lib/x402/trust-api/verdict";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: HOME_TITLE },
  description: HOME_DESCRIPTION,
  alternates: { canonical: `${VEYRA_ORIGIN}/` },
  openGraph: {
    title: HOME_TITLE,
    description: HOME_DESCRIPTION,
    url: `${VEYRA_ORIGIN}/`,
  },
  twitter: {
    card: "summary_large_image",
    title: HOME_TITLE,
    description: HOME_DESCRIPTION,
  },
};

const integer = new Intl.NumberFormat("en-US");
const utcTimestamp = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

export default async function HomePage() {
  const summary = await getCachedArcOfferIndexSummary();

  return (
    <main className="mx-auto w-full max-w-4xl space-y-8 px-4 py-8 sm:px-6 sm:py-10">
      <NovaReturnBanner />

      <header className="space-y-3">
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-sky-300">
          Arc Mainnet · Free x402 preflight
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
          {HOME_HEADLINE}.
        </h1>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-base">
          Inspect an endpoint&rsquo;s live HTTP 402 payment challenge, USDC price, and payee on Arc
          Mainnet before sending funds.
        </p>
      </header>

      <EndpointChecker maxBudget={TRUST_API_MAX_BUDGET_USDC} />

      <section
        aria-labelledby="arc-index-metrics-heading"
        className="space-y-3 rounded-2xl border border-white/10 bg-[#0b0f19]/60 p-5"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="arc-index-metrics-heading" className="text-base font-semibold text-foreground">
            Observed Arc x402 index
          </h2>
          {summary ? (
            <p className="text-xs text-muted-foreground">
              As of{" "}
              <time dateTime={summary.asOf}>
                {utcTimestamp.format(new Date(summary.asOf))} UTC
              </time>
            </p>
          ) : null}
        </div>

        {summary ? (
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-xl border border-white/10 bg-background/60 p-3.5">
              <dt className="text-xs text-muted-foreground">Arc Mainnet listings</dt>
              <dd className="mt-1 font-mono text-2xl font-semibold text-foreground">
                {integer.format(summary.listings)}
              </dd>
            </div>
            <div className="rounded-xl border border-white/10 bg-background/60 p-3.5">
              <dt className="text-xs text-muted-foreground">Distinct hosts</dt>
              <dd className="mt-1 font-mono text-2xl font-semibold text-foreground">
                {integer.format(summary.hosts)}
              </dd>
            </div>
            <div className="rounded-xl border border-white/10 bg-background/60 p-3.5">
              <dt className="text-xs text-muted-foreground">Checks (7d)</dt>
              <dd className="mt-1 font-mono text-2xl font-semibold text-foreground">
                {integer.format(summary.checks7d)}
              </dd>
            </div>
            <div className="rounded-xl border border-white/10 bg-background/60 p-3.5">
              <dt className="text-xs text-muted-foreground">Valid Arc challenge</dt>
              <dd className="mt-1 font-mono text-2xl font-semibold text-foreground">
                {summary.arcChallengeRate7d !== null
                  ? `${Math.round(summary.arcChallengeRate7d * 100)}%`
                  : "—"}
              </dd>
              {summary.checks7d > 0 && (
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {integer.format(summary.arcChallengeChecks7d)} of {integer.format(summary.checks7d)}
                </p>
              )}
            </div>
          </dl>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            Live Arc index metrics are temporarily unavailable.
          </p>
        )}

        <p className="text-xs text-muted-foreground">
          Refreshed every 10 minutes from unpaid endpoint checks. No USDC is spent and delivery is not tested.
        </p>
      </section>

      <ConnectAgent />

      <footer className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-white/10 pt-5 text-sm">
        <Link href="/check" className="font-medium text-primary underline-offset-4 hover:underline">
          Browse Arc index
        </Link>
        <Link href="/state" className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
          State of Arc x402
        </Link>
        <Link href="/nova" className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
          Your personal agent (Nova)
        </Link>
        <Link href={ARC_OPENAPI_PATH} className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
          Trust API OpenAPI
        </Link>
      </footer>
    </main>
  );
}
