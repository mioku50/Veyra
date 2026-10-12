import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { encodeAbiParameters, encodeDeployData, encodeFunctionData, formatEther, getAddress, getContractAddress,
  isAddress, keccak256, parseAbi, parseEther, toHex, zeroAddress, type Address, type Hex } from "viem";
import { METROPOLIS_DEPLOYMENT, METROPOLIS_FACTORY_ABI, METROPOLIS_V2_ACCOUNT_SALT, parseAccountSetup, readAccountSetup } from "../../lib/monad/account.ts";
import { getMonadReadClient } from "../../lib/monad/erc8004.ts";
import { parseAccountPlanArguments } from "./account-plan.mts";

// Public reads + unsigned data only. No key loading, signing, relaying or funding.
export { METROPOLIS_V2_ACCOUNT_SALT } from "../../lib/monad/account.ts";
const factoryConstructor = [{ type: "constructor", stateMutability: "nonpayable", inputs: [
  { type: "address", name: "gate" }, { type: "address", name: "usdc" },
  { type: "bytes32", name: "rpIdHash" }, { type: "string", name: "origin" },
] }] as const;
const accountConstructor = [{ type: "constructor", stateMutability: "nonpayable", inputs: [
  { type: "address", name: "gate" }, { type: "address", name: "usdc" }, { type: "bytes32", name: "qx" },
  { type: "bytes32", name: "qy" }, { type: "bytes32", name: "rpIdHash" }, { type: "string", name: "origin" },
] }] as const;

