import { concatHex, isHex, numberToHex, sha256, toBytes, toHex, type Hex } from "viem";
import { createWebAuthnCredential, toWebAuthnAccount } from "viem/account-abstraction";

// Canonical existing Veyra hostname, matching README and release configuration.
// Preview URLs and the alternate Vercel alias must not silently create other credentials.
export const METROPOLIS_ORIGIN = "https://agent-commerce-six.vercel.app";
const P256_ORDER = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
export type MetropolisCredential = {id:string;publicKey:Hex;origin:string};
export type AssertionMetadata = {authenticatorData:Hex;clientDataJSON:string;challengeIndex?:number;typeIndex?:number};

export function requirePasskeyOrigin(origin: string) {
  const url = new URL(origin);
  const local = url.hostname === "localhost" && (url.protocol === "http:" || url.protocol === "https:");
  if (url.origin !== origin || (!local && origin !== METROPOLIS_ORIGIN)) {
    throw new Error("Open Metropolis on the canonical Veyra domain before creating or using a passkey.");
  }
  return url.hostname;
}
export function passkeyCoordinates(publicKey:Hex) {
  if (!/^0x[0-9a-fA-F]{128}$/.test(publicKey)) throw new Error("Expected a P256 public key");
  return {qx:`0x${publicKey.slice(2,66)}` as Hex,qy:`0x${publicKey.slice(66)}` as Hex};
}
export function base64Url(challenge:Hex) {
  return btoa(String.fromCharCode(...toBytes(challenge))).replaceAll("+","-").replaceAll("/","_").replace(/=+$/,"");
}

/** Use viem's browser credential parsing and DER decoding, rather than hand-rolling either. */
export async function createMetropolisPasskey(origin:string):Promise<MetropolisCredential> {
  const rpId = requirePasskeyOrigin(origin);
  const credential = await createWebAuthnCredential({name:"Veyra Metropolis Testnet",
    rp:{id:rpId,name:"Veyra Metropolis"},
    authenticatorSelection:{authenticatorAttachment:"platform",residentKey:"required",requireResidentKey:true,userVerification:"required"},
  });
  passkeyCoordinates(credential.publicKey);
  return {id:credential.id,publicKey:credential.publicKey,origin};
}

/** Match the account's exact JSON/RP/UV restrictions before relaying any assertion. */
export function toContractAssertion(signature:Hex,metadata:AssertionMetadata,challenge:Hex,origin:string) {
  const rpId = requirePasskeyOrigin(origin);
  if (!/^0x[0-9a-fA-F]{128}$/.test(signature) || !isHex(metadata.authenticatorData) || metadata.authenticatorData.length < 76) {
    throw new Error("Malformed WebAuthn assertion");
  }
  const expectedJSON = JSON.stringify({type:"webauthn.get",challenge:base64Url(challenge),origin,crossOrigin:false});
  const flags = parseInt(metadata.authenticatorData.slice(66,68),16);
  if (metadata.clientDataJSON !== expectedJSON || metadata.authenticatorData.slice(0,66).toLowerCase() !== sha256(toHex(rpId)).toLowerCase()
    || (flags & 5) !== 5 || ((flags & 0x10) !== 0 && (flags & 8) === 0)
    || metadata.challengeIndex !== expectedJSON.indexOf('"challenge"') || metadata.typeIndex !== expectedJSON.indexOf('"type"')) {
    throw new Error("The assertion does not match the account's WebAuthn requirements.");
  }
  const r = `0x${signature.slice(2,66)}` as Hex;
  let s = BigInt(`0x${signature.slice(66)}`);
  if (BigInt(r) === BigInt(0) || BigInt(r) >= P256_ORDER || s === BigInt(0) || s >= P256_ORDER) throw new Error("Invalid P256 signature");
  if (s > P256_ORDER / BigInt(2)) s = P256_ORDER - s;
  return {r,s:numberToHex(s,{size:32}),challengeIndex:BigInt(metadata.challengeIndex),typeIndex:BigInt(metadata.typeIndex),
    authenticatorData:metadata.authenticatorData,clientDataJSON:metadata.clientDataJSON};
}
export async function signMetropolisChallenge(credential:MetropolisCredential,challenge:Hex,origin:string) {
  const rpId = requirePasskeyOrigin(origin);
  if (credential.origin !== origin || !/^0x[0-9a-fA-F]{64}$/.test(challenge)) throw new Error("Credential or challenge origin mismatch");
  const result = await toWebAuthnAccount({credential,rpId}).sign({hash:challenge});
  return toContractAssertion(result.signature,result.webauthn,challenge,origin);
}
export function webAuthnSignedHash(assertion:Pick<AssertionMetadata,"authenticatorData"|"clientDataJSON">) {
  return sha256(concatHex([assertion.authenticatorData,sha256(toHex(assertion.clientDataJSON))]));
}
