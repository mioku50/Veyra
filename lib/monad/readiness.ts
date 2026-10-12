import { encodePacked, formatUnits, keccak256, parseAbi, toHex, type Hex } from "viem";
import { METROPOLIS_DEPLOYMENT, METROPOLIS_V2_DEPLOYMENT, readAccountSetup, validateAccountKey } from "./account.ts";
import { MONAD_CONTRACTS, MONAD_P256_PRECOMPILE } from "./config.ts";
import { deepFreeze } from "./evidence.ts";
import { getMonadReadClient, MONAD_REPUTATION_ABI } from "./erc8004.ts";
import { METROPOLIS_ORIGIN } from "./passkey.ts";
import { PaymentError, purchaseRequestHash } from "./payment.ts";
import { parseMonadUsdc } from "./trust.ts";
import { parseReadinessTask, READINESS_SERVICE_ID } from "./readiness-task.ts";
export { parseReadinessTask, readinessTask, READINESS_SERVICE_ID, READINESS_DELIVERABLE, type ReadinessRequest } from "./readiness-task.ts";

export const READINESS_SOURCES = [
  { title: "Monad current facts", url: "https://docs.monad.xyz/ai/current-facts" },
  { title: "Monad native P256", url: "https://docs.monad.xyz/developer-essentials/precompiles" },
  { title: "Monad finality commitments", url: "https://docs.monad.xyz/monad-arch/consensus/block-states" },
  { title: "ERC-8004 registry source and deployments", url: "https://github.com/erc-8004/erc-8004-contracts" },
  { title: "Circle USDC addresses", url: "https://developers.circle.com/stablecoins/usdc-contract-addresses" },
] as const;
// Public software-generated verification vector, independent of the owner's passkey.
// Both positive and negative eth_call checks are required; this does not verify a device approval.
export const READINESS_P256_VECTOR = {
  hash: "0x35c9881a5c15db7578dda8f318e360f167ba2a41be8ab48e3a46029e701d35f1",
  r: "0x835ccafbdb1b2a5663891db4d3cb096137fcd8be7e34058564e86a13afc4bbf3",
  s: "0x430ef840c159d5ee243f8e6f01799034d9f3a905994207b4d7a5d25d85c8c82a",
  qx: "0x4fdbe53af85737a9a3d1e35fc9f2020e5176c7a33a65ca6163925b63ad7b6863",
  qy: "0x919bd347c824c0d6b11d158ff072a25fd7e2b0f211e3ece07f4324e5fb9a8b1b",
} as const;
export function nativeP256ProbeData(altered = false): Hex {
  const v = READINESS_P256_VECTOR;
  return encodePacked(["bytes32", "bytes32", "bytes32", "bytes32", "bytes32"],
    [altered ? `0x00${v.hash.slice(4)}` : v.hash, v.r, v.s, v.qx, v.qy]);
}
type Client = ReturnType<typeof getMonadReadClient>;
type Check = { id: string; status: "passed" | "blocked"; finding: string; nextAction: string | null };
const accountNonceAbi = parseAbi(["function nonce() view returns(uint256)"]);

