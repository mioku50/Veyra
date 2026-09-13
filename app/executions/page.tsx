"use client";

/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useArcWallet } from "@/components/wallet/use-arc-wallet";
import { Loader2, RefreshCw, Search } from "lucide-react";
import type { ExecutionAttempt, ExecutionState } from "@/lib/execution/types";
import { BRAND } from "@/lib/brand";

/* A decision log is a sequence of economic events, not a spreadsheet. It reads
   down a spine: when it happened, what Veyra decided, what actually moved, and
   how far through the lifecycle it got. The enterprise table it replaced put six
   filter pills across the top and a generic icon in the middle of a void. */

type Tone = "settled" | "moving" | "waiting" | "refused";

const TONE_COLOR: Record<Tone, string> = {
  settled: "var(--run-azure)",
  moving: "var(--run-lavender)",
  waiting: "var(--run-amber)",
  refused: "var(--run-red)",
};

function toneOf(state: ExecutionState): Tone {
  switch (state) {
    case "COMPLETED":
    case "COMPLETED_UNPROVEN":
      return "settled";
    case "DRAFT":
    case "WAITING_FOR_PROVIDER":
    case "EVIDENCE_PENDING":
    case "SETTLEMENT_UNVERIFIED":
      return "waiting";
    case "REJECTED":
    case "EXPIRED":
    case "CANCELLED":
    case "FAILED":
    case "SETTLEMENT_FAILED":
    case "EVALUATION_REJECTED":
    case "SETTLED_SERVICE_FAILED":
      return "refused";
    default:
      return "moving";
  }
}

/** The lifecycle each rail actually walks, so a row shows position rather than
 *  one opaque status word. */
const LIFECYCLE: Record<string, readonly ExecutionState[]> = {
  erc8183: ["AUTHORIZED", "WAITING_FOR_PROVIDER", "SUBMITTED", "EVALUATING", "COMPLETED"],
  x402: ["AUTHORIZED", "EXECUTING", "SETTLING", "COMPLETED"],
};

const STAGE_LABEL: Partial<Record<ExecutionState, string>> = {
  AUTHORIZED: "Authorized",
  WAITING_FOR_PROVIDER: "Funded",
  SUBMITTED: "Submitted",
  EVALUATING: "Evaluated",
  EXECUTING: "Called",
  SETTLING: "Settling",
  COMPLETED: "Paid",
};

function stagesFor(exec: ExecutionAttempt) {
  const chain = LIFECYCLE[exec.rail] ?? LIFECYCLE.x402;
  const reached = chain.indexOf(exec.state);
  const refused = toneOf(exec.state) === "refused";
  return chain.map((stage, index) => ({
    key: stage,
    label: STAGE_LABEL[stage] ?? stage,
    done: !refused && (reached === -1 ? exec.state === "COMPLETED" : index <= reached),
  }));
}

