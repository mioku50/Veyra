/**
 * Copyright 2026 Veyra
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineChain } from "viem";

export const ARC_TESTNET_CHAIN_ID = 5_042_002;
export const ARC_TESTNET_CHAIN_ID_HEX = "0x4cef52";
export const ARC_TESTNET_RPC_URL = "https://rpc.testnet.arc.network";
export const ARC_TESTNET_WS_URL = "wss://rpc.testnet.arc.network";
export const ARC_TESTNET_EXPLORER_URL = "https://testnet.arcscan.app";
export const ARC_TESTNET_FAUCET_URL = "https://faucet.circle.com";
export const ARC_TESTNET_USDC_ADDRESS =
  "0x3600000000000000000000000000000000000000";
export const ARC_TESTNET_USDC_DECIMALS = 6;

export const arcTestnetChain = defineChain({
  id: ARC_TESTNET_CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: {
    name: "USDC",
    symbol: "USDC",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: [ARC_TESTNET_RPC_URL],
      webSocket: [ARC_TESTNET_WS_URL],
    },
  },
  blockExplorers: {
    default: {
      name: "Arcscan",
      url: ARC_TESTNET_EXPLORER_URL,
    },
  },
  testnet: true,
});

/* Arc mainnet. Read from Arc's documentation and checked against the chain
   (eth_chainId 0x13b2; USDC's EIP-712 domain is "USDC", version "2") and
   against Circle Gateway's /v1/info (domain 26). Kept beside the testnet so the
   two are never confused: they share the USDC address and nothing else. */
export const ARC_MAINNET_CHAIN_ID = 5_042;
export const ARC_MAINNET_CHAIN_ID_HEX = "0x13b2";
export const ARC_MAINNET_NETWORK = "eip155:5042";
export const ARC_MAINNET_RPC_URL = "https://rpc.mainnet.arc.io";
export const ARC_MAINNET_EXPLORER_URL = "https://explorer.arc.io";
export const ARC_MAINNET_USDC_ADDRESS =
  "0x3600000000000000000000000000000000000000";

export const arcMainnetChain = defineChain({
  id: ARC_MAINNET_CHAIN_ID,
  name: "Arc",
  nativeCurrency: {
    name: "USDC",
    symbol: "USDC",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: [ARC_MAINNET_RPC_URL],
    },
  },
  blockExplorers: {
    default: {
      name: "Arc Explorer",
      url: ARC_MAINNET_EXPLORER_URL,
    },
  },
});

/**
 * What a wallet needs to add a chain it has never seen. A payment on Arc asks
 * the wallet to switch there, and most wallets do not ship with Arc: without
 * this the switch fails with 4902 and the person is told to do it by hand.
 */
export const ADDABLE_CHAINS: Readonly<Record<number, {
  chainId: string;
  chainName: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrls: string[];
  blockExplorerUrls: string[];
}>> = {
  [ARC_MAINNET_CHAIN_ID]: {
    chainId: ARC_MAINNET_CHAIN_ID_HEX,
    chainName: "Arc",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: [ARC_MAINNET_RPC_URL],
    blockExplorerUrls: [ARC_MAINNET_EXPLORER_URL],
  },
  [ARC_TESTNET_CHAIN_ID]: {
    chainId: ARC_TESTNET_CHAIN_ID_HEX,
    chainName: "Arc Testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: [ARC_TESTNET_RPC_URL],
    blockExplorerUrls: [ARC_TESTNET_EXPLORER_URL],
  },
};

export function getArcExplorerAddressUrl(address: string) {
  return `${ARC_TESTNET_EXPLORER_URL}/address/${address}`;
}
