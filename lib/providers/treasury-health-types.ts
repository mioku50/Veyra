/**
 * Copyright 2026 Circle Internet Group, Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ArcUsdcBlocklistStatus } from "../wallet/arc-usdc.ts";

export interface UsdcTransfer {
  blockNumber: bigint;
  transactionHash: string;
  from: string;
  to: string;
  value: bigint;
  decimals?: 6 | 18;
  logIndex?: number;
  emitter?: string;
  movementType?: "transfer" | "mint" | "burn";
  timestamp?: string;
}

export interface AnomalousTransfer {
  txHash: string;
  amountUsdc: number;
  direction: "inbound" | "outbound";
  reason: string;
  timestamp: string;
}

export interface RecurringPayment {
  counterparty: string;
  avgAmountUsdc: number;
  frequency: string;
  occurrences: number;
}

export interface TreasuryPeriodMetrics {
  windowDays: number;
  inboundUsdc: number;
  outboundUsdc: number;
  netFlowUsdc: number;
  transferCount: number;
  avgDailyBurnUsdc: number;
}

export interface TreasuryAnalytics {
  walletAddress: string;
  totalInboundUsdc: number;
  totalOutboundUsdc: number;
  netFlowUsdc: number;
  transferCount: number;
  uniqueCounterparties: number;
  
  periods: TreasuryPeriodMetrics[];
  
  identifiedAgentPayments: number;
  totalAgentSpendUsdc: number;
  agentRecipients: Array<{ address: string; totalUsdc: number; txCount: number }>;
  
  topRecipients: Array<{
    address: string;
    totalUsdc: number;
    percentage: number;
    txCount: number;
    arcUsdcBlocklistStatus: ArcUsdcBlocklistStatus;
  }>;
  otherRecipientsCount: number;
  otherRecipientsUsdc: number;
  
  herfindahlIndex: number;
  concentrationLevel: "low" | "moderate" | "high" | "critical";
  topCounterpartyShare: number;
  
  recurringPayments: RecurringPayment[];
  
  currentDailyBurnUsdc: number;
  previousDailyBurnUsdc: number;
  burnRateChangePercent: number;
  trendDirection: "increasing" | "stable" | "decreasing";
  
  anomalousTransfers: AnomalousTransfer[];
  
  currentBalanceUsdc: number;
  estimatedRunwayDays: number;
  
  firstTransferAt: string | null;
  lastTransferAt: string | null;
  blocksScanned: number;
  dataTruncated: boolean;
  observationWindowDays: number;
  dataSource: string;
  targetArcUsdcBlocklistStatus: ArcUsdcBlocklistStatus;
  blocklistCheckedAt: string | null;
}
