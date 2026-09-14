/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  concat,
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  isAddress,
  keccak256,
  toBytes,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";

export const ARC_TESTNET_CHAIN_ID = 5_042_002;
export const ARC_TESTNET_EXPLORER_URL = "https://testnet.arcscan.app";

export type OnchainProofStatus = "pending" | "verified" | "failed";

export type OnchainProofMetadata = {
  status: OnchainProofStatus;
  receiptHash: Hex | null;
  proofId: Hex | null;
  serviceHash: Hex | null;
  requestHash: Hex | null;
  responseHash: Hex | null;
  contractAddress: Address | null;
  chainId: number | null;
  transactionHash: Hex | null;
  blockNumber: number | null;
  attester: Address | null;
  verifiedAt: string | null;
  lastAttemptAt: string | null;
  attemptCount: number;
  error: string | null;
};

export type AgentCommerceProof = {
  receiptHash: Hex;
  serviceHash: Hex;
  buyer: Address;
  seller: Address;
  amountAtomic: string;
  requestHash: Hex;
  responseHash: Hex;
  timestamp: number;
};

export type OnchainPaymentEventRecord = {
  id: string;
  endpoint: string;
  payer: string;
  amount_usdc: string;
  receipt_hash: string | null;
  service_hash: string | null;
  request_hash: string | null;
  response_hash: string | null;
  onchain_buyer: string | null;
  onchain_seller: string | null;
  onchain_amount_atomic: string | null;
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

export const onchainPaymentEventColumns = [
  "id",
  "endpoint",
  "payer",
  "amount_usdc",
  "receipt_hash",
  "service_hash",
  "request_hash",
  "response_hash",
  "onchain_buyer",
  "onchain_seller",
  "onchain_amount_atomic",
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

export const proofRegistryAbi = [
  {
    type: "function",
    name: "getProof",
    stateMutability: "view",
    inputs: [{ name: "receiptId", type: "bytes32" }],
    outputs: [
      { name: "serviceHash", type: "bytes32" },
      { name: "buyer", type: "address" },
      { name: "seller", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "requestHash", type: "bytes32" },
      { name: "responseHash", type: "bytes32" },
      { name: "timestamp", type: "uint64" },
    ],
  },
  {
    type: "function",
    name: "isRegistered",
    stateMutability: "view",
    inputs: [{ name: "receiptId", type: "bytes32" }],
    outputs: [{ name: "registered", type: "bool" }],
  },
  {
    type: "function",
    name: "registerProof",
    stateMutability: "nonpayable",
    inputs: [
      { name: "receiptId", type: "bytes32" },
      { name: "serviceHash", type: "bytes32" },
      { name: "buyer", type: "address" },
      { name: "seller", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "requestHash", type: "bytes32" },
      { name: "responseHash", type: "bytes32" },
    ],
    outputs: [{ name: "timestamp", type: "uint64" }],
  },
  {
    type: "event",
    name: "ProofRegistered",
    inputs: [
      { name: "receiptId", type: "bytes32", indexed: true },
      { name: "serviceHash", type: "bytes32", indexed: true },
      { name: "buyer", type: "address", indexed: true },
      { name: "seller", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
      { name: "requestHash", type: "bytes32", indexed: false },
      { name: "responseHash", type: "bytes32", indexed: false },
      { name: "timestamp", type: "uint64", indexed: false },
      { name: "attester", type: "address", indexed: false },
    ],
  },
  {
    type: "function",
    name: "operator",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "operatorAddress", type: "address" }],
  },
  {
    type: "function",
    name: "isAttester",
    stateMutability: "view",
    inputs: [{ name: "attester", type: "address" }],
    outputs: [{ name: "authorized", type: "bool" }],
  },
] as const;

type ProofWriteData = {
  receiptHash: Hex;
  serviceHash: Hex;
  buyer: Address;
  seller: Address;
  amount: bigint;
  requestHash: Hex;
  responseHash: Hex;
};

type RegistrationDetails = {
  transactionHash: Hex | null;
  blockNumber: bigint | null;
  attester: Address | null;
  verifiedAt: string;
};

export type ProofPublishResult = {
  status: OnchainProofStatus;
  paymentEventId: string;
  proofId: Hex | null;
  transactionHash: Hex | null;
  blockNumber: number | null;
};

function rpcUrl() {
  return process.env.ARC_TESTNET_RPC_URL ?? arcTestnet.rpcUrls.default.http[0];
}

export function configuredExplorerUrl() {
  return (
    process.env.ARC_EXPLORER_URL ??
    process.env.NEXT_PUBLIC_ARC_EXPLORER_URL ??
    ARC_TESTNET_EXPLORER_URL
  ).replace(/\/$/, "");
}

export function configuredRegistryAddress() {
  const value = process.env.AGENT_COMMERCE_PROOF_REGISTRY_ADDRESS;
  return value && isAddress(value) ? getAddress(value) : null;
}

function configuredAddress(name: string) {
  const value = process.env[name];
  return value && isAddress(value) ? getAddress(value) : null;
}

function configuredDeploymentBlock() {
  const value = process.env.AGENT_COMMERCE_PROOF_REGISTRY_DEPLOYMENT_BLOCK;
  if (!value || !/^\d+$/.test(value)) return null;
  return BigInt(value);
}

export function configuredAttesterAccount() {
  const value = process.env.AGENT_COMMERCE_PROOF_ATTESTER_PRIVATE_KEY;
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) return null;
  return privateKeyToAccount(value as Hex);
}

