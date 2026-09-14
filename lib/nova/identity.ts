/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { createPublicClient, http, getAddress, parseAbiItem } from "viem";
import { arcTestnet } from "viem/chains";
import { ARC_ERC8004_IDENTITY_REGISTRY } from "../erc8004/types.ts";

/**
 * Nova's identity on Arc.
 *
 * The shape matters more than the code here, because the obvious model is
 * wrong. An ERC-8004 identity is not an address: it is an ERC-721 token, and
 * the pair (identity registry, agentId) is what names the agent. The address
 * holding that token is a separate role, and the standard keeps a third thing
 * apart again -- an operational agentWallet that need not be the owner.
 *
 * Welding those together would have made a wallet change look like a different
 * agent. It is not. The owner is the field that moves; the pair is the field
 * that does not, and everything hanging off the agent -- its memory, its
 * history, its Arc attestations, its standing -- hangs off the pair.
 *
 * Four rules, and each is a thing this file deliberately does not do.
 *
 * The owner is the person. `register(metadataURI)` mints to its caller, so the
 * caller is the connected wallet and nobody else. Veyra does not mint Nova
 * identities to itself: an identity Veyra owned would be Veyra's agent lent
 * out, which is a different product and a worse one.
 *
 * No key is derived from the owner secret. That secret proves ownership of a
 * row; turning it into a signing key would make a recovery phrase into a
 * spending key, and quietly widen what losing it costs.
 *
 * The server never takes the client's word for a registration. A browser
 * reporting "I minted agent #482" is a claim; ownerOf(482) read from Arc is a
 * fact, and only the second is stored.
 *
 * The attester stays out of it. Veyra's key signs Veyra's own attestations and
 * has no part in owning, minting or transferring an identity.
 */

export const NOVA_IDENTITY_REGISTRY = ARC_ERC8004_IDENTITY_REGISTRY;
export const NOVA_IDENTITY_CHAIN_ID = 5_042_002;

/** register(string metadataURI) -- mints the identity NFT to msg.sender. */
export const IDENTITY_REGISTER_ABI = [
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [{ name: "metadataURI", type: "string" }],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

export type NovaArcIdentity = {
  /** Where the identity lives. With agentId, this is the identity. */
  registry: string;
  agentId: string;
  chainId: number;
  /** Who holds the token right now. Expected to change; the agent does not. */
  owner: string;
  /** The registration transaction, when it is known. */
  transaction: string | null;
  registeredAt: string;
};

export type IdentityClaimFailure =
  | "not_registered"
  | "wrong_owner"
  | "unreadable";

function arc() {
  return createPublicClient({
    chain: arcTestnet,
    transport: http(process.env.ARC_TESTNET_RPC_URL ?? arcTestnet.rpcUrls.default.http[0]),
  });
}

/**
 * Confirms a claimed registration against Arc before anything is stored.
 *
 * The browser says it minted an agent id; this reads ownerOf from the registry
 * and compares it to the wallet that claims to own it. A mismatch is refused
 * rather than recorded, because an identity row nobody verified is worth less
 * than no row: it would show a person a badge for an agent they do not own.
 */
export async function confirmIdentity(input: {
  agentId: string;
  expectedOwner: string;
  now?: Date;
}): Promise<{ ok: true; identity: NovaArcIdentity } | { ok: false; reason: IdentityClaimFailure }> {
  if (!/^\d{1,78}$/.test(input.agentId)) return { ok: false, reason: "not_registered" };
  let expected: string;
  try {
    expected = getAddress(input.expectedOwner);
  } catch {
    return { ok: false, reason: "wrong_owner" };
  }

  let owner: string;
  try {
    owner = await arc().readContract({
      address: NOVA_IDENTITY_REGISTRY,
      abi: IDENTITY_REGISTER_ABI,
      functionName: "ownerOf",
      args: [BigInt(input.agentId)],
    }) as string;
  } catch {
    /* An unminted token reverts, and so does an RPC that is having a bad day.
       Neither is a registration, and neither is treated as one. */
    return { ok: false, reason: "unreadable" };
  }

  if (getAddress(owner) !== expected) return { ok: false, reason: "wrong_owner" };

  return {
    ok: true,
    identity: {
      registry: NOVA_IDENTITY_REGISTRY,
      agentId: input.agentId,
      chainId: NOVA_IDENTITY_CHAIN_ID,
      owner: expected,
      transaction: null,
      registeredAt: (input.now ?? new Date()).toISOString(),
    },
  };
}

/**
 * The agent id minted to an address by a given transaction.
 *
 * Read from the Transfer log rather than trusted from the caller, and filtered
 * to the registry and the recipient so a transaction that happens to contain
 * somebody else's mint cannot be claimed as this one.
 */
export async function agentIdFromTransaction(input: {
  transaction: string;
  owner: string;
}): Promise<string | null> {
  try {
    const receipt = await arc().getTransactionReceipt({ hash: input.transaction as `0x${string}` });
    if (receipt.status !== "success") return null;
    const owner = getAddress(input.owner);
    const transfer = parseAbiItem(
      "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
    );
    for (const log of receipt.logs) {
      if (getAddress(log.address) !== getAddress(NOVA_IDENTITY_REGISTRY)) continue;
      if (log.topics[0] !== "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef") continue;
      /* topics[2] is the indexed recipient; topics[3] the token id. */
      const to = log.topics[2] ? getAddress(`0x${log.topics[2].slice(26)}`) : null;
      if (to !== owner) continue;
      if (!log.topics[3]) continue;
      return BigInt(log.topics[3]).toString();
    }
    void transfer;
    return null;
  } catch {
    return null;
  }
}

/** The metadata a registration points at. Public by construction: it is quoted
 *  onchain, so nothing here may be anything the owner would not publish. */
export function agentCard(input: {
  name: string;
  publicId: string;
  createdAt: string;
  origin: string;
}) {
  return {
    name: input.name,
    description: `${input.name} is a personal research agent. It watches what its owner cares about, and every payment it makes is authorised by Veyra and signed by its owner.`,
    /* The product identity, which outlives any wallet and any token. */
    externalId: input.publicId,
    createdAt: input.createdAt,
    url: `${input.origin}/nova`,
    registrations: [
      { agentRegistry: `eip155:${NOVA_IDENTITY_CHAIN_ID}:${NOVA_IDENTITY_REGISTRY}` },
    ],
  };
}