export async function planPasskeyV2Transition(setupValue: unknown, sender: Address,
  factoryBytecode: Hex, accountBytecode: Hex, client = getMonadReadClient()) {
  if (client.chain.id !== 10143 || await client.getChainId() !== 10143) throw new Error("V2 planning supports Monad Testnet 10143 only.");
  if (!isAddress(sender, { strict: true }) || sender === zeroAddress) throw new Error("Invalid public sender.");
  for (const bytecode of [factoryBytecode, accountBytecode]) {
    if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(bytecode)) throw new Error("Compile the reviewed V2 contracts before planning.");
  }
  const setup = await parseAccountSetup(setupValue);
  const oldAccount = await readAccountSetup(`0x${setup.qx.slice(2)}${setup.qy.slice(2)}`, setup.origin, client);
  if (getAddress(setup.accountAddress) !== oldAccount.accountAddress || !oldAccount.accountDeployed) {
    throw new Error("The supplied public key does not match a deployed V1 account.");
  }
  const [nonce, pendingNonce, balance, senderCode, fees, oldNonce, oldCode, attester] = await Promise.all([
    client.getTransactionCount({ address: sender, blockTag: "latest" }), client.getTransactionCount({ address: sender, blockTag: "pending" }),
    client.getBalance({ address: sender, blockTag: "latest" }), client.getCode({ address: sender }), client.estimateFeesPerGas(),
    client.readContract({ address: oldAccount.accountAddress, abi: parseAbi(["function nonce() view returns(uint256)"]), functionName: "nonce",
      blockNumber: BigInt(oldAccount.observedBlock) }),
    client.getCode({ address: oldAccount.accountAddress, blockNumber: BigInt(oldAccount.observedBlock) }),
    client.readContract({ address: METROPOLIS_DEPLOYMENT.trustGate, abi: parseAbi(["function hasRole(bytes32,address) view returns(bool)"]),
      functionName: "hasRole", args: [keccak256(toHex("TRUST_ATTESTER_ROLE")), sender] }),
  ]);
  if (nonce !== pendingNonce) throw new Error("Sender has pending transactions; the CREATE prediction is not safe to review.");
  if (senderCode && senderCode !== "0x") throw new Error("This V2 deployment plan requires an EOA sender.");
  if (fees.maxFeePerGas <= 0n || fees.maxPriorityFeePerGas < 0n || fees.maxPriorityFeePerGas > fees.maxFeePerGas) {
    throw new Error("Invalid RPC fee estimate.");
  }
  const predictedFactory = getContractAddress({ from: sender, nonce: BigInt(nonce) });
  const data = encodeDeployData({ abi: factoryConstructor, bytecode: factoryBytecode,
    args: [setup.trustGate, setup.usdc, setup.rpIdHash, setup.origin] });
  const accountInitCode = encodeDeployData({ abi: accountConstructor, bytecode: accountBytecode,
    args: [setup.trustGate, setup.usdc, setup.qx, setup.qy, setup.rpIdHash, setup.origin] });
  const create2Salt = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
    [setup.qx, setup.qy, METROPOLIS_V2_ACCOUNT_SALT]));
  const predictedAccount = getContractAddress({ opcode: "CREATE2", from: predictedFactory, salt: create2Salt, bytecode: accountInitCode });
  const [factoryCode, accountCode] = await Promise.all([
    client.getCode({ address: predictedFactory }), client.getCode({ address: predictedAccount }),
  ]);
  if ((factoryCode && factoryCode !== "0x") || (accountCode && accountCode !== "0x")) throw new Error("A predicted V2 address already has code.");
  if (predictedAccount === oldAccount.accountAddress) throw new Error("V1 and V2 must have different accounts.");
  const estimationBalance = balance > parseEther("1") ? balance : parseEther("1");
  const estimatedGas = await client.estimateGas({ account: sender, data, value: 0n,
    maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    stateOverride: [{ address: sender, balance: estimationBalance }] });
  const gas = estimatedGas + (estimatedGas + 19n) / 20n;
  if (estimatedGas <= 0n || gas > 30_000_000n) throw new Error("V2 factory exceeds the reviewed transaction gas limit.");
  const [factoryRuntime, accountRuntime] = await Promise.all([
    client.call({ account: sender, data, value: 0n }), client.call({ account: sender, data: accountInitCode, value: 0n }),
  ]);
  if (!factoryRuntime.data || factoryRuntime.data === "0x" || !accountRuntime.data || accountRuntime.data === "0x") {
    throw new Error("Constructor simulation did not return the expected runtime code.");
  }
  return {
    summary: { kind: "veyra.metropolis.passkey-v2-transition", version: 1, plannedAt: new Date().toISOString(), network: "Monad Testnet", chainId: 10143,
      contract: "VeyraPasskeyAccountFactoryV2", accountVersion: 2, sender, nonce, trustGate: setup.trustGate, usdc: setup.usdc,
      origin: setup.origin, rpIdHash: setup.rpIdHash, existingAttesterActiveForSender: attester,
      predictedFactory, predictedAccount, creationBytecodeHash: keccak256(factoryBytecode), accountCreationBytecodeHash: keccak256(accountBytecode),
      deploymentDataHash: keccak256(data), expectedFactoryRuntimeCodeHash: keccak256(factoryRuntime.data), expectedAccountRuntimeCodeHash: keccak256(accountRuntime.data),
      estimatedGas: estimatedGas.toString(), gasLimit: gas.toString(), maxFeePerGasWei: fees.maxFeePerGas.toString(),
      maxPriorityFeePerGasWei: fees.maxPriorityFeePerGas.toString(), maximumFeeMon: formatEther(gas * fees.maxFeePerGas),
      senderBalanceMon: formatEther(balance), requiresFunding: balance < gas * fees.maxFeePerGas,
      estimationUsedBalanceOverride: estimationBalance !== balance, usdcSpent: "0", nativeValueMon: "0",
      oldAccount: { address: oldAccount.accountAddress, nonce: oldNonce.toString(), usdcBalanceUnits: oldAccount.usdcBalanceUnits,
        runtimeCodeHash: keccak256(oldCode!), observedBlock: oldAccount.observedBlock, observedBlockHash: oldAccount.observedBlockHash,
        fundsMoved: false },
      approvalStatus: "not authorized; no transaction signed or sent", accountCreated: false,
      note: "Recheck nonce, fees, gas and code before a separately approved factory deployment. Account creation, funding and frontend activation need later review." },
    factoryTransaction: { chainId: 10143, from: sender, nonce, value: "0", data, gas: gas.toString(),
      maxFeePerGas: fees.maxFeePerGas.toString(), maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(), type: "eip1559" },
    conditionalAccountCreation: { status: "not executable until the factory is deployed and verified; gas and nonce are not estimated",
      from: sender, to: predictedFactory, value: "0", data: encodeFunctionData({ abi: METROPOLIS_FACTORY_ABI,
        functionName: "createAccount", args: [setup.qx, setup.qy, METROPOLIS_V2_ACCOUNT_SALT] }),
      publicKey: { qx: setup.qx, qy: setup.qy }, userSalt: METROPOLIS_V2_ACCOUNT_SALT, predictedAccount },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { setupPath, sender } = parseAccountPlanArguments(process.argv.slice(2));
    if (statSync(setupPath).size > 16384) throw new Error("Public setup is too large.");
    const setup: unknown = JSON.parse(readFileSync(setupPath, "utf8"));
    const bytecode = (name: string) => JSON.parse(readFileSync(new URL(`../../contracts/monad/out/${name}.sol/${name}.json`, import.meta.url), "utf8")).bytecode.object as Hex;
    console.log(JSON.stringify(await planPasskeyV2Transition(setup, sender, bytecode("VeyraPasskeyAccountFactoryV2"), bytecode("VeyraPasskeyAccountV2")), null, 2));
  } catch (error) { console.error(error instanceof Error ? error.message : "V2 planning failed"); process.exitCode = 1; }
}
