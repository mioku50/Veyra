import { defineChain, type Address } from "viem";

// Separate from all Arc configuration and execution paths.
export const monadDemoTestnet = defineChain({
  id:10143, name:"Monad Testnet", nativeCurrency:{name:"Monad",symbol:"MON",decimals:18},
  rpcUrls:{default:{http:["https://testnet-rpc.monad.xyz"]}},
  blockExplorers:{default:{name:"Monadscan",url:"https://testnet.monadscan.com"}}, testnet:true,
});
export const monadReadOnlyMainnet = defineChain({
  id:143, name:"Monad Mainnet", nativeCurrency:{name:"Monad",symbol:"MON",decimals:18},
  rpcUrls:{default:{http:["https://rpc.monad.xyz"]}},
  blockExplorers:{default:{name:"Monadscan",url:"https://monadscan.com"}},
});
export const MONAD_CONTRACTS = {
  10143:{usdc:"0x534b2f3A21130d7a60830c2Df862319e593943A3",identityRegistry:"0x8004A818BFB912233c491871b3d84c89A494BD9e",reputationRegistry:"0x8004B663056A597Dffe9eCcC1965A193B7388713"},
  143:{usdc:"0x754704Bc059F8C67012fEd69BC8A327a5aafb603",identityRegistry:"0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",reputationRegistry:"0x8004BAa17C55a88189AE136b182e5fdA19dE9b63"},
} as const satisfies Record<number,{usdc:Address;identityRegistry:Address;reputationRegistry:Address}>;
export const MONAD_P256_PRECOMPILE = "0x0000000000000000000000000000000000000100" as const;