export function getProofRegistryDiagnostic() {
  const registryAddress = configuredRegistryAddress();
  const expectedAttester = configuredAddress(
    "AGENT_COMMERCE_PROOF_ATTESTER_ADDRESS",
  );
  const account = configuredAttesterAccount();
  const derivedAttester = account?.address ?? null;

  return {
    configured: Boolean(registryAddress && account),
    chainId: ARC_TESTNET_CHAIN_ID,
    registryAddress,
    operatorAddress: configuredAddress(
      "AGENT_COMMERCE_PROOF_OPERATOR_ADDRESS",
    ),
    attesterAddress: expectedAttester ?? derivedAttester,
    attesterMatchesPrivateKey: Boolean(
      expectedAttester &&
        derivedAttester &&
        expectedAttester.toLowerCase() === derivedAttester.toLowerCase(),
    ),
    attesterPrivateKeyConfigured: Boolean(account),
    rpcConfigured: Boolean(process.env.ARC_TESTNET_RPC_URL),
    explorerUrl: configuredExplorerUrl(),
    deploymentTransaction:
      bytes32(process.env.AGENT_COMMERCE_PROOF_REGISTRY_DEPLOYMENT_TX) ?? null,
  };
}

function safeErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const configuredSecrets = [
    process.env.AGENT_COMMERCE_PROOF_ATTESTER_PRIVATE_KEY,
    process.env.AGENT_COMMERCE_PROOF_OPERATOR_PRIVATE_KEY,
    process.env.ARC_TESTNET_RPC_URL,
  ].filter((value): value is string => Boolean(value));
  let sanitized = message;

  for (const secret of configuredSecrets) {
    sanitized = sanitized.split(secret).join("[redacted]");
  }

  return sanitized
    .replace(/(?:private\s*key|secret)\s*[:=]\s*\S+/gi, "secret [redacted]")
    .replace(/bearer\s+[^\s]+/gi, "bearer [redacted]")
    .slice(0, 800);
}

function isTransientArcRpcError(error: unknown) {
  const message = safeErrorMessage(error).toLowerCase();
  return [
    "status: 429",
    "request limit reached",
    "rate limit",
    "status: 502",
    "status: 503",
    "status: 504",
    "timed out",
    "timeout",
    "econnreset",
    "socket hang up",
  ].some((signal) => message.includes(signal));
}

