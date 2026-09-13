import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARC_TESTNET_USDC_ADDRESS } from "../lib/wallet/arc.ts";

type Json = Record<string, any>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function requirePrivateKey(name: string, fallbacks: string[] = []) {
  const value = [name, ...fallbacks]
    .map((key) => process.env[key]?.trim())
    .find(Boolean);
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} is required for the operator-only Arc Testnet canary.`);
  }
  return value as Hex;
}

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown canary failure.";
  return message
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/payment-signature[^\s]*/gi, "payment-signature [redacted]")
    .replace(/0x[0-9a-fA-F]{64,}/g, "0x[redacted]")
    .slice(0, 500);
}

function baseUrl() {
  const argument = process.argv.find((value) => value.startsWith("--base-url="));
  return (
    argument?.slice("--base-url=".length) ||
    process.env.BYOA_CANARY_BASE_URL?.trim() ||
    "https://agent-commerce-six.vercel.app"
  ).replace(/\/$/, "");
}

function requireConfirmation(url: string) {
  if (!process.argv.includes("--confirm-arc-testnet-payment")) {
    throw new Error("Re-run with --confirm-arc-testnet-payment to authorize one Arc Testnet x402 workflow payment.");
  }
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "agent-commerce-six.vercel.app") {
    throw new Error("The paid canary is restricted to the canonical production HTTPS deployment.");
  }
}

async function jsonRequest(
  url: string,
  init: RequestInit = {},
  expected?: number | number[],
) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(45_000),
  });
  const body = await response.json().catch(() => ({})) as Json;
  const statuses = expected === undefined ? null : Array.isArray(expected) ? expected : [expected];
  if (statuses ? !statuses.includes(response.status) : !response.ok) {
    const reason = typeof body.reason === "string" ? ` (${body.reason})` : "";
    throw new Error(`Request ${new URL(url).pathname} returned HTTP ${response.status}${reason}.`);
  }
  return { response, body };
}

function cookieFrom(response: Response) {
  const value = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!value) throw new Error("Owner management session cookie was not issued.");
  return value;
}

async function waitForResult(url: string, credential: string, jobId: string) {
  const deadline = Date.now() + 300_000;
  let result: Json | null = null;
  while (Date.now() < deadline) {
    const response = await jsonRequest(`${url}/api/byoa/v1/results/${jobId}`, {
      headers: { Authorization: `Bearer ${credential}` },
    });
    result = response.body;
    const status = result.job?.status;
    if (status === "failed") throw new Error("The BYOA canary workflow failed after settlement.");
    const proofs = Array.isArray(result.proofs) ? result.proofs : [];
    if (status === "completed" && proofs.length >= 2 && proofs.every((proof: Json) => proof.status === "verified")) {
      return result;
    }
    await sleep(2_000);
  }
  throw new Error("The BYOA canary did not complete with verified downstream proofs in time.");
}

async function waitForAggregateProof(url: string, paymentEventId: string) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const { response, body } = await jsonRequest(`${url}/api/proofs/${paymentEventId}`, {}, [200, 404]);
    if (response.ok && body.status === "verified" && body.proof && body.metadata) {
      return { ...(body.metadata as Json), registryRead: body.proof };
    }
    if (response.ok && body.status === "failed") {
      throw new Error("Aggregate workflow payment proof failed.");
    }
    await sleep(2_000);
  }
  throw new Error("Aggregate workflow payment proof was not verified in time.");
}

async function main() {
  const url = baseUrl();
  requireConfirmation(url);

  const ownerAccount = privateKeyToAccount(
    requirePrivateKey("BYOA_CANARY_OWNER_PRIVATE_KEY", [
      "PHASE26_CHECKOUT_PRIVATE_KEY",
      "AGENT_COMMERCE_PROOF_OPERATOR_PRIVATE_KEY",
      "SELLER_PRIVATE_KEY",
    ]),
  );
  const agentKey = requirePrivateKey("BYOA_CANARY_AGENT_PRIVATE_KEY", ["BUYER_PRIVATE_KEY"]);
  const agentAccount = privateKeyToAccount(agentKey);
  const review = await jsonRequest(`${url}/api/review/status`);
  const hostedPayer = getAddress(String(review.body.hostedRunner?.payerAddress));
  assert.notEqual(ownerAccount.address.toLowerCase(), agentAccount.address.toLowerCase(), "Owner and external agent wallets must be distinct.");
  assert.notEqual(agentAccount.address.toLowerCase(), hostedPayer.toLowerCase(), "External agent and downstream payer wallets must be distinct.");

  const originHeaders = { Origin: url, "Content-Type": "application/json" };
  const ownerChallenge = await jsonRequest(`${url}/api/byoa/management/challenges`, {
    method: "POST",
    headers: originHeaders,
    body: JSON.stringify({ wallet: ownerAccount.address }),
  }, 201);
  const ownerSignature = await ownerAccount.signMessage({ message: ownerChallenge.body.challenge.message });
  const sessionResponse = await jsonRequest(`${url}/api/byoa/management/session`, {
    method: "POST",
    headers: originHeaders,
    body: JSON.stringify({
      challengeId: ownerChallenge.body.challenge.id,
      message: ownerChallenge.body.challenge.message,
      signature: ownerSignature,
    }),
  });
  const cookie = cookieFrom(sessionResponse.response);
  const managementHeaders = { ...originHeaders, Cookie: cookie };

  const listed = await jsonRequest(`${url}/api/byoa/management/agents`, { headers: managementHeaders });
  let agent = (listed.body.agents as Json[] | undefined)?.find(
    (candidate) => String(candidate.agentWallet).toLowerCase() === agentAccount.address.toLowerCase(),
  );
  if (!agent) {
    const created = await jsonRequest(`${url}/api/byoa/management/agents`, {
      method: "POST",
      headers: managementHeaders,
      body: JSON.stringify({
        displayName: "Arc Testnet BYOA Canary",
        agentWallet: agentAccount.address,
      }),
    }, 201);
    agent = created.body.agent;
  }
  assert(agent?.id && agent?.publicId, "Canary agent registration did not return an agent.");

  if (agent.walletStatus !== "verified" || agent.status !== "active") {
    const binding = await jsonRequest(`${url}/api/byoa/management/agents/${agent.id}/wallet-challenge`, {
      method: "POST",
      headers: managementHeaders,
      body: "{}",
    }, 201);
    const signature = await agentAccount.signMessage({ message: binding.body.challenge.message });
    const verified = await jsonRequest(`${url}/api/byoa/management/agents/${agent.id}/verify-wallet`, {
      method: "POST",
      headers: managementHeaders,
      body: JSON.stringify({
        challengeId: binding.body.challenge.id,
        message: binding.body.challenge.message,
        signature,
      }),
    });
    agent = verified.body.agent;
  }

  const policy = {
    allowedWorkflows: ["market_context"],
    allowedServiceTypes: ["internal_deterministic", "live_provider"],
    maxPricePerRunUsdc: 0.005,
    dailySpendLimitUsdc: 0.02,
    maxDailyCalls: 10,
    status: "active",
  };
  await jsonRequest(`${url}/api/byoa/management/agents/${agent.id}/policy`, {
    method: "PUT",
    headers: managementHeaders,
    body: JSON.stringify(policy),
  });
  const issued = await jsonRequest(`${url}/api/byoa/management/agents/${agent.id}/credentials`, {
    method: "POST",
    headers: managementHeaders,
    body: JSON.stringify({
      label: "One-time production canary credential",
      scopes: ["manifest:read", "quotes:create", "workflows:execute", "results:read"],
      expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
    }),
  }, 201);
  const credential = String(issued.body.token);
  const credentialId = String(issued.body.credential.id);

  try {
    const idempotencyKey = `byoa-canary-${randomUUID()}`;
    const requestBody = {
      workflowType: "market_context",
      task: "Create an evidence-labeled ETH market context brief for the BYOA canary.",
      inputText: "Assess current ETH market context using live provider data and deterministic text analysis; preserve partial results and never invent unavailable facts.",
      marketSymbol: "ETH/USD",
      budgetUsdc: 0.005,
    };
    const agentHeaders = {
      Authorization: `Bearer ${credential}`,
      "Idempotency-Key": idempotencyKey,
      "Content-Type": "application/json",
    };
    const quoted = await jsonRequest(`${url}/api/byoa/v1/quotes`, {
      method: "POST",
      headers: agentHeaders,
      body: JSON.stringify(requestBody),
    }, 201);
    const quote = quoted.body.quote as Json;
    assert.equal(quote.network, "eip155:5042002");
    assert.equal(getAddress(quote.asset), getAddress(ARC_TESTNET_USDC_ADDRESS));
    assert.equal(getAddress(quote.payTo), getAddress(String(process.env.SELLER_ADDRESS)));
    assert(Number(quote.amountAtomic) >= 1_000 && Number(quote.amountAtomic) <= 5_000);
    assert.equal(new URL(quote.resourceUrl).origin, url);

    const unpaid = await jsonRequest(quote.resourceUrl, {
      method: "POST",
      headers: agentHeaders,
      body: JSON.stringify(requestBody),
    }, 402);
    assert(unpaid.response.headers.has("payment-required"), "Unpaid execute did not return PAYMENT-REQUIRED.");

    const gateway = new GatewayClient({ chain: "arcTestnet", privateKey: agentKey });
    assert.equal(gateway.address.toLowerCase(), agentAccount.address.toLowerCase());
    const balances = await gateway.getBalances();
    assert(balances.gateway.available >= BigInt(quote.amountAtomic), "External agent has insufficient Gateway balance for the quoted workflow.");

    const paid = await gateway.pay<Json>(quote.resourceUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential}`,
        "Idempotency-Key": idempotencyKey,
      },
      body: requestBody,
    });
    assert([200, 202].includes(paid.status), "Paid execute did not create a BYOA job.");
    assert.equal(paid.amount, BigInt(quote.amountAtomic));
    const jobId = String(paid.data.jobId);
    const paymentId = String(paid.data.aggregatePaymentId);
    assert(jobId && paymentId, "Paid execute did not return job and aggregate payment IDs.");

    const completed = await waitForResult(url, credential, jobId);
    assert(completed.finalReport, "BYOA result is missing the Final Report.");
    assert((completed.internalReceiptIds as string[]).length >= 2, "BYOA workflow did not create internal receipts.");
    assert((completed.proofs as Json[]).every((proof) => proof.status === "verified"));
    const quoteReplay = await jsonRequest(`${url}/api/byoa/v1/quotes`, {
      method: "POST",
      headers: agentHeaders,
      body: JSON.stringify(requestBody),
    }, 200);
    assert.equal(quoteReplay.body.quote.id, quote.id, "Quote replay created a new quote.");
    const executeReplay = await jsonRequest(quote.resourceUrl, {
      method: "POST",
      headers: agentHeaders,
      body: JSON.stringify(requestBody),
    }, 200);
    assert.equal(executeReplay.body.jobId, jobId, "Execute replay created a new job.");
    assert.equal(executeReplay.body.idempotent, true, "Execute replay was not labeled idempotent.");
    const replayResult = await jsonRequest(`${url}/api/byoa/v1/results/${jobId}`, {
      headers: { Authorization: `Bearer ${credential}` },
    });
    assert.deepEqual(replayResult.body.internalReceiptIds, completed.internalReceiptIds, "Replay changed receipt IDs.");
    assert.deepEqual(
      (replayResult.body.proofs as Json[]).map((proof) => proof.transactionHash),
      (completed.proofs as Json[]).map((proof) => proof.transactionHash),
      "Replay changed proof transactions.",
    );

    const paymentEventId = String(completed.aggregateWorkflowPayment.payment_event_id);
    const aggregateProof = await waitForAggregateProof(url, paymentEventId);

    const passport = await jsonRequest(`${url}/api/byoa/agents/${agent.publicId}/passport`);
    assert(Number(passport.body.passport.total_workflows) >= 1, "Registered-agent Passport was not updated.");

    console.log(JSON.stringify({
      status: "passed",
      network: "Arc Testnet",
      chainId: 5_042_002,
      ownerWallet: ownerAccount.address,
      agentPublicId: agent.publicId,
      agentWallet: agentAccount.address,
      downstreamPayerWallet: hostedPayer,
      policy,
      quoteId: quote.id,
      workflowPriceUsdc: quote.priceUsdc,
      workflowPaymentTransaction: completed.aggregateWorkflowPayment.gateway_transaction ?? paid.transaction,
      aggregatePaymentEventId: paymentEventId,
      aggregateProof: {
        transactionHash: aggregateProof.transactionHash,
        blockNumber: aggregateProof.blockNumber,
        proofId: aggregateProof.proofId,
        isRegistered: Boolean(aggregateProof.registryRead),
      },
      jobId,
      agentRunId: completed.job.agentRunId,
      resultApi: `${url}/api/byoa/v1/results/${jobId}`,
      passportUrl: `${url}/agents/byoa/${agent.publicId}`,
      receiptUrls: (completed.internalReceiptIds as string[]).map((id) => `${url}/receipts/${id}`),
      proofTransactions: (completed.proofs as Json[]).map((proof) => proof.transactionHash),
      idempotency: {
        sameQuote: true,
        sameJob: true,
        sameReceipts: true,
        sameProofs: true,
      },
    }, null, 2));
  } finally {
    await jsonRequest(`${url}/api/byoa/management/agents/${agent.id}/credentials/${credentialId}`, {
      method: "DELETE",
      headers: managementHeaders,
    }).catch(() => undefined);
    await jsonRequest(`${url}/api/byoa/management/session`, {
      method: "DELETE",
      headers: managementHeaders,
    }).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(`[byoa-canary] ${safeError(error)}`);
  process.exit(1);
});
