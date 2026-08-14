/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import React from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export interface PublicBetaBadgeProps {
  className?: string;
  variant?: "default" | "compact" | "banner";
  showDisclaimer?: boolean;
}

export function PublicBetaBadge({
  className,
  variant = "default",
  showDisclaimer = false,
}: PublicBetaBadgeProps) {
  if (variant === "compact") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-300 backdrop-blur-md shadow-[0_0_10px_rgba(0,208,132,0.15)]",
          className,
        )}
      >
        <span className="relative flex size-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex size-1.5 rounded-full bg-emerald-400" />
        </span>
        <span>Arc Testnet · Public Beta</span>
      </span>
    );
  }

  if (variant === "banner") {
    return (
      <div
        className={cn(
          "flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-2.5 text-xs text-emerald-300 backdrop-blur-md",
          className,
        )}
      >
        <div className="flex items-center gap-2 font-medium">
          <span className="relative flex size-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex size-2 rounded-full bg-emerald-400" />
          </span>
          <span>Arc Testnet · Public Beta v0.1.0</span>
        </div>
        {showDisclaimer && (
          <span className="text-[11px] text-muted-foreground">
            Experimental software · Smart contracts are not audited · Use testnet funds only
          </span>
        )}
      </div>
    );
  }

  return (
    <div className={cn("inline-flex flex-col sm:flex-row items-center gap-2", className)}>
      <Badge className="rounded-full border-emerald-500/30 bg-emerald-500/10 px-3.5 py-1 text-xs font-semibold text-emerald-300 backdrop-blur-md shadow-[0_0_15px_rgba(0,208,132,0.15)]">
        <span className="mr-2 inline-block size-2 rounded-full bg-emerald-400 animate-pulse shadow-[0_0_8px_rgba(0,208,132,0.8)]" />
        Arc Testnet · Public Beta
      </Badge>
      {showDisclaimer && (
        <span className="text-[11px] font-medium text-muted-foreground/80">
          Experimental · Contracts are not audited
        </span>
      )}
    </div>
  );
}
