/**
 * Copyright 2026 Circle Internet Group, Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createPublicClient,
  getContract,
  http,
  isAddress,
  isHex,
  parseAbiItem,
  parseEventLogs,
  zeroAddress,
  type Hex,
} from "viem";
import { arcTestnet } from "viem/chains";
import {
  ARC_ERC8004_IDENTITY_REGISTRY,
  ARC_ERC8004_REPUTATION_REGISTRY,
  ARC_ERC8004_VALIDATION_REGISTRY,
  type Erc8004AgentIdentityRecord,
  type Erc8004ValidationStatus,
} from "./types.ts";

export {
  ARC_ERC8004_IDENTITY_REGISTRY,
  ARC_ERC8004_REPUTATION_REGISTRY,
  ARC_ERC8004_VALIDATION_REGISTRY,
};
import { getByoaClient } from "../byoa/service.ts";

export const ARC_TESTNET_RPC_URL =
  process.env.ARC_TESTNET_RPC_URL || "https://rpc.testnet.arc.network";

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"
);

export interface Erc8004MintRecord {
  agentId: string;
  transactionHash: Hex;
  blockNumber: bigint;
}

/**
 * Why a canonical identity could not be established.
 *
 * `chain_history_unavailable` is deliberately distinct from the `*_mismatch`
 * codes: it means the chain could not answer, not that it contradicted the
 * stored record. Both keep the identity unverified - the difference exists so
 * an operator can tell an Arc Testnet history reset apart from tampering.
 */
export type Erc8004VerificationFailureCode =
  | "storage_unavailable"
  | "record_mismatch"
  | "owner_mismatch"
  | "metadata_mismatch"
  | "registration_tx_invalid"
  | "registration_not_canonical"
  | "mint_event_missing"
  | "chain_history_unavailable"
  | "onchain_verification_failed";

export class Erc8004IdentityVerificationError extends Error {
  constructor(
    message: string,
    readonly code: Erc8004VerificationFailureCode = "onchain_verification_failed",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "Erc8004IdentityVerificationError";
  }
}

export function getArcPublicClient(rpcUrl = ARC_TESTNET_RPC_URL) {
  return createPublicClient({
    chain: arcTestnet,
    transport: http(rpcUrl, { retryCount: 3, timeout: 15_000 }),
  });
}

export async function getAgentIdentityRecord(
  agentId: string
): Promise<Erc8004AgentIdentityRecord | null> {
  if (!/^\d+$/.test(agentId) || BigInt(agentId) <= BigInt(0)) {
    return null;
  }

  const supabase = getByoaClient();
  const { data, error } = await supabase
    .from("erc8004_agent_identity")
    .select("*")
    .eq("agent_id", agentId)
    .maybeSingle();

  if (error) {
    throw new Erc8004IdentityVerificationError(
      `ERC-8004 identity storage unavailable (${error.code || "query_failed"})`,
      "storage_unavailable",
      { cause: error },
    );
  }

  return data ? (data as Erc8004AgentIdentityRecord) : null;
}

export async function getVeyraAgentIdentityRecord(): Promise<Erc8004AgentIdentityRecord | null> {
  const expectedAgentId = process.env.ERC8004_VEYRA_AGENT_ID?.trim();
  if (!expectedAgentId) {
    return null;
  }
  return getAgentIdentityRecord(expectedAgentId);
}

