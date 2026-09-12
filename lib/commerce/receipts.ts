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

import type { SupabaseClient } from "@supabase/supabase-js";
import { createPublicSupabase } from "@/lib/agent/runs-public";
import {
  ARC_TESTNET_EXPLORER_URL,
  onchainProofMetadataFromRow,
  type OnchainProofMetadata,
} from "@/lib/commerce/onchain-proof";
import {
  type ApiService,
  type ServiceMethod,
  type ServiceSourceType,
} from "@/lib/services/registry";
import { listAllStoreServices } from "@/lib/services/store-service-persistence";

type AgentRunRow = {
  id: string;
  created_at: string;
  updated_at: string;
  task: string;
  status: string;
  agent_wallet: string | null;
  budget_usdc: string;
  spent_usdc: string;
};

type AgentPurchaseStepRow = {
  id: string;
  created_at: string;
  run_id: string;
  step_index: number;
  service_id: string | null;
  service_slug: string | null;
  service_name: string | null;
  service_source_type: string | null;
  endpoint: string | null;
  method: string | null;
  price_usdc: string | null;
  status: string;
  reasoning: string | null;
  request_id: string | null;
  payment_event_id: string | null;
  response_preview: unknown;
  error: string | null;
};

type PaymentEventRow = {
  id: string;
  created_at: string;
  endpoint: string;
  payer: string;
  amount_usdc: string;
  network: string;
  gateway_tx: string | null;
  receipt_hash: string | null;
  service_hash: string | null;
  request_hash: string | null;
  response_hash: string | null;
  onchain_contract_address: string | null;
  onchain_chain_id: number | string | null;
  onchain_tx_hash: string | null;
  onchain_status: string | null;
  onchain_block_number: number | string | null;
  onchain_proof_id: string | null;
  onchain_attester: string | null;
  onchain_verified_at: string | null;
  onchain_last_attempt_at: string | null;
  onchain_attempt_count: number | null;
  onchain_error: string | null;
};

export type CommerceReceiptOnchainProof = OnchainProofMetadata & {
  contractExplorerUrl: string | null;
  transactionExplorerUrl: string | null;
};

export type CommerceReceiptPaymentEvent = {
  id: string;
  createdAt: string;
  amountUsdc: string;
  network: string;
  gatewayTx: string | null;
  payer: string;
  onchainProof: CommerceReceiptOnchainProof | null;
};

export type CommerceReceipt = {
  id: string;
  receiptId: string;
  createdAt: string;
  status: "x402 paid";
  amountUsdc: string;
  buyerWallet: string | null;
  runId: string;
  runTask: string | null;
  runStatus: string | null;
  serviceId: string | null;
  serviceSlug: string | null;
  serviceName: string;
  serviceSourceType: ServiceSourceType;
  sourceLabel:
    | "Internal deterministic"
    | "Live Provider"
    | "Seller-created mock"
    | "External Seller API"
    | "Seller-created placeholder";
  method: ServiceMethod | string | null;
  endpoint: string | null;
  requestId: string | null;
  paymentEventId: string | null;
  matchedPaymentEventId: string | null;
  paymentEventStatusLabel:
    | "Payment event matched"
    | "Payment event unavailable";
  paymentEvent: CommerceReceiptPaymentEvent | null;
  onchainProof: CommerceReceiptOnchainProof | null;
  responsePreview: unknown;
  reasoning: string | null;
  links: {
    receipt: string;
    run: string;
    agent: string | null;
    service: string | null;
    paymentEvent: string | null;
  };
};

export type ReceiptListOptions = {
  limit?: number;
  wallet?: string | null;
  serviceSlug?: string | null;
};

const runColumns = [
  "id",
  "created_at",
  "updated_at",
  "task",
  "status",
  "agent_wallet",
  "budget_usdc",
  "spent_usdc",
].join(",");

const stepColumns = [
  "id",
  "created_at",
  "run_id",
  "step_index",
  "service_id",
  "service_slug",
  "service_name",
  "service_source_type",
  "endpoint",
  "method",
  "price_usdc",
  "status",
  "reasoning",
  "request_id",
  "payment_event_id",
  "response_preview",
  "error",
].join(",");