async function withArcRpcReadRetry<T>(
  label: string,
  operation: () => Promise<T>,
) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientArcRpcError(error) || attempt === 3) throw error;
      const delayMs = 500 * 2 ** attempt;
      console.warn(
        `[proof-registry] ${label} hit a transient Arc RPC limit; retrying in ${delayMs}ms.`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(`${label} retry loop exhausted`);
}

function bytes32(value: string | null | undefined): Hex | null {
  return value && /^0x[0-9a-fA-F]{64}$/.test(value) ? (value as Hex) : null;
}

function numericValue(value: number | string | null | undefined) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function timestampFromBlock(seconds: bigint) {
  return new Date(Number(seconds) * 1_000).toISOString();
}

function atomicAmountFromUsdc(value: string) {
  if (!/^\d+(?:\.\d+)?$/.test(value)) {
    throw new Error("Payment event amount is not a positive decimal USDC value");
  }
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > 6) {
    throw new Error("Payment event amount exceeds USDC 6-decimal precision");
  }
  return (
    BigInt(whole) * BigInt(1_000_000) +
    BigInt(fraction.padEnd(6, "0") || "0")
  );
}

export function createProofIdentifiers(paymentEventId: string, endpoint: string) {
  return {
    receiptHash: keccak256(toBytes(paymentEventId)),
    serviceHash: keccak256(toBytes(endpoint)),
    contractAddress: configuredRegistryAddress(),
    chainId: ARC_TESTNET_CHAIN_ID,
    attesterAddress:
      configuredAddress("AGENT_COMMERCE_PROOF_ATTESTER_ADDRESS") ??
      configuredAttesterAccount()?.address ??
      null,
  };
}

async function hashRequest(request: Request, endpoint: string) {
  const body = new Uint8Array(await request.arrayBuffer());
  const search = new URL(request.url).search;
  const context = toBytes(`${request.method}\n${endpoint}\n${search}\n`);
  return keccak256(concat([context, body]));
}

async function hashResponse(response: Response) {
  return keccak256(new Uint8Array(await response.arrayBuffer()));
}

async function updatePaymentEvent(
  supabase: SupabaseClient,
  paymentEventId: string,
  values: Record<string, unknown>,
) {
  const { error } = await supabase
    .from("payment_events")
    .update(values)
    .eq("id", paymentEventId);

  if (error) throw new Error(error.message);
}

function proofDataFromRecord(record: OnchainPaymentEventRecord): ProofWriteData {
  const receiptHash = bytes32(record.receipt_hash);
  const serviceHash = bytes32(record.service_hash);
  const requestHash = bytes32(record.request_hash);
  const responseHash = bytes32(record.response_hash);
  const buyer = record.onchain_buyer ?? record.payer;
  const seller = record.onchain_seller;
  const amount = record.onchain_amount_atomic
    ? BigInt(record.onchain_amount_atomic)
    : atomicAmountFromUsdc(record.amount_usdc);

  if (!receiptHash || !serviceHash || !requestHash || !responseHash) {
    throw new Error("Payment event is missing required proof hashes");
  }
  if (!isAddress(buyer) || !seller || !isAddress(seller)) {
    throw new Error("Payment event is missing valid proof buyer or seller");
  }
  if (amount <= BigInt(0)) throw new Error("Settlement amount must be positive");

  return {
    receiptHash,
    serviceHash,
    buyer: getAddress(buyer),
    seller: getAddress(seller),
    amount,
    requestHash,
    responseHash,
  };
}

async function readProofData(
  publicClient: PublicClient,
  contractAddress: Address,
  receiptHash: Hex,
): Promise<AgentCommerceProof | null> {
  const registered = await publicClient.readContract({
    address: contractAddress,
    abi: proofRegistryAbi,
    functionName: "isRegistered",
    args: [receiptHash],
  });
  if (!registered) return null;

  const [serviceHash, buyer, seller, amount, requestHash, responseHash, timestamp] =
    await publicClient.readContract({
      address: contractAddress,
      abi: proofRegistryAbi,
      functionName: "getProof",
      args: [receiptHash],
    });

  return {
    receiptHash,
    serviceHash,
    buyer,
    seller,
    amountAtomic: amount.toString(),
    requestHash,
    responseHash,
    timestamp: Number(timestamp),
  };
}

