/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { createPublicClient, createWalletClient, http, keccak256, toBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { proofRegistryAbi } from "../commerce/onchain-proof.ts";
import { fetchReputationEvidenceForAgent, saveReputationSnapshot } from "./db.ts";
import { computeAgentReputation, createReputationSnapshot } from "./engine.ts";
import type { CanonicalAgentIdentity, EconomicProvenance, ReputationSnapshot } from "./types.ts";
import { prepareEconomicProvenance } from "./economic-provenance.ts";

const PROOF_REGISTRY_ADDRESS = (process.env.AGENT_COMMERCE_PROOF_REGISTRY_ADDRESS || "0x0db0b8ddc03c3c56c0662b547822e4654167b684") as `0x${string}`;

export async function generateAndSaveReputationSnapshot(
  identity: CanonicalAgentIdentity,
  arcProofTx?: string
): Promise<ReputationSnapshot> {
  const evidenceList = await fetchReputationEvidenceForAgent(identity.agentId);
  const explanation = computeAgentReputation(identity, evidenceList);
  const snapshot = createReputationSnapshot(identity, evidenceList, explanation, arcProofTx);

  await saveReputationSnapshot(snapshot);
  return snapshot;
}

export async function publishReputationSnapshotProofToArc(
  snapshot: ReputationSnapshot,
  identityOwner?: string,
  attesterKeyOverride?: string,
  economicValueUsdc?: number,
  provenance?: EconomicProvenance
): Promise<{ transactionHash: string | null; blockNumber: number; verifiedOnchain: boolean; proofAlreadyRegistered?: boolean; proofStatus?: string }> {
  const rpcUrl = process.env.ARC_TESTNET_RPC_URL || "https://rpc.testnet.arc.network";
  const publicClient = createPublicClient({
    chain: arcTestnet,
    transport: http(rpcUrl),
  });

  const receiptId = snapshot.canonicalHash as Hex;
  const serviceHash = keccak256(toBytes("veyra.reputation.snapshot.v1"));

  // If no real economic provenance, skip commerce proof registration entirely.
  // Never fabricate synthetic buyer/seller/amount.
  const preparedProvenance = prepareEconomicProvenance(provenance, economicValueUsdc);
  if (!preparedProvenance) {
    console.log("[reputation-proof] No economic provenance — skipping commerce proof registration");
    return {
      transactionHash: null,
      blockNumber: 0,
      verifiedOnchain: false,
      proofStatus: "no_economic_provenance",
    };
  }

  const buyer = preparedProvenance.buyer;
  const seller = preparedProvenance.seller;
  const amount = preparedProvenance.amountAtomic;

  const requestHash = keccak256(toBytes(snapshot.agentId));
  const responseHash = snapshot.canonicalHash as Hex;

  // 1. Check if proof is already registered onchain
  try {
    const isRegistered = await publicClient.readContract({
      address: PROOF_REGISTRY_ADDRESS,
      abi: proofRegistryAbi,
      functionName: "isRegistered",
      args: [receiptId],
    });

    if (isRegistered) {
      const [, , , , , respHash] = await publicClient.readContract({
        address: PROOF_REGISTRY_ADDRESS,
        abi: proofRegistryAbi,
        functionName: "getProof",
        args: [receiptId],
      });

      if (respHash.toLowerCase() !== snapshot.canonicalHash.toLowerCase()) {
        return {
          transactionHash: null,
          blockNumber: 0,
          verifiedOnchain: false,
          proofAlreadyRegistered: true,
        };
      }

      let logs: any[] = [];
      try {
        const currentBlock = await publicClient.getBlockNumber();
        const fromBlock = currentBlock > BigInt(9000) ? currentBlock - BigInt(9000) : BigInt(0);
        logs = await publicClient.getLogs({
          address: PROOF_REGISTRY_ADDRESS,
          event: proofRegistryAbi[3],
          args: { receiptId },
          fromBlock,
          toBlock: "latest",
        });
      } catch {
        logs = [];
      }

      const logTxHash = logs.at(-1)?.transactionHash;
      const isValidLogTx = logTxHash && /^0x[0-9a-fA-F]{64}$/.test(logTxHash) && logTxHash.toLowerCase() !== receiptId.toLowerCase();
      const storedTxHash = snapshot.arcProofTx && /^0x[0-9a-fA-F]{64}$/.test(snapshot.arcProofTx) && snapshot.arcProofTx.toLowerCase() !== receiptId.toLowerCase() ? snapshot.arcProofTx : null;
      
      const realTxHash = isValidLogTx ? logTxHash : storedTxHash;
      let blockNum = logs.at(-1)?.blockNumber ? Number(logs.at(-1)!.blockNumber) : 0;

      if (realTxHash) {
        try {
          const receipt = await publicClient.getTransactionReceipt({ hash: realTxHash as `0x${string}` });
          if (receipt.status === "success") {
            blockNum = Number(receipt.blockNumber);
            snapshot.arcProofTx = realTxHash;
            await saveReputationSnapshot(snapshot);
            return {
              transactionHash: realTxHash,
              blockNumber: blockNum,
              verifiedOnchain: true,
              proofAlreadyRegistered: true,
            };
          }
        } catch {}
      }

      return {
        transactionHash: realTxHash || null,
        blockNumber: blockNum,
        verifiedOnchain: true,
        proofAlreadyRegistered: true,
      };
    }
  } catch (err) {
    console.warn("[reputation-proof] Read contract check warning:", err);
  }

  // 2. Register proof onchain if not yet registered
  const privateKey = (
    attesterKeyOverride ||
    process.env.AGENT_COMMERCE_PROOF_ATTESTER_PRIVATE_KEY ||
    process.env.AGENT_COMMERCE_PROOF_OPERATOR_PRIVATE_KEY ||
    process.env.CANARY_DEPLOYER_PRIVATE_KEY ||
    process.env.VEYRA_EVALUATOR_ATTESTER_PRIVATE_KEY ||
    process.env.ERC8183_EVALUATOR_ATTESTER_PRIVATE_KEY ||
    process.env.BUYER_PRIVATE_KEY
  )?.trim() as `0x${string}`;

  if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("Missing valid attester private key to register Arc Proof");
  }

  const account = privateKeyToAccount(privateKey);
  const walletClient = createWalletClient({
    account,
    chain: arcTestnet,
    transport: http(rpcUrl),
  });

  try {
    const txHash = await walletClient.writeContract({
      address: PROOF_REGISTRY_ADDRESS,
      abi: proofRegistryAbi,
      functionName: "registerProof",
      args: [receiptId, serviceHash, buyer, seller, amount, requestHash, responseHash],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      throw new Error(`Proof registration transaction reverted: ${txHash}`);
    }

    snapshot.arcProofTx = txHash;
    await saveReputationSnapshot(snapshot);

    return {
      transactionHash: txHash,
      blockNumber: Number(receipt.blockNumber),
      verifiedOnchain: true,
    };
  } catch (err: any) {
    if (err?.message?.includes("0xa53006da") || err?.message?.includes("DuplicateReceipt")) {
      return {
        transactionHash: snapshot.arcProofTx && /^0x[0-9a-fA-F]{64}$/.test(snapshot.arcProofTx) ? snapshot.arcProofTx : null,
        blockNumber: 0,
        verifiedOnchain: true,
        proofAlreadyRegistered: true,
      };
    }
    throw err;
  }
}
