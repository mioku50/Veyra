"use client";

import Link from "next/link";
import { useMemo } from "react";
import {
  BadgeCheck,
  ExternalLink,
  Fuel,
  LogOut,
  Wrench,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { WalletAddress } from "@/components/wallet/WalletAddress";
import { useArcWallet } from "@/components/wallet/use-arc-wallet";
import {
  getArcExplorerAddressUrl,
} from "@/lib/wallet/arc";
import { cn, shortenHash } from "@/lib/utils";
import {
  HOSTED_REQUESTER_IDENTITY_LABEL,
  HOSTED_REQUESTER_NOT_CHARGED_COPY,
  HOSTED_REQUESTER_PAYMENT_COPY,
} from "@/lib/agent/hosted-ui";

export function WalletWidget({ compact = false }: { compact?: boolean }) {
  const {
    address,
    chainId,
    connecting,
    switching,
    error,
    providerAvailable,
    isArcTestnet,
    connect,
    switchToArc,
    disconnect,
  } = useArcWallet();

  const explorerUrl = useMemo(
    () => (address ? getArcExplorerAddressUrl(address) : null),
    [address],
  );

  if (!address) {
    return (
      <Button
        type="button"
        size={compact ? "sm" : "default"}
        variant="outline"
        onClick={connect}
        disabled={connecting || !providerAvailable}
        className="border-primary/35 bg-primary/10 text-primary hover:bg-primary/15"
      >
        <Wallet />
        {connecting ? "Connecting..." : "Connect Wallet"}
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size={compact ? "sm" : "default"}
          className="max-w-[220px] justify-start border-border/80 bg-card/90"
        >
          <span
            className={cn(
              "size-2 rounded-full",
              isArcTestnet ? "bg-sky-400 shadow-[0_0_16px_rgb(0_208_132/0.6)]" : "bg-amber-400",
            )}
          />
          <span className="min-w-0 truncate font-mono">
            {shortenHash(address, 4)}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[340px] p-3">
        <div className="mb-3 rounded-md border border-primary/20 bg-primary/5 p-3">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">
            {HOSTED_REQUESTER_IDENTITY_LABEL}
          </p>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            <span className="block font-semibold text-foreground">
              {HOSTED_REQUESTER_NOT_CHARGED_COPY}
            </span>
            {HOSTED_REQUESTER_PAYMENT_COPY}
          </p>
        </div>
        <div className="rounded-md border bg-muted/35 p-3">
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            <span
              className={cn(
                "size-2 rounded-full",
                isArcTestnet ? "bg-sky-400" : "bg-amber-400",
              )}
            />
            {isArcTestnet ? "Arc Testnet" : `Chain ${chainId ?? "?"}`}
          </p>
          <div className="mt-3">
            <WalletAddress address={address} full />
          </div>
        </div>

        {!isArcTestnet ? (
          <Button
            type="button"
            className="mt-3 w-full"
            onClick={switchToArc}
            disabled={switching}
          >
            <Fuel />
            {switching ? "Switching..." : "Switch to Arc Testnet"}
          </Button>
        ) : null}

        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/developer-tools">
              Developer Tools
              <Wrench />
            </Link>
          </Button>
          {explorerUrl ? (
            <Button asChild variant="outline" size="sm">
              <Link href={explorerUrl} target="_blank" rel="noreferrer">
                Explorer
                <ExternalLink />
              </Link>
            </Button>
          ) : null}
          <Button asChild variant="outline" size="sm">
            <Link href={`/agents/${address}`}>
              Passport
              <BadgeCheck />
            </Link>
          </Button>
        </div>

        {error ? (
          <p className="mt-3 rounded-md border bg-muted/50 p-2 text-xs text-muted-foreground">
            {error}
          </p>
        ) : null}

        <DropdownMenuSeparator className="my-3" />
        <DropdownMenuItem
          className="cursor-pointer text-destructive focus:text-destructive"
          onSelect={(event) => {
            event.preventDefault();
            void disconnect();
          }}
        >
          <LogOut />
          Disconnect wallet
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