function shortHex(value?: string | null, lead = 6, tail = 4) {
  if (!value) return null;
  return value.length <= lead + tail + 1 ? value : `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

function money(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return value < 0.01 ? value.toFixed(4) : value.toFixed(2);
}

const FILTERS = [
  ["ALL", "All"],
  ["COMPLETED", "Settled"],
  ["WAITING_FOR_PROVIDER", "Waiting"],
  ["EXECUTING", "In flight"],
  ["FAILED", "Refused"],
] as const;

function Entry({ exec }: { exec: ExecutionAttempt }) {
  const color = TONE_COLOR[toneOf(exec.state)];
  const at = new Date(exec.updatedAt || exec.createdAt);
  const stages = stagesFor(exec);
  const settled = typeof exec.actualSettledAmountUsdc === "number" ? exec.actualSettledAmountUsdc : null;
  const tx = exec.completeTx ?? exec.paymentTx ?? exec.createTx ?? null;

  return (
    <li className="grid grid-cols-[62px_20px_minmax(0,1fr)] gap-x-3 py-5 sm:grid-cols-[86px_20px_minmax(0,1fr)] sm:gap-x-4">
      <div className="text-right">
        <div className="run-num text-[12.5px] text-[var(--run-text)]">
          {at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
        </div>
        <div className="run-num mt-0.5 text-[10.5px] text-[var(--run-text-faint)]">
          {at.toLocaleDateString([], { month: "short", day: "numeric" })}
        </div>
      </div>

      {/* The spine: one continuous line with a node per event, so the page reads
          as a ledger instead of a stack of cards. */}
      <div className="relative flex justify-center">
        <span aria-hidden className="absolute inset-y-[-20px] w-px bg-[var(--run-line)]" />
        <span
          aria-hidden
          className="relative mt-1.5 h-[9px] w-[9px] rounded-full"
          style={{ background: color, boxShadow: `0 0 0 4px color-mix(in srgb, ${color} 16%, transparent)` }}
        />
      </div>

      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-[15px] font-semibold tracking-tight" style={{ color }}>
            {exec.state.replace(/_/g, " ")}
          </span>
          <span className="run-num text-[15px] text-[var(--run-text)]">
            ${money(settled ?? exec.authorizedAmountUsdc)}
            <span className="ml-1 text-[10px] text-[var(--run-text-faint)]">USDC</span>
          </span>
          {settled !== null && settled !== exec.authorizedAmountUsdc ? (
            <span className="run-num text-[11px] text-[var(--run-text-faint)]">
              of ${money(exec.authorizedAmountUsdc)} authorized
            </span>
          ) : null}
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px] text-[var(--run-text-muted)]">
          <span>{exec.capability.replace(/_/g, " ")}</span>
          <span aria-hidden className="text-[var(--run-line-strong)]">·</span>
          <span className="run-num">{shortHex(exec.counterpartyWallet)}</span>
          <span aria-hidden className="text-[var(--run-line-strong)]">·</span>
          <span className="run-num uppercase text-[var(--run-text-faint)]">{exec.rail}</span>
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-x-1.5 gap-y-1">
          {stages.map((stage, i) => (
            <React.Fragment key={stage.key}>
              {i > 0 ? (
                <span aria-hidden className="text-[10px] text-[var(--run-line-strong)]">→</span>
              ) : null}
              <span
                className="run-num text-[10px] uppercase tracking-[0.1em]"
                style={{ color: stage.done ? color : "var(--run-text-faint)" }}
              >
                {stage.label}
              </span>
            </React.Fragment>
          ))}
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px]">
          <span className="run-num text-[var(--run-text-faint)]">{exec.executionId}</span>
          {tx ? (
            <a
              href={`https://testnet.arcscan.app/tx/${tx}`}
              target="_blank"
              rel="noreferrer"
              className="run-focus run-num text-[var(--run-azure)] hover:underline"
            >
              {shortHex(tx)} ↗
            </a>
          ) : null}
          <Link
            href={`/execution/${exec.executionId}`}
            className="run-focus text-[var(--run-accent)] hover:underline"
          >
            Receipt →
          </Link>
        </div>
      </div>
    </li>
  );
}

