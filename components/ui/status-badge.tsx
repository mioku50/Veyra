"use client";

import { cn } from "@/lib/utils";

const statusClass: Record<string, string> = {
  completed:
    "border-sky-400/25 bg-sky-400/10 text-sky-300 before:bg-sky-300",
  paid: "border-sky-400/25 bg-sky-400/10 text-sky-300 before:bg-sky-300",
  failed: "border-red-400/25 bg-red-400/10 text-red-300 before:bg-red-300",
  running:
    "border-blue-400/25 bg-blue-400/10 text-blue-300 before:bg-blue-300 before:animate-pulse",
  pending:
    "border-amber-400/25 bg-amber-400/10 text-amber-300 before:bg-amber-300",
  skipped:
    "border-slate-500/35 bg-slate-500/10 text-slate-300 before:bg-slate-400",
  scripted:
    "border-slate-500/35 bg-transparent text-slate-300 before:bg-slate-500",
};

export function StatusBadge({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  const normalized = status.toLowerCase();

  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-2 rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] before:size-1.5 before:shrink-0 before:rounded-full",
        statusClass[normalized] ??
          "border-border bg-muted/40 text-muted-foreground before:bg-muted-foreground",
        className,
      )}
    >
      <span className="truncate">{status}</span>
    </span>
  );
}
