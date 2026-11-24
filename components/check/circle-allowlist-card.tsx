"use client";

/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import { useState } from "react";
import { buildCircleRecipientAllowlistCommand } from "@/lib/x402/trust-api/circle-policy";

type Props = {
  payToAddresses: ReadonlyArray<string>;
};

export function CircleAllowlistCard({ payToAddresses }: Props) {
  const policy = buildCircleRecipientAllowlistCommand(payToAddresses);
  const [copied, setCopied] = useState(false);

  if (!policy) return null;

  async function copyCommand() {
    if (!policy) return;
    try {
      await navigator.clipboard.writeText(policy.command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="min-w-0 space-y-2.5 rounded-lg border border-white/10 bg-[#0b0f19]/60 p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-foreground">
          Circle CLI recipient allowlist
        </h3>
        <button
          type="button"
          onClick={copyCommand}
          className="rounded-md border border-white/15 bg-white/5 px-3 py-1 text-xs font-medium text-foreground hover:bg-white/10"
        >
          {copied ? "Copied" : "Copy command"}
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        Replace <code className="font-mono text-foreground">&lt;YOUR_AGENT_WALLET&gt;</code> with your Arc mainnet agent wallet address and run this command in your own terminal:
      </p>
      <pre className="max-w-full overflow-x-auto rounded-md border border-white/10 bg-background/80 p-3 font-mono text-xs leading-relaxed text-foreground whitespace-pre-wrap break-all">
        <code>{policy.command}</code>
      </pre>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Requires Circle CLI 1.4.0+ and applies to Arc mainnet agent wallets only. The CLI sends an email OTP prompt — confirm it only in your own terminal (human wallet owner action; never pass OTPs into an agent).
      </p>
    </section>
  );
}
