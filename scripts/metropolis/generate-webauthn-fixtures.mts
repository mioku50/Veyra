import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { encodeAbiParameters, encodeFunctionData, erc20Abi, hashTypedData, keccak256, toBytes, type Hex } from "viem";
import { EIP712_CLEARANCE_TYPES, getTrustGateEip712Domain } from "../../lib/trust-gate/sign.ts";

// Entirely synthetic test accounts. The randomly generated P256 private key lives
// only in this process; neither the key nor any real wallet credentials are saved.
const gate = "0x000000000000000000000000000000000000F002";
const account = "0x000000000000000000000000000000000000F001";
const token = "0x000000000000000000000000000000000000F003";
const seller = "0x0000000000000000000000000000000000000222";
const timestamp = 1_800_000_000n;
const deadline = timestamp + 120n;
const origin = "https://metropolis.example.test";
const rpId = "metropolis.example.test";
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const hashText = (text: string) => keccak256(toBytes(text));
const actionHash = (recipient: Hex, amount: bigint) => keccak256(encodeAbiParameters(
  [{type:"address"}, {type:"uint256"}, {type:"bytes"}],
  [token, 0n, encodeFunctionData({abi:erc20Abi,functionName:"transfer",args:[recipient,amount]})],
));
const clearance = {
  decisionId: hashText("metropolis-test-decision"), subject: seller as Hex, executor: account as Hex, counterparty: seller as Hex,
  actionHash: actionHash(seller,12_000n), requestedAmount:12_000n, maxAmount:20_000n,
  snapshotHash:hashText("metropolis-test-snapshot"), policyVersion:hashText("metropolis-test-policy"),
  evaluator:"0x0000000000000000000000000000000000000000" as Hex, issuedAt:timestamp, expiresAt:timestamp+300n,
};
function challengeFor(message = clearance, nonce = 0n, chainId = 10143n, accountAddress: Hex = account): Hex {
  const digest = hashTypedData({domain:getTrustGateEip712Domain(Number(chainId),gate),types:EIP712_CLEARANCE_TYPES,
    primaryType:"TrustClearance",message});
  return keccak256(encodeAbiParameters(
    [{type:"bytes32"},{type:"uint256"},{type:"address"},{type:"address"},{type:"bytes32"},{type:"bytes32"},{type:"uint256"},{type:"uint64"}],
    [hashText("VeyraPasskeyPayment(uint256 chainId,address account,address trustGate,bytes32 clearanceDigest,bytes32 actionHash,uint256 nonce,uint64 deadline)"),
      chainId,accountAddress,gate,digest,message.actionHash,nonce,deadline],
  ));
}
const { publicKey, privateKey } = generateKeyPairSync("ec", {namedCurve:"prime256v1"});
const jwk = publicKey.export({format:"jwk"});
const coordinate = (input: string) => `0x${Buffer.from(input,"base64url").toString("hex")}` as Hex;
const qx = coordinate(jwk.x!);
const qy = coordinate(jwk.y!);
const tuple = [{type:"tuple", components:[{name:"r",type:"bytes32"},{name:"s",type:"bytes32"},
  {name:"challengeIndex",type:"uint256"},{name:"typeIndex",type:"uint256"},
  {name:"authenticatorData",type:"bytes"},{name:"clientDataJSON",type:"string"}]}] as const;

