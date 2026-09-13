/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { chromium, type Page, type Request } from "playwright";
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ARC_TESTNET_CHAIN_ID_HEX,
  arcTestnetChain,
} from "../lib/wallet/arc.ts";

type HostedStatus = {
  job: {
    id: string;
    workflowType: string;
    status: "queued" | "running" | "completed" | "failed";
    spentUsdc: string;
    inputPreview: string;
    inputSha256: string;
    paymentMode: "legacy_sponsored" | "sponsored" | "paid";
    error: string | null;
    structuredResult: {
      aggregationMode: string;
      synthesis?: { status: string; provider: string | null; model: string | null };
      marketSymbol: string | null;
      apiResults: Array<{
        serviceSlug: string;
        status: "paid" | "failed";
        amountUsdc: string | null;
        stepId: string | null;
        response: Record<string, unknown> | null;
      }>;
    } | null;
  };
  userPayment: {
    id: string;
    paymentMode: "sponsored" | "paid";
    status: string;
    grossAmountUsdc: string;
    providerCostUsdc: string;
    platformFeeUsdc: string;
    netRevenueUsdc: string;
    creditAmountUsdc: string;
    transactionHash: string | null;
    transactionUrl: string | null;
  } | null;
  receiptIds: string[];
  proofs: Array<{
    receiptId: string;
    status: "pending" | "verified" | "failed";
    transactionHash: string | null;
  }>;
  links: {
    hostedRun: string;
    workflowReceipt: string;
    agentRun: string | null;
    passport: string | null;
    proofTransaction: string | null;
  };
};

