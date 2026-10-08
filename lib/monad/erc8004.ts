import { createPublicClient, erc20Abi, http, parseAbi, zeroAddress, type Address } from "viem";
import { monadDemoTestnet, monadReadOnlyMainnet, MONAD_CONTRACTS } from "./config.ts";

export const MONAD_IDENTITY_ABI = parseAbi([
  "function ownerOf(uint256 agentId) view returns (address)",
  "function tokenURI(uint256 agentId) view returns (string)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
]);
export const MONAD_REPUTATION_ABI = parseAbi([
  "function getIdentityRegistry() view returns (address)",
  "function getSummary(uint256 agentId,address[] clientAddresses,string tag1,string tag2) view returns (uint64 count,int128 summaryValue,uint8 summaryValueDecimals)",
]);
export function getMonadReadClient(chainId:10143|143 = 10143, rpcUrl?: string) {
  return createPublicClient({chain:chainId === 10143 ? monadDemoTestnet : monadReadOnlyMainnet,
    transport:http(rpcUrl,{timeout:15_000,retryCount:1})});
}

export async function verifyMonadInfrastructure(client = getMonadReadClient(), commitment: "latest" | "finalized" = "latest") {
  const chainId = client.chain.id;
  const actualChainId = await client.getChainId();
  if (actualChainId !== chainId || (chainId !== 10143 && chainId !== 143)) throw new Error("Monad RPC chain mismatch");
  const contracts = MONAD_CONTRACTS[chainId];
  const blockNumber = commitment === "finalized"
    ? (await client.getBlock({ blockTag: "finalized" })).number : await client.getBlockNumber();
  if (blockNumber === null) throw new Error("Monad RPC did not return a finalized block number");
  const code = await Promise.all(Object.values(contracts).map(address => client.getCode({address,blockNumber})));
  if (code.some(bytes => !bytes || bytes === "0x")) throw new Error("Canonical Monad contract has no code");
  const [decimals, linkedIdentity] = await Promise.all([
    client.readContract({address:contracts.usdc,abi:erc20Abi,functionName:"decimals",blockNumber}),
    client.readContract({address:contracts.reputationRegistry,abi:MONAD_REPUTATION_ABI,functionName:"getIdentityRegistry",blockNumber}),
  ]);
  if (decimals !== 6 || linkedIdentity.toLowerCase() !== contracts.identityRegistry.toLowerCase()) {
    throw new Error("Monad token or registry configuration mismatch");
  }
  return {chainId,blockNumber,contracts};
}

/** Read canonical identity; do not confuse owner, payee or an identity NFT with trust. */
export async function readMonadAgentIdentity(agentId: bigint, client = getMonadReadClient(), commitment: "latest" | "finalized" = "latest") {
  if (agentId <= BigInt(0)) throw new Error("Invalid ERC-8004 agent ID");
  const {chainId,blockNumber,contracts} = await verifyMonadInfrastructure(client, commitment);
  const [owner,wallet,tokenURI] = await Promise.all([
    client.readContract({address:contracts.identityRegistry,abi:MONAD_IDENTITY_ABI,functionName:"ownerOf",args:[agentId],blockNumber}),
    client.readContract({address:contracts.identityRegistry,abi:MONAD_IDENTITY_ABI,functionName:"getAgentWallet",args:[agentId],blockNumber}),
    client.readContract({address:contracts.identityRegistry,abi:MONAD_IDENTITY_ABI,functionName:"tokenURI",args:[agentId],blockNumber}),
  ]);
  if (owner === zeroAddress || wallet === zeroAddress) throw new Error("Agent has no canonical owner or payment wallet");
  return {chainId,registry:contracts.identityRegistry,agentId,owner,paymentWallet:wallet,tokenURI,blockNumber};
}

/** Client addresses must be selected by a provenance policy, never pooled as a fake 0–100 score. */
export async function readMonadFeedbackSummary(agentId:bigint,clients:Address[],tag1:string,tag2:string,client = getMonadReadClient()) {
  if (agentId <= BigInt(0) || clients.length === 0 || clients.some(address => address === zeroAddress)
    || new Set(clients.map(address => address.toLowerCase())).size !== clients.length) {
    throw new Error("Feedback summary requires an agent and explicit client provenance");
  }
  const {chainId,blockNumber,contracts} = await verifyMonadInfrastructure(client);
  const [count,value,valueDecimals] = await client.readContract({address:contracts.reputationRegistry,
    abi:MONAD_REPUTATION_ABI,functionName:"getSummary",args:[agentId,clients,tag1,tag2],blockNumber});
  return {chainId,blockNumber,count,value,valueDecimals,clients:[...clients],tag1,tag2};
}