function assertProofMatches(expected: ProofWriteData, actual: AgentCommerceProof) {
  const matches =
    actual.receiptHash.toLowerCase() === expected.receiptHash.toLowerCase() &&
    actual.serviceHash.toLowerCase() === expected.serviceHash.toLowerCase() &&
    actual.buyer.toLowerCase() === expected.buyer.toLowerCase() &&
    actual.seller.toLowerCase() === expected.seller.toLowerCase() &&
    actual.amountAtomic === expected.amount.toString() &&
    actual.requestHash.toLowerCase() === expected.requestHash.toLowerCase() &&
    actual.responseHash.toLowerCase() === expected.responseHash.toLowerCase();

  if (!matches) {
    throw new Error("Registered receipt proof does not match the payment event");
  }
}

async function findRegistrationDetails(
  publicClient: PublicClient,
  contractAddress: Address,
  receiptHash: Hex,
): Promise<RegistrationDetails> {
  const latestBlock = await publicClient.getBlockNumber();
  const lookback = BigInt(100_000);
  const fallbackFrom = latestBlock > lookback ? latestBlock - lookback : BigInt(0);
  const fromBlock = configuredDeploymentBlock() ?? fallbackFrom;
  const logs = await publicClient.getLogs({
    address: contractAddress,
    event: proofRegistryAbi[3],
    args: { receiptId: receiptHash },
    fromBlock,
    toBlock: "latest",
  });
  const log = logs.at(-1);

  if (!log?.blockNumber) {
    return {
      transactionHash: null,
      blockNumber: null,
      attester: null,
      verifiedAt: new Date().toISOString(),
    };
  }

  const block = await publicClient.getBlock({ blockNumber: log.blockNumber });
  return {
    transactionHash: log.transactionHash,
    blockNumber: log.blockNumber,
    attester: log.args.attester ? getAddress(log.args.attester) : null,
    verifiedAt: timestampFromBlock(block.timestamp),
  };
}

async function persistVerified(input: {
  supabase: SupabaseClient;
  paymentEventId: string;
  proof: ProofWriteData;
  contractAddress: Address;
  details: RegistrationDetails;
  fallbackTransactionHash?: Hex | null;
  fallbackAttester?: Address | null;
}) {
  const {
    supabase,
    paymentEventId,
    proof,
    contractAddress,
    details,
    fallbackTransactionHash,
    fallbackAttester,
  } = input;
  const transactionHash = details.transactionHash ?? fallbackTransactionHash ?? null;
  const attester = details.attester ?? fallbackAttester ?? null;

  await updatePaymentEvent(supabase, paymentEventId, {
    onchain_status: "verified",
    onchain_contract_address: contractAddress,
    onchain_chain_id: ARC_TESTNET_CHAIN_ID,
    onchain_proof_id: proof.receiptHash,
    onchain_tx_hash: transactionHash,
    onchain_block_number: details.blockNumber?.toString() ?? null,
    onchain_attester: attester,
    onchain_verified_at: details.verifiedAt,
    onchain_error: null,
  });

  return {
    status: "verified" as const,
    paymentEventId,
    proofId: proof.receiptHash,
    transactionHash,
    blockNumber: details.blockNumber ? Number(details.blockNumber) : null,
  };
}

