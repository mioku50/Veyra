"use client";

import { useState } from "react";
import { useArcWallet } from "./use-arc-wallet";
import { NoWalletHere } from "./wallet-app-links";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
  DialogDescription,
} from "@/components/ui/dialog";
import { chainLabel } from "@/lib/execution/presentation";

/** Optional account control. The payment form remains responsible for naming
 * its payer, funding source and network before asking for a signature. */
export function WalletControl({
  compact = false,
  verified,
  onVerify,
  verifying = false,
}: {
  compact?: boolean;
  verified?: boolean | null;
  onVerify?: () => void;
  verifying?: boolean;
}) {
  const wallet = useArcWallet();
  const [open, setOpen] = useState(false);
  const short = wallet.address
    ? `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`
    : null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size={compact ? "sm" : "default"}
          aria-label={short ? `Wallet ${short}` : "Connect wallet"}
        >
          {short ?? "Wallet"}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogTitle>Wallet</DialogTitle>
        <DialogDescription>
          Reading your brief needs no wallet. Each purchase shows its amount,
          network and source of funds before you sign.
        </DialogDescription>
        {!wallet.providerSettled ? (
          <p role="status">Looking for a wallet…</p>
        ) : !wallet.providerAvailable ? (
          <NoWalletHere what="this action" />
        ) : !wallet.address ? (
          <Button
            onClick={() => void wallet.connect()}
            disabled={wallet.connecting}
          >
            {wallet.connecting ? "Opening wallet…" : "Connect wallet"}
          </Button>
        ) : (
          <div className="space-y-4">
            <p className="break-all font-mono text-sm">{wallet.address}</p>
            <p className="text-sm">
              Connected network: {chainLabel(wallet.chainId)}
            </p>
            {verified === false && onVerify && (
              <Button disabled={verifying} onClick={onVerify}>
                {verifying ? "Waiting for signature…" : "Verify wallet"}
              </Button>
            )}
            <Button variant="outline" onClick={() => void wallet.disconnect()}>
              Disconnect wallet
            </Button>
          </div>
        )}
        {wallet.error && (
          <p role="alert" className="text-sm text-destructive">
            {wallet.error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
