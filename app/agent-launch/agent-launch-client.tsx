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
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  ExternalLink,
  Fuel,
  ListChecks,
  ReceiptText,
  RefreshCw,
  Send,
  Wallet,
} from "lucide-react";
import {
  encodeFunctionData,
  isAddress,
  parseEther,
  parseUnits,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { CopyButton } from "@/components/copy-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  arcClient,
  formatArcBalance,
  getErrorMessage,
  getProvider,
  useArcWallet,
} from "@/components/wallet/use-arc-wallet";
import {
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_EXPLORER_URL,
  ARC_TESTNET_FAUCET_URL,
  ARC_TESTNET_USDC_ADDRESS,
  ARC_TESTNET_USDC_DECIMALS,
  getArcExplorerAddressUrl,
} from "@/lib/wallet/arc";
import { BRAND } from "@/lib/brand";
import { shortenHash } from "@/lib/utils";

const erc20TransferAbi = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

type FundingKind = "native" | "erc20";

type TransactionState = {
  kind: FundingKind;
  status: "wallet-confirmation" | "submitted" | "confirmed" | "failed";
  hash?: Hex;
  message: string;
};

function validateAmount(value: string) {
  const normalized = value.trim().replace(",", ".");
  if (!normalized || Number(normalized) <= 0 || !Number.isFinite(Number(normalized))) {
    throw new Error("Enter a positive USDC amount like 0.05.");
  }

  return normalized;
}

function getExplorerTxUrl(hash: string) {
  return `${ARC_TESTNET_EXPLORER_URL}/tx/${hash}`;
}

function buildAgentCommand(task: string, limit: string) {
  const safeTask = task.trim() || `Create a small ${BRAND.name} workflow proof`;
  const safeLimit = validateAmount(limit || "0.0113");
  const escapedTask = safeTask.replaceAll('"', '\\"');

  return `AGENT_MAX_IN_FLIGHT=1 npm run agent -- --task "${escapedTask}" --limit ${safeLimit}`;
}