async function reconcileRegisteredProof(input: {
  supabase: SupabaseClient;
  paymentEventId: string;
  publicClient: PublicClient;
  contractAddress: Address;
  proof: ProofWriteData;
  fallbackTransactionHash?: Hex | null;
  fallbackAttester?: Address | null;
}) {
  const actual = await readProofData(
    input.publicClient,
    input.contractAddress,
    input.proof.receiptHash,
  );
  if (!actual) return null;

  assertProofMatches(input.proof, actual);
  let details: RegistrationDetails;
  if (input.fallbackTransactionHash) {
    const receipt = await input.publicClient.getTransactionReceipt({
      hash: input.fallbackTransactionHash,
    });
    if (receipt.status !== "success") {
      throw new Error("Stored proof transaction reverted");
    }
    const block = await input.publicClient.getBlock({
      blockNumber: receipt.blockNumber,
    });
    details = {
      transactionHash: input.fallbackTransactionHash,
      blockNumber: receipt.blockNumber,
      attester: input.fallbackAttester ?? null,
      verifiedAt: timestampFromBlock(block.timestamp),
    };
  } else {
    details = await findRegistrationDetails(
      input.publicClient,
      input.contractAddress,
      input.proof.receiptHash,
    );
  }
  return persistVerified({ ...input, details });
}

export async function markOnchainProofFailed(
  supabase: SupabaseClient,
  paymentEventId: string,
  error?: unknown,
) {
  try {
    await updatePaymentEvent(supabase, paymentEventId, {
      onchain_status: "failed",
      onchain_last_attempt_at: new Date().toISOString(),
      onchain_error: error ? safeErrorMessage(error) : "Proof scheduling failed",
    });
  } catch (persistenceError) {
    console.error(
      `[proof-registry] Failed to persist failed status for receipt ${paymentEventId}: ${safeErrorMessage(persistenceError)}`,
    );
  }
}

