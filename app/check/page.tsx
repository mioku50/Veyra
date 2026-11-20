/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import type { Metadata } from "next";
import Link from "next/link";
import { formatUnits } from "viem";
import { listArcOfferIndex } from "@/lib/discovery/arc-offer-index";
import { VEYRA_ORIGIN } from "@/lib/erc8004/veyra-registration";
import { ARC_OPENAPI_PATH } from "@/lib/x402/trust-api/arc-mainnet";

const title = "Check an Arc x402 endpoint";
const description = "Find Arc Mainnet x402 endpoints and inspect their live payment challenge, USDC price and payee.";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: `${VEYRA_ORIGIN}/check` },
  openGraph: { title, description, url: `${VEYRA_ORIGIN}/check` },
};

type SearchParams = Promise<{ q?: string | string[]; page?: string | string[] }>;

function pageHref(term: string, page: number) {
  const params = new URLSearchParams();
  if (term) params.set("q", term);
  if (page > 1) params.set("page", String(page));
  return params.size ? `/check?${params}` : "/check";
}

export default async function ArcOfferIndex({ searchParams }: { searchParams: SearchParams }) {
  const search = await searchParams;
  const candidate = typeof search.q === "string" ? search.q.trim().slice(0, 120) : "";
  const term = candidate.replace(/[^a-zA-Z0-9.:/ -]/g, "");
  const page = typeof search.page === "string" && /^\d{1,3}$/.test(search.page)
    ? Math.max(1, Number(search.page)) : 1;
  const index = await listArcOfferIndex(page, term);

  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 px-5 py-10 sm:px-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Check an Arc x402 endpoint</h1>
        <p className="text-muted-foreground">{description}</p>
        <p className="text-sm text-muted-foreground">Veyra requests the payment challenge without sending USDC.</p>
        <Link href={ARC_OPENAPI_PATH} className="inline-block text-sm underline underline-offset-4">Trust API reference</Link>
      </header>

      <form method="get" action="/check" role="search" className="flex flex-wrap items-end gap-2">
        <label className="min-w-0 flex-1 basis-48 text-sm">
          Search by host or path
          <input name="q" defaultValue={term} type="search" maxLength={120}
            className="mt-1 block w-full rounded-md border bg-background px-3 py-2" />
        </label>
        <button type="submit" className="rounded-md bg-primary px-4 py-2 text-primary-foreground">Search</button>
      </form>

      {!index ? (
        <p role="status" className="rounded-lg border p-4 text-muted-foreground">The endpoint index is temporarily unavailable.</p>
      ) : !index.items.length ? (
        <p role="status" className="rounded-lg border p-4 text-muted-foreground">
          {term ? "No indexed endpoints matched your search." : "There are no endpoints on this page yet."}
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {index.items.map((item) => (
            <li key={item.resource_key}>
              <Link href={`/check/${item.resource_key}`} className="block space-y-1 rounded-md p-4 hover:bg-muted/40">
                <span className="block break-all text-sm font-medium">{item.method} {item.resource}</span>
                <span className="block text-sm text-muted-foreground">
                  {formatUnits(BigInt(item.listed_amount), 6)} USDC listed · {item.last_checked_at ? "Check available" : "Awaiting first check"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {(page > 1 || index?.more) && (
        <nav aria-label="Endpoint pages" className="flex flex-wrap gap-4 text-sm">
          {page > 1 && <Link href={pageHref(term, page - 1)} className="underline underline-offset-4">Previous page</Link>}
          {index?.more && page < 999 && <Link href={pageHref(term, page + 1)} className="underline underline-offset-4">Next page</Link>}
        </nav>
      )}
    </main>
  );
}
