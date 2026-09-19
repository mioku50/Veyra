import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getExecutionAttempt } from "@/lib/execution/db";
import { publicExecutionView } from "@/lib/execution/public-view";
import {
  chainLabel,
  executionLabels,
  executionNetwork,
  formatUsdc,
  paymentSummary,
  transactionUrl,
} from "@/lib/execution/presentation";

type RouteContext = { params: Promise<{ publicId: string }> };
export const dynamic = "force-dynamic";
export async function generateMetadata({
  params,
}: RouteContext): Promise<Metadata> {
  const { publicId } = await params;
  return {
    title: `Execution Receipt ${publicId}`,
    description: "Payment details, delivery status and settlement evidence.",
  };
}
export default async function ExecutionReceiptPage({ params }: RouteContext) {
  const { publicId } = await params;
  const attempt = await getExecutionAttempt(publicId);
  if (!attempt) notFound();
  const execution = publicExecutionView(attempt);
  const network = executionNetwork(execution);
  const transactions = [
    { label: "Payment transaction", tx: execution.paymentTx },
    { label: "Completion transaction", tx: execution.completeTx },
    { label: "Job creation transaction", tx: execution.createTx },
  ].filter(
    (entry, index, entries) =>
      entry.tx && entries.findIndex((other) => other.tx === entry.tx) === index,
  );
  return (
    <main className="mx-auto max-w-4xl space-y-6 px-5 py-8">
      <Link href="/executions" className="text-sm text-link underline">
        ← Decisions
      </Link>
      <header>
        <h1 className="mt-4 text-3xl font-semibold">Execution Receipt</h1>
        <p className="mt-3 font-medium">{executionLabels[execution.state]}</p>
        <p className="mt-2 text-sm text-muted-foreground">
          {chainLabel(network)} · {execution.rail}
        </p>
      </header>
      <dl className="grid gap-4 rounded-xl border bg-card/80 p-5 sm:grid-cols-3">
        {[
          ["Requested amount", execution.requestedAmountUsdc],
          ["Authorized amount", execution.authorizedAmountUsdc],
          ["Recorded / reserved spend", execution.actualSettledAmountUsdc],
        ].map(([label, amount]) => (
          <div key={label}>
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="mt-2 font-mono">
              {formatUsdc(amount as number)} USDC
            </dd>
          </div>
        ))}
      </dl>
      <section className="rounded-xl border bg-card/80 p-5">
        <h2 className="font-semibold">Payment evidence</h2>
        <p className="mt-2 text-sm">{paymentSummary(execution)}</p>
        <p className="mt-2 text-sm text-muted-foreground">
          Payment confirmation and the delivery check are separate. A recorded
          amount can include spend reserved while confirmation is unavailable.
        </p>
        {transactions.map(({ tx, label }) => {
          const url = transactionUrl(network, tx);
          return (
            <p key={tx} className="mt-3 break-all font-mono text-xs">
              {url ? (
                <a
                  className="text-link underline"
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {label}: {tx} ↗
                </a>
              ) : (
                `${label} · network not recorded or unsupported: ${tx}`
              )}
            </p>
          );
        })}
        {!transactions.length && (
          <p className="mt-3 text-sm text-muted-foreground">
            No transaction reference recorded. Batched payments may await a
            batch transaction.
          </p>
        )}
      </section>
      <section className="rounded-xl border bg-card/80 p-5">
        <h2 className="font-semibold">Service</h2>
        <p className="mt-2 text-sm">
          {execution.capability.replace(/_/g, " ")}
        </p>
        <p className="mt-2 break-all text-sm">
          Recipient: {execution.counterpartyWallet}
        </p>
        {execution.x402 && (
          <p className="mt-2 break-all text-sm">
            Payer: {execution.x402.payerWallet}
          </p>
        )}
        {execution.failureCode && (
          <p className="mt-3 text-sm">
            Delivery / execution detail:{" "}
            {execution.failureCode.replace(/_/g, " ")}
          </p>
        )}
      </section>
      <details className="rounded-xl border p-5 text-sm">
        <summary className="cursor-pointer font-medium">
          Details and provenance
        </summary>
        <dl className="mt-4 space-y-3">
          {[
            ["Execution", execution.executionId],
            ["Counterparty agent", execution.counterpartyAgentId],
            ["Mandate", execution.mandateId ?? "Direct / prepared"],
            ["Selection hash", execution.selectionHash],
            ["Clearance digest", execution.clearanceDigest],
            ["Canonical hash", execution.canonicalHash],
          ].map(
            ([label, value]) =>
              value && (
                <div key={label}>
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="break-all font-mono text-xs">{value}</dd>
                </div>
              ),
          )}
        </dl>
      </details>
    </main>
  );
}