export default function ExecutionsPage() {
  const { address } = useArcWallet();
  const [executions, setExecutions] = useState<ExecutionAttempt[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterState, setFilterState] = useState<string>("ALL");
  const [onlyMyWallet, setOnlyMyWallet] = useState(false);

  const fetchExecutions = useCallback(async () => {
    setLoading(true);
    try {
      let url = "/api/execution/v1";
      if (onlyMyWallet && address) {
        url += `?counterpartyWallet=${encodeURIComponent(address)}`;
      }
      const res = await fetch(url);
      const data = await res.json();
      if (res.ok) setExecutions(data.executions || []);
    } catch {
      // A failed poll leaves the last known log on screen rather than blanking it.
    } finally {
      setLoading(false);
    }
  }, [address, onlyMyWallet]);

  useEffect(() => {
    void fetchExecutions();
  }, [fetchExecutions]);

  const filtered = useMemo(
    () =>
      executions.filter((item) => {
        if (filterState !== "ALL" && item.state !== filterState) return false;
        if (!searchQuery) return true;
        const q = searchQuery.toLowerCase();
        return (
          item.executionId.toLowerCase().includes(q) ||
          item.capability.toLowerCase().includes(q) ||
          item.counterpartyWallet.toLowerCase().includes(q) ||
          Boolean(item.mandateId && item.mandateId.toLowerCase().includes(q))
        );
      }),
    [executions, filterState, searchQuery],
  );

  const settledUsdc = useMemo(
    () =>
      executions.reduce(
        (sum, e) => sum + (typeof e.actualSettledAmountUsdc === "number" ? e.actualSettledAmountUsdc : 0),
        0,
      ),
    [executions],
  );

  return (
    <div className="mx-auto w-full max-w-[1000px] px-5 pb-24 pt-10 sm:px-8">
      <header>
        <span className="run-eyebrow">Decision log · Arc Testnet</span>
        <div className="mt-2.5 flex flex-wrap items-end justify-between gap-5">
          <div>
            <h1 className="run-display text-[30px] sm:text-[36px]">Decisions</h1>
            <p className="mt-2 max-w-[54ch] text-[13.5px] leading-relaxed text-[var(--run-text-muted)]">
              Every payment {BRAND.name} approved, what was actually charged against it,
              and how far each one got.
            </p>
          </div>
          <div className="flex items-center gap-5">
            <div className="text-right">
              <div className="run-eyebrow">Settled</div>
              <div className="run-num mt-1 text-[19px]">${money(settledUsdc)}</div>
            </div>
            <div className="text-right">
              <div className="run-eyebrow">Entries</div>
              <div className="run-num mt-1 text-[19px]">{executions.length}</div>
            </div>
            <button
              type="button"
              onClick={() => void fetchExecutions()}
              disabled={loading}
              aria-label="Refresh the log"
              className="run-focus flex h-9 w-9 items-center justify-center rounded-[var(--run-radius-sm)] border border-[var(--run-line)] bg-[var(--run-surface)] text-[var(--run-text-muted)] transition-colors hover:text-[var(--run-text)]"
            >
              <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>
      </header>

      {/* One control row, not six pills wrapping across the page. */}
      <div className="mt-7 flex flex-wrap items-center gap-3 border-y border-[var(--run-line)] py-3">
        <div className="run-field flex h-9 min-w-[200px] flex-1 items-center gap-2 px-3">
          <Search className="size-3.5 shrink-0 text-[var(--run-text-faint)]" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Execution ID, wallet, capability"
            className="w-full bg-transparent text-[12.5px] text-[var(--run-text)] outline-none placeholder:text-[var(--run-text-faint)]"
          />
        </div>
        <div className="run-track flex gap-1">
          {FILTERS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setFilterState(value)}
              data-active={filterState === value}
              className="run-seg run-focus px-3 py-1.5 text-[12px] font-medium"
              style={{ color: filterState === value ? "var(--run-text)" : "var(--run-text-faint)" }}
            >
              {label}
            </button>
          ))}
        </div>
        {address ? (
          <button
            type="button"
            onClick={() => setOnlyMyWallet((v) => !v)}
            data-active={onlyMyWallet}
            className="run-seg run-focus rounded-[var(--run-radius-sm)] border border-[var(--run-line)] px-3 py-1.5 text-[12px]"
            style={{ color: onlyMyWallet ? "var(--run-text)" : "var(--run-text-faint)" }}
          >
            My wallet
          </button>
        ) : null}
      </div>

      {loading && executions.length === 0 ? (
        <div className="flex items-center gap-3 py-20 text-[13px] text-[var(--run-text-muted)]">
          <Loader2 className="size-4 animate-spin text-[var(--run-accent)]" />
          Reading the log…
        </div>
      ) : filtered.length === 0 ? (
        /* An empty log is a fact worth stating plainly, next to the proof that
           the path works and the one action that puts something in it. */
        <section className="run-panel mt-8 p-7">
          {searchQuery || filterState !== "ALL" ? (
            <>
              <h2 className="text-[15px] font-semibold">Nothing matches that filter.</h2>
              <p className="mt-2 text-[13px] text-[var(--run-text-muted)]">
                {executions.length} entr{executions.length === 1 ? "y is" : "ies are"} in the log.
              </p>
            </>
          ) : (
            <>
              <h2 className="text-[15px] font-semibold">No decisions recorded yet.</h2>
              <p className="mt-2 max-w-[58ch] text-[13px] leading-relaxed text-[var(--run-text-muted)]">
                Nothing has been authorized on this deployment. The path itself is
                proven: a full ERC-8183 job settled on Arc — escrow, deliverable,
                independent verdict, payout — in 19 seconds, for 0.0118 USDC of gas.
              </p>
              <div className="mt-5 flex flex-wrap items-center gap-4">
                <Link
                  href="/run"
                  className="run-cta run-focus inline-flex h-10 items-center rounded-[var(--run-radius-sm)] px-4 text-[13.5px] font-semibold"
                >
                  Run a decision
                </Link>
                <a
                  href="https://testnet.arcscan.app/tx/0xd1d958d5014a3584a21c7e67444091af25c64940aa4759c928fa2962d0995a22"
                  target="_blank"
                  rel="noreferrer"
                  className="run-focus run-num text-[12px] text-[var(--run-azure)] hover:underline"
                >
                  Job #186207 on Arcscan ↗
                </a>
              </div>
            </>
          )}
        </section>
      ) : (
        <ul className="mt-2">
          {filtered.map((exec) => (
            <Entry key={exec.executionId} exec={exec} />
          ))}
        </ul>
      )}
    </div>
  );
}
