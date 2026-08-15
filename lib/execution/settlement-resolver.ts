/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { createPublicClient, http, erc20Abi, parseEventLogs, type Address } from "viem";
import { arcTestnet } from "viem/chains";
import type { ExecutionAttempt } from "./types.ts";

export const ARC_USDC_CONTRACT: Address = "0x3600000000000000000000000000000000000000";
export const TRANSACTION_HASH_REGEX = /^0x[0-9a-fA-F]{64}$/;

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
    const expectedPayer = x402Context?.payerWallet?.toLowerCase();
    const expectedPayTo = attempt.counterpartyWallet?.toLowerCase();
    const expectedAsset = (x402Context?.asset || ARC_USDC_CONTRACT).toLowerCase();
    const maxAllowedUsdc = attempt.authorizedAmountUsdc;

    // Check candidate transaction hash
    const candidateTx = hint || attempt.paymentTx || x402Context?.facilitatorReference;
    if (!candidateTx || !TRANSACTION_HASH_REGEX.test(candidateTx)) {
      return { resolved: false, settled: false, failed: false };
    }

    try {
      const publicClient = createPublicClient({
        chain: arcTestnet,
        transport: http(this.rpcUrl),
      });

      const receipt = await publicClient.getTransactionReceipt({
        hash: candidateTx as `0x${string}`,
      });

      if (!receipt) {
        return { resolved: false, settled: false, failed: false };
      }

      if (receipt.status === "reverted") {
        return {
          resolved: true,
          settled: false,
          failed: true,
          failureReason: "ONCHAIN_PAYMENT_TX_REVERTED",
          txHash: receipt.transactionHash,
        };
      }

      if (receipt.status === "success") {
        // Parse Transfer logs on canonical Arc USDC contract
        const transferLogs = parseEventLogs({
          abi: erc20Abi,
          eventName: "Transfer",
          logs: receipt.logs,
        });

        for (const log of transferLogs) {
          const logContract = log.address.toLowerCase();
          const logFrom = log.args.from.toLowerCase();
          const logTo = log.args.to.toLowerCase();
          const amountUsdc = Number(log.args.value) / 1_000_000;

          const assetMatch = logContract === expectedAsset;
          const payerMatch = !expectedPayer || logFrom === expectedPayer;
          const payToMatch = logTo === expectedPayTo;
          const budgetMatch = amountUsdc > 0 && amountUsdc <= maxAllowedUsdc + 0.000001;

          if (assetMatch && payerMatch && payToMatch && budgetMatch) {
            return {
              resolved: true,
              settled: true,
              failed: false,
              txHash: receipt.transactionHash,
              settledAmountUsdc: amountUsdc,
              payer: log.args.from,
              payTo: log.args.to,
            };
          }
        }
      }
    } catch {
      // RPC or network lookup failed — remain unresolved
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
