/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { formatUnits } from "viem";
import { readArcOfferDetail, type ArcOfferCheck } from "@/lib/discovery/arc-offer-index";
import { VEYRA_ORIGIN } from "@/lib/erc8004/veyra-registration";

export const dynamic = "force-dynamic";
const readOffer = cache(readArcOfferDetail);
const sourceLabels = { circle: "Circle Discovery", bazaar: "Coinbase Bazaar", erc8004: "Arc ERC-8004" };
const utc = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

type Props = { params: Promise<{ resourceKey: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { resourceKey } = await params;
  const offer = await readOffer(resourceKey);
  if (offer.state !== "found") return { title: "Arc endpoint check", robots: { index: false } };
  const title = `x402 check for ${offer.listing.hostname}`;
  const description = "Arc Mainnet USDC price, payee and HTTP 402 observations from Veyra.";
  const url = `${VEYRA_ORIGIN}/check/${resourceKey}`;
  const lastCheckedAt = offer.listing.last_checked_at;
  const fresh = lastCheckedAt && Date.now() - Date.parse(lastCheckedAt) < 3 * 86_400_000;
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { title, description, url },
    robots: { index: Boolean(fresh), follow: true },
  };
}

function price(amount: string | null) {
  return amount === null ? "Unavailable for this request" : `${formatUnits(BigInt(amount), 6)} USDC`;
}

function resultLabel(check: ArcOfferCheck) {
  if (check.drift.length) return "Terms differ from the catalogue";
  if (check.arc_challenge) return "Arc Mainnet USDC challenge observed";
  if (check.http_status === 402) return "No usable Arc Mainnet USDC option in the 402 response";
  if (check.http_status !== null) return `HTTP ${check.http_status} · no 402 challenge`;
  return check.error_category === "timeout" ? "Request timed out" : "Endpoint unavailable";
}

export default async function ArcOfferDetail({ params }: Props) {
  const { resourceKey } = await params;
  const offer = await readOffer(resourceKey);
  if (offer.state === "missing") notFound();

  if (offer.state === "unavailable") {
    return (
      <main className="mx-auto max-w-4xl space-y-4 px-5 py-10">
        <h1 className="text-3xl font-semibold">Endpoint check unavailable</h1>
        <p>The index could not be read. Try again later.</p>
        <Link href="/check" className="underline">Browse Arc endpoints</Link>
      </main>
    );
  }

  const { listing, checks } = offer;
  const latest = listing.last_checked_at === checks?.[0]?.checked_at ? checks?.[0] : undefined;
  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 px-5 py-10 sm:px-8">
      <Link href="/check" className="text-sm underline underline-offset-4">Browse Arc endpoints</Link>
      <header className="space-y-2">
        <h1 className="break-all text-3xl font-semibold tracking-tight">{listing.hostname}</h1>
        <p className="break-all font-mono text-sm">{listing.method} {listing.resource}</p>
        <p className="text-sm text-muted-foreground">Arc Mainnet · USDC</p>
      </header>

      <section className="space-y-2 rounded-lg border p-4">
        <h2 className="font-semibold">Catalogue terms</h2>
        <p className="text-sm text-muted-foreground">Terms from {sourceLabels[listing.sources[0]]}{listing.sources.length > 1 ? ` · Also listed by ${listing.sources.slice(1).map((source) => sourceLabels[source]).join(", ")}` : ""}</p>
        <dl className="space-y-2 text-sm">
          <div><dt>Listed price</dt><dd>{price(listing.listed_amount)} · {listing.listed_rail === "wallet" ? "Wallet" : "Circle Gateway"}</dd></div>
          <div><dt>Listed payee</dt><dd className="break-all font-mono">{listing.listed_payee}</dd></div>
          <div><dt>Last indexed</dt><dd><time dateTime={listing.listed_at}>{utc.format(new Date(listing.listed_at))} UTC</time></dd></div>
        </dl>
      </section>

      <section className="space-y-2 rounded-lg border p-4">
        <h2 className="font-semibold">Latest unpaid check</h2>
        {latest ? (
          <>
            <p>{resultLabel(latest)}</p>
            <p className="text-sm text-muted-foreground"><time dateTime={latest.checked_at}>{utc.format(new Date(latest.checked_at))} UTC</time></p>
            <dl className="space-y-2 text-sm">
              <div><dt>Observed price</dt><dd>{price(latest.live_amount)}</dd></div>
              <div><dt>Observed payee</dt><dd className="break-all font-mono">{latest.live_payee ?? "Unavailable"}</dd></div>
            </dl>
            {latest.failed_checks.length > 0 && (
              <details>
                <summary className="cursor-pointer text-sm">Failed checks ({latest.failed_checks.length})</summary>
                <ul className="mt-2 list-inside list-disc text-sm">
                  {latest.failed_checks.map((id) => <li key={id}>{id.replaceAll("_", " ")}</li>)}
                </ul>
              </details>
            )}
          </>
        ) : <p className="text-sm text-muted-foreground">{checks?.length ? "Awaiting a check of the current terms." : checks ? "Awaiting first check." : "Check results are temporarily unavailable."}</p>}
        <p className="text-sm text-muted-foreground">These checks cover the endpoint and payment challenge. They provide no evidence of successful settlement or delivery.</p>
      </section>

      {checks && checks.length > 0 && (
        <section className="space-y-2 rounded-lg border p-4">
          <h2 className="font-semibold">Recent checks and drift</h2>
          <ul className="divide-y text-sm">
            {checks.map((check) => (
              <li key={check.checked_at} className="space-y-1 py-2">
                <time dateTime={check.checked_at} className="block text-muted-foreground">{utc.format(new Date(check.checked_at))} UTC</time>
                <p>{resultLabel(check)}</p>
                {check.drift.length > 0 && (
                  <p className="break-words">
                    {check.drift.map((code) => code.replaceAll("_", " ")).join(", ")}. Catalogue {price(check.listed_amount)}, live {price(check.live_amount)}.
                    {check.drift.includes("payto_changed") && (
                      <span className="block break-all">Catalogue payee {check.listed_payee}, live payee {check.live_payee}.</span>
                    )}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
