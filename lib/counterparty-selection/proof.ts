import {
  createWalletClient,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseUnits,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import {
  ARC_TESTNET_CHAIN_ID,
  proofRegistryAbi,
} from "../commerce/onchain-proof.ts";
import { fetchOnchainJob } from "../erc8183/client.ts";
import { getArcPublicClient } from "../erc8004/client.ts";
import { deriveSettledErc8183ValueUsdc } from "../reputation/erc8183-adapter.ts";
import { fetchReputationEvidenceForAgent } from "../reputation/db.ts";
import { getByoaClient } from "../byoa/service.ts";
import { fetchCounterpartySelection, saveSelectionProof } from "./db.ts";
import { CounterpartySelectionError } from "./service.ts";
import type { CounterpartySelection, SelectionProof, SelectionTenant } from "./types.ts";

function configuration() {
  const registry = process.env.AGENT_COMMERCE_PROOF_REGISTRY_ADDRESS;
  const key = (
    process.env.AGENT_COMMERCE_PROOF_ATTESTER_PRIVATE_KEY
    || process.env.AGENT_COMMERCE_PROOF_OPERATOR_PRIVATE_KEY
  )?.trim();
  if (!registry || !isAddress(registry) || !key || !/^0x[0-9a-f]{64}$/i.test(key)) {
    throw new CounterpartySelectionError("proof_unavailable", 503);
  }
  const account = privateKeyToAccount(key as Hex);
  const expected = process.env.AGENT_COMMERCE_PROOF_ATTESTER_ADDRESS;
  if (expected && (!isAddress(expected) || getAddress(expected) !== getAddress(account.address))) {
    throw new CounterpartySelectionError("proof_unavailable", 503);
  }
  return {
    registry: getAddress(registry),
    account,
    rpcUrl: process.env.ARC_TESTNET_RPC_URL || arcTestnet.rpcUrls.default.http[0],
  };
}

type EconomicEvidenceProvenance = {
  source: "erc8183_job";
  sourceId: string;
  amountUsdc: number;
  amountAtomic: bigint;
  transactionHash: Hex;
  buyer: Address;
  seller: Address;
};

async function resolveEconomicEvidence(
  selection: CounterpartySelection,
  publicClient: ReturnType<typeof getArcPublicClient>,
): Promise<EconomicEvidenceProvenance> {
  const evidence = (await fetchReputationEvidenceForAgent(selection.recommendedAgentId))
    .filter((item) =>
      item.type === "erc8183_job_completed"
      && item.positive
      && item.verifiedOnchain
      && item.arcProofVerified
      && Number(item.economicValueUsdc || 0) > 0
      && /^\d+$/.test(item.sourceId))
    .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt));
  for (const item of evidence) {
    const evaluation = await getByoaClient()
      .from("erc8183_evaluations")
      .select("agentic_commerce,job_id,settlement_tx_hash,status,decision")
      .eq("job_id", item.sourceId)
      .eq("status", "completed")
      .eq("decision", "complete")
      .maybeSingle();
    if (evaluation.error || !evaluation.data
      || !isAddress(evaluation.data.agentic_commerce)
      || !/^0x[0-9a-f]{64}$/i.test(evaluation.data.settlement_tx_hash || "")) continue;
    try {
      const [job, receipt] = await Promise.all([
        fetchOnchainJob(evaluation.data.agentic_commerce, BigInt(item.sourceId), publicClient),
        publicClient.getTransactionReceipt({ hash: evaluation.data.settlement_tx_hash as Hex }),
      ]);
      if (receipt.status !== "success"
        || job.status !== "Completed"
        || job.provider.toLowerCase() !== selection.recommendedWallet.toLowerCase()) continue;
      const amountUsdc = deriveSettledErc8183ValueUsdc({
        job,
        receipt,
        commerceAddress: evaluation.data.agentic_commerce,
      });
      if (!(amountUsdc > 0)) continue;
      return {
        source: "erc8183_job",
        sourceId: item.sourceId,
        amountUsdc: Number(amountUsdc.toFixed(6)),
        amountAtomic: parseUnits(amountUsdc.toFixed(6), 6),
        transactionHash: evaluation.data.settlement_tx_hash as Hex,
        buyer: getAddress(job.client),
        seller: getAddress(job.provider),
      };
    } catch {
      // Fail closed and try another already-persisted real execution record.
    }
  }
  throw new Error("proof_economic_provenance_unavailable");
}

function expectedProof(selection: CounterpartySelection, provenance: EconomicEvidenceProvenance) {
  return {
    receiptId: selection.canonicalHash,
    serviceHash: keccak256(toBytes(
      `veyra-counterparty-selection:${selection.capability}:${selection.recommendedServiceId || "identity"}:${provenance.source}:${provenance.sourceId}`,
    )),
    buyer: provenance.buyer,
    seller: provenance.seller,
    amount: provenance.amountAtomic,
    requestHash: selection.taskHash,
    responseHash: selection.canonicalHash,
  };
}