export function AgentLaunchClient() {
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
    setError,
  } = useArcWallet();
  const [destination, setDestination] = useState(
    process.env.NEXT_PUBLIC_DEMO_BUYER_ADDRESS ?? "",
  );
  const [nativeAmount, setNativeAmount] = useState("0.05");
  const [erc20Amount, setErc20Amount] = useState("0.05");
  const [task, setTask] = useState("Analyze tone and sentiment for a short builder update");
  const [limit, setLimit] = useState("0.005");
  const [txState, setTxState] = useState<TransactionState | null>(null);
  const [buyerNativeBalance, setBuyerNativeBalance] = useState<bigint | null>(null);
  const [buyerErc20Balance, setBuyerErc20Balance] = useState<bigint | null>(null);
  const [buyerBalanceError, setBuyerBalanceError] = useState<string | null>(null);
  const [buyerBalanceLoading, setBuyerBalanceLoading] = useState(false);

  const destinationIsValid = isAddress(destination);
  const destinationExplorerUrl = destinationIsValid
    ? getArcExplorerAddressUrl(destination)
    : null;

  const command = useMemo(() => {
    try {
      return buildAgentCommand(task, limit);
    } catch {
      return `AGENT_MAX_IN_FLIGHT=1 npm run agent -- --task "${task.trim() || "..."}" --limit ${limit || "0.0113"}`;
    }
  }, [limit, task]);

  const loadBuyerBalances = useCallback(async () => {
    if (!destinationIsValid) {
      setBuyerNativeBalance(null);
      setBuyerErc20Balance(null);
      setBuyerBalanceError(null);
      return;
    }

    setBuyerBalanceLoading(true);
    try {
      const [native, erc20] = await Promise.all([
        arcClient.getBalance({ address: destination as Address }),
        arcClient.readContract({
          address: ARC_TESTNET_USDC_ADDRESS as Address,
          abi: [
            {
              type: "function",
              name: "balanceOf",
              stateMutability: "view",
              inputs: [{ name: "account", type: "address" }],
              outputs: [{ name: "", type: "uint256" }],
            },
          ] as const,
          functionName: "balanceOf",
          args: [destination as Address],
        }),
      ]);

      setBuyerNativeBalance(native);
      setBuyerErc20Balance(erc20);
      setBuyerBalanceError(null);
    } catch (caught) {
      setBuyerNativeBalance(null);
      setBuyerErc20Balance(null);
      setBuyerBalanceError(getErrorMessage(caught));
    } finally {
      setBuyerBalanceLoading(false);
    }
  }, [destination, destinationIsValid]);

  useEffect(() => {
    void loadBuyerBalances();
  }, [loadBuyerBalances]);

  const ensureReady = useCallback(
    (amount: string) => {
      const provider = getProvider();
      if (!provider) throw new Error("No injected EVM wallet was detected.");
      if (!address) throw new Error("Connect your browser wallet first.");
      if (!isArcTestnet) {
        throw new Error(`Switch your wallet to Arc Testnet (${ARC_TESTNET_CHAIN_ID}) first.`);
      }
      if (!destinationIsValid) {
        throw new Error("Buyer-agent wallet destination must be a valid EVM address.");
      }

      return { provider, normalizedAmount: validateAmount(amount) };
    },
    [address, destinationIsValid, isArcTestnet],
  );

  const sendNative = useCallback(async () => {
    try {
      const { provider, normalizedAmount } = ensureReady(nativeAmount);
      const value = parseEther(normalizedAmount);
      if (nativeBalanceWei !== null && value > nativeBalanceWei) {
        throw new Error("Connected wallet does not have enough native USDC.");
      }

      setTxState({
        kind: "native",
        status: "wallet-confirmation",
        message: "Confirm the native USDC transfer in your wallet.",
      });

      const hash = await provider.request<Hex>({
        method: "eth_sendTransaction",
        params: [
          {
            from: address,
            to: destination,
            value: toHex(value),
          },
        ],
      });

      setTxState({
        kind: "native",
        status: "submitted",
        hash,
        message: "Native USDC funding transaction submitted.",
      });

      await arcClient.waitForTransactionReceipt({ hash });

      setTxState({
        kind: "native",
        status: "confirmed",
        hash,
        message: "Native gas USDC funding confirmed on Arc Testnet.",
      });

      if (address) await loadBalances(address);
      await loadBuyerBalances();
    } catch (caught) {
      const message = getErrorMessage(caught);
      setError(message);
      setTxState({
        kind: "native",
        status: "failed",
        message,
      });
    }
  }, [
    address,
    destination,
    ensureReady,
    loadBalances,
    loadBuyerBalances,
    nativeAmount,
    nativeBalanceWei,
    setError,
  ]);

  const sendErc20 = useCallback(async () => {
    try {
      const { provider, normalizedAmount } = ensureReady(erc20Amount);
      const value = parseUnits(normalizedAmount, ARC_TESTNET_USDC_DECIMALS);
      if (erc20UsdcBalance !== null && value > erc20UsdcBalance) {
        throw new Error("Connected wallet does not have enough ERC-20 USDC.");
      }

      const data = encodeFunctionData({
        abi: erc20TransferAbi,
        functionName: "transfer",
        args: [destination as Address, value],
      });

      setTxState({
        kind: "erc20",
        status: "wallet-confirmation",
        message: "Confirm the ERC-20 USDC transfer in your wallet.",
      });

      const hash = await provider.request<Hex>({
        method: "eth_sendTransaction",
        params: [
          {
            from: address,
            to: ARC_TESTNET_USDC_ADDRESS,
            data,
          },
        ],
      });

      setTxState({
        kind: "erc20",
        status: "submitted",
        hash,
        message: "ERC-20 USDC funding transaction submitted.",
      });

      await arcClient.waitForTransactionReceipt({ hash });

      setTxState({
        kind: "erc20",
        status: "confirmed",
        hash,
        message: "ERC-20 USDC funding confirmed on Arc Testnet.",
      });

      if (address) await loadBalances(address);
      await loadBuyerBalances();
    } catch (caught) {
      const message = getErrorMessage(caught);
      setError(message);
      setTxState({
        kind: "erc20",
        status: "failed",
        message,
      });
    }
  }, [
    address,
    destination,
    ensureReady,
    erc20Amount,
    erc20UsdcBalance,
    loadBalances,
    loadBuyerBalances,
    setError,
  ]);

  const transactionInFlight =
    txState?.status === "wallet-confirmation" || txState?.status === "submitted";
  const fundingDisabled =
    !address || !isArcTestnet || !destinationIsValid || transactionInFlight;

  return (
    <div className="grid gap-8 px-8 py-12">
      <div className="grid gap-6 lg:grid-cols-[1fr_0.78fr]">
        <Card className="rounded-lg shadow-sm">
          <CardHeader>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Badge variant="secondary">Connected wallet</Badge>
              <Badge variant={isArcTestnet ? "default" : "outline"}>
                {address ? (isArcTestnet ? "Arc Testnet" : `Chain ${chainId ?? "?"}`) : "Not connected"}
              </Badge>
            </div>
            <CardTitle>Wallet funding source</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            {!providerAvailable ? (
              <p className="rounded-md border bg-muted/50 p-3 text-sm text-muted-foreground">
                No injected EVM wallet detected. Unlock a browser wallet to fund
                the buyer-agent wallet.
              </p>
            ) : null}

            {address ? (
              <div className="rounded-md border bg-muted/35 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                      Browser wallet
                    </p>
                    <p className="mt-2 break-all font-mono text-sm">{address}</p>
                  </div>
                  <CopyButton value={address} label="Copy address" />
                </div>
              </div>
            ) : (
              <Button type="button" onClick={connect} disabled={connecting || !providerAvailable}>
                <Wallet />
                {connecting ? "Connecting..." : "Connect Funding Wallet"}
              </Button>
            )}

            {address && !isArcTestnet ? (
              <div className="flex flex-col gap-3 rounded-md border border-primary/25 bg-primary/5 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex gap-3 text-sm">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-primary" />
                  <div>
                    <p className="font-semibold">Switch to Arc Testnet</p>
                    <p className="mt-1 text-muted-foreground">
                      Funding is disabled unless the browser wallet is on chain
                      {` ${ARC_TESTNET_CHAIN_ID}`}.
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
                <dt className="text-sm text-muted-foreground">Native gas USDC</dt>
                <dd className="mt-2 font-mono text-xl font-bold tracking-tight text-foreground">
                  {loadingBalances
                    ? "Loading..."
                    : `${formatArcBalance(nativeBalanceWei)} USDC`}
                </dd>
              </div>
              <div className="rounded-md border bg-background p-4">
                <dt className="text-sm text-muted-foreground">ERC-20 USDC</dt>
                <dd className="mt-2 font-mono text-xl font-bold tracking-tight text-foreground">
                  {loadingBalances
                    ? "Loading..."
                    : `${formatArcBalance(erc20UsdcBalance, ARC_TESTNET_USDC_DECIMALS)} USDC`}
                </dd>
              </div>
            </dl>

            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              {address ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void loadBalances(address)}
                  disabled={loadingBalances}
                >
                  <RefreshCw className={loadingBalances ? "animate-spin" : undefined} />
                  Refresh balances
                </Button>
              ) : null}
              <Button asChild variant="outline">
                <Link href={ARC_TESTNET_FAUCET_URL} target="_blank" rel="noreferrer">
                  Open Faucet
                  <ExternalLink />
                </Link>
              </Button>
              {address ? (
                <Button asChild variant="outline">
                  <Link href={getArcExplorerAddressUrl(address)} target="_blank" rel="noreferrer">
                    Source Explorer
                    <ExternalLink />
                  </Link>
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-lg shadow-sm">
          <CardHeader>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Badge variant="secondary">Buyer-agent wallet</Badge>
              <Badge variant="outline">No private key in browser</Badge>
            </div>
            <CardTitle>Destination and readiness</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <label className="grid gap-2 text-sm">
              <span className="font-medium">Buyer-agent wallet destination</span>
              <Input
                value={destination}
                onChange={(event) => setDestination(event.target.value)}
                placeholder="0x..."
                className="font-mono"
              />
            </label>
            {!destinationIsValid ? (
              <p className="rounded-md border bg-muted/50 p-3 text-sm text-muted-foreground">
                Enter the buyer-agent wallet address used by your local CLI
                agent. This should match `BUYER_ADDRESS` in `.env.local`.
              </p>
            ) : null}

            <dl className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-md border bg-background p-4">
                <dt className="text-sm text-muted-foreground">Buyer native</dt>
                <dd className="mt-2 font-mono text-lg font-bold tracking-tight text-foreground">
                  {buyerBalanceLoading
                    ? "Loading..."
                    : `${formatArcBalance(buyerNativeBalance)} USDC`}
                </dd>
              </div>
              <div className="rounded-md border bg-background p-4">
                <dt className="text-sm text-muted-foreground">Buyer ERC-20</dt>
                <dd className="mt-2 font-mono text-lg font-bold tracking-tight text-foreground">
                  {buyerBalanceLoading
                    ? "Loading..."
                    : `${formatArcBalance(buyerErc20Balance, ARC_TESTNET_USDC_DECIMALS)} USDC`}
                </dd>
              </div>
            </dl>

            {buyerBalanceError ? (
              <p className="rounded-md border bg-muted/50 p-3 text-sm text-muted-foreground">
                Buyer balance check failed: {buyerBalanceError}
              </p>
            ) : null}

            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <Button
                type="button"
                variant="outline"
                onClick={() => void loadBuyerBalances()}
                disabled={!destinationIsValid || buyerBalanceLoading}
              >
                <RefreshCw className={buyerBalanceLoading ? "animate-spin" : undefined} />
                Refresh buyer
              </Button>
              {destinationIsValid ? (
                <>
                  <Button asChild variant="outline">
                    <Link href={destinationExplorerUrl ?? "#"} target="_blank" rel="noreferrer">
                      Buyer Explorer
                      <ExternalLink />
                    </Link>
                  </Button>
                  <Button asChild variant="outline">
                    <Link href={`/agents/${destination}`}>
                      Agent Passport
                      <BadgeCheck />
                    </Link>
                  </Button>
                  <Button asChild variant="outline">
                    <Link href={`/receipts?wallet=${destination}`}>
                      Receipts
                      <ReceiptText />
                    </Link>
                  </Button>
                </>
              ) : null}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="rounded-lg shadow-sm">
        <CardHeader>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Badge variant="default">Testnet-only funding</Badge>
            <Badge variant="outline">User-confirmed wallet transactions</Badge>
          </div>
          <CardTitle>Fund Local CLI Agent</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-5">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-lg border bg-background p-4">
              <div className="mb-4 flex items-center gap-2">
                <Fuel className="size-5 text-primary" />
                <h3 className="font-semibold">Send native gas USDC</h3>
              </div>
              <p className="mb-4 text-sm leading-6 text-muted-foreground">
                Funds the buyer-agent wallet with Arc native USDC for gas on
                Arc Testnet. This uses 18-decimal native value.
              </p>
              <label className="grid gap-2 text-sm">
                <span className="font-medium">Amount</span>
                <Input
                  value={nativeAmount}
                  onChange={(event) => setNativeAmount(event.target.value)}
                  inputMode="decimal"
                />
              </label>
              <Button
                type="button"
                className="mt-4 w-full"
                onClick={() => void sendNative()}
                disabled={fundingDisabled}
              >
                <Send />
                Send native USDC
              </Button>
            </div>

            <div className="rounded-lg border bg-background p-4">
              <div className="mb-4 flex items-center gap-2">
                <Send className="size-5 text-primary" />
                <h3 className="font-semibold">Send ERC-20 USDC</h3>
              </div>
              <p className="mb-4 text-sm leading-6 text-muted-foreground">
                Transfers canonical Arc Testnet ERC-20 USDC to the buyer-agent
                wallet. This uses the 6-decimal USDC token contract.
              </p>
              <label className="grid gap-2 text-sm">
                <span className="font-medium">Amount</span>
                <Input
                  value={erc20Amount}
                  onChange={(event) => setErc20Amount(event.target.value)}
                  inputMode="decimal"
                />
              </label>
              <Button
                type="button"
                className="mt-4 w-full"
                onClick={() => void sendErc20()}
                disabled={fundingDisabled}
              >
                <Send />
                Send ERC-20 USDC
              </Button>
            </div>
          </div>

          {txState ? (
            <div className="rounded-lg border bg-muted/35 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-semibold">
                    {txState.kind === "native" ? "Native funding" : "ERC-20 funding"}:{" "}
                    {txState.status}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">{txState.message}</p>
                  {txState.hash ? (
                    <p className="mt-2 break-all font-mono text-xs">
                      {shortenHash(txState.hash, 10)}
                    </p>
                  ) : null}
                </div>
                {txState.hash ? (
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <CopyButton value={txState.hash} label="Copy tx" />
                    <Button asChild variant="outline" size="sm">
                      <Link href={getExplorerTxUrl(txState.hash)} target="_blank" rel="noreferrer">
                        Explorer
                        <ExternalLink />
                      </Link>
                    </Button>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {error ? (
            <p className="rounded-md border bg-muted/50 p-3 text-sm text-muted-foreground">
              {error}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card className="rounded-lg shadow-sm">
        <CardHeader>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Badge variant="secondary">Local CLI launch</Badge>
            <Badge variant="outline">No browser x402 signing</Badge>
          </div>
          <CardTitle>Run the buyer-agent after funding</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-4 md:grid-cols-[1fr_160px]">
            <label className="grid gap-2 text-sm">
              <span className="font-medium">Task</span>
              <Input value={task} onChange={(event) => setTask(event.target.value)} />
            </label>
            <label className="grid gap-2 text-sm">
              <span className="font-medium">Budget limit</span>
              <Input
                value={limit}
                onChange={(event) => setLimit(event.target.value)}
                inputMode="decimal"
              />
            </label>
          </div>
          <div className="flex flex-col gap-3 rounded-md border bg-muted/35 p-4 sm:flex-row sm:items-center sm:justify-between">
            <code className="break-all font-mono text-sm">{command}</code>
            <CopyButton value={command} label="Copy command" />
          </div>
          <p className="text-sm leading-6 text-muted-foreground">
            The command runs the existing local buyer-agent. Your browser wallet
            only funds the destination; paid x402 requests and Gateway behavior
            remain in the CLI flow.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <Button asChild variant="outline">
              <Link href="/agent-control">
                Agent Control dry-run
                <ArrowRight />
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/runs">
                Agent Runs
                <ListChecks />
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href={destinationIsValid ? `/receipts?wallet=${destination}` : "/receipts"}>
                Receipts after run
                <ReceiptText />
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