function assertion(challenge: Hex, flags = 0x05, assertionOrigin = origin, assertionRpId = rpId, signer = privateKey, type = "webauthn.get", extraClientData:Record<string,unknown> = {}, transformClientData:(json:string)=>string = json=>json) {
  const authenticatorData = Buffer.concat([createHash("sha256").update(assertionRpId).digest(), Buffer.from([flags]), Buffer.alloc(4)]);
  const clientDataJSON = transformClientData(JSON.stringify({type,challenge:Buffer.from(challenge.slice(2),"hex").toString("base64url"),origin:assertionOrigin,crossOrigin:false,...extraClientData}));
  const payload = Buffer.concat([authenticatorData,createHash("sha256").update(clientDataJSON).digest()]);
  const sig = sign("sha256",payload,{key:signer,dsaEncoding:"ieee-p1363"});
  const r = `0x${sig.subarray(0,32).toString("hex")}` as Hex;
  let s = BigInt(`0x${sig.subarray(32).toString("hex")}`);
  if (s > N / 2n) s = N - s;
  const auth = {r,s:`0x${s.toString(16).padStart(64,"0")}` as Hex,
    challengeIndex:BigInt(clientDataJSON.indexOf('"challenge"')),typeIndex:BigInt(clientDataJSON.indexOf('"type"')),
    authenticatorData:`0x${authenticatorData.toString("hex")}` as Hex,clientDataJSON};
  return {encoded:encodeAbiParameters(tuple,[auth]),auth,hash:`0x${createHash("sha256").update(payload).digest("hex")}` as Hex};
}
const challenge = challengeFor();
const valid = assertion(challenge);
const wrongKey = generateKeyPairSync("ec",{namedCurve:"prime256v1"}).privateKey;
const variants = {
  valid:valid.encoded,
  extraClientData:assertion(challenge,0x05,origin,rpId,privateKey,"webauthn.get",{
    other_keys_can_be_added_here:"do not compare clientDataJSON against a template",
  }).encoded,
  nestedExtra:assertion(challenge,0x05,origin,rpId,privateKey,"webauthn.get",{
    future:{message:"quotes \" and braces {}",nested:[true,3,{name:"unicode ☃"}]},
  }).encoded,
  crossOrigin:assertion(challenge,0x05,origin,rpId,privateKey,"webauthn.get",{crossOrigin:true,topOrigin:"https://other.example.test"}).encoded,
  reordered:assertion(challenge,0x05,origin,rpId,privateKey,"webauthn.get",{},json=>{
    const data=JSON.parse(json);return JSON.stringify({challenge:data.challenge,type:data.type,origin:data.origin,crossOrigin:false});
  }).encoded,
  nestedRequired:assertion(challenge,0x05,origin,rpId,privateKey,"webauthn.get",{},json=>`{"nested":${json}}`).encoded,
  badDelimiter:assertion(challenge,0x05,origin,rpId,privateKey,"webauthn.get",{},json=>`${json.slice(0,-1)}x}`).encoded,
  missingBoundary:assertion(challenge,0x05,origin,rpId,privateKey,"webauthn.get",{},json=>json.slice(0,-1)).encoded,
  trailingData:assertion(challenge,0x05,origin,rpId,privateKey,"webauthn.get",{},json=>`${json} }`).encoded,
  oversized:assertion(challenge,0x05,origin,rpId,privateKey,"webauthn.get",{future:"x".repeat(4096)}).encoded,
  missingClosingBrace:assertion(challenge,0x05,origin,rpId,privateKey,"webauthn.get",{future:"value"},json=>json.slice(0,-1)).encoded,
  noUP:assertion(challenge,0x04).encoded,
  noUV:assertion(challenge,0x01).encoded,
  invalidBackup:assertion(challenge,0x15).encoded,
  synced:assertion(challenge,0x1d).encoded,
  wrongOrigin:assertion(challenge,0x05,"https://other.example.test").encoded,
  wrongRpId:assertion(challenge,0x05,origin,"other.example.test").encoded,
  wrongType:assertion(challenge,0x05,origin,rpId,privateKey,"webauthn.create").encoded,
  wrongKey:assertion(challenge,0x05,origin,rpId,wrongKey).encoded,
  nextNonce:assertion(challengeFor(clearance,1n)).encoded,
};
const output = fileURLToPath(new URL("../../contracts/monad/test/fixtures/webauthn.json",import.meta.url));
mkdirSync(fileURLToPath(new URL("../../contracts/monad/test/fixtures/",import.meta.url)),{recursive:true});
writeFileSync(output,JSON.stringify({description:"Generated software WebAuthn fixtures; not a real device attestation or a live payment.",
  qx,qy,challenge,deadline:Number(deadline),signedHash:valid.hash,variants},null,2)+"\n");
console.log("Generated public WebAuthn test fixtures; no private keys were saved.");
