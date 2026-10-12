import { decodeEventLog, encodeEventTopics, encodeFunctionData, formatEther, getAddress, isAddress, keccak256, parseAbi, zeroAddress, type Address, type Hex } from "viem";
import { MONAD_CONTRACTS } from "./config.ts";
import { deepFreeze } from "./evidence.ts";
import { getMonadReadClient, MONAD_IDENTITY_ABI, verifyMonadInfrastructure } from "./erc8004.ts";
import { PaymentError } from "./payment.ts";
import { READINESS_SERVICE_ID, READINESS_SOURCES } from "./readiness.ts";

/** A registry read is an identity check, never a provider quality score. */
export async function readRegisteredReadinessAgent(agentId: bigint, blockNumber: bigint, client: Client = getMonadReadClient()) {
  if (client.chain.id !== 10143 || await client.getChainId() !== 10143 || agentId <= BigInt(0)) throw new PaymentError("Readiness identities support Monad Testnet only.");
  const address = MONAD_CONTRACTS[10143].identityRegistry;
  const [owner, wallet, tokenURI] = await Promise.all([
    client.readContract({ address, abi: MONAD_IDENTITY_ABI, functionName: "ownerOf", args: [agentId], blockNumber }),
    client.readContract({ address, abi: MONAD_IDENTITY_ABI, functionName: "getAgentWallet", args: [agentId], blockNumber }),
    client.readContract({ address, abi: MONAD_IDENTITY_ABI, functionName: "tokenURI", args: [agentId], blockNumber }),
  ]);
  return { owner, wallet, tokenURI };
}

