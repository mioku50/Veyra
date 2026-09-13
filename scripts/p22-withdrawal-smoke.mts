/**
 * P2.2 production smoke for the non-custodial seller Gateway withdrawal.
 *
 * The seller key is read only by the local process. It is used to create the
 * owner session, sign the Gateway burn intent, and send the Arc mint call; it
 * is never sent to Veyra or printed.
 */
import { randomUUID } from "node:crypto";
import { createPublicClient, createWalletClient, getAddress, http, isAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARC_TESTNET_RPC_URL, arcTestnetChain } from "../lib/wallet/arc.ts";

const CONFIRMATION = "--confirm-production";
const CANONICAL_HOST = "agent-commerce-six.vercel.app";

type Json = Record<string, any>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function requestJson(baseUrl: URL, path: string, init: RequestInit = {}, expected: number | number[] = 200) {
  const response = await fetch(new URL(path, baseUrl), {
    ...init,
    signal: AbortSignal.timeout(45_000),
  });
  const body = await response.json().catch(() => ({})) as Json;
  const statuses = Array.isArray(expected) ? expected : [expected];
  if (!statuses.includes(response.status)) {
    throw new Error(`${path} returned HTTP ${response.status}.`);
  }
  return { response, body };
}

function sessionCookie(response: Response) {
  const value = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert(value, "Production owner session cookie was not issued.");
  return value;
}

async function ownerSession(baseUrl: URL, account: ReturnType<typeof privateKeyToAccount>) {
  const headers = { Origin: baseUrl.origin, "Content-Type": "application/json" };
  const challenge = await requestJson(baseUrl, "/api/byoa/management/challenges", {
    method: "POST",
    headers,
    body: JSON.stringify({ wallet: account.address }),
  }, 201);
  const signature = await account.signMessage({ message: challenge.body.challenge.message });
  const session = await requestJson(baseUrl, "/api/byoa/management/session", {
    method: "POST",
    headers,
    body: JSON.stringify({
      challengeId: challenge.body.challenge.id,
      message: challenge.body.challenge.message,
      signature,
    }),
  });
  return { ...headers, Cookie: sessionCookie(session.response) };
}

async function authorizeWithdrawal(
  baseUrl: URL,
  headers: Record<string, string>,
  seller: ReturnType<typeof privateKeyToAccount>,
  withdrawalId: string,
  detail: Json,
) {
  if (detail.transaction) return detail.transaction as { to: Address; data: Hex };
  assert(detail.typedData, "Resumable withdrawal has neither typed data nor mint transaction.");
  const ownerSignature = await seller.signTypedData(detail.typedData);
  const authorized = await requestJson(baseUrl, `/api/seller/withdrawals/${withdrawalId}/submit`, {
    method: "POST",
    headers,
    body: JSON.stringify({ signature: ownerSignature }),
  });
  assert(isAddress(authorized.body.transaction?.to) && /^0x[0-9a-fA-F]+$/.test(String(authorized.body.transaction?.data)), "Gateway authorization did not return valid Arc mint calldata.");
  return authorized.body.transaction as { to: Address; data: Hex };
}

async function mintAndConfirm(
  baseUrl: URL,
  headers: Record<string, string>,
  seller: ReturnType<typeof privateKeyToAccount>,
  withdrawalId: string,
  transaction: { to: Address; data: Hex },
) {
  const transport = http(process.env.ARC_TESTNET_RPC_URL?.trim() || ARC_TESTNET_RPC_URL);
  const walletClient = createWalletClient({ account: seller, chain: arcTestnetChain, transport });
  const publicClient = createPublicClient({ chain: arcTestnetChain, transport });
  const transactionHash = await walletClient.sendTransaction({
    account: seller,
    chain: arcTestnetChain,
    to: getAddress(transaction.to),
    data: transaction.data,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: transactionHash, timeout: 60_000 });
  assert(receipt.status === "success", "Arc Gateway mint transaction failed.");
  const confirmRequest = {
    method: "POST",
    headers,
    body: JSON.stringify({ transactionHash }),
  } satisfies RequestInit;
  const confirmed = await requestJson(baseUrl, `/api/seller/withdrawals/${withdrawalId}/confirm`, confirmRequest);
  const confirmReplay = await requestJson(baseUrl, `/api/seller/withdrawals/${withdrawalId}/confirm`, confirmRequest);
  assert(confirmed.body.withdrawal?.status === "confirmed", "Seller withdrawal was not confirmed.");
  assert(confirmReplay.body.withdrawal?.mintTransactionHash === transactionHash, "Withdrawal confirmation replay changed the Arc transaction.");
  return transactionHash;
}