export async function getCanonicalAgentIdentity(
  agentId: string,
  publicClient = getArcPublicClient()
): Promise<Erc8004AgentIdentityRecord | null> {
  const dbRecord = await getAgentIdentityRecord(agentId);
  if (!dbRecord) {
    return null;
  }

  if (dbRecord.agent_id !== agentId) {
    throw new Erc8004IdentityVerificationError("Stored ERC-8004 agent identity does not match request", "record_mismatch");
  }
  if (dbRecord.chain_id !== arcTestnet.id) {
    throw new Erc8004IdentityVerificationError("Stored ERC-8004 identity has an unexpected chain ID", "record_mismatch");
  }
  if (dbRecord.registry_address.toLowerCase() !== ARC_ERC8004_IDENTITY_REGISTRY.toLowerCase()) {
    throw new Erc8004IdentityVerificationError("Stored ERC-8004 identity uses a non-canonical registry", "record_mismatch");
  }
  if (!isAddress(dbRecord.owner_address)) {
    throw new Erc8004IdentityVerificationError("Stored ERC-8004 identity owner is invalid", "record_mismatch");
  }
  if (
    !isHex(dbRecord.registration_tx) ||
    dbRecord.registration_tx.length !== 66 ||
    /^0x0{64}$/i.test(dbRecord.registration_tx)
  ) {
    throw new Erc8004IdentityVerificationError("Stored ERC-8004 identity has no real registration transaction", "registration_tx_invalid");
  }

  try {
    const numericAgentId = BigInt(agentId);
    const onchain = await fetchAgentIdentityOnchain(
      numericAgentId,
      ARC_ERC8004_IDENTITY_REGISTRY,
      publicClient
    );
    if (onchain.owner.toLowerCase() !== dbRecord.owner_address.toLowerCase()) {
      throw new Erc8004IdentityVerificationError("ERC-8004 ownerOf does not match the stored owner", "owner_mismatch");
    }
    if (onchain.tokenURI !== dbRecord.metadata_uri) {
      throw new Erc8004IdentityVerificationError("ERC-8004 tokenURI does not match stored metadata", "metadata_mismatch");
    }

    const receipt = await publicClient.getTransactionReceipt({
      hash: dbRecord.registration_tx as Hex,
    });
    if (
      receipt.status !== "success" ||
      receipt.to?.toLowerCase() !== ARC_ERC8004_IDENTITY_REGISTRY.toLowerCase()
    ) {
      throw new Erc8004IdentityVerificationError("ERC-8004 registration transaction is not canonical", "registration_not_canonical");
    }

    const mintLogs = parseEventLogs({
      abi: [TRANSFER_EVENT],
      eventName: "Transfer",
      logs: receipt.logs,
      strict: true,
    });
    const exactMint = mintLogs.find(
      (log) =>
        log.address.toLowerCase() === ARC_ERC8004_IDENTITY_REGISTRY.toLowerCase() &&
        log.args.from?.toLowerCase() === zeroAddress &&
        log.args.to?.toLowerCase() === dbRecord.owner_address.toLowerCase() &&
        log.args.tokenId === numericAgentId
    );
    if (!exactMint) {
      throw new Erc8004IdentityVerificationError(
        "ERC-8004 registration receipt does not contain the exact mint event",
        "mint_event_missing",
      );
    }
  } catch (error) {
    if (error instanceof Erc8004IdentityVerificationError) throw error;
    // Arc Testnet has dropped historical transactions before while keeping
    // contract state intact. Losing the receipt is an availability failure, not
    // evidence of tampering, and collapsing both into one opaque message made
    // the difference impossible to see in production logs.
    const name = error instanceof Error ? error.name : "";
    const unavailable = name === "TransactionReceiptNotFoundError"
      || name === "TransactionNotFoundError"
      || name === "BlockNotFoundError";
    throw new Erc8004IdentityVerificationError(
      unavailable
        ? "ERC-8004 registration history is not available from the Arc RPC"
        : `ERC-8004 onchain identity verification failed (${name || "unknown_error"})`,
      unavailable ? "chain_history_unavailable" : "onchain_verification_failed",
      { cause: error },
    );
  }

  return dbRecord;
}

export async function getCanonicalVeyraAgentIdentity(
  publicClient = getArcPublicClient()
): Promise<Erc8004AgentIdentityRecord | null> {
  const expectedAgentId = process.env.ERC8004_VEYRA_AGENT_ID?.trim();
  if (!expectedAgentId) {
    return null;
  }
  return getCanonicalAgentIdentity(expectedAgentId, publicClient);
}

/**
 * Fetch onchain owner and tokenURI for a given ERC-8004 agentId from IdentityRegistry.
 */
export async function fetchAgentIdentityOnchain(
  agentId: bigint,
  registryAddress: string = ARC_ERC8004_IDENTITY_REGISTRY,
  client = getArcPublicClient()
) {
  const contract = getContract({
    address: registryAddress as `0x${string}`,
    abi: [
      {
        name: "ownerOf",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "tokenId", type: "uint256" }],
        outputs: [{ name: "", type: "address" }],
      },
      {
        name: "tokenURI",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "tokenId", type: "uint256" }],
        outputs: [{ name: "", type: "string" }],
      },
    ],
    client,
  });

  const [owner, tokenURI] = await Promise.all([
    contract.read.ownerOf([agentId]),
    contract.read.tokenURI([agentId]),
  ]);

  return { owner, tokenURI };
}

