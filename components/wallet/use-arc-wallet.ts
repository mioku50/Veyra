/**
 * Copyright 2026 Circle Internet Group, Inc.  All rights reserved.
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

import { useCallback, useEffect, useState } from "react";
import {
  createPublicClient,
  formatEther,
  formatUnits,
  getAddress,
  http,
  isAddress,
  parseUnits,
  stringToHex,
  toHex,
  type Address,
  type Hex,
} from "viem";
import {
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_RPC_URL,
  ARC_TESTNET_USDC_ADDRESS,
  ARC_TESTNET_USDC_DECIMALS,
  arcTestnetChain,
} from "@/lib/wallet/arc";
import {
  requestArcTestnet,
  type ArcNetworkProvider,
} from "@/lib/wallet/request-arc-testnet";
import {
  arcAccountKind,
  readArcUsdcBlocklistStatuses,
} from "@/lib/wallet/arc-usdc";
import {
  ARC_MEMO_WORKFLOW_PAYMENT_PROTOCOL,
  encodeWorkflowPaymentTransaction,
  type WorkflowPaymentDescriptor,
} from "@/lib/commerce/workflow-payment";

export type EthereumProvider = ArcNetworkProvider & {
  on?(
    event: "accountsChanged" | "chainChanged",
    listener: (...args: unknown[]) => void,
  ): void;
  removeListener?(
    event: "accountsChanged" | "chainChanged",
    listener: (...args: unknown[]) => void,
  ): void;
};

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

export const erc20BalanceAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const arcClient = createPublicClient({
  chain: arcTestnetChain,
  transport: http(ARC_TESTNET_RPC_URL),
});

export function getProvider() {
  if (typeof window === "undefined") return null;
  return window.ethereum ?? null;
}

export function parseChainId(value: string | number | null) {
  if (value === null) return null;
  if (typeof value === "number") return value;
  return Number.parseInt(value, 16);
}

export function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message);
  }
  return String(error);
}

export function isProviderError(error: unknown, code: number) {
  if (!error || typeof error !== "object") return false;

  return "code" in error && Number((error as { code?: unknown }).code) === code;
}

export function formatArcBalance(value: bigint | null, decimals = 18) {
  if (value === null) return "n/a";

  const formatted =
    decimals === 18 ? formatEther(value) : formatUnits(value, decimals);
  const numeric = Number(formatted);

  if (!Number.isFinite(numeric)) return formatted;
  if (numeric === 0) return "0";
  if (numeric < 0.0001) return "<0.0001";

  return numeric.toLocaleString("en", {
    maximumFractionDigits: 4,
  });
}

export function useArcWallet() {
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [nativeBalanceWei, setNativeBalanceWei] = useState<bigint | null>(null);
  const [erc20UsdcBalance, setErc20UsdcBalance] = useState<bigint | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [loadingBalances, setLoadingBalances] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providerAvailable, setProviderAvailable] = useState(false);
  const isArcTestnet = chainId === ARC_TESTNET_CHAIN_ID;

  const readWalletState = useCallback(async () => {
    const provider = getProvider();
    if (!provider) return;

    try {
      const [accounts, connectedChainId] = await Promise.all([
        provider.request<string[]>({ method: "eth_accounts" }),
        provider.request<string>({ method: "eth_chainId" }),
      ]);

      setAddress(accounts[0] ?? null);
      setChainId(parseChainId(connectedChainId));
      setError(null);
    } catch (caught) {
      setError(getErrorMessage(caught));
    }
  }, []);

  const loadBalances = useCallback(async (walletAddress: string) => {
    setLoadingBalances(true);

    try {
      const [native, erc20] = await Promise.all([
        arcClient.getBalance({ address: walletAddress as Address }),
        arcClient.readContract({
          address: ARC_TESTNET_USDC_ADDRESS as Address,
          abi: erc20BalanceAbi,
          functionName: "balanceOf",
          args: [walletAddress as Address],
        }),
      ]);

      setNativeBalanceWei(native);
      setErc20UsdcBalance(erc20);
      setError(null);
    } catch (caught) {
      setNativeBalanceWei(null);
      setErc20UsdcBalance(null);
      setError(`Could not load Arc balances: ${getErrorMessage(caught)}`);
    } finally {
      setLoadingBalances(false);
    }
  }, []);

  // Injected wallets are not guaranteed to exist at mount: several extensions
  // attach `window.ethereum` after hydration. Detect the provider on arrival so
  // the connect button never stays disabled on an installed wallet.
  useEffect(() => {
    const detect = () => {
      if (!getProvider()) return false;
      setProviderAvailable(true);
      void readWalletState();
      return true;
    };
    if (detect()) return;

    const onInitialized = () => detect();
    window.addEventListener("ethereum#initialized", onInitialized, { once: true });
    const timer = window.setTimeout(onInitialized, 3_000);

    return () => {
      window.removeEventListener("ethereum#initialized", onInitialized);
      window.clearTimeout(timer);
    };
  }, [readWalletState]);

  useEffect(() => {
    if (!address) return;
    void loadBalances(address);
  }, [address, loadBalances]);

  useEffect(() => {
    const provider = getProvider();
    if (!provider?.on) return;

    const handleAccountsChanged = (accounts: unknown) => {
      const nextAccounts = Array.isArray(accounts) ? accounts : [];
      setAddress(typeof nextAccounts[0] === "string" ? nextAccounts[0] : null);
    };
    const handleChainChanged = (nextChainId: unknown) => {
      setChainId(typeof nextChainId === "string" ? parseChainId(nextChainId) : null);
    };

    provider.on("accountsChanged", handleAccountsChanged);
    provider.on("chainChanged", handleChainChanged);

    return () => {
      provider.removeListener?.("accountsChanged", handleAccountsChanged);
      provider.removeListener?.("chainChanged", handleChainChanged);
    };
  }, [providerAvailable]);

  const connect = useCallback(async () => {
    const provider = getProvider();
    if (!provider) {
      setError("No injected EVM wallet was detected.");
      return;
    }

    setConnecting(true);
    try {
      const accounts = await provider.request<string[]>({
        method: "eth_requestAccounts",
      });
      const connectedChainId = await provider.request<string>({
        method: "eth_chainId",
      });
      const nextAddress = accounts[0] ?? null;
      const nextChainId = parseChainId(connectedChainId);

      setAddress(nextAddress);
      setChainId(nextChainId);
      if (nextAddress && nextChainId !== ARC_TESTNET_CHAIN_ID) {
        setSwitching(true);
        try {
          await requestArcTestnet(provider);
          setChainId(ARC_TESTNET_CHAIN_ID);
          setError(null);
        } catch (caught) {
          setError(`Wallet connected. Switch to Arc Testnet to continue: ${getErrorMessage(caught)}`);
        } finally {
          setSwitching(false);
        }
      } else {
        setError(null);
      }
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setConnecting(false);
    }
  }, []);

  const switchToArc = useCallback(async () => {
    const provider = getProvider();
    if (!provider) {
      setError("No injected EVM wallet was detected.");
      return;
    }

    setSwitching(true);
    try {
      await requestArcTestnet(provider);
      setChainId(ARC_TESTNET_CHAIN_ID);
      setError(null);
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setSwitching(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    const provider = getProvider();

    try {
      await provider?.request({
        method: "wallet_revokePermissions",
        params: [{ eth_accounts: {} }],
      });
    } catch {
      // Not every injected wallet supports permission revocation. Clearing
      // local state still disconnects this app session without exposing keys.
    } finally {
      setAddress(null);
      setNativeBalanceWei(null);
      setErc20UsdcBalance(null);
      setError(null);
    }
  }, []);

  const refresh = useCallback(async () => {
    await readWalletState();
    if (address) await loadBalances(address);
  }, [address, loadBalances, readWalletState]);

  const signMessage = useCallback(async (message: string) => {
    const provider = getProvider();
    if (!provider || !address) throw new Error("Connect a wallet before signing.");
    try {
      const signature = await provider.request<Hex>({
        method: "personal_sign",
        params: [stringToHex(message), address],
      });
      setError(null);
      return signature;
    } catch (caught) {
      const message = getErrorMessage(caught);
      setError(message);
      throw caught;
    }
  }, [address]);

  const sendWorkflowPayment = useCallback(async (input: {
    treasuryAddress: string;
    amountUsdc: number;
    payment?: WorkflowPaymentDescriptor | null;
  }) => {
    const provider = getProvider();
    if (!provider || !address) throw new Error("Connect a wallet before paying.");
    const currentChain = parseChainId(
      await provider.request<string>({ method: "eth_chainId" }),
    );
    if (currentChain !== ARC_TESTNET_CHAIN_ID) {
      throw new Error("Switch to Arc Testnet before paying.");
    }
    if (!isAddress(input.treasuryAddress)) throw new Error("Invalid workflow treasury address.");
    const amountAtomic6 = Math.round(input.amountUsdc * 1_000_000);
    if (
      !Number.isFinite(input.amountUsdc) ||
      input.amountUsdc <= 0 ||
      Math.abs(input.amountUsdc * 1_000_000 - amountAtomic6) > 0.000001
    ) {
      throw new Error("Workflow price must be a positive USDC amount with at most 6 decimals.");
    }
    const treasuryAddress = getAddress(input.treasuryAddress);
    const compliance = await readArcUsdcBlocklistStatuses(
      [address, treasuryAddress],
      arcClient,
    );
    const senderStatus = compliance.get(getAddress(address).toLowerCase()) ?? "unknown";
    const treasuryStatus = compliance.get(treasuryAddress.toLowerCase()) ?? "unknown";
    if (senderStatus === "blocklisted" || treasuryStatus === "blocklisted") {
      throw new Error("Arc USDC payment is blocked by the onchain blocklist.");
    }
    if (senderStatus === "unknown" || treasuryStatus === "unknown") {
      throw new Error("Arc USDC blocklist status could not be verified. Try again before paying.");
    }
    const descriptor = input.payment ?? null;
    if (descriptor) {
      if (
        descriptor.treasuryAddress.toLowerCase() !== treasuryAddress.toLowerCase() ||
        BigInt(descriptor.amountAtomic6) !== BigInt(amountAtomic6)
      ) {
        throw new Error("Workflow payment details do not match the immutable quote.");
      }
      if (descriptor.protocol === ARC_MEMO_WORKFLOW_PAYMENT_PROTOCOL) {
        const accountKind = await arcAccountKind(address, arcClient);
        if (accountKind !== "eoa") {
          throw new Error(
            accountKind === "contract"
              ? "Arc Memo checkout requires an EOA wallet; smart-contract wallets are not supported for this payment."
              : "Wallet type could not be verified for Arc Memo checkout.",
          );
        }
      }
    }
    const transaction = descriptor
      ? encodeWorkflowPaymentTransaction(descriptor)
      : {
          to: treasuryAddress,
          value: parseUnits((amountAtomic6 / 1_000_000).toFixed(6), 18),
          data: "0x" as Hex,
        };
    try {
      const transactionHash = await provider.request<Hex>({
        method: "eth_sendTransaction",
        params: [{
          from: address,
          to: transaction.to,
          value: toHex(transaction.value),
          data: transaction.data,
        }],
      });
      setError(null);
      return transactionHash;
    } catch (caught) {
      const message = getErrorMessage(caught);
      setError(message);
      throw caught;
    }
  }, [address]);

  const signTypedData = useCallback(async (params: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }) => {
    const provider = getProvider();
    if (!provider || !address) throw new Error("Connect a wallet before signing.");
    try {
      const signature = await provider.request<Hex>({
        method: "eth_signTypedData_v4",
        params: [address, JSON.stringify(params)],
      });
      setError(null);
      return signature;
    } catch (caught) {
      const message = getErrorMessage(caught);
      setError(message);
      throw caught;
    }
  }, [address]);

  const sendTransaction = useCallback(async (params: {
    to: Address;
    data?: Hex;
    value?: Hex;
  }) => {
    const provider = getProvider();
    if (!provider || !address) throw new Error("Connect a wallet before sending transaction.");
    const currentChain = parseChainId(
      await provider.request<string>({ method: "eth_chainId" }),
    );
    if (currentChain !== ARC_TESTNET_CHAIN_ID) {
      throw new Error("Switch to Arc Testnet before sending transaction.");
    }
    try {
      const transactionHash = await provider.request<Hex>({
        method: "eth_sendTransaction",
        params: [{
          from: address,
          to: getAddress(params.to),
          value: params.value ?? "0x0",
          data: params.data ?? "0x",
        }],
      });
      setError(null);
      return transactionHash;
    } catch (caught) {
      const message = getErrorMessage(caught);
      setError(message);
      throw caught;
    }
  }, [address]);

  return {
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
    disconnect,
    loadBalances,
    refresh,
    signMessage,
    signTypedData,
    sendWorkflowPayment,
    sendTransaction,
    setError,
  };
}
