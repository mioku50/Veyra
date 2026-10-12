import { encodeAbiParameters, encodePacked, getAddress, isAddress, keccak256, parseAbi,
  toHex, zeroAddress, type Hex } from "viem";
import { AccountSetupError, METROPOLIS_V2_DEPLOYMENT, readAccountSetup } from "./account.ts";
import { MONAD_P256_PRECOMPILE } from "./config.ts";
import { getMonadReadClient } from "./erc8004.ts";
import { METROPOLIS_ORIGIN, selectMetropolisPasskey, webAuthnSignedHash } from "./passkey.ts";

const keyAbi=parseAbi(["function qx() view returns (bytes32)","function qy() view returns (bytes32)"]);
export class PasskeySelectionError extends Error {
  constructor(message:string){super(message);this.name="PasskeySelectionError";}
}

/** Select public browser metadata only after proving possession of the existing
 * account's immutable key. This read-only challenge cannot authorize a payment.
 */
export async function selectExistingAccountPasskey(address:string,origin:string,client=getMonadReadClient()) {
  if(origin!==METROPOLIS_ORIGIN)throw new PasskeySelectionError("Select your existing passkey on the canonical Veyra domain.");
  if(!isAddress(address,{strict:true})||getAddress(address)===zeroAddress) {
    throw new PasskeySelectionError("Enter the full address of your existing V2 account.");
  }
  const account=getAddress(address);
  if(client.chain.id!==10143||await client.getChainId()!==10143)throw new PasskeySelectionError("Passkey selection supports Monad Testnet only.");
  const block=await client.getBlock({blockTag:"finalized"});
  if(block.number===null||!block.hash)throw new PasskeySelectionError("No finalized Monad block was returned.");
  const code=await client.getCode({address:account,blockNumber:block.number});
  if(!code||code==="0x")throw new PasskeySelectionError("This address does not have a deployed V2 account.");
  const [qx,qy]=await Promise.all([
    client.readContract({address:account,abi:keyAbi,functionName:"qx",blockNumber:block.number}),
    client.readContract({address:account,abi:keyAbi,functionName:"qy",blockNumber:block.number}),
  ]);
  const publicKey=`0x${qx.slice(2)}${qy.slice(2)}` as Hex;
  const setup=await readAccountSetup(publicKey,origin,client,block.number,METROPOLIS_V2_DEPLOYMENT.factory);
  if(!setup.accountDeployed||setup.accountAddress!==account||setup.observedBlockHash!==block.hash) {
    throw new PasskeySelectionError("This address does not match the verified V2 factory and account key.");
  }
  const expiresAt=Math.floor(Date.now()/1000)+120;
  const challenge=keccak256(encodeAbiParameters(
    [{type:"bytes32"},{type:"uint256"},{type:"address"},{type:"address"},{type:"string"},{type:"bytes32"},{type:"uint64"},{type:"bytes32"}],
    [keccak256(toHex("Veyra Metropolis existing passkey selection v1")),BigInt(10143),account,setup.factory,origin,
      block.hash,BigInt(expiresAt),toHex(crypto.getRandomValues(new Uint8Array(32)))]));
  const selected=await selectMetropolisPasskey(publicKey,challenge,origin);
  const result=await client.call({to:MONAD_P256_PRECOMPILE,blockNumber:block.number,
    data:encodePacked(["bytes32","bytes32","bytes32","bytes32","bytes32"],
      [webAuthnSignedHash(selected.assertion),selected.assertion.r,selected.assertion.s,qx,qy])});
  if(!result.data||result.data==="0x"||BigInt(result.data)!==BigInt(1)) {
    throw new PasskeySelectionError("The selected passkey does not belong to this account. Choose its original passkey.");
  }
  if(Date.now()>=expiresAt*1000)throw new PasskeySelectionError("The selection request expired. Select your passkey again.");
  // Refresh display data after the owner has answered the browser prompt.
  const fresh=await readAccountSetup(publicKey,origin,client,undefined,METROPOLIS_V2_DEPLOYMENT.factory);
  if(!fresh.accountDeployed||fresh.accountAddress!==account)throw new AccountSetupError("The existing account could not be confirmed.");
  return {credential:selected.credential,setup:fresh};
}
