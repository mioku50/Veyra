/**
 * Copyright 2026 Veyra
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

"use client";

import Link from "next/link";
import { useMemo } from "react";
import {
  AlertTriangle,
  BadgeCheck,
  ExternalLink,
  Fuel,
  RefreshCw,
  Wallet,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/copy-button";
import {
  formatArcBalance,
  useArcWallet,
} from "@/components/wallet/use-arc-wallet";
import {
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_FAUCET_URL,
  ARC_TESTNET_USDC_DECIMALS,
  getArcExplorerAddressUrl,
} from "@/lib/wallet/arc";
import { cn, shortenHash } from "@/lib/utils";

type ArcWalletWidgetProps = {
  variant?: "card" | "compact";
  className?: string;
};

export function ArcWalletWidget({
  variant = "card",
  className,
}: ArcWalletWidgetProps) {
  const {
    address,
    chainId,
    nativeBalanceWei,
    erc20UsdcBalance,
    connecting,
    switching,
    loadingBalances,
    error,
    providerAvailable,
    isArcTestnet,
    connect,
    switchToArc,
    loadBalances,
  } = useArcWallet();

  const explorerUrl = useMemo(
    () => (address ? getArcExplorerAddressUrl(address) : null),
    [address],
  );

  if (variant === "compact") {
    return (
      <div className={cn("flex items-center gap-2", className)}>
        {address ? (
          <>
            <Badge
              variant={isArcTestnet ? "secondary" : "outline"}
              className="max-w-[140px] gap-1.5 sm:max-w-[168px]"
            >
              <Wallet className="size-3.5" />
              <span className="truncate font-mono">{shortenHash(address, 4)}</span>
            </Badge>
            <Badge variant={isArcTestnet ? "default" : "outline"} className="hidden sm:inline-flex">
              {isArcTestnet ? "Arc Testnet" : `Chain ${chainId ?? "?"}`}
            </Badge>
            {!isArcTestnet ? (
              <Button type="button" size="sm" variant="outline" onClick={switchToArc}>
                <Fuel />
                {switching ? "Switching..." : "Switch Arc"}
              </Button>
            ) : null}
          </>
        ) : (
          <Button type="button" size="sm" variant="outline" onClick={connect} disabled={connecting}>
            <Wallet />
            {connecting ? "Connecting..." : "Connect Wallet"}
          </Button>
        )}
      </div>
    );
  }

  return (
    <section className={cn("rounded-lg border bg-card p-5 shadow-sm", className)}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Badge variant="secondary">Browser wallet</Badge>
            <Badge variant={isArcTestnet ? "default" : "outline"}>
              {address ? (isArcTestnet ? "Arc Testnet connected" : "Wrong network") : "Read-only UX"}
            </Badge>
          </div>
          <h2 className="text-xl font-semibold">Arc Testnet Wallet</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Connect an EVM wallet to inspect Arc Testnet balances, switch
            networks, fund the local buyer-agent wallet, and jump into faucet,
            explorer, Passport, or receipts.
          </p>
        </div>
        {address ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void loadBalances(address)}
            disabled={loadingBalances}
          >
            <RefreshCw className={cn(loadingBalances && "animate-spin")} />
            Refresh
          </Button>
        ) : (
          <Button type="button" onClick={connect} disabled={connecting || !providerAvailable}>
            <Wallet />
            {connecting ? "Connecting..." : "Connect Wallet"}
          </Button>
        )}
      </div>

      {!providerAvailable ? (
        <p className="mt-4 rounded-md border bg-muted/50 p-3 text-sm text-muted-foreground">
          No injected EVM wallet detected. Install or unlock a browser wallet to
          use Arc Testnet wallet actions.
        </p>
      ) : null}

      {address ? (
        <div className="mt-5 grid gap-4">
          <div className="rounded-md border bg-muted/35 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  Connected wallet
                </p>
                <p className="mt-2 break-all font-mono text-sm">{address}</p>
              </div>
              <CopyButton value={address} label="Copy address" />
            </div>
          </div>

          {!isArcTestnet ? (
            <div className="flex flex-col gap-3 rounded-md border border-primary/25 bg-primary/5 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex gap-3 text-sm">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-primary" />
                <div>
                  <p className="font-semibold text-foreground">
                    Switch to Arc Testnet
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    Current network: {chainId ? `chain ${chainId}` : "unknown"}.
                    Arc Testnet is chain {ARC_TESTNET_CHAIN_ID}.
                  </p>
                </div>
              </div>
              <Button type="button" onClick={switchToArc} disabled={switching}>
                <Fuel />
                {switching ? "Switching..." : "Switch Network"}
              </Button>
            </div>
          ) : null}

          <dl className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-md border bg-background p-4">
              <dt className="text-sm text-muted-foreground">Native gas balance</dt>
              <dd className="mt-2 font-mono text-2xl font-semibold">
                {loadingBalances
                  ? "Loading..."
                  : `${formatArcBalance(nativeBalanceWei)} USDC`}
              </dd>
              <p className="mt-2 text-xs text-muted-foreground">
                Arc gas uses native USDC with 18-decimal accounting.
              </p>
            </div>
            <div className="rounded-md border bg-background p-4">
              <dt className="text-sm text-muted-foreground">ERC-20 USDC balance</dt>
              <dd className="mt-2 font-mono text-2xl font-semibold">
                {loadingBalances
                  ? "Loading..."
                  : `${formatArcBalance(erc20UsdcBalance, ARC_TESTNET_USDC_DECIMALS)} USDC`}
              </dd>
              <p className="mt-2 text-xs text-muted-foreground">
                Canonical Arc Testnet USDC token uses 6 decimals.
              </p>
            </div>
          </dl>

          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <Button asChild variant="outline">
              <Link href="/developer-tools">
                Developer Tools
                <Fuel />
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href={ARC_TESTNET_FAUCET_URL} target="_blank" rel="noreferrer">
                Open Faucet
                <ExternalLink />
              </Link>
            </Button>
            {explorerUrl ? (
              <Button asChild variant="outline">
                <Link href={explorerUrl} target="_blank" rel="noreferrer">
                  Arc Explorer
                  <ExternalLink />
                </Link>
              </Button>
            ) : null}
            <Button asChild variant="outline">
              <Link href={`/agents/${address}`}>
                Agent Passport
                <BadgeCheck />
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href={`/receipts?wallet=${address}`}>Related Receipts</Link>
            </Button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p className="mt-4 rounded-md border bg-muted/50 p-3 text-sm text-muted-foreground">
          {error}
        </p>
      ) : null}
    </section>
  );
}
