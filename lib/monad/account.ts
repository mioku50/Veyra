import { erc20Abi, getAddress, isAddress, keccak256, parseAbi, sha256, toBytes, toHex,
  zeroAddress, type Address, type Hex } from "viem";
import { MONAD_CONTRACTS } from "./config.ts";
import { getMonadReadClient } from "./erc8004.ts";
import { METROPOLIS_ORIGIN, passkeyCoordinates } from "./passkey.ts";

// Public deployments with finalized receipts and Sourcify matches recorded in docs.
export const METROPOLIS_DEPLOYMENT = {
  chainId: 10143,
  factory: "0x8fbaAcB3390ba67F80db02434c024fF2F04ca94B",
  trustGate: "0x4a8f26B1d376c9924aAE80877261E0c635eb54Bb",
  factoryCodeHash: "0xe9630176eb7ac1acabf30aa40fdf3e8b1925897502d9f095ccb267ea880f07e9",
  gateCodeHash: "0x9720d8163fb50e28636619a075c82152782ae33d71ba4a3663f2e28aeff9ac1f",
} as const;
export const METROPOLIS_ACCOUNT_SALT = keccak256(toHex("Veyra Metropolis personal account v1"));
export const METROPOLIS_V2_ACCOUNT_SALT = keccak256(toHex("Veyra Metropolis personal account v2"));
export const METROPOLIS_V2_DEPLOYMENT = {
  ...METROPOLIS_DEPLOYMENT,
  factory: "0x0624d4C7fcB61d178BFA2b675ec25B111C0E4c7a",
  factoryCodeHash: "0x2b55104da9e31a77ef1cd4ec74d3ab1fcdb99b5ef4a46792502f6100d4e5fe3d",
} as const;

/** Select a pinned deployment; a saved package never silently changes account versions. */
export function metropolisAccountProfile(factory: unknown) {
  if (factory === METROPOLIS_DEPLOYMENT.factory) {
    return { ...METROPOLIS_DEPLOYMENT, accountVersion: 1 as const, userSalt: METROPOLIS_ACCOUNT_SALT };
  }
  if (factory === METROPOLIS_V2_DEPLOYMENT.factory) {
    return { ...METROPOLIS_V2_DEPLOYMENT, accountVersion: 2 as const, userSalt: METROPOLIS_V2_ACCOUNT_SALT };
  }
  throw new AccountSetupError("Unsupported Metropolis account factory.");
}
export const METROPOLIS_FACTORY_ABI = parseAbi([
  "function trustGate() view returns (address)",
  "function usdc() view returns (address)",
  "function rpIdHash() view returns (bytes32)",
  "function origin() view returns (string)",
  "function accountAddress(bytes32 qx,bytes32 qy,bytes32 userSalt) view returns (address)",
  "function createAccount(bytes32 qx,bytes32 qy,bytes32 userSalt) returns (address)",
]);
const accountAbi = parseAbi([
  "function trustGate() view returns (address)", "function usdc() view returns (address)",
  "function rpIdHash() view returns (bytes32)", "function origin() view returns (string)",
  "function qx() view returns (bytes32)", "function qy() view returns (bytes32)",
]);
const versionAbi = parseAbi(["function ACCOUNT_VERSION() view returns (uint256)"]);
export type MetropolisAccountSetup = {
  kind: "veyra.metropolis.account-setup"; version: 1; chainId: 10143;
  factory: Address; trustGate: Address; usdc: Address; origin: string; rpIdHash: Hex;
  qx: Hex; qy: Hex; userSalt: Hex; accountAddress: Address;
  observedBlock: string; observedBlockHash: Hex; accountDeployed: boolean; usdcBalanceUnits: string;
};
const setupFields = ["kind", "version", "chainId", "factory", "trustGate", "usdc", "origin", "rpIdHash",
  "qx", "qy", "userSalt", "accountAddress", "observedBlock", "observedBlockHash", "accountDeployed", "usdcBalanceUnits"];