function proofMatches(
  expected: ReturnType<typeof expectedProof>,
  actual: readonly [Hex, Address, Address, bigint, Hex, Hex, bigint],
) {
  return actual[0].toLowerCase() === expected.serviceHash.toLowerCase()
    && actual[1].toLowerCase() === expected.buyer.toLowerCase()
    && actual[2].toLowerCase() === expected.seller.toLowerCase()
    && actual[3] === expected.amount
    && actual[4].toLowerCase() === expected.requestHash.toLowerCase()
    && actual[5].toLowerCase() === expected.responseHash.toLowerCase();
}

async function findProofLog(input: {
  client: ReturnType<typeof getArcPublicClient>;
  registry: Address;
  receiptId: Hex;
}) {
  const latest = await input.client.getBlockNumber();
  const configured = process.env.AGENT_COMMERCE_PROOF_REGISTRY_DEPLOYMENT_BLOCK;
  const lookback = BigInt(100_000);
  const fromBlock = configured && /^\d+$/.test(configured)
    ? BigInt(configured)
    : latest > lookback ? latest - lookback : BigInt(0);
  const logs = await input.client.getLogs({
    address: input.registry,
    event: proofRegistryAbi[3],
    args: { receiptId: input.receiptId },
    fromBlock,
    toBlock: "latest",
  });
  return logs.at(-1) || null;
}

export async function publishCounterpartySelectionProof(input: {
  selectionId: string;
  tenant: SelectionTenant;
}) {
  const selection = await fetchCounterpartySelection(input.selectionId, input.tenant);
  if (!selection) throw new CounterpartySelectionError("selection_not_found", 404);
  if (selection.proof) return { proof: selection.proof, replayed: true, chargedUsdc: 0, jobCreated: false };

  const { registry, account, rpcUrl } = configuration();
  const publicClient = getArcPublicClient(rpcUrl);
  try {
    const [chainId, code, authorized] = await Promise.all([
      publicClient.getChainId(),
      publicClient.getCode({ address: registry }),
      publicClient.readContract({
        address: registry,
        abi: proofRegistryAbi,
        functionName: "isAttester",
        args: [account.address],
      }),
    ]);
    if (chainId !== ARC_TESTNET_CHAIN_ID || !code || code === "0x" || !authorized) {
      throw new Error("proof_registry_preflight_failed");
    }
    const provenance = await resolveEconomicEvidence(selection, publicClient);
    const expected = expectedProof(selection, provenance);
    const registered = await publicClient.readContract({
      address: registry,
      abi: proofRegistryAbi,
      functionName: "isRegistered",
      args: [expected.receiptId],
    });
    let transactionHash: Hex;
    let blockNumber: bigint;
    if (registered) {
      const actual = await publicClient.readContract({
        address: registry,
        abi: proofRegistryAbi,
        functionName: "getProof",
        args: [expected.receiptId],
      });
      if (!proofMatches(expected, actual)) throw new Error("proof_payload_mismatch");
      const log = await findProofLog({ client: publicClient, registry, receiptId: expected.receiptId });
      if (!log?.transactionHash || !log.blockNumber) throw new Error("proof_transaction_not_found");
      transactionHash = log.transactionHash;
      blockNumber = log.blockNumber;
    } else {
      const { request } = await publicClient.simulateContract({
        account,
        address: registry,
        abi: proofRegistryAbi,
        functionName: "registerProof",
        args: [
          expected.receiptId,
          expected.serviceHash,
          expected.buyer,
          expected.seller,
          expected.amount,
          expected.requestHash,
          expected.responseHash,
        ],
      });
      const walletClient = createWalletClient({ account, chain: arcTestnet, transport: http(rpcUrl) });
      transactionHash = await walletClient.writeContract(request);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: transactionHash });
      if (receipt.status !== "success") throw new Error("proof_transaction_reverted");
      blockNumber = receipt.blockNumber;
      const actual = await publicClient.readContract({
        address: registry,
        abi: proofRegistryAbi,
        functionName: "getProof",
        args: [expected.receiptId],
      });
      if (!proofMatches(expected, actual)) throw new Error("proof_payload_mismatch");
    }
    const proof: SelectionProof = {
      proofTx: transactionHash,
      blockNumber: Number(blockNumber),
      proofStatus: "verified",
      evidenceSource: provenance.source,
      evidenceSourceId: provenance.sourceId,
      evidenceAmountUsdc: provenance.amountUsdc,
      evidenceTx: provenance.transactionHash,
    };
    return {
      proof: await saveSelectionProof({
        selectionId: selection.selectionId,
        canonicalHash: selection.canonicalHash,
        proof,
      }),
      replayed: registered,
      chargedUsdc: 0,
      jobCreated: false,
      evidenceReused: true,
    };
  } catch (error) {
    console.error("counterparty_selection_proof_failed", {
      selectionId: selection.selectionId,
      errorCode: error instanceof Error && /^[a-z0-9_]{3,80}$/i.test(error.message)
        ? error.message
        : error instanceof Error ? error.name : "unknown_error",
    });
    throw new CounterpartySelectionError("proof_unavailable", 503);
  }
}