async function main() {
  assert(process.argv[2] === CONFIRMATION, `Pass ${CONFIRMATION} to authorize the production withdrawal smoke.`);
  assert(process.argv[3], "Pass the canonical production HTTPS base URL.");
  const baseUrl = new URL(process.argv[3]);
  assert(baseUrl.protocol === "https:" && baseUrl.hostname === CANONICAL_HOST, `Smoke is restricted to https://${CANONICAL_HOST}.`);

  const privateKey = process.env.SELLER_PRIVATE_KEY?.trim();
  assert(privateKey && /^0x[0-9a-fA-F]{64}$/.test(privateKey), "SELLER_PRIVATE_KEY is required for the reference seller withdrawal smoke.");
  const seller = privateKeyToAccount(privateKey as Hex);
  const configuredWallet = process.env.REFERENCE_SELLER_WALLET?.trim() || process.env.SELLER_ADDRESS?.trim();
  assert(configuredWallet && isAddress(configuredWallet), "REFERENCE_SELLER_WALLET or SELLER_ADDRESS must be configured.");
  assert(getAddress(configuredWallet) === seller.address, "Reference seller wallet does not match SELLER_PRIVATE_KEY.");

  const headers = await ownerSession(baseUrl, seller);
  const account = await requestJson(baseUrl, "/api/seller/account", { headers });
  assert(account.body.account?.onboardingStatus === "active", "Reference seller onboarding is not active.");
  assert(getAddress(account.body.account.ownerWallet) === seller.address, "Seller session owner does not match the reference wallet.");

  const amount = process.env.P22_WITHDRAWAL_SMOKE_AMOUNT_USDC?.trim() || "0.0001";
  assert(/^\d+(?:\.\d{1,6})?$/.test(amount) && Number(amount) > 0, "P22 withdrawal smoke amount is invalid.");
  const before = await requestJson(baseUrl, "/api/seller/withdrawals", { headers });
  assert(Number(before.body.balance?.availableUsdc) >= Number(amount), "Reference seller Gateway balance is too low for the withdrawal smoke.");
  assert(Number(before.body.balance?.nativeGasUsdc) > 0, "Reference seller Arc gas balance is empty.");

  const recovery = (before.body.withdrawals ?? []).find((row: Json) => {
    const status = String(row.status);
    return String(row.amountUsdc) === amount && (
      ["ready_to_mint", "submitted"].includes(status) ||
      (status === "awaiting_signature" && Date.parse(String(row.expiresAt)) > Date.now())
    );
  }) as Json | undefined;
  if (recovery) {
    const detail = await requestJson(baseUrl, `/api/seller/withdrawals/${recovery.id}`, { headers });
    const transaction = await authorizeWithdrawal(baseUrl, headers, seller, String(recovery.id), detail.body);
    const recoveredHash = await mintAndConfirm(baseUrl, headers, seller, String(recovery.id), transaction);
    console.log(`[p22-withdrawal-smoke] recovered interrupted intent=${recovery.id} Arc=${recoveredHash}`);
  }
  if (process.env.P22_WITHDRAWAL_RECOVERY_ONLY === "true") {
    if (!recovery) console.log("[p22-withdrawal-smoke] no resumable seller withdrawal intent remains");
    return;
  }

  const idempotencyKey = `p22-withdrawal-smoke:${randomUUID()}`;
  const prepareRequest = {
    method: "POST",
    headers: { ...headers, "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ amountUsdc: amount }),
  } satisfies RequestInit;
  const prepared = await requestJson(baseUrl, "/api/seller/withdrawals", prepareRequest, 201);
  const replay = await requestJson(baseUrl, "/api/seller/withdrawals", prepareRequest, 201);
  const withdrawalId = String(prepared.body.withdrawal?.id ?? "");
  assert(withdrawalId && replay.body.withdrawal?.id === withdrawalId, "Withdrawal idempotency replay did not return the original intent.");
  assert(getAddress(prepared.body.withdrawal.destinationWallet) === seller.address, "Withdrawal destination is not the verified owner wallet.");

  const transaction = await authorizeWithdrawal(baseUrl, headers, seller, withdrawalId, prepared.body);
  const transactionHash = await mintAndConfirm(baseUrl, headers, seller, withdrawalId, transaction);

  const after = await requestJson(baseUrl, "/api/seller/withdrawals", { headers });
  const stored = (after.body.withdrawals ?? []).filter((row: Json) => row.id === withdrawalId);
  assert(stored.length === 1 && stored[0].status === "confirmed", "Withdrawal history is not idempotent or seller-scoped.");
  console.log(`[p22-withdrawal-smoke] PASSED: intent=${withdrawalId} Arc=${transactionHash}`);
}

main().catch((error) => {
  console.error(`[p22-withdrawal-smoke] FAILED: ${error instanceof Error ? error.message : "Unknown error"}`);
  process.exitCode = 1;
});
