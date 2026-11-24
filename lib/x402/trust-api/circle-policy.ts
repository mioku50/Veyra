/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import { getAddress, isAddress, zeroAddress } from "viem";

export type CircleAllowlistCommand = {
  command: string;
  chain: "ARC";
  policyType: "stablecoin";
  ruleType: "recipient-allowlist";
  targets: `0x${string}`[];
  minCliVersion: "1.4.0";
  requiresHumanOtp: true;
  note: string;
};

export function normalizeAllowlistTargets(addresses: ReadonlyArray<string | null | undefined>): `0x${string}`[] {
  const seen = new Set<string>();
  const targets: `0x${string}`[] = [];
  for (const raw of addresses) {
    if (!raw || !isAddress(raw)) continue;
    const checksummed = getAddress(raw);
    if (checksummed.toLowerCase() === zeroAddress) continue;
    if (seen.has(checksummed)) continue;
    seen.add(checksummed);
    targets.push(checksummed);
  }
  return targets;
}

export function buildCircleRecipientAllowlistCommand(
  addresses: ReadonlyArray<string | null | undefined>,
): CircleAllowlistCommand | null {
  const targets = normalizeAllowlistTargets(addresses);
  if (targets.length === 0) return null;

  const command =
    `circle wallet limit set --address <YOUR_AGENT_WALLET> --chain ARC ` +
    `--policy-type stablecoin --rule-type recipient-allowlist ` +
    `--targets "[${targets.join(",")}]" --output json`;

  return {
    command,
    chain: "ARC",
    policyType: "stablecoin",
    ruleType: "recipient-allowlist",
    targets,
    minCliVersion: "1.4.0",
    requiresHumanOtp: true,
    note:
      "Requires Circle CLI 1.4.0+ on Arc mainnet agent wallets only. Run this command yourself in your own interactive terminal — the CLI emails a 6-digit OTP confirmation that only the wallet owner enters (if an active policy already exists on ARC, run `circle wallet limit reset --address <YOUR_AGENT_WALLET> --chain ARC --yes` first).",
  };
}