export async function publishStoredProof(input: {
  supabase: SupabaseClient;
  record: OnchainPaymentEventRecord;
}): Promise<ProofPublishResult> {
  const { supabase, record } = input;
  const contractAddress = configuredRegistryAddress();
  const account = configuredAttesterAccount();
  let publicClient: PublicClient | null = null;
  let proof: ProofWriteData | null = null;
  let transactionHash = bytes32(record.onchain_tx_hash);

  try {
    if (!contractAddress) {
      throw new Error("AGENT_COMMERCE_PROOF_REGISTRY_ADDRESS is missing or invalid");
    }
    if (!account) {
      throw new Error("AGENT_COMMERCE_PROOF_ATTESTER_PRIVATE_KEY is missing or invalid");
    }
    const expectedAttester = configuredAddress(
      "AGENT_COMMERCE_PROOF_ATTESTER_ADDRESS",
    );
    if (
      expectedAttester &&
      expectedAttester.toLowerCase() !== account.address.toLowerCase()
    ) {
      throw new Error("Configured attester address does not match its private key");
    }

    proof = proofDataFromRecord(record);
    const attemptCount = Math.max(record.onchain_attempt_count ?? 0, 0) + 1;
    await updatePaymentEvent(supabase, record.id, {
      onchain_status: "pending",
      onchain_contract_address: contractAddress,
      onchain_chain_id: ARC_TESTNET_CHAIN_ID,
      onchain_proof_id: proof.receiptHash,
      onchain_attester: account.address,
      onchain_last_attempt_at: new Date().toISOString(),
      onchain_attempt_count: attemptCount,
      onchain_error: null,
    });

    publicClient = createPublicClient({
      chain: arcTestnet,
      transport: http(rpcUrl()),
    });
    const observedChainId = await withArcRpcReadRetry(
      "chain ID read",
      () => publicClient!.getChainId(),
    );
    if (observedChainId !== ARC_TESTNET_CHAIN_ID) {
      throw new Error(
        `Refusing proof write on chain ${observedChainId}; expected ${ARC_TESTNET_CHAIN_ID}`,
      );
    }

    const existing = await withArcRpcReadRetry(
      "existing proof reconciliation",
      () => reconcileRegisteredProof({
        supabase,
        paymentEventId: record.id,
        publicClient: publicClient!,
        contractAddress,
        proof: proof!,
        fallbackTransactionHash: transactionHash,
        fallbackAttester: account.address,
      }),
    );
    if (existing) return existing;

    const { request: writeRequest } = await withArcRpcReadRetry(
      "proof simulation",
      () => publicClient!.simulateContract({
        account,
        address: contractAddress,
        abi: proofRegistryAbi,
        functionName: "registerProof",
        args: [
          proof!.receiptHash,
          proof!.serviceHash,
          proof!.buyer,
          proof!.seller,
          proof!.amount,
          proof!.requestHash,
          proof!.responseHash,
        ],
      }),
    );
    const walletClient = createWalletClient({
      account,
      chain: arcTestnet,
      transport: http(rpcUrl()),
    });

    transactionHash = await walletClient.writeContract(writeRequest);
    await updatePaymentEvent(supabase, record.id, {
      onchain_tx_hash: transactionHash,
      onchain_status: "pending",
    });

    const receipt = await withArcRpcReadRetry(
      "proof transaction receipt",
      () => publicClient!.waitForTransactionReceipt({ hash: transactionHash! }),
    );
    if (receipt.status !== "success") {
      throw new Error("Proof transaction reverted");
    }

    const actual = await withArcRpcReadRetry(
      "registered proof read",
      () => readProofData(
        publicClient!,
        contractAddress,
        proof!.receiptHash,
      ),
    );
    if (!actual) throw new Error("Proof transaction succeeded but proof is unavailable");
    assertProofMatches(proof, actual);

    const block = await withArcRpcReadRetry(
      "proof block read",
      () => publicClient!.getBlock({ blockNumber: receipt.blockNumber }),
    );
    return persistVerified({
      supabase,
      paymentEventId: record.id,
      proof,
      contractAddress,
      details: {
        transactionHash,
        blockNumber: receipt.blockNumber,
        attester: account.address,
        verifiedAt: timestampFromBlock(block.timestamp),
      },
      fallbackTransactionHash: transactionHash,
      fallbackAttester: account.address,
    });
  } catch (error) {
    if (publicClient && contractAddress && proof) {
      try {
        const recovered = await withArcRpcReadRetry(
          "failed proof reconciliation",
          () => reconcileRegisteredProof({
            supabase,
            paymentEventId: record.id,
            publicClient: publicClient!,
            contractAddress,
            proof: proof!,
            fallbackTransactionHash: transactionHash,
            fallbackAttester: account?.address ?? null,
          }),
        );
        if (recovered) return recovered;
      } catch {
        // Preserve the original failure below. Recovery can retry reconciliation.
      }
    }

    const safeMessage = safeErrorMessage(error);
    console.error(
      `[proof-registry] Proof attestation failed for receipt ${record.id}: ${safeMessage}`,
    );
    await markOnchainProofFailed(supabase, record.id, error);
    return {
      status: "failed",
      paymentEventId: record.id,
      proofId: proof?.receiptHash ?? null,
      transactionHash,
      blockNumber: null,
    };
  }
}

export async function attestPaymentEvent(input: {
  supabase: SupabaseClient;
  paymentEventId: string;
  endpoint: string;
  amountAtomic: string;
  buyer: string;
  seller: string;
  request: Request;
  response: Response;
  responseHashOverride?: Hex;
}) {
  const {
    supabase,
    paymentEventId,
    endpoint,
    amountAtomic,
    buyer,
    seller,
    request,
    response,
    responseHashOverride,
  } = input;

  try {
    const { receiptHash, serviceHash, contractAddress, chainId } =
      createProofIdentifiers(paymentEventId, endpoint);
    const canonicalResponseHash = responseHashOverride
      ? bytes32(responseHashOverride)
      : null;
    if (responseHashOverride && !canonicalResponseHash) {
      throw new Error("Canonical proof response hash must be bytes32.");
    }
    const [requestHash, responseHash] = await Promise.all([
      hashRequest(request, endpoint),
      canonicalResponseHash
        ? Promise.resolve(canonicalResponseHash)
        : hashResponse(response),
    ]);
    const attester = configuredAttesterAccount()?.address ?? null;

    await updatePaymentEvent(supabase, paymentEventId, {
      receipt_hash: receiptHash,
      service_hash: serviceHash,
      request_hash: requestHash,
      response_hash: responseHash,
      onchain_buyer: buyer,
      onchain_seller: seller,
      onchain_amount_atomic: amountAtomic,
      onchain_contract_address: contractAddress,
      onchain_chain_id: chainId,
      onchain_proof_id: receiptHash,
      onchain_attester: attester,
      onchain_status: "pending",
      onchain_error: null,
    });

    const { data, error } = await supabase
      .from("payment_events")
      .select(onchainPaymentEventColumns)
      .eq("id", paymentEventId)
      .single();
    if (error || !data) {
      throw new Error(error?.message ?? "Unable to reload proof payment event");
    }

    return publishStoredProof({
      supabase,
      record: data as unknown as OnchainPaymentEventRecord,
    });
  } catch (error) {
    console.error(
      `[proof-registry] Proof preparation failed for receipt ${paymentEventId}: ${safeErrorMessage(error)}`,
    );
    await markOnchainProofFailed(supabase, paymentEventId, error);
    return {
      status: "failed" as const,
      paymentEventId,
      proofId: null,
      transactionHash: null,
      blockNumber: null,
    };
  }
}