const bytes32 = /^0x[0-9a-fA-F]{64}$/;
const expectedRpIdHash = sha256(toHex(new URL(METROPOLIS_ORIGIN).hostname));
export class AccountSetupError extends Error {
  constructor(message: string) { super(message); this.name = "AccountSetupError"; }
}

/** Public-key validation uses the platform's P256 implementation, not signature mocks. */
export async function validateAccountKey(publicKey: string) {
  if (!/^0x[0-9a-fA-F]{128}$/.test(publicKey)) throw new AccountSetupError("Expected a P256 public key.");
  try {
    await crypto.subtle.importKey("raw", new Uint8Array(toBytes(`0x04${publicKey.slice(2)}`)),
      { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  } catch { throw new AccountSetupError("The account key is not a valid P256 point."); }
  return passkeyCoordinates(publicKey as Hex);
}

/** Accept public setup fields only. This export is a deployment proposal, never an authorization. */
export async function parseAccountSetup(value: unknown): Promise<MetropolisAccountSetup> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AccountSetupError("Invalid account setup.");
  const data = value as Record<string, unknown>;
  if (Object.keys(data).length !== setupFields.length || setupFields.some(key => !(key in data))) {
    throw new AccountSetupError("Account setup must contain only the documented public fields.");
  }
  const deployment = metropolisAccountProfile(data.factory);
  if (data.kind !== "veyra.metropolis.account-setup" || data.version !== 1 || data.chainId !== 10143
    || data.trustGate !== deployment.trustGate
    || data.usdc !== MONAD_CONTRACTS[10143].usdc || data.origin !== METROPOLIS_ORIGIN
    || data.rpIdHash !== expectedRpIdHash || data.userSalt !== deployment.userSalt) {
    throw new AccountSetupError("Account setup does not match the approved Testnet factory and canonical origin.");
  }
  for (const key of ["qx", "qy", "observedBlockHash"]) {
    if (typeof data[key] !== "string" || !bytes32.test(data[key])) throw new AccountSetupError("Invalid public setup bytes.");
  }
  if (typeof data.accountAddress !== "string" || !isAddress(data.accountAddress, { strict: true })
    || getAddress(data.accountAddress) === zeroAddress || typeof data.accountDeployed !== "boolean"
    || typeof data.observedBlock !== "string" || !/^[1-9]\d*$/.test(data.observedBlock)
    || typeof data.usdcBalanceUnits !== "string" || !/^\d+$/.test(data.usdcBalanceUnits)) {
    throw new AccountSetupError("Invalid account address or observation metadata.");
  }
  await validateAccountKey(`0x${(data.qx as string).slice(2)}${(data.qy as string).slice(2)}`);
  return { ...data } as MetropolisAccountSetup;
}

/** Finalized reads only: check deployed code/configuration before predicting an account. */
export async function readAccountSetup(publicKey: Hex, origin: string, client = getMonadReadClient(), historicalBlock?: bigint,
  factoryAddress: Address = METROPOLIS_DEPLOYMENT.factory): Promise<MetropolisAccountSetup> {
  const deployment = metropolisAccountProfile(factoryAddress);
  if (origin !== METROPOLIS_ORIGIN) throw new AccountSetupError("Prepare your account on the canonical Veyra domain.");
  const { qx, qy } = await validateAccountKey(publicKey);
  if (client.chain.id !== 10143 || await client.getChainId() !== 10143) throw new AccountSetupError("Account setup supports Monad Testnet 10143 only.");
  const finalized = await client.getBlock({ blockTag: "finalized" });
  if (finalized.number === null || !finalized.hash) throw new AccountSetupError("No finalized Monad block was returned.");
  if (historicalBlock !== undefined && (historicalBlock < BigInt(1) || historicalBlock > finalized.number)) {
    throw new AccountSetupError("Account observations must be at or before the finalized height.");
  }
  const block = historicalBlock === undefined ? finalized : await client.getBlock({ blockNumber: historicalBlock });
  if (historicalBlock !== undefined && block.number !== historicalBlock) throw new AccountSetupError("RPC returned a different historical block.");
  if (block.number === null || !block.hash) throw new AccountSetupError("No finalized Monad block was returned.");
  const blockNumber = block.number;
  const { factory, trustGate } = deployment;
  const usdc = MONAD_CONTRACTS[10143].usdc;
  const [factoryCode, gateCode, tokenCode] = await Promise.all([
    client.getCode({ address: factory, blockNumber }), client.getCode({ address: trustGate, blockNumber }),
    client.getCode({ address: usdc, blockNumber }),
  ]);
  if (!factoryCode || keccak256(factoryCode) !== deployment.factoryCodeHash
    || !gateCode || keccak256(gateCode) !== deployment.gateCodeHash || !tokenCode || tokenCode === "0x") {
    throw new AccountSetupError("Monad deployment code does not match the verified contracts.");
  }
  if (deployment.accountVersion === 2 && await client.readContract({ address: factory, abi: versionAbi,
    functionName: "ACCOUNT_VERSION", blockNumber }) !== BigInt(2)) {
    throw new AccountSetupError("The verified factory does not identify account version 2.");
  }
  const [gate, token, rpIdHash, factoryOrigin, decimals, accountAddress] = await Promise.all([
    client.readContract({ address: factory, abi: METROPOLIS_FACTORY_ABI, functionName: "trustGate", blockNumber }),
    client.readContract({ address: factory, abi: METROPOLIS_FACTORY_ABI, functionName: "usdc", blockNumber }),
    client.readContract({ address: factory, abi: METROPOLIS_FACTORY_ABI, functionName: "rpIdHash", blockNumber }),
    client.readContract({ address: factory, abi: METROPOLIS_FACTORY_ABI, functionName: "origin", blockNumber }),
    client.readContract({ address: usdc, abi: erc20Abi, functionName: "decimals", blockNumber }),
    client.readContract({ address: factory, abi: METROPOLIS_FACTORY_ABI, functionName: "accountAddress",
      args: [qx, qy, deployment.userSalt], blockNumber }),
  ]);
  if (gate !== trustGate || token !== usdc || rpIdHash !== expectedRpIdHash || factoryOrigin !== origin || decimals !== 6
    || accountAddress === zeroAddress) throw new AccountSetupError("Monad factory configuration mismatch.");
  const [accountCode, balance] = await Promise.all([
    client.getCode({ address: accountAddress, blockNumber }),
    client.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [accountAddress], blockNumber }),
  ]);
  const accountDeployed = !!accountCode && accountCode !== "0x";
  if (accountDeployed) {
    if (deployment.accountVersion === 2 && await client.readContract({ address: accountAddress, abi: versionAbi,
      functionName: "ACCOUNT_VERSION", blockNumber }) !== BigInt(2)) {
      throw new AccountSetupError("The deployed personal account is not version 2.");
    }
    const [accountGate, accountToken, accountRp, accountOrigin, accountX, accountY] = await Promise.all([
      client.readContract({ address: accountAddress, abi: accountAbi, functionName: "trustGate", blockNumber }),
      client.readContract({ address: accountAddress, abi: accountAbi, functionName: "usdc", blockNumber }),
      client.readContract({ address: accountAddress, abi: accountAbi, functionName: "rpIdHash", blockNumber }),
      client.readContract({ address: accountAddress, abi: accountAbi, functionName: "origin", blockNumber }),
      client.readContract({ address: accountAddress, abi: accountAbi, functionName: "qx", blockNumber }),
      client.readContract({ address: accountAddress, abi: accountAbi, functionName: "qy", blockNumber }),
    ]);
    if (accountGate !== trustGate || accountToken !== usdc || accountRp !== rpIdHash || accountOrigin !== origin
      || accountX.toLowerCase() !== qx.toLowerCase() || accountY.toLowerCase() !== qy.toLowerCase()) {
      throw new AccountSetupError("Existing account does not match this passkey and configuration.");
    }
  }
  return { kind: "veyra.metropolis.account-setup", version: 1, chainId: 10143, factory, trustGate, usdc,
    origin, rpIdHash, qx, qy, userSalt: deployment.userSalt, accountAddress,
    observedBlock: blockNumber.toString(), observedBlockHash: block.hash, accountDeployed, usdcBalanceUnits: balance.toString() };
}
