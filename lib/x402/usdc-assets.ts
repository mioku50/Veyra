/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The USDC deployment Veyra is willing to quote, per chain.
 *
 * An earlier version of the quote route decided this from the accept's EIP-712
 * domain name, which is not the asset's identity: a Circle Gateway batched
 * accept is domain-separated by "GatewayWalletBatched" and a vanilla accept by
 * whatever the token contract calls itself ("USD Coin" on some deployments,
 * "USDC" on others). Real USDC endpoints were refused as `asset_not_usdc`.
 *
 * The contract address is the identity. This table is Circle's own published
 * list, read from the Gateway facilitator's `/v1/x402/supported`, so it says
 * what Circle itself will settle rather than what Veyra believes.
 *
 * Bridged variants (USDbC, USDC.e) are deliberately absent: they are different
 * contracts with different redemption guarantees, and quoting them as USDC
 * would be the same conflation this table exists to fix.
 */
export const USDC_BY_CHAIN_ID: Readonly<Record<number, `0x${string}`>> = {
  // Mainnet
  1: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  10: "0x0b2c639c533813f4aa9d7837caf62653d097ff85",
  130: "0x078d782b760474a361dda0af3839290b0ef57ad6",
  137: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
  146: "0x29219dd400f2bf60e5a23d13be72b486d4038894",
  480: "0x79a02482a880bce3f13e09da970dc34db4cd24d1",
  999: "0xb88339cb7199b77e23db6e890353e22632ba630f",
  1329: "0xe15fc38f6d8c56af07bbcbe3baf5708a2bf42392",
  8453: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  42161: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
  43114: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e",

  // Testnet
  998: "0x2b3370ee501b4a559b57d449569354196457d8ab",
  1301: "0x31d0220469e10c4e71834a79b1f276d740d3768f",
  1328: "0x4fcf1784b31630811181f670aea7a7bef803eaed",
  4801: "0x66145f38cbac35ca6f1dfb4914df98f1614aea88",
  14601: "0x0ba304580ee7c9a980cf72e55f5ed2e9fd30bc51",
  43113: "0x5425890298aed601595a70ab815c96711a31bc65",
  80002: "0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582",
  84532: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
  421614: "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d",
  5042002: "0x3600000000000000000000000000000000000000",
  11155111: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
  11155420: "0x5fd84259d66cd46123540766be93dfe6d43130d7",
} as const;

export function usdcAddressForChain(chainId: number): `0x${string}` | null {
  return USDC_BY_CHAIN_ID[chainId] ?? null;
}

/**
 * True only when `asset` is the USDC deployment for `chainId`. The pair, not
 * either half of it.
 *
 * There used to be a fallback here: a chain missing from the table was accepted
 * if the address matched the USDC of any chain that was in it, so that a newly
 * launched Circle network stayed payable rather than being silently
 * unquotable. The reasoning is backwards. USDC addresses are chain-specific, so
 * matching some other chain's deployment says nothing whatever about this one
 * -- and a seller naming chain 987654321 with Base's USDC address passed a
 * check whose entire purpose is to say which token on which chain a wallet is
 * about to be asked to authorize.
 *
 * An unknown chain is now unquotable, which is the honest answer and a one-line
 * change to fix when Circle launches one.
 */
export function isUsdcAsset(chainId: number, asset: string): boolean {
  const normalized = asset.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) return false;
  return USDC_BY_CHAIN_ID[chainId] === normalized;
}

/** Whether Veyra knows this chain at all, used to explain a refusal precisely. */
export function isKnownUsdcChain(chainId: number): boolean {
  return chainId in USDC_BY_CHAIN_ID;
}