export function onchainProofMetadataFromRow(row: {
  receipt_hash: string | null;
  service_hash: string | null;
  request_hash: string | null;
  response_hash: string | null;
  onchain_contract_address: string | null;
  onchain_chain_id: number | string | null;
  onchain_tx_hash: string | null;
  onchain_status: string | null;
  onchain_block_number?: number | string | null;
  onchain_proof_id?: string | null;
  onchain_attester?: string | null;
  onchain_verified_at?: string | null;
  onchain_last_attempt_at?: string | null;
  onchain_attempt_count?: number | null;
  onchain_error?: string | null;
}): OnchainProofMetadata | null {
  if (
    row.onchain_status !== "pending" &&
    row.onchain_status !== "verified" &&
    row.onchain_status !== "failed"
  ) {
    return null;
  }

  const contractAddress =
    row.onchain_contract_address && isAddress(row.onchain_contract_address)
      ? getAddress(row.onchain_contract_address)
      : null;
  const attester =
    row.onchain_attester && isAddress(row.onchain_attester)
      ? getAddress(row.onchain_attester)
      : null;
  const numericChainId = Number(row.onchain_chain_id);

  return {
    status: row.onchain_status,
    receiptHash: bytes32(row.receipt_hash),
    proofId: bytes32(row.onchain_proof_id) ?? bytes32(row.receipt_hash),
    serviceHash: bytes32(row.service_hash),
    requestHash: bytes32(row.request_hash),
    responseHash: bytes32(row.response_hash),
    contractAddress,
    chainId: Number.isInteger(numericChainId) ? numericChainId : null,
    transactionHash: bytes32(row.onchain_tx_hash),
    blockNumber: numericValue(row.onchain_block_number),
    attester,
    verifiedAt: row.onchain_verified_at ?? null,
    lastAttemptAt: row.onchain_last_attempt_at ?? null,
    attemptCount: Math.max(row.onchain_attempt_count ?? 0, 0),
    error: row.onchain_error ?? null,
  };
}

export async function readAgentCommerceProof(
  metadata: OnchainProofMetadata,
): Promise<AgentCommerceProof | null> {
  if (
    !metadata.receiptHash ||
    !metadata.contractAddress ||
    metadata.chainId !== ARC_TESTNET_CHAIN_ID
  ) {
    return null;
  }

  const publicClient = createPublicClient({
    chain: arcTestnet,
    transport: http(rpcUrl()),
  });
  const observedChainId = await publicClient.getChainId();
  if (observedChainId !== ARC_TESTNET_CHAIN_ID) {
    throw new Error(
      `Arc RPC returned chain ${observedChainId}; expected ${ARC_TESTNET_CHAIN_ID}`,
    );
  }

  return readProofData(
    publicClient,
    metadata.contractAddress,
    metadata.receiptHash,
  );
}
