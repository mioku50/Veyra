/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { createPublicClient, encodeFunctionData, erc20Abi, http, type Chain } from "viem";
import {
  arbitrum, arcTestnet, avalanche, avalancheFuji, base, baseSepolia, mainnet,
  optimism, polygon, sei, sepolia, sonic, unichain, worldchain,
} from "viem/chains";
import { usdcAddressForChain } from "./usdc-assets.ts";

/**
 * What a Circle Gateway endpoint actually needs before it can be paid.
 *
 * A batched accept does not spend the wallet's USDC balance. It spends a
 * deposit already sitting in Circle's GatewayWallet on that chain, and a wallet
 * holding plenty of USDC will still be refused. Veyra said so in prose and then
 * left the reader at a dead end: the panel named a problem it gave no way to
 * solve.
 *
 * Nothing here holds a key. The reads are public chain and public API data, and
 * the writes are unsigned calldata for the buyer's own wallet to sign — the
 * same arrangement as the ERC-8183 job flow.
 *
 * 74 of the 389 resources in Circle's catalog settle this way and 289 do not,
 * and no resource offers both, so this is a property of the endpoint the buyer
 * picked rather than a setting anyone can switch.
 */

/** Circle's GatewayWallet, identical on every chain of a given network. */
export const GATEWAY_WALLET_MAINNET = "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE" as const;
export const GATEWAY_WALLET_TESTNET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9" as const;

/** Circle's domain ids, which the balances API addresses deposits by. */
const MAINNET_DOMAINS: Record<number, number> = {
  1: 0,        // Ethereum
  43114: 1,    // Avalanche
  10: 2,       // OP
  42161: 3,    // Arbitrum
  8453: 6,     // Base
  137: 7,      // Polygon PoS
  130: 10,     // Unichain
  146: 13,     // Sonic
  480: 14,     // World Chain
  1329: 16,    // Sei
  999: 19,     // HyperEVM
};

const TESTNET_DOMAINS: Record<number, number> = {
  11155111: 0, // Ethereum Sepolia
  43113: 1,    // Avalanche Fuji
  84532: 6,    // Base Sepolia
  5042002: 26, // Arc Testnet
};

export type GatewayContext = {
  chainId: number;
  domain: number;
  gatewayWallet: `0x${string}`;
  usdc: `0x${string}`;
  testnet: boolean;
  balancesUrl: string;
};

/** The Gateway deployment a chain belongs to, or null where there is none. */
export function gatewayContextForChain(chainId: number): GatewayContext | null {
  const usdc = usdcAddressForChain(chainId);
  if (!usdc) return null;
  const testnet = chainId in TESTNET_DOMAINS;
  const domain = testnet ? TESTNET_DOMAINS[chainId] : MAINNET_DOMAINS[chainId];
  if (domain === undefined) return null;
  return {
    chainId,
    domain,
    gatewayWallet: testnet ? GATEWAY_WALLET_TESTNET : GATEWAY_WALLET_MAINNET,
    usdc: usdc as `0x${string}`,
    testnet,
    balancesUrl: testnet
      ? "https://gateway-api-testnet.circle.com/v1/balances"
      : "https://gateway-api.circle.com/v1/balances",
  };
}

/* Named explicitly rather than scanned out of viem's full chain list: these are
   the chains Circle actually runs Gateway on, and an unknown chain must read as
   unsupported rather than resolve to something that merely shares an id. */
const GATEWAY_CHAINS: Chain[] = [
  mainnet, avalanche, optimism, arbitrum, base, polygon, unichain, sonic,
  worldchain, sei, sepolia, avalancheFuji, baseSepolia, arcTestnet,
];

function chainFor(chainId: number): Chain | null {
  return GATEWAY_CHAINS.find((candidate) => candidate.id === chainId) ?? null;
}

function atomicFromDecimal(value: string): bigint {
  const [whole, fraction = ""] = value.trim().split(".");
  const padded = `${fraction}000000`.slice(0, 6);
  try {
    return BigInt(whole || "0") * BigInt(1_000_000) + BigInt(padded || "0");
  } catch {
    return BigInt(0);
  }
}

