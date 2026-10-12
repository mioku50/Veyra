import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { encodeAbiParameters, encodeDeployData, encodeFunctionData, formatEther, getAddress,
  getContractAddress, isAddress, keccak256, parseEther, zeroAddress, type Address, type Hex } from "viem";
import { METROPOLIS_FACTORY_ABI, metropolisAccountProfile, parseAccountSetup, readAccountSetup } from "../../lib/monad/account.ts";
import { getMonadReadClient } from "../../lib/monad/erc8004.ts";

const accountConstructor = [{ type: "constructor", inputs: [
  { name: "gate", type: "address" }, { name: "usdc", type: "address" },
  { name: "qx", type: "bytes32" }, { name: "qy", type: "bytes32" },
  { name: "rpIdHash", type: "bytes32" }, { name: "origin", type: "string" },
], stateMutability: "nonpayable" }] as const;

export function parseAccountPlanArguments(args: string[]) {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i], value = args[i + 1];
    if (!["--setup", "--sender"].includes(name) || values.has(name) || !value) {
      throw new Error("Provide only --setup PUBLIC_SETUP_JSON_PATH and --sender PUBLIC_ADDRESS.");
    }
    values.set(name, value);
  }
  const sender = values.get("--sender");
  if (values.size !== 2 || !sender || !isAddress(sender, { strict: true }) || getAddress(sender) === zeroAddress) {
    throw new Error("A public setup file and a nonzero sender address are required.");
  }
  return { setupPath: values.get("--setup")!, sender: getAddress(sender) };
}

/** Public setup + compiled artifact only; re-read the chain instead of trusting browser observations. */
export async function planAccountCreation(setupValue: unknown, sender: Address, bytecode: Hex, client = getMonadReadClient()) {
  if (!isAddress(sender, { strict: true }) || getAddress(sender) === zeroAddress) throw new Error("Invalid deployment sender.");
  const setup = await parseAccountSetup(setupValue);
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(bytecode)) throw new Error("Compile the passkey account before preparing its deployment.");
  const fresh = await readAccountSetup(`0x${setup.qx.slice(2)}${setup.qy.slice(2)}`, setup.origin, client, undefined, setup.factory);
  const initCode = encodeDeployData({ abi: accountConstructor, bytecode,
    args: [setup.trustGate, setup.usdc, setup.qx, setup.qy, setup.rpIdHash, setup.origin] });
  const salt = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
    [setup.qx, setup.qy, setup.userSalt]));
  const independentAddress = getContractAddress({ opcode: "CREATE2", from: setup.factory, salt, bytecode: initCode });
  if (getAddress(setup.accountAddress) !== fresh.accountAddress || independentAddress !== fresh.accountAddress) {
    throw new Error("Browser, compiled account and factory CREATE2 addresses disagree.");
  }
  if (fresh.accountDeployed) {
    return { summary: { ...fresh, sender, action: "already deployed; no creation transaction needed", usdcSpent: "0" }, transaction: null };
  }
  const [nonce, pendingNonce, balance, senderCode, fees] = await Promise.all([
    client.getTransactionCount({ address: sender, blockTag: "latest" }),
    client.getTransactionCount({ address: sender, blockTag: "pending" }),
    client.getBalance({ address: sender, blockTag: "latest" }), client.getCode({ address: sender }), client.estimateFeesPerGas(),
  ]);
  if (nonce !== pendingNonce) throw new Error("Sender has pending transactions; resolve them before preparing account creation.");
  if (senderCode && senderCode !== "0x") throw new Error("This deployment plan requires an EOA sender.");
  if (fees.maxFeePerGas <= 0n || fees.maxPriorityFeePerGas < 0n || fees.maxPriorityFeePerGas > fees.maxFeePerGas) {
    throw new Error("Invalid RPC fee estimate.");
  }
  const data = encodeFunctionData({ abi: METROPOLIS_FACTORY_ABI, functionName: "createAccount",
    args: [setup.qx, setup.qy, setup.userSalt] });
  const estimationBalance = balance > parseEther("1") ? balance : parseEther("1");
  const estimatedGas = await client.estimateGas({ account: sender, to: setup.factory, data, value: 0n,
    maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    stateOverride: [{ address: sender, balance: estimationBalance }] });
  const gas = estimatedGas + (estimatedGas + 19n) / 20n;
  if (estimatedGas <= 0n || gas > 30_000_000n) throw new Error("Account creation exceeds the reviewed transaction gas limit.");
  const maximumFee = gas * fees.maxFeePerGas;
  return {
    summary: { ...fresh, network: "Monad Testnet", sender, action: "createAccount", nonce,
      estimatedGas: estimatedGas.toString(), gasLimit: gas.toString(),
      maxFeePerGasWei: fees.maxFeePerGas.toString(), maxPriorityFeePerGasWei: fees.maxPriorityFeePerGas.toString(),
      maximumFeeMon: formatEther(maximumFee), senderBalanceMon: formatEther(balance), requiresFunding: balance < maximumFee,
      estimationUsedBalanceOverride: estimationBalance !== balance, usdcSpent: "0", nativeValueMon: "0",
      creationBytecodeHash: keccak256(bytecode), callDataHash: keccak256(data),
      approvalStatus: "not authorized; no transaction signed or sent",
      note: "This public setup does not prove ownership by itself or authorize deployment. Review the device key and approve the exact transaction separately." },
    transaction: { chainId: 10143, from: sender, to: setup.factory, nonce, value: "0", data,
      gas: gas.toString(), maxFeePerGas: fees.maxFeePerGas.toString(), maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(), type: "eip1559" },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { setupPath, sender } = parseAccountPlanArguments(process.argv.slice(2));
    if (statSync(setupPath).size > 16_384) throw new Error("Public setup JSON is too large.");
    let setup: unknown;
    try { setup = JSON.parse(readFileSync(setupPath, "utf8")); }
    catch { throw new Error("The public setup file must be valid JSON."); }
    const parsed = await parseAccountSetup(setup);
    const name = metropolisAccountProfile(parsed.factory).accountVersion === 2 ? "VeyraPasskeyAccountV2" : "VeyraPasskeyAccount";
    const artifact = JSON.parse(readFileSync(new URL(`../../contracts/monad/out/${name}.sol/${name}.json`, import.meta.url), "utf8")) as { bytecode: { object: Hex } };
    console.log(JSON.stringify(await planAccountCreation(setup, sender, artifact.bytecode.object), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Account deployment planning failed.");
    process.exitCode = 1;
  }
}
