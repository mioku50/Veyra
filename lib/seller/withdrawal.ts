/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomBytes } from "node:crypto";
import {
  encodeFunctionData,
  createPublicClient,
  formatEther,
  formatUnits,
  getAddress,
  maxUint256,
  http,
  pad,
  parseUnits,
  verifyTypedData,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { CHAIN_CONFIGS } from "@circle-fin/x402-batching/client";
import { ARC_TESTNET_RPC_URL, arcTestnetChain } from "../wallet/arc.ts";
import { ensureSellerAccount, getSellerMarketplaceClient } from "./marketplace.ts";

const GATEWAY_API = "https://gateway-api-testnet.circle.com/v1";
const SOURCE_CHAIN = "arcTestnet" as const;
const chainConfig = CHAIN_CONFIGS[SOURCE_CHAIN];
const arcPublicClient = createPublicClient({
  chain: arcTestnetChain,
  transport: http(process.env.ARC_TESTNET_RPC_URL ?? ARC_TESTNET_RPC_URL),
});
const MAX_FEE_USDC = "2.01";
const INTENT_TTL_MS = 15 * 60_000;

const burnIntentTypes = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
  ],
  TransferSpec: [
    { name: "version", type: "uint32" },
    { name: "sourceDomain", type: "uint32" },
    { name: "destinationDomain", type: "uint32" },
    { name: "sourceContract", type: "bytes32" },
    { name: "destinationContract", type: "bytes32" },
    { name: "sourceToken", type: "bytes32" },
    { name: "destinationToken", type: "bytes32" },
    { name: "sourceDepositor", type: "bytes32" },
    { name: "destinationRecipient", type: "bytes32" },
    { name: "sourceSigner", type: "bytes32" },
    { name: "destinationCaller", type: "bytes32" },
    { name: "value", type: "uint256" },
    { name: "salt", type: "bytes32" },
    { name: "hookData", type: "bytes" },
  ],
  BurnIntent: [
    { name: "maxBlockHeight", type: "uint256" },
    { name: "maxFee", type: "uint256" },
    { name: "spec", type: "TransferSpec" },
  ],
} as const;

const gatewayMinterAbi = [{
  type: "function",
  name: "gatewayMint",
  stateMutability: "nonpayable",
  inputs: [
    { name: "attestation", type: "bytes" },
    { name: "signature", type: "bytes" },
  ],
  outputs: [],
}] as const;

type StoredBurnIntent = {
  maxBlockHeight: string;
  maxFee: string;
  spec: {
    version: number;
    sourceDomain: number;
    destinationDomain: number;
    sourceContract: Hex;
    destinationContract: Hex;
    sourceToken: Hex;
    destinationToken: Hex;
    sourceDepositor: Hex;
    destinationRecipient: Hex;
    sourceSigner: Hex;
    destinationCaller: Hex;
    value: string;
    salt: Hex;
    hookData: Hex;
  };
};

type WithdrawalRow = {
  id: string;
  public_id: string;
  seller_id: string;
  amount_usdc: string | number;
  source_chain: string;
  destination_chain: string;
  destination_wallet: string;
  max_fee_usdc: string | number;
  burn_intent: StoredBurnIntent;
  owner_signature: string | null;
  gateway_attestation: string | null;
  gateway_signature: string | null;
  mint_calldata: string | null;
  mint_transaction_hash: string | null;
  status: string;
  failure_code: string | null;
  expires_at: string;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
};

function formatUsdc(value: string | number) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount.toFixed(6).replace(/\.?0+$/, "") || "0" : "0";
}

function addressBytes32(address: Address) {
  return pad(address.toLowerCase() as Address, { size: 32 });
}

