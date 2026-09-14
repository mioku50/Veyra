/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { createWalletClient, createPublicClient, http, keccak256, toBytes, concat } from "viem";
import { arcTestnet } from "viem/chains";
import {
  ARC_TESTNET_CHAIN_ID,
  configuredAttesterAccount,
  configuredExplorerUrl,
  configuredRegistryAddress,
  proofRegistryAbi,
} from "../commerce/onchain-proof.ts";

/**
 * Putting a Nova purchase on Arc.
 *
 * The Arc page told the truth and it was not a flattering one: Nova is not an
 * identity on Arc yet, and the registry that would record its work has been
 * deployed, verified and configured this whole time without a single Nova row
 * ever reaching it. Every verified purchase lived in Postgres, where Veyra is
 * the only witness -- which is the one arrangement a trust product cannot
 * defend, because the party making the claim also owns the record.
 *
 * So a purchase that passed its delivery check is written to the proof
 * registry on Arc: who paid, who was paid, how much, and the two hashes that
 * pin down what was asked and what came back. After that the claim stops being
 * Veyra's word. Anyone can read it from the chain and compare.
 *
 * Three rules.
 *
 * Only a verified purchase. A proof is a record of something that was checked,
 * and writing the unchecked ones would make the registry a log rather than
 * evidence.
 *
 * It cannot cost the purchase. Arc can be down, the attester can be unfunded,
 * the transaction can revert -- and none of that may take away a result
 * somebody already paid for. Every failure here returns null and the receipt
 * stands, exactly as a missing reading does.
 *
 * Veyra signs it, not the owner. The registry takes writes from an authorised
 * attester, so recording the history costs the person nothing and needs no
 * wallet on a second chain. What is being attested is Veyra's own verdict --
 * which is the thing Veyra is answerable for, and the reason it is the one
 * signing.
 */

export type NovaArcProof = {
  /** keccak256 of the execution id: the proof's key in the registry. */
  receiptId: `0x${string}`;
  transaction: `0x${string}`;
  chainId: number;
  registry: `0x${string}`;
  attester: `0x${string}`;
  explorerUrl: string;
  registeredAt: string;
};

/** What was asked, hashed the way the registry's other writers hash it. */
export function novaRequestHash(input: {
  method: string;
  resource: string;
  body: unknown;
}): `0x${string}` {
  const body = toBytes(JSON.stringify(input.body ?? {}));
  const context = toBytes(`${input.method}\n${input.resource}\n\n`);
  return keccak256(concat([context, body]));
}

export async function recordPurchaseOnArc(input: {
  executionPublicId: string;
  resource: string;
  buyer: string;
  seller: string;
  /** Atomic USDC actually paid. The registry rejects zero, and so should we. */
  amountAtomic: bigint;
  requestHash: `0x${string}`;
  responseHash: `0x${string}`;
  now?: Date;
}): Promise<NovaArcProof | null> {
  const registry = configuredRegistryAddress();
  const account = configuredAttesterAccount();
  if (!registry || !account) return null;
  if (input.amountAtomic <= BigInt(0)) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.buyer) || !/^0x[0-9a-fA-F]{40}$/.test(input.seller)) {
    return null;
  }

  const receiptId = keccak256(toBytes(input.executionPublicId));
  const serviceHash = keccak256(toBytes(input.resource));

  try {
    const transport = http(process.env.ARC_TESTNET_RPC_URL ?? arcTestnet.rpcUrls.default.http[0]);
    const publicClient = createPublicClient({ chain: arcTestnet, transport });

    /* Already there is success, not a collision. A retry after a timeout must
       not read as a failed purchase, and the registry rejects duplicates. */
    const registered = await publicClient.readContract({
      address: registry,
      abi: proofRegistryAbi,
      functionName: "isRegistered",
      args: [receiptId],
    }) as boolean;
    if (registered) return null;

    const { request } = await publicClient.simulateContract({
      account,
      address: registry,
      abi: proofRegistryAbi,
      functionName: "registerProof",
      args: [
        receiptId,
        serviceHash,
        input.buyer as `0x${string}`,
        input.seller as `0x${string}`,
        input.amountAtomic,
        input.requestHash,
        input.responseHash,
      ],
    });

    const wallet = createWalletClient({ account, chain: arcTestnet, transport });
    const transaction = await wallet.writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: transaction });
    if (receipt.status !== "success") return null;

    return {
      receiptId,
      transaction,
      chainId: ARC_TESTNET_CHAIN_ID,
      registry,
      attester: account.address,
      explorerUrl: `${configuredExplorerUrl()}/tx/${transaction}`,
      registeredAt: (input.now ?? new Date()).toISOString(),
    };
  } catch {
    /* A proof records something that already happened. Failing to record it
       changes nothing about what happened, and must not. */
    return null;
  }
}

/**
 * Publishes proofs for verified purchases that do not have one yet.
 *
 * Shared by the script and the internal route, because the environment that
 * holds the attester key is production and the environment a developer runs a
 * script in usually is not. One implementation, two ways to reach it.
 *
 * The response hash it commits to is the one verifyPostCall computed over the
 * bytes the endpoint actually sent, when the row kept it. Rows that settled
 * before that was stored have only the parsed result, so theirs is derived from
 * what Veyra retained; the row records which rule was used, since a proof whose
 * derivation is ambiguous is worse than one that says.
 */
export async function publishMissingArcProofs(input: {
  db: { from: (table: string) => any };
  limit?: number;
}): Promise<Array<{ executionPublicId: string; provider: string; published: boolean; explorerUrl?: string }>> {
  const { data } = await input.db.from("nova_research")
    .select("research_id, status, terms, request_body, request_method, payer_wallet, paid_usdc, execution_public_id, verification, result, arc_proof")
    .eq("status", "verified")
    .limit(input.limit ?? 25);

  const done: Array<{ executionPublicId: string; provider: string; published: boolean; explorerUrl?: string }> = [];
  for (const row of (data ?? []) as any[]) {
    if (row.arc_proof || !row.payer_wallet) continue;

    const stored = row.verification?.responseHash as string | undefined;
    const responseHash = (stored ?? keccak256(toBytes(
      typeof row.result === "string" ? row.result : JSON.stringify(row.result),
    ))) as `0x${string}`;

    const proof = await recordPurchaseOnArc({
      executionPublicId: row.execution_public_id ?? row.research_id,
      resource: row.terms.resource,
      buyer: row.payer_wallet,
      seller: row.terms.payTo,
      amountAtomic: BigInt(Math.round(Number(row.paid_usdc ?? 0) * 1_000_000)),
      requestHash: novaRequestHash({
        method: row.request_method ?? "POST",
        resource: row.terms.resource,
        body: row.request_body,
      }),
      responseHash,
    });

    const entry = {
      executionPublicId: row.execution_public_id ?? row.research_id,
      provider: row.terms?.provider ?? "unknown",
      published: Boolean(proof),
      explorerUrl: proof?.explorerUrl,
    };
    if (proof) {
      await input.db.from("nova_research")
        .update({ arc_proof: { ...proof, responseHashSource: stored ? "delivered_bytes" : "retained_result" } })
        .eq("research_id", row.research_id);
    }
    done.push(entry);
  }
  return done;
}
