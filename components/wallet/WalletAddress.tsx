"use client";

import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { shortenHash } from "@/lib/utils";

export function WalletAddress({
  address,
  chars = 6,
  copyable = true,
  full = false,
}: {
  address: string;
  chars?: number;
  copyable?: boolean;
  full?: boolean;
}) {
  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(address);
      toast.success("Copied wallet address");
    } catch {
      toast.error("Could not copy wallet address");
    }
  }

  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-2">
      <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-sm text-code tabular-usdc">
        {full ? address : shortenHash(address, chars)}
      </span>
      {copyable ? (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-7 shrink-0"
          onClick={copyAddress}
          aria-label="Copy wallet address"
        >
          <Copy className="size-3.5" />
        </Button>
      ) : null}
    </span>
  );
}