function withdrawalProjection(row: WithdrawalRow) {
  return {
    id: row.public_id,
    amountUsdc: formatUsdc(row.amount_usdc),
    sourceChain: row.source_chain,
    destinationChain: row.destination_chain,
    destinationWallet: getAddress(row.destination_wallet),
    status: row.status,
    failureCode: row.failure_code,
    mintTransactionHash: row.mint_transaction_hash,
    expiresAt: row.expires_at,
    confirmedAt: row.confirmed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function typedData(intent: StoredBurnIntent) {
  return {
    domain: { name: "GatewayWallet", version: "1" },
    types: burnIntentTypes,
    primaryType: "BurnIntent" as const,
    message: {
      maxBlockHeight: BigInt(intent.maxBlockHeight),
      maxFee: BigInt(intent.maxFee),
      spec: {
        ...intent.spec,
        value: BigInt(intent.spec.value),
      },
    },
  };
}

function typedDataJson(intent: StoredBurnIntent) {
  return {
    domain: { name: "GatewayWallet", version: "1" },
    types: burnIntentTypes,
    primaryType: "BurnIntent" as const,
    message: intent,
  };
}

function createBurnIntent(ownerWallet: Address, amountAtomic: bigint): StoredBurnIntent {
  return {
    maxBlockHeight: maxUint256.toString(),
    maxFee: parseUnits(MAX_FEE_USDC, 6).toString(),
    spec: {
      version: 1,
      sourceDomain: chainConfig.domain,
      destinationDomain: chainConfig.domain,
      sourceContract: addressBytes32(chainConfig.gatewayWallet),
      destinationContract: addressBytes32(chainConfig.gatewayMinter),
      sourceToken: addressBytes32(chainConfig.usdc),
      destinationToken: addressBytes32(chainConfig.usdc),
      sourceDepositor: addressBytes32(ownerWallet),
      destinationRecipient: addressBytes32(ownerWallet),
      sourceSigner: addressBytes32(ownerWallet),
      destinationCaller: addressBytes32(zeroAddress),
      value: amountAtomic.toString(),
      salt: `0x${randomBytes(32).toString("hex")}`,
      hookData: "0x",
    },
  };
}

function parseGatewayAmount(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return BigInt(0);
  const raw = String(value);
  if (/^\d+(?:\.\d{1,6})?$/.test(raw)) return parseUnits(raw, 6);
  return BigInt(0);
}

export async function getSellerGatewayBalance(ownerWallet: Address) {
  const owner = getAddress(ownerWallet);
  const [gatewayResponse, nativeBalance] = await Promise.all([
    fetch(`${GATEWAY_API}/balances`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        token: "USDC",
        sources: [{ domain: chainConfig.domain, depositor: owner }],
      }),
    }),
    arcPublicClient.getBalance({ address: owner }),
  ]);
  if (!gatewayResponse.ok) throw new Error("Gateway balance is temporarily unavailable.");
  const body = await gatewayResponse.json() as {
    balances?: Array<{ domain?: number; balance?: unknown; withdrawing?: unknown; withdrawable?: unknown }>;
  };
  const balance = body.balances?.find((item) => item.domain === chainConfig.domain);
  const available = parseGatewayAmount(balance?.balance);
  const withdrawing = parseGatewayAmount(balance?.withdrawing);
  const withdrawable = parseGatewayAmount(balance?.withdrawable);
  return {
    wallet: owner,
    chain: SOURCE_CHAIN,
    availableUsdc: formatUnits(available, 6),
    withdrawingUsdc: formatUnits(withdrawing, 6),
    withdrawableUsdc: formatUnits(withdrawable, 6),
    nativeGasUsdc: formatEther(nativeBalance),
  };
}

async function ownedWithdrawal(ownerWallet: Address, publicId: string) {
  const seller = await ensureSellerAccount(ownerWallet);
  const result = await getSellerMarketplaceClient().from("seller_withdrawal_requests")
    .select("*").eq("seller_id", seller.id).eq("public_id", publicId).maybeSingle();
  if (result.error) throw new Error("Unable to load seller withdrawal.");
  return result.data as WithdrawalRow | null;
}

function isExpiredOpenWithdrawal(row: WithdrawalRow) {
  return Date.parse(row.expires_at) <= Date.now() &&
    ["awaiting_signature", "ready_to_mint", "submitted"].includes(row.status);
}

async function expireWithdrawal(row: WithdrawalRow) {
  if (!isExpiredOpenWithdrawal(row)) return row;
  const result = await getSellerMarketplaceClient().from("seller_withdrawal_requests")
    .update({ status: "expired", failure_code: "intent_expired" })
    .eq("id", row.id)
    .in("status", ["awaiting_signature", "ready_to_mint", "submitted"])
    .select("*")
    .maybeSingle();
  if (result.error) throw new Error("Unable to expire stale seller withdrawal.");
  if (result.data) return result.data as WithdrawalRow;
  const replay = await getSellerMarketplaceClient().from("seller_withdrawal_requests")
    .select("*").eq("id", row.id).maybeSingle();
  if (replay.error) throw new Error("Unable to reconcile stale seller withdrawal.");
  return (replay.data as WithdrawalRow | null) ?? row;
}

