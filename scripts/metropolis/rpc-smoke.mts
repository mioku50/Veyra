import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeAbiParameters, encodePacked, type Hex } from "viem";
import { getMonadReadClient, verifyMonadInfrastructure, readMonadAgentIdentity } from "../../lib/monad/erc8004.ts";
import { MONAD_P256_PRECOMPILE } from "../../lib/monad/config.ts";

// Every request is eth_chainId, eth_blockNumber, eth_getCode or eth_call.
// No wallet, private key, signed transaction or state mutation is involved.
for (const chainId of [143,10143] as const) {
  const client = getMonadReadClient(chainId);
  const result = await verifyMonadInfrastructure(client);
  console.log(JSON.stringify({network:client.chain.name,chainId:result.chainId,block:result.blockNumber.toString(),
    usdcDecimals:6,registryLinkVerified:true}));
}
const testnet = getMonadReadClient();
const identity = await readMonadAgentIdentity(1n,testnet);
console.log(JSON.stringify({readOnlyExistingAgent:identity.agentId.toString(),owner:identity.owner,paymentWallet:identity.paymentWallet,
  note:"Public registry read only; this agent is not a Veyra demo agent or an endorsed provider."}));
const fixture = JSON.parse(readFileSync(new URL("../../contracts/monad/test/fixtures/webauthn.json",import.meta.url),"utf8"));
const [auth] = decodeAbiParameters([{type:"tuple",components:[{name:"r",type:"bytes32"},{name:"s",type:"bytes32"},
  {name:"challengeIndex",type:"uint256"},{name:"typeIndex",type:"uint256"},
  {name:"authenticatorData",type:"bytes"},{name:"clientDataJSON",type:"string"}]}],fixture.variants.valid);
const input = encodePacked(["bytes32","bytes32","bytes32","bytes32","bytes32"],
  [fixture.signedHash,auth.r,auth.s,fixture.qx,fixture.qy]);
const valid = await testnet.call({to:MONAD_P256_PRECOMPILE,data:input});
assert.equal(BigInt(valid.data ?? "0x0"),1n,"Monad P256 must verify the generated WebAuthn signature");
const altered = (`0x${input.slice(2,4) === "00" ? "01" : "00"}${input.slice(4)}`) as Hex;
const invalid = await testnet.call({to:MONAD_P256_PRECOMPILE,data:altered});
assert.ok(!invalid.data || invalid.data === "0x","Invalid P256 signature must return empty data");
console.log("Monad Testnet native P256: valid signature accepted, altered signature rejected (eth_call, no transaction).");