const paymentEventColumns = [
  "id",
  "created_at",
  "endpoint",
  "payer",
  "amount_usdc",
  "network",
  "gateway_tx",
  "receipt_hash",
  "service_hash",
  "request_hash",
  "response_hash",
  "onchain_contract_address",
  "onchain_chain_id",
  "onchain_tx_hash",
  "onchain_status",
  "onchain_block_number",
  "onchain_proof_id",
  "onchain_attester",
  "onchain_verified_at",
  "onchain_last_attempt_at",
  "onchain_attempt_count",
  "onchain_error",
].join(",");

function toNumber(value: string | number | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundUsdc(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function formatUsdc(value: number) {
  const formatted = roundUsdc(value).toFixed(6).replace(/\.?0+$/, "");
  return formatted === "" ? "0" : formatted;
}

function normalizedAmount(value: string | null | undefined) {
  return roundUsdc(toNumber(value));
}

function sourceTypeFromValue(value: string | null | undefined): ServiceSourceType {
  if (
    value === "provider_backed" ||
    value === "seller_mock" ||
    value === "external_placeholder" ||
    value === "external_seller"
  ) return value;
  return "static";
}

export function receiptSourceLabel(sourceType: ServiceSourceType) {
  if (sourceType === "static") return "Internal deterministic";
  if (sourceType === "provider_backed") return "Live Provider";
  if (sourceType === "seller_mock") return "Seller-created mock";
  if (sourceType === "external_seller") return "External Seller API";
  return "Seller-created placeholder";
}

function safeLimit(limit: number | undefined) {
  if (!limit || !Number.isFinite(limit)) return 25;
  return Math.min(Math.max(Math.trunc(limit), 1), 100);
}

function normalizeWallet(wallet: string | null | undefined) {
  return wallet?.trim().toLowerCase() || null;
}

function methodFromValue(value: string | null | undefined) {
  if (value === "GET" || value === "POST") return value;
  return value ?? null;
}

function resolveService(
  step: AgentPurchaseStepRow,
  servicesBySlug: Map<string, ApiService>,
  servicesByEndpoint: Map<string, ApiService>,
) {
  if (step.service_slug && servicesBySlug.has(step.service_slug)) {
    return servicesBySlug.get(step.service_slug) ?? null;
  }

  if (step.endpoint && servicesByEndpoint.has(step.endpoint)) {
    return servicesByEndpoint.get(step.endpoint) ?? null;
  }

  return null;
}

async function fetchRowsByIds<T>(
  client: SupabaseClient,
  table: string,
  columns: string,
  ids: string[],
) {
  if (ids.length === 0) return [] as T[];

  const { data, error } = await client.from(table).select(columns).in("id", ids);

  if (error) throw new Error(error.message);

  return (data ?? []) as unknown as T[];
}

async function fetchRunsForSteps(client: SupabaseClient, steps: AgentPurchaseStepRow[]) {
  const runIds = Array.from(new Set(steps.map((step) => step.run_id)));
  const runs = await fetchRowsByIds<AgentRunRow>(
    client,
    "agent_runs",
    runColumns,
    runIds,
  );

  return new Map(runs.map((run) => [run.id, run]));
}

async function fetchPaymentEventsForSteps(
  client: SupabaseClient,
  steps: AgentPurchaseStepRow[],
) {
  if (steps.length === 0) return [] as PaymentEventRow[];

  const directIds = Array.from(
    new Set(steps.map((step) => step.payment_event_id).filter(Boolean) as string[]),
  );
  const endpoints = Array.from(
    new Set(steps.map((step) => step.endpoint).filter(Boolean) as string[]),
  );
  const stepTimes = steps.map((step) => new Date(step.created_at).getTime());
  const minTime = Math.min(...stepTimes);
  const maxTime = Math.max(...stepTimes);

  const [directEvents, candidateEvents] = await Promise.all([
    fetchRowsByIds<PaymentEventRow>(
      client,
      "payment_events",
      paymentEventColumns,
      directIds,
    ),
    endpoints.length > 0
      ? client
          .from("payment_events")
          .select(paymentEventColumns)
          .in("endpoint", endpoints)
          .gte("created_at", new Date(minTime - 30 * 60 * 1000).toISOString())
          .lte("created_at", new Date(maxTime + 30 * 60 * 1000).toISOString())
          .order("created_at", { ascending: false })
          .limit(1000)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (candidateEvents.error) throw new Error(candidateEvents.error.message);

  const eventMap = new Map<string, PaymentEventRow>();
  for (const event of directEvents) eventMap.set(event.id, event);
  for (const event of (candidateEvents.data ?? []) as unknown as PaymentEventRow[]) {
    eventMap.set(event.id, event);
  }

  return Array.from(eventMap.values());
}

function findPaymentEventForStep(
  step: AgentPurchaseStepRow,
  run: AgentRunRow | undefined,
  paymentEvents: PaymentEventRow[],
  usedEventIds: Set<string>,
) {
  if (step.payment_event_id) {
    const direct = paymentEvents.find((event) => event.id === step.payment_event_id);
    if (direct) {
      usedEventIds.add(direct.id);
      return direct;
    }
  }

  if (!step.endpoint || !run?.agent_wallet || !step.price_usdc) return null;

  const expectedAmount = normalizedAmount(step.price_usdc);
  const stepTime = new Date(step.created_at).getTime();
  const runStart = new Date(run.created_at).getTime() - 5 * 60 * 1000;
  const runEnd = new Date(run.updated_at).getTime() + 10 * 60 * 1000;

  const matchedEvent =
    paymentEvents
      .filter((event) => {
        if (usedEventIds.has(event.id)) return false;

        const eventTime = new Date(event.created_at).getTime();
        const sameEndpoint = event.endpoint === step.endpoint;
        const samePayer =
          event.payer.toLowerCase() === run.agent_wallet?.toLowerCase();
        const sameAmount =
          Math.abs(normalizedAmount(event.amount_usdc) - expectedAmount) < 0.000001;
        const inRunWindow = eventTime >= runStart && eventTime <= runEnd;
        const closeToStep = Math.abs(eventTime - stepTime) <= 10 * 60 * 1000;

        return sameEndpoint && samePayer && sameAmount && (inRunWindow || closeToStep);
      })
      .sort(
        (a, b) =>
          Math.abs(new Date(a.created_at).getTime() - stepTime) -
          Math.abs(new Date(b.created_at).getTime() - stepTime),
      )[0] ?? null;

  if (matchedEvent) usedEventIds.add(matchedEvent.id);

  return matchedEvent;
}

function paymentEventSummary(
  event: PaymentEventRow | null,
): CommerceReceiptPaymentEvent | null {
  if (!event) return null;

  const onchainProof = onchainProofSummary(event);

  return {
    id: event.id,
    createdAt: event.created_at,
    amountUsdc: event.amount_usdc,
    network: event.network,
    gatewayTx: event.gateway_tx,
    payer: event.payer,
    onchainProof,
  };
}

function onchainProofSummary(
  event: PaymentEventRow | null,
): CommerceReceiptOnchainProof | null {
  if (!event) return null;

  const metadata = onchainProofMetadataFromRow(event);
  if (!metadata) return null;

  const explorerBase = (
    process.env.NEXT_PUBLIC_ARC_EXPLORER_URL ?? ARC_TESTNET_EXPLORER_URL
  ).replace(/\/$/, "");

  return {
    ...metadata,
    contractExplorerUrl: metadata.contractAddress
      ? `${explorerBase}/address/${metadata.contractAddress}`
      : null,
    transactionExplorerUrl: metadata.transactionHash
      ? `${explorerBase}/tx/${metadata.transactionHash}`
      : null,
  };
}

function buildReceipt(input: {
  step: AgentPurchaseStepRow;
  run: AgentRunRow | undefined;
  service: ApiService | null;
  paymentEvent: PaymentEventRow | null;
}): CommerceReceipt {
  const { step, run, service, paymentEvent } = input;
  const serviceSlug = service?.slug ?? step.service_slug;
  const serviceSourceType =
    service?.sourceType ?? sourceTypeFromValue(step.service_source_type);
  const wallet = run?.agent_wallet ?? null;
  const directPaymentEventId = step.payment_event_id ?? null;
  const matchedPaymentEventId =
    !directPaymentEventId && paymentEvent ? paymentEvent.id : null;
  const onchainProof = onchainProofSummary(paymentEvent);

  return {
    id: step.id,
    receiptId: step.id,
    createdAt: step.created_at,
    status: "x402 paid",
    amountUsdc: paymentEvent?.amount_usdc ?? formatUsdc(toNumber(step.price_usdc)),
    buyerWallet: wallet,
    runId: step.run_id,
    runTask: run?.task ?? null,
    runStatus: run?.status ?? null,
    serviceId: service?.id ?? step.service_id,
    serviceSlug,
    serviceName: service?.name ?? step.service_name ?? serviceSlug ?? "Unknown service",
    serviceSourceType,
    sourceLabel: receiptSourceLabel(serviceSourceType),
    method: service?.method ?? methodFromValue(step.method),
    endpoint: service?.endpoint ?? step.endpoint,
    requestId: step.request_id,
    paymentEventId: directPaymentEventId,
    matchedPaymentEventId,
    paymentEventStatusLabel: paymentEvent
      ? "Payment event matched"
      : "Payment event unavailable",
    paymentEvent: paymentEventSummary(paymentEvent),
    onchainProof,
    responsePreview: step.response_preview,
    reasoning: step.reasoning,
    links: {
      receipt: `/receipts/${step.id}`,
      run: `/runs/${step.run_id}`,
      agent: wallet ? `/agents/${wallet}` : null,
      service: serviceSlug ? `/store/${serviceSlug}` : null,
      paymentEvent: paymentEvent ? "/dashboard" : null,
    },
  };
}

async function buildReceipts(
  client: SupabaseClient,
  steps: AgentPurchaseStepRow[],
) {
  if (steps.length === 0) return [] as CommerceReceipt[];

  const [{ services }, runsById, paymentEvents] = await Promise.all([
    listAllStoreServices(),
    fetchRunsForSteps(client, steps),
    fetchPaymentEventsForSteps(client, steps),
  ]);
  const servicesBySlug = new Map(services.map((service) => [service.slug, service]));
  const servicesByEndpoint = new Map(services.map((service) => [service.endpoint, service]));
  const usedEventIds = new Set<string>();

  return steps.map((step) => {
    const run = runsById.get(step.run_id);
    const service = resolveService(step, servicesBySlug, servicesByEndpoint);
    const paymentEvent = findPaymentEventForStep(step, run, paymentEvents, usedEventIds);

    return buildReceipt({ step, run, service, paymentEvent });
  });
}

export async function fetchRecentReceipts(options: ReceiptListOptions = {}) {
  const client = createPublicSupabase();
  const limit = safeLimit(options.limit);
  const serviceSlug = options.serviceSlug?.trim() || null;
  const wallet = normalizeWallet(options.wallet);
  const queryLimit = wallet ? Math.min(Math.max(limit * 5, 50), 250) : limit;

  let query = client
    .from("agent_purchase_steps")
    .select(stepColumns)
    .eq("status", "paid")
    .order("created_at", { ascending: false })
    .limit(queryLimit);

  if (serviceSlug) query = query.eq("service_slug", serviceSlug);

  const { data, error } = await query;

  if (error) throw new Error(error.message);

  const steps = (data ?? []) as unknown as AgentPurchaseStepRow[];
  const receipts = await buildReceipts(client, steps);

  return receipts
    .filter((receipt) => {
      if (!wallet) return true;
      return receipt.buyerWallet?.toLowerCase() === wallet;
    })
    .slice(0, limit);
}

export async function fetchReceiptById(id: string) {
  const client = createPublicSupabase();
  const { data, error } = await client
    .from("agent_purchase_steps")
    .select(stepColumns)
    .eq("id", id)
    .eq("status", "paid")
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return null;

  const receipts = await buildReceipts(
    client,
    [data as unknown as AgentPurchaseStepRow],
  );

  return receipts[0] ?? null;
}

export function fetchReceiptsByAgentWallet(wallet: string, limit = 10) {
  return fetchRecentReceipts({ wallet, limit });
}

export function fetchReceiptsByServiceSlug(serviceSlug: string, limit = 25) {
  return fetchRecentReceipts({ serviceSlug, limit });
}
