import {
  createPublicClient,
  getAddress,
  http,
  isAddress,
  parseAbi,
  type Address,
  type PublicClient,
} from "viem";
import {
  ARC_TESTNET_RPC_URL,
  ARC_TESTNET_USDC_ADDRESS,
  arcTestnetChain,
} from "./arc.ts";

export const ARC_TESTNET_NATIVE_USDC_EMITTER =
  "0xfffffffffffffffffffffffffffffffffffffffe" as const;
export const ARC_TESTNET_LEGACY_USDC_EMITTER =
  "0x1800000000000000000000000000000000000000" as const;
export const ARC_TESTNET_MEMO_ADDRESS =
  "0x5294E9927c3306DcBaDb03fe70b92e01cCede505" as const;
export const ARC_ZERO5_ACTIVATION_UNIX_SECONDS = 1_779_894_517;
export const ARC_ZERO5_ACTIVATION_BLOCK = BigInt(44_295_021);

export const ARC_USDC_BLOCKLIST_ABI = parseAbi([
  "function isBlacklisted(address account) view returns (bool)",
]);

export const ARC_USDC_TRANSFER_ABI = parseAbi([
  "function transfer(address to, uint256 value) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export const ARC_MEMO_ABI = parseAbi([
  "function memo(address target, bytes data, bytes32 memoId, bytes memoData)",
  "event BeforeMemo(uint256 indexed memoIndex)",
  "event Memo(address indexed sender, address indexed target, bytes32 callDataHash, bytes32 indexed memoId, bytes memo, uint256 memoIndex)",
]);

export type ArcUsdcBlocklistStatus = "clear" | "blocklisted" | "unknown";

function defaultArcClient() {
  return createPublicClient({
    chain: arcTestnetChain,
    transport: http(ARC_TESTNET_RPC_URL, { retryCount: 0, timeout: 10_000 }),
  });
}

export async function readArcUsdcBlocklistStatus(
  account: string,
  client: PublicClient = defaultArcClient(),
): Promise<ArcUsdcBlocklistStatus> {
  if (!isAddress(account)) return "unknown";
  try {
    const blocked = await client.readContract({
      address: ARC_TESTNET_USDC_ADDRESS as Address,
      abi: ARC_USDC_BLOCKLIST_ABI,
      functionName: "isBlacklisted",
      args: [getAddress(account)],
    });
    return blocked ? "blocklisted" : "clear";
  } catch {
    return "unknown";
  }
}

export async function readArcUsdcBlocklistStatuses(
  accounts: string[],
  client: PublicClient = defaultArcClient(),
) {
  const unique = Array.from(new Set(
    accounts
      .filter((account) => isAddress(account))
      .map((account) => getAddress(account).toLowerCase()),
  ));
  const entries = await Promise.all(
    unique.map(async (account) => [
      account,
      await readArcUsdcBlocklistStatus(account, client),
    ] as const),
  );
  return new Map(entries);
}

export async function arcAccountKind(
  account: string,
  client: PublicClient = defaultArcClient(),
): Promise<"eoa" | "contract" | "unknown"> {
  if (!isAddress(account)) return "unknown";
  try {
    const bytecode = await client.getBytecode({ address: getAddress(account) });
    return bytecode && bytecode !== "0x" ? "contract" : "eoa";
  } catch {
    return "unknown";
  }
}
