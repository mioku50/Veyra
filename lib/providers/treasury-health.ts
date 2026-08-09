/**
 * Copyright 2026 Circle Internet Group, Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PublicClient } from "viem";
import {
  createPublicClient,
  formatUnits,
  getAddress,
  http,
  isAddress,
  parseAbiItem,
} from "viem";
import {
  ARC_TESTNET_USDC_ADDRESS,
  arcTestnetChain,
} from "../wallet/arc.ts";
import {
  ARC_TESTNET_LEGACY_USDC_EMITTER,
  ARC_TESTNET_NATIVE_USDC_EMITTER,
  ARC_ZERO5_ACTIVATION_BLOCK,
  readArcUsdcBlocklistStatuses,
} from "../wallet/arc-usdc.ts";
import type {
  UsdcTransfer,
  TreasuryAnalytics,
  TreasuryPeriodMetrics,
  RecurringPayment,
  AnomalousTransfer,
} from "./treasury-health-types.ts";

export async function fetchUsdcTransfers(
  walletAddress: string,
  fromBlock: bigint,
  toBlock: bigint,
  client: PublicClient
): Promise<{ transfers: UsdcTransfer[]; dataTruncated: boolean }> {
  const transfers: UsdcTransfer[] = [];
  let dataTruncated = false;

  const eventAbi = parseAbiItem(
    "event Transfer(address indexed from, address indexed to, uint256 value)"
  );

  // Arc produces sub-second blocks. Keep historical RPC backfills narrow so a
  // shared node never receives an unbounded eth_getLogs range.
  const CHUNK_SIZE = BigInt(1000);

  for (let currentFrom = fromBlock; currentFrom <= toBlock; currentFrom += CHUNK_SIZE) {
    if (transfers.length >= 50000) {
      dataTruncated = true;
      break;
    }
    const currentTo =
      currentFrom + CHUNK_SIZE - BigInt(1) > toBlock
        ? toBlock
        : currentFrom + CHUNK_SIZE - BigInt(1);

    const logsFrom = await client.getLogs({
      address: ARC_TESTNET_NATIVE_USDC_EMITTER,
      event: eventAbi,
      args: { from: walletAddress as `0x${string}` },
      fromBlock: currentFrom,
      toBlock: currentTo,
    });

    const logsTo = await client.getLogs({
      address: ARC_TESTNET_NATIVE_USDC_EMITTER,
      event: eventAbi,
      args: { to: walletAddress as `0x${string}` },
      fromBlock: currentFrom,
      toBlock: currentTo,
    });

    const combined = [...logsFrom, ...logsTo].sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) {
        return Number(a.blockNumber! - b.blockNumber!);
      }
      return a.transactionIndex! - b.transactionIndex!;
    });

    const unique = [];
    const seen = new Set();
    for (const log of combined) {
      const key = `${log.transactionHash}-${log.logIndex}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(log);
      }
    }

    for (const log of unique) {
      if (transfers.length >= 50000) {
        dataTruncated = true;
        break;
      }
      transfers.push({
        blockNumber: log.blockNumber!,
        transactionHash: log.transactionHash!,
        from: log.args.from!.toLowerCase(),
        to: log.args.to!.toLowerCase(),
        value: log.args.value!,
        decimals: 18,
        logIndex: log.logIndex ?? undefined,
        emitter: ARC_TESTNET_NATIVE_USDC_EMITTER,
        movementType:
          log.args.from === "0x0000000000000000000000000000000000000000"
            ? "mint"
            : log.args.to === "0x0000000000000000000000000000000000000000"
              ? "burn"
              : "transfer",
      });
    }
  }

  return { transfers, dataTruncated };
}

export function analyzeTreasury(
  transfers: UsdcTransfer[],
  walletAddress: string,
  currentBalanceUsdc: number,
  blocksScanned: number,
  dataTruncated: boolean,
  observationEndMs: number = Date.now(),
  observationWindowDays: number = 180,
  dataSource: string = "Arc JSON-RPC",
): TreasuryAnalytics {
  const normWallet = walletAddress.toLowerCase();
  let totalIn = 0;
  let totalOut = 0;
  const counterparties = new Set<string>();

  const recipientTotals = new Map<string, { totalUsdc: number; txCount: number }>();
  const valueUsdc = (transfer: UsdcTransfer) =>
    Number(formatUnits(transfer.value, transfer.decimals ?? 6));

  for (const tx of transfers) {
    const val = valueUsdc(tx);
    if (tx.to === normWallet && tx.from !== normWallet) {
      totalIn += val;
      if ((tx.movementType ?? "transfer") === "transfer") counterparties.add(tx.from);
    } else if (tx.from === normWallet && tx.to !== normWallet) {
      totalOut += val;
      if ((tx.movementType ?? "transfer") === "transfer") {
        counterparties.add(tx.to);
        const rec = recipientTotals.get(tx.to) || { totalUsdc: 0, txCount: 0 };
        rec.totalUsdc += val;
        rec.txCount += 1;
        recipientTotals.set(tx.to, rec);
      }
    }
  }

  let hhi = 0;
  let topShare = 0;
  if (totalOut > 0) {
    let top = 0;
    for (const rec of recipientTotals.values()) {
      const share = rec.totalUsdc / totalOut;
      hhi += (share * 100) ** 2;
      if (share > top) top = share;
    }
    topShare = top;
  }
  let concLevel: "low" | "moderate" | "high" | "critical" = "low";
  if (hhi > 2500) concLevel = "high";
  else if (hhi > 1500) concLevel = "moderate";
  if (topShare > 0.8) concLevel = "critical";

  const maxBlock =
    transfers.length > 0
      ? transfers.reduce((max, t) => (t.blockNumber > max ? t.blockNumber : max), BigInt(0))
      : BigInt(0);

  const getPeriodMetrics = (days: number): TreasuryPeriodMetrics => {
    const blocksInWindow = BigInt(days * 43200); // 1 day = 86400 / 2 = 43200 blocks
    const minBlock = maxBlock > blocksInWindow ? maxBlock - blocksInWindow : BigInt(0);

    let wIn = 0;
    let wOut = 0;
    let wCount = 0;

    const timestampCutoff = observationEndMs - days * 86_400_000;
    const hasTimestampedHistory = transfers.every(
      (transfer) =>
        typeof transfer.timestamp === "string" &&
        Number.isFinite(Date.parse(transfer.timestamp)),
    );

    for (const tx of transfers) {
      const inWindow = hasTimestampedHistory
        ? Date.parse(tx.timestamp!) >= timestampCutoff
        : tx.blockNumber >= minBlock;
      if (inWindow) {
        wCount++;
        const val = valueUsdc(tx);
        if (tx.to === normWallet) wIn += val;
        if (tx.from === normWallet) wOut += val;
      }
    }

    return {
      windowDays: days,
      inboundUsdc: wIn,
      outboundUsdc: wOut,
      netFlowUsdc: wIn - wOut,
      transferCount: wCount,
      avgDailyBurnUsdc: days > 0 ? wOut / days : 0,
    };
  };

  const p7 = getPeriodMetrics(7);
  const p30 = getPeriodMetrics(30);
  const p90 = getPeriodMetrics(90);

  const burnRateChange =
    p30.avgDailyBurnUsdc === 0
      ? 0
      : ((p7.avgDailyBurnUsdc - p30.avgDailyBurnUsdc) / p30.avgDailyBurnUsdc) * 100;
  let trendDirection: "increasing" | "stable" | "decreasing" = "stable";
  if (burnRateChange > 10) trendDirection = "increasing";
  else if (burnRateChange < -10) trendDirection = "decreasing";

  const runway = p30.avgDailyBurnUsdc > 0 ? currentBalanceUsdc / p30.avgDailyBurnUsdc : 9999;

  const recurring: RecurringPayment[] = [];
  for (const [rec, data] of recipientTotals.entries()) {
    if (data.txCount >= 3) {
      recurring.push({
        counterparty: rec,
        avgAmountUsdc: data.totalUsdc / data.txCount,
        frequency: "regular",
        occurrences: data.txCount,
      });
    }
  }

  const anomalies: AnomalousTransfer[] = [];
  const avgOut = recipientTotals.size > 0 ? totalOut / recipientTotals.size : 0;
  for (const tx of transfers) {
    const val = valueUsdc(tx);
    if (tx.from === normWallet && val > avgOut * 5 && val > 1000) {
      anomalies.push({
        txHash: tx.transactionHash,
        amountUsdc: val,
        direction: "outbound",
        reason: "Unusually large outbound transfer",
        timestamp: tx.timestamp ?? "",
      });
    }
  }

  const sortedRecipients = Array.from(recipientTotals.entries())
    .map(([addr, data]) => ({
      address: addr,
      totalUsdc: data.totalUsdc,
      percentage: totalOut > 0 ? (data.totalUsdc / totalOut) * 100 : 0,
      txCount: data.txCount,
      arcUsdcBlocklistStatus: "unknown" as const,
    }))
    .sort((a, b) => b.totalUsdc - a.totalUsdc);

  const topRecipients = sortedRecipients.slice(0, 5);
  const otherRecipients = sortedRecipients.slice(5);

  const timestamps = transfers
    .map((transfer) => transfer.timestamp)
    .filter((value): value is string =>
      typeof value === "string" && Number.isFinite(Date.parse(value)),
    )
    .sort((left, right) => Date.parse(left) - Date.parse(right));

  return {
    walletAddress: normWallet,
    totalInboundUsdc: totalIn,
    totalOutboundUsdc: totalOut,
    netFlowUsdc: totalIn - totalOut,
    transferCount: transfers.length,
    uniqueCounterparties: counterparties.size,
    periods: [p7, p30, p90],
    identifiedAgentPayments: 0,
    totalAgentSpendUsdc: 0,
    agentRecipients: [],
    topRecipients,
    otherRecipientsCount: otherRecipients.length,
    otherRecipientsUsdc: otherRecipients.reduce((sum, r) => sum + r.totalUsdc, 0),
    herfindahlIndex: hhi,
    concentrationLevel: concLevel,
    topCounterpartyShare: topShare,
    recurringPayments: recurring,
    currentDailyBurnUsdc: p7.avgDailyBurnUsdc,
    previousDailyBurnUsdc: p30.avgDailyBurnUsdc,
    burnRateChangePercent: burnRateChange,
    trendDirection,
    anomalousTransfers: anomalies,
    currentBalanceUsdc,
    estimatedRunwayDays: runway,
    firstTransferAt: timestamps[0] ?? null,
    lastTransferAt: timestamps.at(-1) ?? null,
    blocksScanned,
    dataTruncated,
    observationWindowDays,
    dataSource,
    targetArcUsdcBlocklistStatus: "unknown",
    blocklistCheckedAt: null,
  };
}

export function calculateTreasuryHealthScore(analytics: TreasuryAnalytics) {
  if (analytics.transferCount === 0) {
    return {
      overallScore: null,
      confidence: "low" as const,
      breakdown: {
        liquidityScore: null,
        burnRateStabilityScore: null,
        counterpartyDiversificationScore: null,
        inflowOutflowBalanceScore: null,
        anomalyAbsenceScore: null,
        recurringPaymentRegularityScore: null,
      },
    };
  }

  let liquidityScore = Math.min(100, Math.max(0, (analytics.estimatedRunwayDays / 180) * 100));
  if (analytics.estimatedRunwayDays > 180) liquidityScore = 100;

  let burnRateStabilityScore = 100 - Math.min(100, Math.abs(analytics.burnRateChangePercent));

  let counterpartyDiversificationScore = 100;
  if (analytics.concentrationLevel === "critical") counterpartyDiversificationScore = 20;
  else if (analytics.concentrationLevel === "high") counterpartyDiversificationScore = 50;
  else if (analytics.concentrationLevel === "moderate") counterpartyDiversificationScore = 80;

  let inflowOutflowBalanceScore = 50;
  if (analytics.netFlowUsdc > 0) inflowOutflowBalanceScore = 100;
  else if (analytics.netFlowUsdc > -1000) inflowOutflowBalanceScore = 75;
  else inflowOutflowBalanceScore = 30;

  let anomalyAbsenceScore = 100 - analytics.anomalousTransfers.length * 20;
  if (anomalyAbsenceScore < 0) anomalyAbsenceScore = 0;

  let recurringPaymentRegularityScore = Math.min(
    100,
    analytics.recurringPayments.length * 20 + 50
  );

  const overall =
    liquidityScore * 0.2 +
    burnRateStabilityScore * 0.2 +
    counterpartyDiversificationScore * 0.15 +
    inflowOutflowBalanceScore * 0.15 +
    anomalyAbsenceScore * 0.15 +
    recurringPaymentRegularityScore * 0.15;

  const conf =
    analytics.transferCount >= 100
      ? "high"
      : analytics.transferCount >= 10
      ? "medium"
      : "low";

  return {
    overallScore: Math.round(overall),
    confidence: conf as "high" | "medium" | "low",
    breakdown: {
      liquidityScore: Math.round(liquidityScore),
      burnRateStabilityScore: Math.round(burnRateStabilityScore),
      counterpartyDiversificationScore: Math.round(counterpartyDiversificationScore),
      inflowOutflowBalanceScore: Math.round(inflowOutflowBalanceScore),
      anomalyAbsenceScore: Math.round(anomalyAbsenceScore),
      recurringPaymentRegularityScore: Math.round(recurringPaymentRegularityScore),
    },
  };
}

const TREASURY_HISTORY_PROVIDER = "arcscan_blockscout";
const TREASURY_BALANCE_PROVIDER = "arc_json_rpc";
const ARC_BLOCKSCOUT_API_ORIGIN = "https://testnet.arcscan.app";
const TREASURY_PUBLIC_REASON =
  "Treasury data could not be collected from the configured provider.";

export type TreasuryProviderName =
  | typeof TREASURY_HISTORY_PROVIDER
  | typeof TREASURY_BALANCE_PROVIDER
  | "treasury_input";

export class TreasuryProviderError extends Error {
  constructor(
    readonly internalErrorCode:
      | "invalid_wallet"
      | "unsupported_network"
      | "missing_input"
      | "policy_denial"
      | "treasury_provider_unavailable"
      | "treasury_provider_malformed_response",
    readonly provider: TreasuryProviderName,
    readonly retryable: boolean,
    readonly httpStatus: number | null,
    message: string,
  ) {
    super(message);
    this.name = "TreasuryProviderError";
  }
}

export type TreasuryAttemptTelemetry = {
  attempt: number;
  provider: TreasuryProviderName;
  errorCode: string | null;
  retryable: boolean;
  durationMs: number;
};

export class TreasuryHealthExecutionError extends Error {
  constructor(
    readonly failure: TreasuryProviderError,
    readonly attempts: TreasuryAttemptTelemetry[],
    readonly durationMs: number,
  ) {
    super(TREASURY_PUBLIC_REASON);
    this.name = "TreasuryHealthExecutionError";
  }
}

type BlockscoutLog = {
  address?: string;
  blockNumber?: string;
  transactionHash?: string;
  timeStamp?: string;
  logIndex?: string;
  topics?: Array<string | null>;
  data?: string;
};

type BlockscoutLogPage = {
  status?: string;
  message?: string;
  result?: BlockscoutLog[] | string;
};

type ArcMovementLogKind =
  | "system_transfer"
  | "legacy_transfer"
  | "legacy_mint"
  | "legacy_burn";

const ARC_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ARC_LEGACY_TRANSFER_TOPIC =
  "0x62f084c00a442dcf51cdbb51beed2839bf42a268da8474b0e98f38edb7db5a22";
const ARC_LEGACY_MINT_TOPIC =
  "0xb049859d09b3a7d0189a07db4d4becee1a2aa269023205478b1360ab6fc12114";
const ARC_LEGACY_BURN_TOPIC =
  "0xaaf1ef013644e67c5cea90217acdf0accd334f8437fc9a89a53cfc9b25fb5c25";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function nestedHttpStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  const direct = Number(record.status ?? record.statusCode);
  if (Number.isInteger(direct) && direct >= 100 && direct <= 599) return direct;
  return nestedHttpStatus(record.cause);
}

function errorTokens(error: unknown, values: string[] = []): string[] {
  if (!error || values.length > 20) return values;
  if (error instanceof Error) {
    values.push(error.name, error.message);
    errorTokens((error as Error & { cause?: unknown }).cause, values);
  } else if (typeof error === "object") {
    const record = error as Record<string, unknown>;
    for (const key of ["name", "code", "message", "details"]) {
      if (record[key] !== undefined) values.push(String(record[key]));
    }
    errorTokens(record.cause, values);
  }
  return values;
}

export function normalizeTreasuryProviderError(
  error: unknown,
  provider: TreasuryProviderName,
) {
  if (error instanceof TreasuryProviderError) return error;
  if (error instanceof TreasuryHealthExecutionError) return error.failure;
  const status = nestedHttpStatus(error);
  const tokens = errorTokens(error).join(" ").toLowerCase();
  const retryable =
    status === 408 ||
    status === 425 ||
    status === 429 ||
    (status !== null && status >= 500) ||
    [
      "aborted",
      "econnreset",
      "etimedout",
      "fetch failed",
      "headers timeout",
      "rate limit",
      "socket hang up",
      "temporarily unavailable",
      "timed out",
      "timeout",
    ].some((token) => tokens.includes(token));
  return new TreasuryProviderError(
    retryable
      ? "treasury_provider_unavailable"
      : "treasury_provider_malformed_response",
    provider,
    retryable,
    status,
    TREASURY_PUBLIC_REASON,
  );
}

function parseHexQuantity(value: unknown) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error("invalid hex quantity");
  }
  return BigInt(value);
}

function addressFromTopic(value: unknown) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("invalid address topic");
  }
  return getAddress(`0x${value.slice(-40)}`).toLowerCase();
}

export function parseBlockscoutArcMovementLog(
  value: BlockscoutLog,
  kind: ArcMovementLogKind,
): UsdcTransfer {
  try {
    const emitter = kind === "system_transfer"
      ? ARC_TESTNET_NATIVE_USDC_EMITTER
      : ARC_TESTNET_LEGACY_USDC_EMITTER;
    if (value.address?.toLowerCase() !== emitter.toLowerCase()) {
      throw new Error("unexpected emitter");
    }
    const transactionHash = value.transactionHash;
    if (!transactionHash || !/^0x[0-9a-fA-F]{64}$/.test(transactionHash)) {
      throw new Error("invalid transaction hash");
    }
    const topics = value.topics ?? [];
    const expectedTopic = kind === "system_transfer"
      ? ARC_TRANSFER_TOPIC
      : kind === "legacy_transfer"
        ? ARC_LEGACY_TRANSFER_TOPIC
        : kind === "legacy_mint"
          ? ARC_LEGACY_MINT_TOPIC
          : ARC_LEGACY_BURN_TOPIC;
    if (topics[0]?.toLowerCase() !== expectedTopic) throw new Error("unexpected topic");
    const blockNumber = parseHexQuantity(value.blockNumber);
    const timestampSeconds = parseHexQuantity(value.timeStamp);
    const logIndex = Number(parseHexQuantity(value.logIndex));
    const rawValue = parseHexQuantity(value.data);
    if (!Number.isSafeInteger(logIndex)) throw new Error("invalid log index");
    const from = kind === "legacy_mint" ? ZERO_ADDRESS : addressFromTopic(topics[1]);
    const to = kind === "legacy_burn"
      ? ZERO_ADDRESS
      : kind === "legacy_mint"
        ? addressFromTopic(topics[1])
        : addressFromTopic(topics[2]);
    return {
      blockNumber,
      transactionHash,
      from,
      to,
      value: rawValue,
      decimals: 18,
      logIndex,
      emitter,
      movementType: kind === "legacy_mint" || from === ZERO_ADDRESS
        ? "mint"
        : kind === "legacy_burn" || to === ZERO_ADDRESS
          ? "burn"
          : "transfer",
      timestamp: new Date(Number(timestampSeconds) * 1_000).toISOString(),
    };
  } catch {
    throw new TreasuryProviderError(
      "treasury_provider_malformed_response",
      TREASURY_HISTORY_PROVIDER,
      false,
      null,
      "The treasury history provider returned an invalid Arc movement log.",
    );
  }
}

export async function fetchBlockscoutUsdcTransfers(input: {
  walletAddress: string;
  scanDays: number;
  latestBlock: bigint;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  nowMs: number;
  maxTransfers?: number;
}) {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const cutoffMs = input.nowMs - input.scanDays * 86_400_000;
  const maxTransfers = input.maxTransfers ?? 50_000;
  const transfers: UsdcTransfer[] = [];
  let dataTruncated = false;
  let queryCount = 0;
  // 200k blocks/day is a conservative envelope around Arc's documented
  // ~0.48-second block time. Timestamp filtering enforces the exact window.
  const totalWindowBlocks = BigInt(input.scanDays * 200_000);
  const startBlock = input.latestBlock > totalWindowBlocks
    ? input.latestBlock - totalWindowBlocks
    : BigInt(0);
  const walletTopic = `0x${getAddress(input.walletAddress).slice(2).toLowerCase().padStart(64, "0")}`;
  const specs: Array<{
    kind: ArcMovementLogKind;
    emitter: string;
    topic0: string;
    walletTopicPosition: 1 | 2;
    fromBlock: bigint;
    toBlock: bigint;
  }> = [];
  const systemFromBlock = startBlock > ARC_ZERO5_ACTIVATION_BLOCK
    ? startBlock
    : ARC_ZERO5_ACTIVATION_BLOCK;
  if (systemFromBlock <= input.latestBlock) {
    specs.push(
      { kind: "system_transfer", emitter: ARC_TESTNET_NATIVE_USDC_EMITTER, topic0: ARC_TRANSFER_TOPIC, walletTopicPosition: 1, fromBlock: systemFromBlock, toBlock: input.latestBlock },
      { kind: "system_transfer", emitter: ARC_TESTNET_NATIVE_USDC_EMITTER, topic0: ARC_TRANSFER_TOPIC, walletTopicPosition: 2, fromBlock: systemFromBlock, toBlock: input.latestBlock },
    );
  }
  const legacyToBlock = input.latestBlock < ARC_ZERO5_ACTIVATION_BLOCK
    ? input.latestBlock
    : ARC_ZERO5_ACTIVATION_BLOCK - BigInt(1);
  if (startBlock <= legacyToBlock) {
    specs.push(
      { kind: "legacy_transfer", emitter: ARC_TESTNET_LEGACY_USDC_EMITTER, topic0: ARC_LEGACY_TRANSFER_TOPIC, walletTopicPosition: 1, fromBlock: startBlock, toBlock: legacyToBlock },
      { kind: "legacy_transfer", emitter: ARC_TESTNET_LEGACY_USDC_EMITTER, topic0: ARC_LEGACY_TRANSFER_TOPIC, walletTopicPosition: 2, fromBlock: startBlock, toBlock: legacyToBlock },
      { kind: "legacy_mint", emitter: ARC_TESTNET_LEGACY_USDC_EMITTER, topic0: ARC_LEGACY_MINT_TOPIC, walletTopicPosition: 1, fromBlock: startBlock, toBlock: legacyToBlock },
      { kind: "legacy_burn", emitter: ARC_TESTNET_LEGACY_USDC_EMITTER, topic0: ARC_LEGACY_BURN_TOPIC, walletTopicPosition: 1, fromBlock: startBlock, toBlock: legacyToBlock },
    );
  }

  const initialRangeSize = BigInt(30 * 200_000);
  for (const spec of specs) {
    if (dataTruncated || transfers.length >= maxTransfers) break;
    const ranges: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
    for (let toBlock = spec.toBlock; toBlock >= spec.fromBlock;) {
      const fromBlock = toBlock - spec.fromBlock + BigInt(1) > initialRangeSize
        ? toBlock - initialRangeSize + BigInt(1)
        : spec.fromBlock;
      ranges.push({ fromBlock, toBlock });
      if (fromBlock === spec.fromBlock) break;
      toBlock = fromBlock - BigInt(1);
    }
    let reachedCutoff = false;
    while (ranges.length > 0 && !dataTruncated && !reachedCutoff) {
      input.signal?.throwIfAborted();
      const range = ranges.shift()!;
      const url = new URL("/api", ARC_BLOCKSCOUT_API_ORIGIN);
      url.searchParams.set("module", "logs");
      url.searchParams.set("action", "getLogs");
      url.searchParams.set("address", spec.emitter);
      url.searchParams.set("fromBlock", range.fromBlock.toString());
      url.searchParams.set("toBlock", range.toBlock.toString());
      url.searchParams.set("topic0", spec.topic0);
      url.searchParams.set(`topic${spec.walletTopicPosition}`, walletTopic);
      url.searchParams.set(`topic0_${spec.walletTopicPosition}_opr`, "and");
      let response: Response;
      try {
        response = await fetchImpl(url, {
          headers: { Accept: "application/json" },
          signal: input.signal,
        });
      } catch (error) {
        throw normalizeTreasuryProviderError(error, TREASURY_HISTORY_PROVIDER);
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        const retryable = [408, 425, 429].includes(response.status) || response.status >= 500;
        throw new TreasuryProviderError(
          retryable
            ? "treasury_provider_unavailable"
            : response.status === 403
              ? "policy_denial"
              : "treasury_provider_malformed_response",
          TREASURY_HISTORY_PROVIDER,
          retryable,
          response.status,
          TREASURY_PUBLIC_REASON,
        );
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new TreasuryProviderError(
          "treasury_provider_malformed_response",
          TREASURY_HISTORY_PROVIDER,
          false,
          response.status,
          "The treasury history provider returned malformed JSON.",
        );
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload) || !("result" in payload)) {
        throw new TreasuryProviderError(
          "treasury_provider_malformed_response",
          TREASURY_HISTORY_PROVIDER,
          false,
          response.status,
          "The treasury history provider returned an invalid response shape.",
        );
      }
      const typed = payload as BlockscoutLogPage;
      const noLogs = typed.status === "0" && /no (logs|records) found/i.test(
        String(typed.message ?? typed.result ?? ""),
      );
      if (!Array.isArray(typed.result) && !noLogs) {
        const providerMessage = String(typed.message ?? typed.result ?? "");
        const retryable = /rate limit|timeout|temporar|unavailable/i.test(providerMessage);
        throw new TreasuryProviderError(
          retryable ? "treasury_provider_unavailable" : "treasury_provider_malformed_response",
          TREASURY_HISTORY_PROVIDER,
          retryable,
          response.status,
          TREASURY_PUBLIC_REASON,
        );
      }
      const items = Array.isArray(typed.result) ? typed.result : [];
      queryCount += 1;
      if (queryCount > 200) {
        dataTruncated = true;
        break;
      }
      if (items.length >= 1_000 && range.toBlock > range.fromBlock) {
        const midpoint = (range.fromBlock + range.toBlock) / BigInt(2);
        ranges.unshift({ fromBlock: range.fromBlock, toBlock: midpoint });
        ranges.unshift({ fromBlock: midpoint + BigInt(1), toBlock: range.toBlock });
        continue;
      }
      for (const item of items) {
        const transfer = parseBlockscoutArcMovementLog(item, spec.kind);
        if (Date.parse(transfer.timestamp!) < cutoffMs) {
          reachedCutoff = true;
          continue;
        }
        transfers.push(transfer);
        if (transfers.length >= maxTransfers) {
          dataTruncated = true;
          break;
        }
      }
      if (items.length >= 1_000 && range.toBlock === range.fromBlock) dataTruncated = true;
    }
  }

  const unique = new Map<string, UsdcTransfer>();
  for (const transfer of transfers) {
    unique.set(
      `${transfer.emitter}-${transfer.transactionHash}-${transfer.logIndex}`,
      transfer,
    );
  }
  transfers.splice(0, transfers.length, ...unique.values());

  transfers.sort((left, right) =>
    left.blockNumber === right.blockNumber
      ? (left.logIndex ?? 0) - (right.logIndex ?? 0)
      : left.blockNumber < right.blockNumber ? -1 : 1,
  );
  return {
    transfers,
    dataTruncated,
    blocksScanned: Number(input.latestBlock - startBlock + BigInt(1)),
  };
}

export type AnalyzeTreasuryHealthOptions = {
  rpcUrl?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  now?: Date;
  maxTransfers?: number;
};

export async function analyzeTreasuryHealth(
  walletAddress: string,
  scanDays: number = 180,
  options: AnalyzeTreasuryHealthOptions = {},
): Promise<TreasuryAnalytics> {
  if (!walletAddress?.trim()) {
    throw new TreasuryProviderError(
      "missing_input",
      "treasury_input",
      false,
      400,
      "A treasury wallet is required.",
    );
  }
  if (!isAddress(walletAddress)) {
    throw new TreasuryProviderError(
      "invalid_wallet",
      "treasury_input",
      false,
      400,
      "The treasury wallet is invalid.",
    );
  }
  if (!Number.isInteger(scanDays) || scanDays < 1 || scanDays > 365) {
    throw new TreasuryProviderError(
      "policy_denial",
      "treasury_input",
      false,
      400,
      "The treasury observation window is not allowed.",
    );
  }
  const nowMs = (options.now ?? new Date()).getTime();
  const rpcUrl =
    options.rpcUrl?.trim() ||
    process.env.ARC_TESTNET_RPC_URL?.trim() ||
    arcTestnetChain.rpcUrls.default.http[0];
  const client = createPublicClient({
    chain: arcTestnetChain,
    transport: http(rpcUrl, { retryCount: 0, timeout: 12_000 }),
  });
  let latestBlock: bigint;
  let balanceWei: bigint;
  try {
    [latestBlock, balanceWei] = await Promise.all([
      client.getBlockNumber(),
      client.readContract({
        address: ARC_TESTNET_USDC_ADDRESS as `0x${string}`,
        abi: [parseAbiItem("function balanceOf(address account) view returns (uint256)")],
        functionName: "balanceOf",
        args: [getAddress(walletAddress)],
      }) as Promise<bigint>,
    ]);
  } catch (error) {
    throw normalizeTreasuryProviderError(error, TREASURY_BALANCE_PROVIDER);
  }
  options.signal?.throwIfAborted();
  const { transfers, dataTruncated, blocksScanned } =
    await fetchBlockscoutUsdcTransfers({
      walletAddress,
      scanDays,
      latestBlock,
      signal: options.signal,
      fetchImpl: options.fetchImpl,
      nowMs,
      maxTransfers: options.maxTransfers,
    });
  const analytics = analyzeTreasury(
    transfers,
    getAddress(walletAddress),
    Number(formatUnits(balanceWei, 6)),
    blocksScanned,
    dataTruncated,
    nowMs,
    scanDays,
    "Arc EIP-7708 system events + pre-Zero5 native events via Arcscan Blockscout; Arc JSON-RPC",
  );
  const checkedAt = new Date(nowMs).toISOString();
  const blocklistStatuses = await readArcUsdcBlocklistStatuses(
    [analytics.walletAddress, ...analytics.topRecipients.map((item) => item.address)],
    client,
  );
  return {
    ...analytics,
    targetArcUsdcBlocklistStatus:
      blocklistStatuses.get(analytics.walletAddress.toLowerCase()) ?? "unknown",
    blocklistCheckedAt: checkedAt,
    topRecipients: analytics.topRecipients.map((item) => ({
      ...item,
      arcUsdcBlocklistStatus:
        blocklistStatuses.get(item.address.toLowerCase()) ?? "unknown",
    })),
  };
}

export async function executeTreasuryHealthWithRetry(input: {
  walletAddress: string;
  scanDays?: number;
  maxAttempts?: number;
  initialDelayMs?: number;
  deadlineMs?: number;
  operation?: (signal: AbortSignal, attempt: number) => Promise<TreasuryAnalytics>;
  sleepImpl?: (durationMs: number) => Promise<void>;
  onAttempt?: (telemetry: TreasuryAttemptTelemetry) => void | Promise<void>;
}) {
  const startedAt = Date.now();
  const maxAttempts = input.maxAttempts ?? 3;
  const initialDelayMs = input.initialDelayMs ?? 500;
  const deadlineMs = input.deadlineMs ?? 120_000;
  const attempts: TreasuryAttemptTelemetry[] = [];
  const sleepImpl = input.sleepImpl ?? ((durationMs: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, durationMs)));
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
    throw new Error("Treasury retry attempts must be between one and three.");
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const elapsed = Date.now() - startedAt;
    const remaining = deadlineMs - elapsed;
    if (remaining <= 0) {
      const failure = new TreasuryProviderError(
        "treasury_provider_unavailable",
        TREASURY_HISTORY_PROVIDER,
        true,
        null,
        TREASURY_PUBLIC_REASON,
      );
      throw new TreasuryHealthExecutionError(failure, attempts, elapsed);
    }
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("Treasury provider attempt timed out.")),
      Math.min(40_000, remaining),
    );
    const attemptStartedAt = Date.now();
    try {
      const analytics = await (input.operation
        ? input.operation(controller.signal, attempt)
        : analyzeTreasuryHealth(input.walletAddress, input.scanDays ?? 180, {
            signal: controller.signal,
          }));
      const telemetry: TreasuryAttemptTelemetry = {
        attempt,
        provider: TREASURY_HISTORY_PROVIDER,
        errorCode: null,
        retryable: false,
        durationMs: Date.now() - attemptStartedAt,
      };
      attempts.push(telemetry);
      await input.onAttempt?.(telemetry);
      return { analytics, attempts, durationMs: Date.now() - startedAt };
    } catch (error) {
      const failure = normalizeTreasuryProviderError(error, TREASURY_HISTORY_PROVIDER);
      const telemetry: TreasuryAttemptTelemetry = {
        attempt,
        provider: failure.provider,
        errorCode: failure.internalErrorCode,
        retryable: failure.retryable,
        durationMs: Date.now() - attemptStartedAt,
      };
      attempts.push(telemetry);
      await input.onAttempt?.(telemetry);
      const delayMs = initialDelayMs * 2 ** (attempt - 1);
      const canRetry =
        failure.retryable &&
        attempt < maxAttempts &&
        Date.now() - startedAt + delayMs < deadlineMs;
      if (!canRetry) {
        throw new TreasuryHealthExecutionError(
          failure,
          attempts,
          Date.now() - startedAt,
        );
      }
      await sleepImpl(delayMs);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error("Treasury retry loop ended unexpectedly.");
}