export async function getSellerWithdrawalDetail(ownerWallet: Address, publicId: string) {
  const owned = await ownedWithdrawal(ownerWallet, publicId);
  if (!owned) return null;
  const row = await expireWithdrawal(owned);
  return {
    withdrawal: withdrawalProjection(row),
    ...(row.status === "awaiting_signature" ? { typedData: typedDataJson(row.burn_intent) } : {}),
    ...(["ready_to_mint", "submitted"].includes(row.status) && row.mint_calldata
      ? { transaction: { to: chainConfig.gatewayMinter, data: row.mint_calldata } }
      : {}),
  };
}

export async function listSellerWithdrawals(ownerWallet: Address) {
  const seller = await ensureSellerAccount(ownerWallet);
  const [balance, rows] = await Promise.all([
    getSellerGatewayBalance(ownerWallet),
    getSellerMarketplaceClient().from("seller_withdrawal_requests")
      .select("*").eq("seller_id", seller.id).order("created_at", { ascending: false }).limit(100),
  ]);
  if (rows.error) throw new Error("Unable to load seller withdrawals.");
  const normalizedRows = await Promise.all(((rows.data ?? []) as WithdrawalRow[]).map(expireWithdrawal));
  return {
    balance,
    withdrawals: normalizedRows.map(withdrawalProjection),
  };
}

export async function prepareSellerWithdrawal(
  ownerWallet: Address,
  amountValue: unknown,
  idempotencyKey: string,
) {
  const seller = await ensureSellerAccount(ownerWallet);
  if (seller.status !== "active" || seller.onboarding_status !== "active") {
    throw new Error("Active seller onboarding is required for withdrawals.");
  }
  const amount = String(amountValue ?? "").trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(amount)) throw new Error("Withdrawal amount must use at most 6 decimals.");
  const amountAtomic = parseUnits(amount, 6);
  if (amountAtomic <= BigInt(0)) throw new Error("Withdrawal amount must be greater than 0 USDC.");
  if (!/^[A-Za-z0-9._:-]{16,160}$/.test(idempotencyKey)) {
    throw new Error("A valid Idempotency-Key is required.");
  }
  const keyHash = createHash("sha256").update(idempotencyKey).digest("hex");
  const existing = await getSellerMarketplaceClient().from("seller_withdrawal_requests")
    .select("*").eq("seller_id", seller.id).eq("idempotency_key_hash", keyHash).maybeSingle();
  if (existing.error) throw new Error("Unable to inspect withdrawal idempotency.");
  if (existing.data) {
    const row = existing.data as WithdrawalRow;
    if (parseUnits(String(row.amount_usdc), 6) !== amountAtomic || getAddress(row.destination_wallet) !== getAddress(ownerWallet)) {
      throw new Error("Idempotency-Key is already bound to a different withdrawal.");
    }
    return { withdrawal: withdrawalProjection(row), typedData: typedDataJson(row.burn_intent) };
  }
  const balance = await getSellerGatewayBalance(ownerWallet);
  if (parseUnits(balance.availableUsdc, 6) < amountAtomic) {
    throw new Error("Withdrawal amount exceeds the seller's available Gateway balance.");
  }

  const intent = createBurnIntent(getAddress(ownerWallet), amountAtomic);
  const inserted = await getSellerMarketplaceClient().from("seller_withdrawal_requests").insert({
    seller_id: seller.id,
    idempotency_key_hash: keyHash,
    amount_usdc: formatUnits(amountAtomic, 6),
    destination_wallet: getAddress(ownerWallet),
    max_fee_usdc: MAX_FEE_USDC,
    burn_intent: intent,
    expires_at: new Date(Date.now() + INTENT_TTL_MS).toISOString(),
  }).select("*").single();
  if (inserted.error || !inserted.data) throw new Error("Unable to create seller withdrawal intent.");
  const row = inserted.data as WithdrawalRow;
  return { withdrawal: withdrawalProjection(row), typedData: typedDataJson(intent) };
}