/** Useful free diagnosis. All facts are read at the same finalized block; no signer or writes. */
export async function generateReadinessReport(input: unknown, client: Client = getMonadReadClient(), historicalBlock?: bigint) {
  const { task, request } = parseReadinessTask(input);
  await validateAccountKey(request.publicKey);
  const factory = request.accountVersion === 2 ? METROPOLIS_V2_DEPLOYMENT.factory : METROPOLIS_DEPLOYMENT.factory;
  const setup = await readAccountSetup(request.publicKey, METROPOLIS_ORIGIN, client, historicalBlock, factory);
  const blockNumber = BigInt(setup.observedBlock);
  const block = await client.getBlock({ blockNumber });
  if (block.number !== blockNumber || block.hash !== setup.observedBlockHash) throw new PaymentError("The readiness snapshot is no longer canonical.");
  const contracts = MONAD_CONTRACTS[10143];
  const [registryCodes, identityLink, goodSignature, badSignature, accountNonce] = await Promise.all([
    Promise.all([contracts.identityRegistry, contracts.reputationRegistry].map(address => client.getCode({ address, blockNumber }))),
    client.readContract({ address: contracts.reputationRegistry, abi: MONAD_REPUTATION_ABI, functionName: "getIdentityRegistry", blockNumber }),
    client.call({ to: MONAD_P256_PRECOMPILE, data: nativeP256ProbeData(), blockNumber }),
    client.call({ to: MONAD_P256_PRECOMPILE, data: nativeP256ProbeData(true), blockNumber }),
    setup.accountDeployed ? client.readContract({ address: setup.accountAddress, abi: accountNonceAbi, functionName: "nonce", blockNumber }) : Promise.resolve(null),
  ]);
  const registryVerified = registryCodes.every(code => !!code && code !== "0x") && identityLink.toLowerCase() === contracts.identityRegistry.toLowerCase();
  const nativeVerified = goodSignature.data === `0x${"0".repeat(63)}1` && (!badSignature.data || badSignature.data === "0x");
  const sufficientBalance = BigInt(setup.usdcBalanceUnits) >= parseMonadUsdc(request.budgetUsdc);
  const checks: Check[] = [
    { id: "deployment", status: "passed", finding: "TrustGate and factory runtime hashes, USDC decimals, canonical RP/origin and derived account configuration match the verified deployment.", nextAction: null },
    { id: "registries", status: registryVerified ? "passed" : "blocked", finding: registryVerified ? "Canonical Identity and Reputation registries have code and the expected linkage." : "Registry code or linkage does not match.", nextAction: registryVerified ? null : "Resolve the registry mismatch before selecting a provider." },
    { id: "native_p256", status: nativeVerified ? "passed" : "blocked", finding: nativeVerified ? "Native 0x0100 accepted a known P256 signature and rejected an altered message through eth_call." : "The native verifier did not pass both probes.", nextAction: nativeVerified ? null : "Check RPC and native P256 support; do not approve a payment." },
    { id: "personal_account", status: setup.accountDeployed ? "passed" : "blocked", finding: setup.accountDeployed ? `Your per-passkey account is deployed; its nonce is ${accountNonce}.` : "The derived per-passkey account is not deployed.", nextAction: setup.accountDeployed ? null : "Review and authorize creation of the derived account." },
    { id: "budget_funding", status: sufficientBalance ? "passed" : "blocked", finding: `${formatUnits(BigInt(setup.usdcBalanceUnits), 6)} test USDC available for a ${request.budgetUsdc}-USDC budget. Balance is not policy authorization.`, nextAction: sufficientBalance ? null : "Fund the personal account with test USDC or choose a smaller budget." },
  ];
  return deepFreeze({
    kind: "veyra.metropolis.readiness-report" as const, version: 1 as const, chainId: 10143 as const,
    serviceId: READINESS_SERVICE_ID, task, requestHash: purchaseRequestHash(task),
    observation: { blockNumber: setup.observedBlock, blockHash: setup.observedBlockHash, commitment: "finalized" as const, timestamp: block.timestamp.toString() },
    account: { address: setup.accountAddress, deployed: setup.accountDeployed, nonce: accountNonce?.toString() ?? null, usdcBalanceUnits: setup.usdcBalanceUnits },
    contracts: { ...contracts, factory: setup.factory, trustGate: setup.trustGate, p256: MONAD_P256_PRECOMPILE },
    checks, status: checks.every(check => check.status === "passed") ? "checks_passed" as const : "blocked" as const,
    purchaseAuthorized: false as const, productionReady: false as const, transactionSent: false as const,
    nextActions: [
      ...checks.flatMap(check => check.nextAction ? [check.nextAction] : []),
      "Choose a real provider and collect current corroborated payment and delivery history. Identity alone remains REVIEW_REQUIRED.",
      "Review a fresh Veyra clearance and exact task/amount with the owner, then obtain a passkey approval and review the relayer transaction.",
      "After an actual payment, verify the receipt and the requested result separately. A free readiness snapshot does not create paid-delivery history.",
    ],
    limitations: [
      "This free operator-run demonstration reports a Testnet snapshot; it is not an independent security audit or Mainnet certification.",
      "The positive P256 probe uses a public software vector, not the owner's device assertion or a payment transaction.",
      "No provider reputation, Veyra clearance, attester authority, relayer balance or service delivery was established by this report.",
      "Official documentation links identify expected parameters; the service does not fetch or interpret their current text.",
      "The immutable account prototype has no key recovery/rotation, general calls or escrow. Autonomous spending remains frozen.",
    ], sources: READINESS_SOURCES,
  });
}
export type ReadinessReport = Awaited<ReturnType<typeof generateReadinessReport>>;
export function readinessResponseHash(report: ReadinessReport): Hex { return keccak256(toHex(JSON.stringify(report))); }
export function renderReadinessReport(report: ReadinessReport): string {
  const lines = ["# Veyra — Monad Testnet readiness", "", `Snapshot: finalized block **${report.observation.blockNumber}**, hash \`${report.observation.blockHash}\`.`, "",
    `Account: \`${report.account.address}\`. Balance: **${formatUnits(BigInt(report.account.usdcBalanceUnits), 6)} test USDC**.`, "",
    `Result: **${report.status}**. A purchase still requires provider evidence, a Veyra clearance and the owner's approval.`, "",
    "## Checked", "", ...report.checks.map(check => `- **${check.status} — ${check.id}**: ${check.finding}`), "",
    "## Next actions", "", ...report.nextActions.map((action, index) => `${index + 1}. ${action}`), "",
    "## Limits", "", ...report.limitations.map(limit => `- ${limit}`), "", "## Sources", "",
    ...report.sources.map(source => `- [${source.title}](${source.url})`), "",
    `Request hash: \`${report.requestHash}\`. Response hash (canonical JSON, not this Markdown): \`${readinessResponseHash(report)}\`.`, ""];
  return lines.join("\n");
}
