/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight } from "lucide-react";
import type { Erc8004IdentityVerificationError } from "@/lib/erc8004/client.ts";

/**
 * Rendered when ERC-8004 identity cannot be canonically verified.
 *
 * The page stays fail-closed - no score, no evidence, nothing that implies
 * verified trust - but it says what happened instead of throwing an opaque
 * 500 at the global error boundary. /reputation had this; /agents/veyra threw
 * the 500 until 27 September.
 */
export function IdentityUnverifiablePanel({
  failure,
  withheld,
  children,
}: {
  failure: Erc8004IdentityVerificationError;
  /** What the page holds back, in one sentence under the heading. */
  withheld: string;
  /** Why nothing is shown, in the page's own terms. */
  children: ReactNode;
}) {
  const historyUnavailable = failure.code === "chain_history_unavailable";
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 md:p-12 font-sans">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="flex items-center gap-3 border-b border-slate-800 pb-6">
          <AlertTriangle className="w-9 h-9 text-amber-400" />
          <div>
            <h1 className="text-2xl font-bold">Onchain identity could not be verified</h1>
            <p className="text-sm text-slate-400">{withheld}</p>
          </div>
        </div>

        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-5 space-y-3">
          <p className="text-sm text-slate-200">
            {historyUnavailable
              ? "The Arc Testnet RPC no longer returns the registration transaction for this agent, so the registration receipt cannot be re-checked. Contract state (ownerOf, tokenURI) still resolves, but Veyra requires the full canonical chain of evidence before it publishes anything that rests on this identity."
              : "A canonical ERC-8004 identity check did not pass, so nothing that rests on it is shown."}
          </p>
          <p className="font-mono text-xs text-amber-300">reason: {failure.code}</p>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5 space-y-2 text-sm text-slate-400">
          <p className="text-slate-200 font-semibold">Why nothing is shown here</p>
          {children}
        </div>

        <div className="flex flex-wrap gap-3">
          <Link href="/trust" className="text-sky-400 hover:text-sky-300 text-sm inline-flex items-center gap-1">
            Trust Overview <ArrowRight className="w-4 h-4" />
          </Link>
          <Link href="/agents" className="text-sky-400 hover:text-sky-300 text-sm inline-flex items-center gap-1">
            Browse agents <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </div>
    </div>
  );
}
