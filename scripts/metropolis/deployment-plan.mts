import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { encodeDeployData, formatEther, getAddress, getContractAddress, isAddress, keccak256,
  parseEther, zeroAddress, type Abi, type Address, type Hex } from "viem";
import { getMonadReadClient } from "../../lib/monad/erc8004.ts";

// Public-client reads and unsigned data only. No key loading, signing or broadcast.
const gateConstructor = [{ type: "constructor", inputs: [
  { name: "initialAdmin", type: "address" }, { name: "initialAttester", type: "address" },
], stateMutability: "nonpayable" }] as const;
type Client = ReturnType<typeof getMonadReadClient>;
export type DeploymentRoles = { sender: Address; admin: Address; attester: Address };

export function parseDeploymentRoles(args: string[]): DeploymentRoles {
  const values = new Map<string, Address>();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    const value = args[i + 1];
    if (!["--sender", "--admin", "--attester"].includes(name) || values.has(name)
      || !value || !isAddress(value, { strict: true }) || getAddress(value) === zeroAddress) {
      throw new Error("Provide only --sender, --admin and --attester, each with a nonzero public address.");
    }
    values.set(name, getAddress(value));
  }
  if (values.size !== 3) throw new Error("All three public addresses are required.");
  return { sender: values.get("--sender")!, admin: values.get("--admin")!, attester: values.get("--attester")! };
}

export async function planTrustGateDeployment(roles: DeploymentRoles, bytecode: Hex, client: Client = getMonadReadClient()) {
  // Reject mainnet before estimation; selecting a chain in the SDK is not RPC verification.
  if (client.chain.id !== 10143 || await client.getChainId() !== 10143) throw new Error("Deployment planning supports Monad Testnet 10143 only.");
  for (const value of Object.values(roles)) {
    if (!isAddress(value, { strict: true }) || value === zeroAddress) throw new Error("Invalid deployment role address.");
  }
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(bytecode)) throw new Error("Compile TrustGate before planning its deployment.");
  const [nonce, pendingNonce, balance, senderCode, attesterCode, block, fees] = await Promise.all([
    client.getTransactionCount({ address: roles.sender, blockTag: "latest" }),
    client.getTransactionCount({ address: roles.sender, blockTag: "pending" }),
    client.getBalance({ address: roles.sender, blockTag: "latest" }),
    client.getCode({ address: roles.sender }), client.getCode({ address: roles.attester }),
    client.getBlock({ blockTag: "latest" }), client.estimateFeesPerGas(),
  ]);
  if (nonce !== pendingNonce) throw new Error("Sender has pending transactions; resolve them before predicting a CREATE address.");
  if ((senderCode && senderCode !== "0x") || (attesterCode && attesterCode !== "0x")) {
    throw new Error("This prototype requires an EOA deployer and ECDSA attester.");
  }
  if (fees.maxFeePerGas <= 0n || fees.maxPriorityFeePerGas < 0n || fees.maxPriorityFeePerGas > fees.maxFeePerGas) {
    throw new Error("Invalid RPC fee estimate.");
  }
  const data = encodeDeployData({ abi: gateConstructor, bytecode, args: [roles.admin, roles.attester] });
  const predictedAddress = getContractAddress({ from: roles.sender, nonce: BigInt(nonce) });
  const predictedCode = await client.getCode({ address: predictedAddress });
  if (predictedCode && predictedCode !== "0x") throw new Error("Predicted deployment address already has code.");
  // A balance override changes only simulated state. It does not fund the sender.
  const estimationBalance = balance > parseEther("1") ? balance : parseEther("1");
  const estimatedGas = await client.estimateGas({ account: roles.sender, data, value: 0n,
    maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    stateOverride: [{ address: roles.sender, balance: estimationBalance }],
  });
  const gas = estimatedGas + (estimatedGas + 19n) / 20n; // Explicit 5% buffer; Monad charges on the limit.
  if (estimatedGas <= 0n || gas > 30_000_000n) throw new Error("Deployment exceeds the reviewed transaction gas limit.");
  const maximumFee = gas * fees.maxFeePerGas;
  return {
    summary: { network: "Monad Testnet", chainId: 10143, contract: "VeyraTrustGate", ...roles,
      predictedAddress, nonce, estimatedGas: estimatedGas.toString(), gasLimit: gas.toString(),
      maxFeePerGasWei: fees.maxFeePerGas.toString(), maximumFeeMon: formatEther(maximumFee),
      senderBalanceMon: formatEther(balance), requiresFunding: balance < maximumFee,
      estimationUsedBalanceOverride: estimationBalance !== balance, usdcSpent: "0", nativeValueMon: "0",
      blockNumber: block.number?.toString(), blockHash: block.hash,
      creationBytecodeHash: keccak256(bytecode), deploymentDataHash: keccak256(data),
      approvalStatus: "not authorized; no transaction signed or sent",
      note: "Recheck sender, nonce, balance, gas and fees immediately before a separately approved deployment." },
    transaction: { chainId: 10143, from: roles.sender, nonce, value: "0", data,
      gas: gas.toString(), maxFeePerGas: fees.maxFeePerGas.toString(),
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(), type: "eip1559" },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const roles = parseDeploymentRoles(process.argv.slice(2));
    const artifact = JSON.parse(readFileSync(new URL("../../contracts/monad/out/VeyraTrustGate.sol/VeyraTrustGate.json", import.meta.url), "utf8")) as { abi: Abi; bytecode: { object: Hex } };
    const constructor = artifact.abi.find(item => item.type === "constructor");
    if (!constructor || constructor.type !== "constructor" || constructor.inputs.length !== 2
      || constructor.inputs.some(input => input.type !== "address")) throw new Error("Unexpected TrustGate constructor ABI.");
    console.log(JSON.stringify(await planTrustGateDeployment(roles, artifact.bytecode.object), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Deployment planning failed.");
    process.exitCode = 1;
  }
}