export type GatewayBalance = {
  /** Spendable now, in atomic USDC. */
  availableAtomic: bigint;
  /** Deposited but still settling into a batch, when Circle reports it. */
  pendingAtomic: bigint;
};

/**
 * What Circle says this depositor can spend through Gateway on this chain.
 *
 * Returns null when the question could not be asked, which is not the same as
 * a zero balance: reporting "you have nothing deposited" because a request
 * timed out would send the reader to fund an account that is already funded.
 */
export async function readGatewayBalance(
  context: GatewayContext,
  depositor: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GatewayBalance | null> {
  try {
    const response = await fetchImpl(context.balancesUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: "USDC",
        sources: [{ domain: context.domain, depositor }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const payload = await response.json() as {
      balances?: Array<{ domain?: number; balance?: string; pendingBatch?: string }>;
    };
    const row = payload.balances?.find((entry) => entry.domain === context.domain);
    if (!row) return null;
    return {
      availableAtomic: atomicFromDecimal(String(row.balance ?? "0")),
      pendingAtomic: atomicFromDecimal(String(row.pendingBatch ?? "0")),
    };
  } catch {
    return null;
  }
}

/** The wallet's own USDC on that chain, which is what a deposit draws from. */
export async function readWalletUsdc(
  context: GatewayContext,
  owner: `0x${string}`,
): Promise<{ balanceAtomic: bigint; allowanceAtomic: bigint } | null> {
  const chain = chainFor(context.chainId);
  if (!chain) return null;
  try {
    const client = createPublicClient({ chain, transport: http() });
    const [balanceAtomic, allowanceAtomic] = await Promise.all([
      client.readContract({
        address: context.usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner],
      }),
      client.readContract({
        address: context.usdc,
        abi: erc20Abi,
        functionName: "allowance",
        args: [owner, context.gatewayWallet],
      }),
    ]);
    return { balanceAtomic, allowanceAtomic };
  } catch {
    return null;
  }
}

export type GatewayStep = {
  kind: "approve" | "deposit";
  to: `0x${string}`;
  data: `0x${string}`;
  value: "0x0";
  chainId: number;
  title: string;
  detail: string;
};

const GATEWAY_WALLET_ABI = [{
  type: "function",
  name: "deposit",
  stateMutability: "nonpayable",
  inputs: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  outputs: [],
}] as const;

function formatUsdc(atomic: bigint) {
  return (Number(atomic) / 1e6).toFixed(6);
}

/**
 * The two transactions Circle's own buyer quickstart performs, as calldata.
 *
 * The approval is for exactly the deposit and never unlimited. An allowance
 * larger than the deposit is an authorization the buyer did not ask to give,
 * and it is the single most common way a signature turns into a loss later.
 *
 * A sufficient allowance skips the first step rather than re-approving, which
 * costs a transaction and tells the reader nothing new.
 */
export function gatewayDepositSteps(input: {
  context: GatewayContext;
  depositAtomic: bigint;
  allowanceAtomic: bigint;
}): GatewayStep[] {
  const { context, depositAtomic } = input;
  const steps: GatewayStep[] = [];
  if (input.allowanceAtomic < depositAtomic) {
    steps.push({
      kind: "approve",
      to: context.usdc,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [context.gatewayWallet, depositAtomic],
      }),
      value: "0x0",
      chainId: context.chainId,
      title: "Approve the deposit",
      detail: `Allows Circle's Gateway wallet to draw exactly ${formatUsdc(depositAtomic)} USDC — not an unlimited allowance.`,
    });
  }
  steps.push({
    kind: "deposit",
    to: context.gatewayWallet,
    data: encodeFunctionData({
      abi: GATEWAY_WALLET_ABI,
      functionName: "deposit",
      // A plain ERC-20 transfer to this address is NOT credited to the
      // unified balance. Only deposit() is.
      args: [context.usdc, depositAtomic],
    }),
    value: "0x0",
    chainId: context.chainId,
    title: "Deposit into Gateway",
    detail: `Moves ${formatUsdc(depositAtomic)} USDC into your Gateway balance, where batched endpoints can spend it.`,
  });
  return steps;
}