export async function submitSellerWithdrawalSignature(
  ownerWallet: Address,
  publicId: string,
  signatureValue: unknown,
) {
  const row = await ownedWithdrawal(ownerWallet, publicId);
  if (!row) return null;
  if (isExpiredOpenWithdrawal(row)) {
    await expireWithdrawal(row);
    throw new Error("Withdrawal intent expired. Create a new intent.");
  }
  if (row.status === "ready_to_mint" || row.status === "submitted") {
    return {
      withdrawal: withdrawalProjection(row),
      transaction: { to: chainConfig.gatewayMinter, data: row.mint_calldata },
    };
  }
  if (row.status !== "awaiting_signature") throw new Error("Withdrawal cannot accept a signature in its current state.");
  if (Date.parse(row.expires_at) <= Date.now()) {
    await getSellerMarketplaceClient().from("seller_withdrawal_requests")
      .update({ status: "expired", failure_code: "intent_expired" }).eq("id", row.id);
    throw new Error("Withdrawal intent expired. Create a new intent.");
  }
  const signature = String(signatureValue ?? "") as Hex;
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error("Withdrawal signature is invalid.");
  const valid = await verifyTypedData({
    address: getAddress(ownerWallet),
    ...typedData(row.burn_intent),
    signature,
  });
  if (!valid) throw new Error("Withdrawal signature does not match the verified owner wallet.");

  const gatewayResponse = await fetch(`${GATEWAY_API}/transfer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify([{ burnIntent: row.burn_intent, signature }]),
  });
  const gateway = await gatewayResponse.json().catch(() => ({})) as Record<string, unknown>;
  const attestation = typeof gateway.attestation === "string" ? gateway.attestation as Hex : null;
  const gatewaySignature = typeof gateway.signature === "string" ? gateway.signature as Hex : null;
  if (!gatewayResponse.ok || !attestation || !gatewaySignature || !/^0x[0-9a-fA-F]+$/.test(attestation) || !/^0x[0-9a-fA-F]+$/.test(gatewaySignature)) {
    throw new Error("Gateway could not authorize this withdrawal intent.");
  }
  const calldata = encodeFunctionData({
    abi: gatewayMinterAbi,
    functionName: "gatewayMint",
    args: [attestation, gatewaySignature],
  });
  const updated = await getSellerMarketplaceClient().from("seller_withdrawal_requests").update({
    owner_signature: signature,
    gateway_attestation: attestation,
    gateway_signature: gatewaySignature,
    mint_calldata: calldata,
    status: "ready_to_mint",
    failure_code: null,
  }).eq("id", row.id).eq("status", "awaiting_signature").select("*").single();
  if (updated.error || !updated.data) throw new Error("Unable to persist Gateway withdrawal authorization.");
  return {
    withdrawal: withdrawalProjection(updated.data as WithdrawalRow),
    transaction: { to: chainConfig.gatewayMinter, data: calldata },
  };
}

export async function confirmSellerWithdrawal(
  ownerWallet: Address,
  publicId: string,
  transactionHashValue: unknown,
) {
  const row = await ownedWithdrawal(ownerWallet, publicId);
  if (!row) return null;
  if (row.status === "confirmed") return withdrawalProjection(row);
  if (!["ready_to_mint", "submitted", "expired"].includes(row.status)) {
    throw new Error("Withdrawal is not ready for confirmation.");
  }
  const hash = String(transactionHashValue ?? "") as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("Mint transaction hash is invalid.");
  const [receipt, transaction] = await Promise.all([
    arcPublicClient.getTransactionReceipt({ hash }),
    arcPublicClient.getTransaction({ hash }),
  ]);
  if (
    receipt.status !== "success" ||
    transaction.from.toLowerCase() !== getAddress(ownerWallet).toLowerCase() ||
    transaction.to?.toLowerCase() !== chainConfig.gatewayMinter.toLowerCase() ||
    transaction.input.toLowerCase() !== row.mint_calldata?.toLowerCase()
  ) {
    throw new Error("Arc mint transaction does not match the authorized withdrawal.");
  }
  const confirmedAt = new Date().toISOString();
  const updated = await getSellerMarketplaceClient().from("seller_withdrawal_requests").update({
    mint_transaction_hash: hash,
    status: "confirmed",
    confirmed_at: confirmedAt,
    failure_code: null,
  }).eq("id", row.id).in("status", ["ready_to_mint", "submitted", "expired"]).select("*").single();
  if (updated.error || !updated.data) throw new Error("Unable to confirm seller withdrawal.");
  return withdrawalProjection(updated.data as WithdrawalRow);
}
