"use client";

import { useState } from "react";
import Link from "next/link";
import { useArcWallet } from "@/components/wallet/use-arc-wallet";
import { useExecutionLog } from "@/components/execution/use-execution-log";
import {
  chainLabel,
  executionNetwork,
  executionLabels,
  filters,
  formatUsdc,
  matchesExecutionFilter,
  paymentSummary,
  transactionUrl,
  type ExecutionFilter,
} from "@/lib/execution/presentation";

export default function ExecutionsPage() {
  const { address } = useArcWallet();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ExecutionFilter>("All");
  const [received, setReceived] = useState(false);
  const {
    executions,
    loading,
    error,
    updated,
    cursor,
    refresh,
    retry,
    loadMore,
  } = useExecutionLog(received ? address : null);

  const visible = executions.filter(
    (e) =>
      matchesExecutionFilter(e, filter) &&
      [
        e.executionId,
        e.capability,
        e.counterpartyWallet,
        e.x402?.payerWallet,
        e.mandateId,
      ].some((value) => value?.toLowerCase().includes(search.toLowerCase())),
  );
  const booked = executions.reduce(
    (sum, e) => sum + e.actualSettledAmountUsdc,
    0,
  );
  const confirmed = executions.reduce(
    (sum, e) =>
      sum +
      (e.settlementProof === "onchain_final" ? e.actualSettledAmountUsdc : 0),
    0,
  );
  return (
    <main className="mx-auto max-w-6xl px-5 py-8 sm:px-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold">Decisions</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Public payment history. Each entry names its payment network and
            confirmation level.
          </p>
        </div>
        <button
          className="rounded-lg border px-4 py-2 text-sm"
          disabled={loading}
          onClick={refresh}
          aria-label="Refresh the log"
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </header>
      {updated && (
        <p className="mt-4 text-xs text-muted-foreground">
          Updated {new Date(updated).toLocaleString()}. Showing{" "}
          {executions.length} loaded entries
          {cursor ? "; older entries available below" : ""}. Totals cover these
          entries only.
        </p>
      )}
      {updated && (
        <dl className="mt-4 flex flex-wrap gap-8 text-sm">
          <div>
            <dt className="text-muted-foreground">Recorded / reserved spend</dt>
            <dd className="mt-1 font-mono">{formatUsdc(booked)} USDC</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Confirmed onchain</dt>
            <dd className="mt-1 font-mono">{formatUsdc(confirmed)} USDC</dd>
          </div>
        </dl>
      )}
      <div className="my-6 flex flex-wrap gap-3">
        <input
          aria-label="Search decisions"
          placeholder="Execution ID, wallet, capability"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="min-w-0 w-full rounded-lg border bg-card p-3 text-sm sm:max-w-sm"
        />
        <div className="flex flex-wrap gap-1" aria-label="Filter decisions">
          {filters.map((value) => (
            <button
              key={value}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
              className={`min-h-11 rounded-lg px-3 text-sm ${filter === value ? "bg-primary/20 text-foreground" : "text-muted-foreground"}`}
            >
              {value}
            </button>
          ))}
        </div>
        {address && (
          <button
            aria-pressed={received}
            className="rounded-lg border px-3 py-2 text-sm"
            onClick={() => setReceived((v) => !v)}
          >
            Received by me
          </button>
        )}
      </div>
      {error && (
        <div
          role="alert"
          className="mb-5 rounded-lg border border-amber-400/40 p-4 text-sm"
        >
          <p>
            {error}{" "}
            {updated
              ? "The displayed history may be out of date."
              : "Your history is unavailable; this does not mean there are no payments."}
          </p>
          <button className="mt-2 underline" onClick={retry} disabled={loading}>
            Retry
          </button>
        </div>
      )}
      {loading && !updated ? (
        <p role="status">Reading the log…</p>
      ) : !error && !visible.length ? (
        <p>
          {executions.length
            ? "Nothing matches that filter in the loaded entries."
            : "No decisions recorded yet."}
        </p>
      ) : null}
      <ul className="divide-y divide-border">
        {visible.map((exec) => {
          const network = executionNetwork(exec);
          const tx = exec.paymentTx ?? exec.completeTx ?? exec.createTx;
          const url = transactionUrl(network, tx);
          const transactionLabel = exec.paymentTx
            ? "Payment transaction"
            : exec.completeTx
              ? "Completion transaction"
              : "Job creation transaction";
          return (
            <li key={exec.executionId} className="py-5">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <h2 className="font-medium">
                  {executionLabels[exec.state] ?? exec.state}
                </h2>
                <time
                  className="text-xs text-muted-foreground"
                  dateTime={exec.createdAt}
                >
                  {new Date(exec.createdAt).toLocaleString()}
                </time>
              </div>
              <p className="mt-2 text-sm">
                {exec.capability.replace(/_/g, " ")} · {chainLabel(network)} ·{" "}
                {exec.rail}
              </p>
              <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-2 text-sm">
                <div>
                  <dt className="text-muted-foreground">Authorized</dt>
                  <dd className="font-mono">
                    {formatUsdc(exec.authorizedAmountUsdc)} USDC
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">
                    Recorded / reserved spend
                  </dt>
                  <dd className="font-mono">
                    {formatUsdc(exec.actualSettledAmountUsdc)} USDC
                  </dd>
                </div>
              </dl>
              <p className="mt-2 text-sm text-muted-foreground">
                {paymentSummary(exec)}
              </p>
              <div className="mt-3 flex flex-wrap gap-4 text-sm">
                <Link
                  className="text-link underline"
                  href={`/execution/${exec.executionId}`}
                >
                  Receipt →
                </Link>
                {url && (
                  <a
                    className="text-link underline"
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {transactionLabel} ↗
                  </a>
                )}
              </div>
              <details className="mt-3 text-xs text-muted-foreground">
                <summary className="cursor-pointer py-2">Details</summary>
                <p className="break-all">Execution: {exec.executionId}</p>
                <p className="mt-2 break-all">
                  Recipient: {exec.counterpartyWallet}
                </p>
                {tx && !url && (
                  <p className="mt-2 break-all">
                    Transaction (network not supported by explorer): {tx}
                  </p>
                )}
              </details>
            </li>
          );
        })}
      </ul>
      {cursor && (
        <button
          className="mt-6 rounded-lg border px-5 py-3"
          disabled={loading}
          onClick={loadMore}
        >
          {loading ? "Loading…" : "Load older entries"}
        </button>
      )}
    </main>
  );
}