type QuoteResponse = {
  quote?: {
    id: string;
    paymentMode: "sponsored" | "paid";
    requesterWallet: string;
    pricing: {
      estimatedProviderCostUsdc: number;
      platformFeeUsdc: number;
      listPriceUsdc: number;
      amountDueUsdc: number;
    };
  };
  error?: string;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function baseUrl() {
  const argument = process.argv.find((value) => value.startsWith("--base-url="));
  return (
    argument?.split("=", 2)[1] ??
    process.env.BASE_URL ??
    "https://veyras.vercel.app"
  ).replace(/\/$/, "");
}

function requestedSymbol() {
  const argument = process.argv.find((value) => value.startsWith("--symbol="));
  const symbol = argument?.slice("--symbol=".length).toUpperCase() ?? "SOL/USD";
  if (!["BTC/USD", "ETH/USD", "SOL/USD"].includes(symbol)) {
    throw new Error("--symbol must be BTC/USD, ETH/USD, or SOL/USD.");
  }
  return symbol as "BTC/USD" | "ETH/USD" | "SOL/USD";
}

function requirePaidConfirmation() {
  if (!process.argv.includes("--confirm-paid-run")) {
    throw new Error("This smoke can spend Arc Testnet USDC. Re-run with --confirm-paid-run.");
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function statusFor(page: Page, jobId: string) {
  return page.evaluate(async (id) => {
    const response = await fetch(`/api/hosted-agent/jobs/${id}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Status request returned ${response.status}`);
    return (await response.json()) as HostedStatus;
  }, jobId);
}

async function waitForCompletion(page: Page, jobId: string, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  let status = await statusFor(page, jobId);
  while (Date.now() < deadline && status.job.status !== "completed") {
    if (status.job.status === "failed") {
      throw new Error(`Hosted workflow failed: ${status.job.error ?? "unknown error"}`);
    }
    await sleep(1_500);
    status = await statusFor(page, jobId);
  }
  assert(status.job.status === "completed", "Hosted workflow did not complete in time.");
  return status;
}

async function waitForProofs(page: Page, jobId: string, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  let status = await statusFor(page, jobId);
  while (
    Date.now() < deadline &&
    (status.proofs.length === 0 || !status.proofs.every((proof) => proof.status === "verified"))
  ) {
    await sleep(1_500);
    status = await statusFor(page, jobId);
  }
  assert(status.proofs.length >= 2, "Hosted workflow did not create a proof per paid service.");
  assert(status.proofs.every((proof) => proof.status === "verified"), "Every receipt was not Verified on Arc in time.");
  return status;
}

async function prepareQuote(
  page: Page,
  inputText: string,
  symbol: "BTC/USD" | "ETH/USD" | "SOL/USD",
) {
  await page.goto(`${baseUrl()}/agent-runner?workflow=market_context&symbol=${encodeURIComponent(symbol)}`, { waitUntil: "networkidle" });
  await page.getByText("Payment wallet", { exact: false }).first().waitFor();
  await page.locator("#hosted-input").fill(inputText);
  const quoteResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/hosted-agent/quotes",
  );
  await page.getByRole("button", { name: "See Final Price" }).click();
  const response = await quoteResponsePromise;
  const json = (await response.json()) as QuoteResponse;
  assert(response.ok() && json.quote, `Workflow quote failed: ${json.error ?? `HTTP ${response.status()}`}`);
  assert(json.quote.requesterWallet.toLowerCase() === accountAddress().toLowerCase(), "Quote is not bound to the injected requester wallet.");
  assert(json.quote.pricing.estimatedProviderCostUsdc === 0.0013, "Internal provider cost is not 0.0013 USDC.");
  assert(json.quote.pricing.platformFeeUsdc === 0.0007, "Platform fee is not 0.0007 USDC.");
  assert(json.quote.pricing.listPriceUsdc === 0.002, "Workflow list price is not 0.002 USDC.");
  return json.quote;
}

let requesterAddress: Address | null = null;
function accountAddress() {
  assert(requesterAddress, "Requester wallet was not initialized.");
  return requesterAddress;
}

async function main() {
  requirePaidConfirmation();
  const privateKey = process.env.PHASE26_CHECKOUT_PRIVATE_KEY?.trim() || process.env.BUYER_PRIVATE_KEY?.trim();
  if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("PHASE26_CHECKOUT_PRIVATE_KEY or BUYER_PRIVATE_KEY is required locally for the paid smoke.");
  }
  const account = privateKeyToAccount(privateKey as Hex);
  requesterAddress = account.address;
  const rpcUrl = process.env.ARC_TESTNET_RPC_URL?.trim() || arcTestnetChain.rpcUrls.default.http[0];
  const publicClient = createPublicClient({ chain: arcTestnetChain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain: arcTestnetChain, transport: http(rpcUrl) });
  const initialBalance = await publicClient.getBalance({ address: account.address });
  assert(initialBalance > 5_000_000_000_000_000n, "Requester wallet has insufficient Arc native USDC for checkout and gas.");

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const sentUserTransactions: Hex[] = [];
  await page.exposeFunction("__arcWalletRequest", async (args: { method: string; params?: unknown[] }) => {
    if (args.method === "eth_accounts" || args.method === "eth_requestAccounts") return [account.address];
    if (args.method === "eth_chainId") return ARC_TESTNET_CHAIN_ID_HEX;
    if (args.method === "wallet_switchEthereumChain" || args.method === "wallet_addEthereumChain" || args.method === "wallet_revokePermissions") return null;
    if (args.method === "personal_sign") {
      const raw = args.params?.[0];
      assert(typeof raw === "string" && /^0x[0-9a-fA-F]*$/.test(raw), "Sponsored authorization was not hex encoded.");
      return account.signMessage({ message: { raw: raw as Hex } });
    }
    if (args.method === "eth_sendTransaction") {
      const transaction = args.params?.[0] as Record<string, unknown> | undefined;
      assert(transaction && typeof transaction === "object", "Wallet payment transaction is missing.");
      assert(String(transaction.from).toLowerCase() === account.address.toLowerCase(), "Wallet payment sender mismatch.");
      assert(transaction.data === "0x", "Workflow checkout unexpectedly supplied calldata.");
      const hash = await walletClient.sendTransaction({
        account,
        chain: arcTestnetChain,
        to: getAddress(String(transaction.to)),
        value: BigInt(String(transaction.value)),
        data: "0x",
      });
      sentUserTransactions.push(hash);
      return hash;
    }
    throw new Error(`Unsupported injected wallet method: ${args.method}`);
  });
  await page.addInitScript(() => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    Object.defineProperty(window, "ethereum", {
      configurable: true,
      value: {
        request: (args: { method: string; params?: unknown[] }) =>
          (window as unknown as { __arcWalletRequest: (request: typeof args) => Promise<unknown> }).__arcWalletRequest(args),
        on: (event: string, listener: (...args: unknown[]) => void) => {
          const handlers = listeners.get(event) ?? new Set();
          handlers.add(listener);
          listeners.set(event, handlers);
        },
        removeListener: (event: string, listener: (...args: unknown[]) => void) => listeners.get(event)?.delete(listener),
      },
    });
  });

  try {
    const url = baseUrl();
    const symbol = requestedSymbol();
    const statusResponse = await fetch(`${url}/api/review/status`);
    const review = (await statusResponse.json()) as { hostedRunner?: { cooldownSeconds?: number } };
    const cooldownSeconds = Math.max(0, review.hostedRunner?.cooldownSeconds ?? 60);

    const firstInput = `Phase 26 sponsored quota bootstrap for ${symbol}: analyze this real Arc builder context using paid text analysis and fresh provider-backed market data without inventing facts.`;
    let quote = await prepareQuote(page, firstInput, symbol);
    if (quote.paymentMode === "sponsored") {
      assert(quote.pricing.amountDueUsdc === 0, "Sponsored quote requested a wallet payment.");
      const confirmationPromise = page.waitForResponse((response) =>
        response.request().method() === "POST" && /\/api\/hosted-agent\/quotes\/[0-9a-f-]+\/confirm$/i.test(new URL(response.url()).pathname),
      );
      await page.getByRole("button", { name: "Run sponsored workflow · 0 USDC" }).click();
      const confirmation = await confirmationPromise;
      const launch = (await confirmation.json()) as { jobId?: string; error?: string };
      assert(confirmation.ok() && launch.jobId, `Sponsored bootstrap failed: ${launch.error ?? confirmation.status()}`);
      const sponsored = await waitForCompletion(page, launch.jobId);
      assert(sponsored.userPayment?.paymentMode === "sponsored" && Number(sponsored.userPayment.grossAmountUsdc) === 0, "Sponsored bootstrap accounting is incorrect.");
      assert(sentUserTransactions.length === 0, "Sponsored bootstrap sent an unexpected USDC transaction.");
      await sleep((cooldownSeconds + 2) * 1_000);
    }

    const paidInput = `Phase 26 user-paid ${symbol} workflow: combine this real builder update with fresh Pyth-backed market context, label evidence, preserve partial results, and never invent unavailable data.`;
    quote = await prepareQuote(page, paidInput, symbol);
    assert(quote.paymentMode === "paid", "Requester did not receive a paid quote after its sponsored quota.");
    assert(quote.pricing.amountDueUsdc === 0.002, "Paid amount due is not the exact 0.002 USDC workflow price.");

    let confirmRequest: Request | null = null;
    const confirmationPromise = page.waitForResponse((response) => {
      const matches = response.request().method() === "POST" && new URL(response.url()).pathname === `/api/hosted-agent/quotes/${quote.id}/confirm`;
      if (matches) confirmRequest = response.request();
      return matches;
    });
    await page.getByRole("button", { name: "Pay 0.0020 USDC & run" }).click();
    const confirmation = await confirmationPromise;
    const launch = (await confirmation.json()) as { jobId?: string; userPaymentId?: string; error?: string };
    assert(confirmation.ok() && launch.jobId && launch.userPaymentId, `Paid workflow launch failed: ${launch.error ?? confirmation.status()}`);
    assert(sentUserTransactions.length === 1, "Paid workflow did not send exactly one user transaction.");
    assert(confirmRequest, "Paid confirmation request was not captured for idempotency replay.");

    let status = await waitForCompletion(page, launch.jobId);
    assert(status.job.paymentMode === "paid", "Hosted job is not labeled as paid checkout.");
    assert(status.job.workflowType === "market_context", "Paid workflow used the wrong template.");
    assert(Number(status.job.spentUsdc) === 0.0013, "Actual downstream provider cost is not 0.0013 USDC.");
    assert(status.receiptIds.length >= 2, "Paid workflow created fewer than two internal receipts.");
    assert(status.userPayment?.id === launch.userPaymentId, "Status returned the wrong user payment.");
    assert(status.userPayment.paymentMode === "paid" && status.userPayment.status === "settled", "User payment is not settled.");
    assert(Number(status.userPayment.grossAmountUsdc) === 0.002, "Gross user payment is not 0.002 USDC.");
    assert(Number(status.userPayment.providerCostUsdc) === 0.0013, "Persisted provider cost is not 0.0013 USDC.");
    assert(Number(status.userPayment.platformFeeUsdc) === 0.0007, "Persisted platform fee is not 0.0007 USDC.");
    assert(Number(status.userPayment.netRevenueUsdc) === 0.0007, "Persisted net revenue is not 0.0007 USDC.");
    assert(Number(status.userPayment.creditAmountUsdc) === 0, "Successful workflow unexpectedly issued credit.");
    assert(status.userPayment.transactionHash === sentUserTransactions[0], "Persisted user transaction differs from the browser transaction.");
    assert(status.userPayment.transactionUrl?.includes(sentUserTransactions[0]), "User payment has no Arcscan transaction link.");
    assert(status.links.workflowReceipt === `/workflow-receipts/${launch.jobId}`, "Aggregate workflow receipt link is missing.");

    const report = status.job.structuredResult;
    assert(report?.marketSymbol === symbol, "Final Report did not preserve the selected market symbol.");
    const provider = report.apiResults.find((result) => result.serviceSlug === "pyth-market-price");
    assert(provider?.status === "paid" && provider.amountUsdc === "0.001", "Pyth-backed internal purchase is missing.");
    assert(provider.response?.provider === "Pyth Network" && provider.response.symbol === symbol, "Final Report Pyth metadata is incorrect.");
    assert(Number(provider.response.price) > 0, "Pyth result does not contain a positive live price.");
    assert(Number.isFinite(Date.parse(String(provider.response.publishTime))), "Pyth publish time is invalid.");

    const replayHeaders = confirmRequest.headers();
    const replayBody = confirmRequest.postData();
    assert(replayHeaders["idempotency-key"] && replayBody, "Paid replay evidence is incomplete.");
    const replay = await page.evaluate(async ({ path, key, body }) => {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body,
      });
      return { status: response.status, json: await response.json() as { jobId?: string; userPaymentId?: string; idempotent?: boolean } };
    }, {
      path: `/api/hosted-agent/quotes/${quote.id}/confirm`,
      key: replayHeaders["idempotency-key"],
      body: replayBody,
    });
    assert(replay.status === 200 && replay.json.idempotent === true, "Paid confirmation replay was not idempotent.");
    assert(replay.json.jobId === launch.jobId && replay.json.userPaymentId === launch.userPaymentId, "Replay returned different checkout artifacts.");
    assert(sentUserTransactions.length === 1, "Idempotency replay triggered a second browser payment.");

    status = await waitForProofs(page, launch.jobId);
    const aggregateResponse = await fetch(`${url}/api/workflow-receipts/${launch.jobId}`);
    const aggregate = await aggregateResponse.json() as { workflowReceipt?: { userPayment?: { transactionHash?: string }; downstreamReceipts?: unknown[]; proofs?: unknown[] } };
    assert(aggregateResponse.ok && aggregate.workflowReceipt, "Aggregate workflow receipt API failed.");
    assert(aggregate.workflowReceipt.userPayment?.transactionHash === sentUserTransactions[0], "Aggregate receipt omitted the user payment.");
    assert((aggregate.workflowReceipt.downstreamReceipts?.length ?? 0) >= 2, "Aggregate receipt omitted downstream commerce receipts.");
    assert((aggregate.workflowReceipt.proofs?.length ?? 0) >= 2, "Aggregate receipt omitted Arc proofs.");

    const finalBalance = await publicClient.getBalance({ address: account.address });
    assert(finalBalance < initialBalance, "Requester wallet balance did not decrease after the paid checkout.");
    console.log(JSON.stringify({
      browserTriggered: true,
      requesterWallet: account.address,
      symbol,
      userPaymentUsdc: status.userPayment?.grossAmountUsdc,
      providerCostUsdc: status.userPayment?.providerCostUsdc,
      platformFeeUsdc: status.userPayment?.platformFeeUsdc,
      netRevenueUsdc: status.userPayment?.netRevenueUsdc,
      userPaymentTransaction: status.userPayment?.transactionHash,
      hostedResult: `${url}${status.links.hostedRun}`,
      workflowReceipt: `${url}${status.links.workflowReceipt}`,
      agentRun: status.links.agentRun ? `${url}${status.links.agentRun}` : null,
      passport: status.links.passport ? `${url}${status.links.passport}` : null,
      receiptIds: status.receiptIds,
      proofTransactions: status.proofs.map((proof) => proof.transactionHash),
      provider: {
        price: provider.response?.price,
        publishTime: provider.response?.publishTime,
      },
      idempotencyReplayPassed: true,
      browserUserTransactionCount: sentUserTransactions.length,
    }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`[hosted-browser-smoke] failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  process.exitCode = 1;
});
