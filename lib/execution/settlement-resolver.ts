/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createPublicClient,
  http,
  erc20Abi,
  parseEventLogs,
  decodeFunctionData,
  type Address,
  type Hash,
} from "viem";
import { arcTestnet } from "viem/chains";
import type { ExecutionAttempt } from "./types.ts";

export const ARC_USDC_CONTRACT: Address = "0x3600000000000000000000000000000000000000";
export const TRANSACTION_HASH_REGEX = /^0x[0-9a-fA-F]{64}$/;

export const EIP3009_ABI = [
  {
    name: "receiveWithAuthorization",
    type: "function",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    name: "transferWithAuthorization",
    type: "function",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    name: "AuthorizationUsed",
    type: "event",
    inputs: [
      { name: "authorizer", type: "address", indexed: true },
      { name: "nonce", type: "bytes32", indexed: true },
    ],
  },
] as const;

export function normalizeHex32(hex?: string | null): string | null {
  if (!hex || typeof hex !== "string") return null;
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return `0x${clean.padStart(64, "0").toLowerCase()}`;
}

export interface SettlementResolution {
  resolved: boolean;
  settled: boolean;
  failed: boolean;
  failureReason?: string | null;
  txHash?: string | null;
  settledAmountUsdc?: number;
  payer?: `0x${string}`;
  payTo?: `0x${string}`;
}

export interface SettlementResolver {
  resolve(params: {
    attempt: ExecutionAttempt;
    hint?: string;
  }): Promise<SettlementResolution>;
}

export class RealArcSettlementResolver implements SettlementResolver {
  private rpcUrl?: string;

  constructor(options?: { rpcUrl?: string }) {
    this.rpcUrl = options?.rpcUrl || process.env.ARC_TESTNET_RPC_URL || process.env.ARC_RPC_URL;
  }