// register(string) initializes both ERC-721 owner and canonical agentWallet to msg.sender.
// Source: erc-8004/erc-8004-contracts, contracts/IdentityRegistryUpgradeable.sol.
export const READINESS_REGISTRATION_ABI = parseAbi([
  "function register(string agentURI) returns(uint256 agentId)",
  "event Registered(uint256 indexed agentId,string agentURI,address indexed owner)",
  "event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)",
]);
export function readinessAgentCard() {
  return deepFreeze({
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "Veyra Monad Readiness — demonstration",
    description: "Veyra-created, operator-run Monad Testnet diagnostic. Checks a personal passkey account, deployed infrastructure, native P256 and budget funding at a finalized block. Free preview; not an independent audit or a Mainnet certification.",
    services: [], active: false, x402Support: false, supportedTrust: [], registrations: [],
    veyra: {
      serviceId: READINESS_SERVICE_ID, demonstration: true, controller: "Veyra development team",
      deliveryMode: "Local operator CLI; no hosted research or delivery API advertised.",
      commercialStatus: "Free readiness preview. A paid demonstration needs a separately approved actual interaction and result assessment.",
      policy: "Registration alone remains REVIEW_REQUIRED. No favorable feedback or prior delivery is claimed.",
      sources: READINESS_SOURCES,
    },
  });
}
export function readinessAgentUri(): string {
  // Self-contained immutable registration data: no unpublished endpoint or mutable hostname dependency.
  return `data:application/json;base64,${Buffer.from(JSON.stringify(readinessAgentCard()), "utf8").toString("base64")}`;
}
type Client = ReturnType<typeof getMonadReadClient>;
export async function planReadinessRegistration(sender: Address, client: Client = getMonadReadClient()) {
  if (!isAddress(sender, { strict: true }) || sender === zeroAddress) throw new PaymentError("Provide a nonzero public provider-owner address.");
  sender = getAddress(sender);
  if (client.chain.id !== 10143 || await client.getChainId() !== 10143) throw new PaymentError("Registration supports Monad Testnet 10143 only.");
  const infrastructure = await verifyMonadInfrastructure(client, "finalized");
  const registry = infrastructure.contracts.identityRegistry, agentURI = readinessAgentUri();
  const [nonce, pending, balance, code, fees, simulation] = await Promise.all([
    client.getTransactionCount({ address: sender, blockTag: "latest" }),
    client.getTransactionCount({ address: sender, blockTag: "pending" }),
    client.getBalance({ address: sender }), client.getCode({ address: sender }), client.estimateFeesPerGas(),
    client.simulateContract({ address: registry, abi: READINESS_REGISTRATION_ABI, functionName: "register", args: [agentURI], account: sender }),
  ]);
  if (nonce !== pending || code && code !== "0x") throw new PaymentError("The provider owner must be an EOA without pending transactions.");
  if (simulation.result <= BigInt(0)) throw new PaymentError("Registration did not return an agent ID in simulation.");
  if (fees.maxFeePerGas <= BigInt(0) || fees.maxPriorityFeePerGas < BigInt(0) || fees.maxPriorityFeePerGas > fees.maxFeePerGas) {
    throw new PaymentError("Invalid RPC fee estimate.");
  }
  const data = encodeFunctionData({ abi: READINESS_REGISTRATION_ABI, functionName: "register", args: [agentURI] });
  const estimatedGas = await client.estimateGas({ account: sender, to: registry, data, value: BigInt(0),
    maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
  const gas = estimatedGas + (estimatedGas + BigInt(19)) / BigInt(20), maximumFee = gas * fees.maxFeePerGas;
  if (estimatedGas <= BigInt(0) || gas > BigInt(2_000_000)) throw new PaymentError("Registration exceeds the reviewed gas ceiling.");
  if (balance < maximumFee) throw new PaymentError("The provider owner needs more MON for registration.");
  return deepFreeze({
    summary: { kind: "veyra.metropolis.readiness-registration-plan", version: 1, network: "Monad Testnet", chainId: 10143,
      registry, owner: sender, expectedPaymentWallet: sender, agentURI, metadata: readinessAgentCard(),
      observedFinalizedBlock: infrastructure.blockNumber.toString(), simulatedAgentId: simulation.result.toString(),
      idIsTentative: true, senderNonce: nonce, estimatedGas: estimatedGas.toString(), gasLimit: gas.toString(),
      maximumFeeMon: formatEther(maximumFee), callDataHash: keccak256(data), usdcSpent: "0", signed: false, broadcast: false,
      disclosures: ["This is a Veyra-created demonstration identity with no claimed reputation or delivery history.",
        "The simulated agent ID can change before execution; the Registered receipt determines the actual ID.",
        "The owner/payment wallet is excluded as a history payer or delivery reporter for this agent.",
        "A separate non-provider reporter and an actual paid interaction are required before a future clearance can become executable."],
    },
    transaction: { chainId: 10143, from: sender, to: registry, nonce, value: "0", data, type: "eip1559",
      gas: gas.toString(), maxFeePerGas: fees.maxFeePerGas.toString(), maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString() },
  });
}
export type ReadinessRegistrationPlan = Awaited<ReturnType<typeof planReadinessRegistration>>;

/** Verify a real receipt and current identity; simulation is never registration evidence. */
export async function verifyReadinessRegistrationReceipt(plan: ReadinessRegistrationPlan, hash: Hex, client: Client = getMonadReadClient()) {
  if (client.chain.id !== 10143 || await client.getChainId() !== 10143 || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new PaymentError("Provide a Monad Testnet registration transaction hash.");
  const registry = MONAD_CONTRACTS[10143].identityRegistry;
  const expectedData = encodeFunctionData({ abi: READINESS_REGISTRATION_ABI, functionName: "register", args: [readinessAgentUri()] });
  const expected = plan.transaction;
  if (expected.chainId !== 10143 || expected.to !== registry || expected.data !== expectedData || expected.value !== "0"
    || !isAddress(expected.from) || expected.from === zeroAddress) throw new PaymentError("Registration plan does not match this demonstration identity.");
  const [receipt, tx, finalized] = await Promise.all([client.getTransactionReceipt({ hash }), client.getTransaction({ hash }), client.getBlock({ blockTag: "finalized" })]);
  if (receipt.status !== "success" || receipt.transactionHash.toLowerCase() !== hash.toLowerCase()
    || finalized.number < receipt.blockNumber + BigInt(1)) throw new PaymentError("Registration failed or is not sufficiently finalized.");
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (block.number !== receipt.blockNumber || block.hash !== receipt.blockHash || tx.hash.toLowerCase() !== hash.toLowerCase()
    || tx.blockNumber !== receipt.blockNumber || tx.blockHash !== receipt.blockHash || tx.chainId !== 10143 || tx.to?.toLowerCase() !== registry.toLowerCase()
    || tx.from.toLowerCase() !== expected.from.toLowerCase() || tx.nonce !== expected.nonce || tx.value !== BigInt(0)
    || tx.input !== expectedData || tx.type !== "eip1559" || tx.gas <= BigInt(0) || tx.gas > BigInt(expected.gas)
    || tx.maxFeePerGas > BigInt(expected.maxFeePerGas) || tx.maxPriorityFeePerGas > BigInt(expected.maxPriorityFeePerGas)
    || receipt.effectiveGasPrice > BigInt(expected.maxFeePerGas)) {
    throw new PaymentError("Receipt is not the exact reviewed registration transaction.");
  }
  const identityLogs = receipt.logs.filter(log => log.address.toLowerCase() === registry.toLowerCase());
  if (identityLogs.some(log => log.removed || log.blockHash !== receipt.blockHash || log.blockNumber !== receipt.blockNumber
    || log.transactionHash.toLowerCase() !== hash.toLowerCase())) throw new PaymentError("Registration log provenance mismatch.");
  const eventTopics = [encodeEventTopics({ abi: READINESS_REGISTRATION_ABI, eventName: "Registered" })[0],
    encodeEventTopics({ abi: READINESS_REGISTRATION_ABI, eventName: "Transfer" })[0]];
  // Ignore other registry event kinds, but fail closed on a malformed recognized event.
  const events = identityLogs.filter(log => log.topics[0] !== undefined && eventTopics.includes(log.topics[0])).map(log =>
    decodeEventLog({ abi: READINESS_REGISTRATION_ABI, data: log.data, topics: log.topics }));
  const registered = events.filter(event => event.eventName === "Registered"), minted = events.filter(event => event.eventName === "Transfer");
  if (registered.length !== 1 || minted.length !== 1 || registered[0].eventName !== "Registered" || minted[0].eventName !== "Transfer") {
    throw new PaymentError("Registration needs one Registered event and one identity mint.");
  }
  const r = registered[0].args, m = minted[0].args;
  if (r.agentId <= BigInt(0) || r.owner.toLowerCase() !== expected.from.toLowerCase() || r.agentURI !== readinessAgentUri()
    || m.from !== zeroAddress || m.to.toLowerCase() !== expected.from.toLowerCase() || m.tokenId !== r.agentId) throw new PaymentError("The minted identity does not match the registration.");
  const identity = await readRegisteredReadinessAgent(r.agentId, finalized.number, client);
  if (identity.owner.toLowerCase() !== expected.from.toLowerCase() || identity.wallet.toLowerCase() !== expected.from.toLowerCase()
    || identity.tokenURI !== readinessAgentUri()) throw new PaymentError("Current identity owner, wallet or metadata differs from the registration.");
  return { kind: "veyra.metropolis.readiness-registration-receipt", version: 1, chainId: 10143, registry,
    agentId: r.agentId.toString(), owner: identity.owner, paymentWallet: identity.wallet, agentURI: identity.tokenURI,
    transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash,
    finalizedBlock: finalized.number.toString(), chargedGasMon: formatEther(tx.gas * receipt.effectiveGasPrice),
    demonstration: true, reputationEstablished: false, serviceDelivered: false };
}