/**
 * Reads validation status from Arc ValidationRegistry.
 */
export async function fetchValidationStatusOnchain(
  requestHash: `0x${string}`,
  registryAddress = ARC_ERC8004_VALIDATION_REGISTRY,
  client = getArcPublicClient()
): Promise<Erc8004ValidationStatus> {
  const contract = getContract({
    address: registryAddress as `0x${string}`,
    abi: [
      {
        name: "getValidationStatus",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "requestHash", type: "bytes32" }],
        outputs: [
          { name: "validatorAddress", type: "address" },
          { name: "agentId", type: "uint256" },
          { name: "response", type: "uint8" },
          { name: "responseHash", type: "bytes32" },
          { name: "tag", type: "string" },
          { name: "lastUpdate", type: "uint256" },
        ],
      },
    ],
    client,
  });

  const res = (await contract.read.getValidationStatus([requestHash])) as readonly [
    `0x${string}`,
    bigint,
    number,
    `0x${string}`,
    string,
    bigint,
  ];

  return {
    validatorAddress: res[0],
    agentId: res[1],
    response: res[2],
    responseHash: res[3],
    tag: res[4],
    lastUpdate: res[5],
  };
}

/**
 * Searches for minted Transfer events on IdentityRegistry to recover newly minted agentId for an owner address.
 */
export async function recoverAgentIdFromLogs(
  ownerAddress: `0x${string}`,
  registryAddress = ARC_ERC8004_IDENTITY_REGISTRY,
  client = getArcPublicClient(),
  options: { fromBlock?: bigint; toBlock?: bigint; expectedAgentId?: bigint } = {}
): Promise<Erc8004MintRecord | null> {
  if (!isAddress(ownerAddress) || registryAddress.toLowerCase() !== ARC_ERC8004_IDENTITY_REGISTRY.toLowerCase()) {
    throw new Erc8004IdentityVerificationError("Mint recovery requires a valid owner and official registry");
  }

  const currentBalance = await client.readContract({
    address: ARC_ERC8004_IDENTITY_REGISTRY,
    abi: [
      {
        name: "balanceOf",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "owner", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
      },
    ],
    functionName: "balanceOf",
    args: [ownerAddress],
  });
  if (currentBalance === BigInt(0)) {
    return null;
  }

  const latestBlock = options.toBlock ?? (await client.getBlockNumber());
  const floorBlock = options.fromBlock ?? BigInt(0);
  const chunkSize = BigInt(9_000);
  let toBlock = latestBlock;

  while (toBlock >= floorBlock) {
    const fromBlock = toBlock > chunkSize ? toBlock - chunkSize : floorBlock;
    const logs = await client.getLogs({
      address: registryAddress as `0x${string}`,
      event: TRANSFER_EVENT,
      args: { from: zeroAddress, to: ownerAddress },
      fromBlock: fromBlock < floorBlock ? floorBlock : fromBlock,
      toBlock,
    });

    const canonicalMints = logs.filter(
      (log) =>
        log.args.from?.toLowerCase() === zeroAddress &&
        log.args.to?.toLowerCase() === ownerAddress.toLowerCase()
    );
    const exactLogs = options.expectedAgentId
      ? canonicalMints.filter((log) => log.args.tokenId === options.expectedAgentId)
      : canonicalMints;
    for (const mintLog of [...exactLogs].reverse()) {
      if (mintLog.args.tokenId === undefined || !mintLog.transactionHash || mintLog.blockNumber === null) {
        continue;
      }
      try {
        const currentOwner = await client.readContract({
          address: ARC_ERC8004_IDENTITY_REGISTRY,
          abi: [
            {
              name: "ownerOf",
              type: "function",
              stateMutability: "view",
              inputs: [{ name: "tokenId", type: "uint256" }],
              outputs: [{ name: "", type: "address" }],
            },
          ],
          functionName: "ownerOf",
          args: [mintLog.args.tokenId],
        });
        if (currentOwner.toLowerCase() !== ownerAddress.toLowerCase()) continue;
        return {
          agentId: mintLog.args.tokenId.toString(),
          transactionHash: mintLog.transactionHash,
          blockNumber: mintLog.blockNumber,
        };
      } catch {
        // Burned or otherwise invalid token; keep searching older canonical mints.
      }
    }

    if (fromBlock <= floorBlock) break;
    toBlock = fromBlock - BigInt(1);
  }

  return null;
}