  async resolve(params: {
    attempt: ExecutionAttempt;
    hint?: string;
  }): Promise<SettlementResolution> {
    const { attempt, hint } = params;
    const x402Context = attempt.x402Context;

    // 1. REQUIRE COMPLETE x402 CONTEXT — fail unresolved if any mandatory context is missing
    if (
      !x402Context ||
      !x402Context.payerWallet ||
      !x402Context.asset ||
      x402Context.authorizedAmountUsdc == null ||
      !x402Context.authorizationNonce ||
      x402Context.authorizationValidBefore == null
    ) {
      return { resolved: false, settled: false, failed: false };
    }

    const expectedPayer = x402Context.payerWallet.toLowerCase();
    const expectedPayTo = (x402Context.payTo || attempt.counterpartyWallet).toLowerCase();
    const expectedAsset = (x402Context.asset || ARC_USDC_CONTRACT).toLowerCase();
    const expectedNonce = normalizeHex32(x402Context.authorizationNonce);
    const expectedValidBefore = Number(x402Context.authorizationValidBefore);

    // 2. EXACT AMOUNT MATCH — derive canonical integer atomic units
    const expectedAmountAtomic = BigInt(
      x402Context.authorizedAmountAtomic ?? Math.round(x402Context.authorizedAmountUsdc * 1_000_000)
    );

    // Check candidate transaction hash
    const candidateTx = hint || attempt.paymentTx || x402Context.facilitatorReference;
    if (!candidateTx || !TRANSACTION_HASH_REGEX.test(candidateTx)) {
      return { resolved: false, settled: false, failed: false };
    }

    try {
      const publicClient = createPublicClient({
        chain: arcTestnet,
        transport: http(this.rpcUrl),
      });

      const [receipt, transaction] = await Promise.all([
        publicClient.getTransactionReceipt({ hash: candidateTx as Hash }).catch(() => null),
        publicClient.getTransaction({ hash: candidateTx as Hash }).catch(() => null),
      ]);

      if (!receipt) {
        return { resolved: false, settled: false, failed: false };
      }

      // 3 & 4. BIND TRANSACTION TO AUTHORIZATION
      let isAuthorizationBound = false;

      // Check method A: Decoded calldata from transaction.input
      if (transaction && transaction.input && transaction.input !== "0x") {
        try {
          const decoded = decodeFunctionData({
            abi: EIP3009_ABI,
            data: transaction.input,
          });

          if (
            decoded &&
            (decoded.functionName === "receiveWithAuthorization" ||
              decoded.functionName === "transferWithAuthorization")
          ) {
            const args: any = decoded.args;
            const fromMatch = args[0]?.toLowerCase() === expectedPayer;
            const toMatch = args[1]?.toLowerCase() === expectedPayTo;
            const valueMatch = BigInt(args[2] ?? 0) === expectedAmountAtomic;
            const validBeforeMatch = Number(args[4] ?? 0) === expectedValidBefore;
            const nonceMatch = normalizeHex32(args[5]) === expectedNonce;
            const assetMatch = transaction.to?.toLowerCase() === expectedAsset;

            if (fromMatch && toMatch && valueMatch && validBeforeMatch && nonceMatch && assetMatch) {
              isAuthorizationBound = true;
            }
          }
        } catch {
          // Calldata was not standard EIP-3009 call
        }
      }

      // Check method B: Decoded logs from receipt (for contract relayers / facilitators)
      if (!isAuthorizationBound && receipt.logs && receipt.logs.length > 0) {
        try {
          const authLogs = parseEventLogs({
            abi: EIP3009_ABI,
            eventName: "AuthorizationUsed",
            logs: receipt.logs,
          });

          for (const authLog of authLogs) {
            const contractMatch = authLog.address.toLowerCase() === expectedAsset;
            const authorizerMatch = authLog.args.authorizer.toLowerCase() === expectedPayer;
            const nonceMatch = normalizeHex32(authLog.args.nonce) === expectedNonce;

            if (contractMatch && authorizerMatch && nonceMatch) {
              isAuthorizationBound = true;
              break;
            }
          }
        } catch {
          // Log parsing error
        }
      }

      // Handle Reverted Transaction
      if (receipt.status === "reverted") {
        // A reverted transaction proves failure ONLY if it was bound to this authorization
        if (isAuthorizationBound) {
          return {
            resolved: true,
            settled: false,
            failed: true,
            failureReason: "ONCHAIN_PAYMENT_TX_REVERTED",
            txHash: receipt.transactionHash,
          };
        }
        // Unrelated reverted transaction -> remain unresolved
        return { resolved: false, settled: false, failed: false };
      }

      // Handle Successful Transaction
      if (receipt.status === "success" && isAuthorizationBound) {
        // Verify canonical Arc USDC Transfer event log
        const transferLogs = parseEventLogs({
          abi: erc20Abi,
          eventName: "Transfer",
          logs: receipt.logs,
        });

        for (const log of transferLogs) {
          const logContract = log.address.toLowerCase();
          const logFrom = log.args.from.toLowerCase();
          const logTo = log.args.to.toLowerCase();
          const logValue = BigInt(log.args.value);

          const assetMatch = logContract === expectedAsset;
          const payerMatch = logFrom === expectedPayer;
          const payToMatch = logTo === expectedPayTo;
          const amountMatch = logValue === expectedAmountAtomic;

          if (assetMatch && payerMatch && payToMatch && amountMatch) {
            return {
              resolved: true,
              settled: true,
              failed: false,
              txHash: receipt.transactionHash,
              settledAmountUsdc: Number(expectedAmountAtomic) / 1_000_000,
              payer: log.args.from,
              payTo: log.args.to,
            };
          }
        }
      }
    } catch {
      // Network or RPC failure -> fail unresolved
      return { resolved: false, settled: false, failed: false };
    }

    return { resolved: false, settled: false, failed: false };
  }
}

/**
 * Mock Settlement Resolver for unit and integration testing without network RPC.
 */
export class MockSettlementResolver implements SettlementResolver {
  private handler: (params: { attempt: ExecutionAttempt; hint?: string }) => Promise<SettlementResolution> | SettlementResolution;

  constructor(
    handler: (params: { attempt: ExecutionAttempt; hint?: string }) => Promise<SettlementResolution> | SettlementResolution
  ) {
    this.handler = handler;
  }

  async resolve(params: { attempt: ExecutionAttempt; hint?: string }): Promise<SettlementResolution> {
    return this.handler(params);
  }
}
