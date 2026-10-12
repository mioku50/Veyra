import assert from "node:assert/strict";
import { createHash,generateKeyPairSync,sign,verify } from "node:crypto";
import { hashTypedData,keccak256,toHex,type Hex } from "viem";
import { METROPOLIS_DEPLOYMENT,METROPOLIS_V2_DEPLOYMENT } from "../../lib/monad/account.ts";
import { MONAD_CONTRACTS } from "../../lib/monad/config.ts";
import { collectMonadEvidence } from "../../lib/monad/evidence.ts";
import { METROPOLIS_ORIGIN,PasskeyCompatibilityError,base64Url,toContractAssertion,toDiagnosticAssertion } from "../../lib/monad/passkey.ts";
import { parseSignedPurchase,verifyPurchaseSignatures,purchaseContext,purchaseRequestHash,parsePurchaseTask,
  parsePaymentApproval,contractAssertion } from "../../lib/monad/payment.ts";
import { issuePurchaseQuote } from "../../lib/monad/purchase-issuer.ts";
import { evaluateMonadPurchase,signMonadClearance,monadApprovalChallenge } from "../../lib/monad/trust.ts";
import { mockClient,policy,assessment,publicTestAttester } from "./trust-tests.mts";

// Synthetic identity/history, public unit-test attester and a real software P256 signature.
// Never load the operator's secret, sign a real-user quote or broadcast to a network.
const now=new Date(),clock=Math.floor(now.getTime()/1000);
export const task=parsePurchaseTask({serviceId:"software-fixture",request:"Local synthetic purchase test",deliverable:"A test result"});
const publicKeyPair=generateKeyPairSync("ec",{namedCurve:"prime256v1"});
const jwk=publicKeyPair.publicKey.export({format:"jwk"});
const softwarePublicKey=`0x${Buffer.from(jwk.x!,"base64url").toString("hex")}${Buffer.from(jwk.y!,"base64url").toString("hex")}` as Hex;
const client=mockClient({clock});
const bundle=await collectMonadEvidence(1n,{...policy,assessments:[await assessment({assessedAt:BigInt(clock-20)})]},client,now);
const intent={executor:"0x000000000000000000000000000000000000F001" as const,amountUsdc:"0.012",budgetUsdc:"0.02",
  serviceId:task.serviceId,requestHash:purchaseRequestHash(task)};
const result=evaluateMonadPurchase(bundle,intent,now);
const signed=await signMonadClearance(result,METROPOLIS_DEPLOYMENT.trustGate,publicTestAttester,now);
const m=signed.message;
const draft=parseSignedPurchase({kind:"veyra.metropolis.purchase",version:1,chainId:10143,origin:METROPOLIS_ORIGIN,
  factory:METROPOLIS_DEPLOYMENT.factory,trustGate:METROPOLIS_DEPLOYMENT.trustGate,usdc:MONAD_CONTRACTS[10143].usdc,
  accountAddress:intent.executor,publicKey:softwarePublicKey,task,budgetUsdc:intent.budgetUsdc,
  provider:{agentId:"1",payee:m.counterparty,demonstration:true},policy:{decision:result.decision.decision,score:result.decision.trust.score,
    confidence:result.decision.trust.confidence,coverage:result.decision.trust.coverage,reasons:result.reasons,disclosures:result.disclosures},
  clearance:{...m,requestedAmount:m.requestedAmount.toString(),maxAmount:m.maxAmount.toString(),issuedAt:m.issuedAt.toString(),expiresAt:m.expiresAt.toString()},
  nonce:"0",deadline:m.expiresAt.toString(),attester:publicTestAttester.address,clearanceSignature:signed.signature,contextSignature:`0x${"00".repeat(65)}`});
export const quote=parseSignedPurchase({...draft,contextSignature:await publicTestAttester.signTypedData(purchaseContext(draft))});
let checks=0;
assert.equal((await verifyPurchaseSignatures(quote)).clearance.digest,signed.digest);checks++;
assert.equal(hashTypedData(purchaseContext(quote)),hashTypedData(purchaseContext(parseSignedPurchase(JSON.parse(JSON.stringify(quote))))));checks++;
for(const changed of [
  {...quote,task:{...quote.task,request:"Changed request"}},
  {...quote,task:{...quote.task,deliverable:"Changed result"}},
  {...quote,task:{...quote.task,serviceId:"other-service"}},
  {...quote,policy:{...quote.policy,score:20}},
  {...quote,policy:{...quote.policy,disclosures:[]}},
  {...quote,provider:{...quote.provider,demonstration:false}},
  {...quote,provider:{...quote.provider,agentId:"2"}},
  {...quote,budgetUsdc:"0.03"},
  {...quote,nonce:"1"},
  {...quote,deadline:(BigInt(quote.deadline)-BigInt(1)).toString()},
  {...quote,factory:METROPOLIS_V2_DEPLOYMENT.factory},
  {...quote,contextSignature:quote.clearanceSignature},
  {...quote,attester:"0x0000000000000000000000000000000000000444"},
]){await assert.rejects(verifyPurchaseSignatures(changed));checks++;}
for(const changed of [null,[],{...quote,privateKey:"forbidden"},{...quote,chainId:143},
  {...quote,factory:"0x0000000000000000000000000000000000000444"},
  {...quote,origin:"https://preview.vercel.app"},{...quote,usdc:MONAD_CONTRACTS[143].usdc},
  {...quote,policy:{...quote.policy,decision:"REVIEW_REQUIRED"}},
  {...quote,clearance:{...quote.clearance,requestedAmount:"12001"}},
  {...quote,clearance:{...quote.clearance,requestedAmount:"0"}},
  {...quote,clearance:{...quote.clearance,requestedAmount:"20001",maxAmount:"20001"}},
  {...quote,clearance:{...quote.clearance,requestedAmount:"-1"}},
  {...quote,clearance:{...quote.clearance,requestedAmount:"01"}},
  {...quote,clearance:{...quote.clearance,evaluator:quote.attester}},
  {...quote,clearance:{...quote.clearance,policyVersion:keccak256(toHex("old-policy"))}},
  {...quote,clearance:{...quote.clearance,policyVersion:keccak256(toHex("veyra-trust-policy-v1:metropolis-evidence-v1"))}},
  {...quote,clearance:{...quote.clearance,expiresAt:(m.issuedAt+BigInt(301)).toString()}},
  {...quote,deadline:(m.expiresAt+BigInt(1)).toString()},
  {...quote,nonce:(BigInt(1)<<BigInt(256)).toString()},
]){assert.throws(()=>parseSignedPurchase(changed));checks++;}
const input={publicKey:softwarePublicKey,task,budgetUsdc:intent.budgetUsdc,agentId:"1",demonstration:true};
await assert.rejects(issuePurchaseQuote({...result},input,publicTestAttester,client,now),/server-issued/);checks++;
const identityOnly=await collectMonadEvidence(1n,{},client,now);
await assert.rejects(issuePurchaseQuote(evaluateMonadPurchase(identityOnly,intent,now),input,publicTestAttester,client,now),/server-issued/);checks++;
await assert.rejects(issuePurchaseQuote(result,{...input,task:{...task,request:"another task"}},publicTestAttester,client,now),/do not match/);checks++;
await assert.rejects(issuePurchaseQuote(result,{...input,budgetUsdc:"0.03"},publicTestAttester,client,now),/budget does not match/);checks++;

const challenge=monadApprovalChallenge(signed,0n,m.expiresAt);
const json=JSON.stringify({type:"webauthn.get",challenge:base64Url(challenge),origin:METROPOLIS_ORIGIN,crossOrigin:false});
const authenticatorData=Buffer.concat([createHash("sha256").update(new URL(METROPOLIS_ORIGIN).hostname).digest(),Buffer.from([5]),Buffer.alloc(4)]);
const sig=sign("sha256",Buffer.concat([authenticatorData,createHash("sha256").update(json).digest()]),{key:publicKeyPair.privateKey,dsaEncoding:"ieee-p1363"});
const auth=toContractAssertion(`0x${sig.toString("hex")}`,{authenticatorData:`0x${authenticatorData.toString("hex")}`,clientDataJSON:json,
  challengeIndex:json.indexOf('"challenge"'),typeIndex:json.indexOf('"type"')},challenge,METROPOLIS_ORIGIN);
const approval=parsePaymentApproval({kind:"veyra.metropolis.payment-approval",version:1,quote,assertion:{...auth,challengeIndex:auth.challengeIndex.toString(),typeIndex:auth.typeIndex.toString()}});
assert.deepEqual(contractAssertion(approval,challenge),auth);checks++;
for(const changed of [
  {...approval,assertion:{...approval.assertion,clientDataJSON:json.replace(METROPOLIS_ORIGIN,"https://evil.invalid")}},
  {...approval,assertion:{...approval.assertion,authenticatorData:`0x${"00".repeat(32)}05${"00".repeat(4)}`}},
  {...approval,assertion:{...approval.assertion,authenticatorData:`0x${authenticatorData.toString("hex").slice(0,64)}01${"00".repeat(4)}`}},
  {...approval,assertion:{...approval.assertion,typeIndex:"4097"}},
  {...approval,assertion:{...approval.assertion,r:`0x${"00".repeat(32)}`}},
]){assert.throws(()=>contractAssertion(parsePaymentApproval(changed),challenge));checks++;}
for(const changed of [{...approval,assertion:{...approval.assertion,typeIndex:"-1"}},
  {...approval,assertion:{...approval.assertion,authenticatorData:"0x12"}},
  {...approval,credentialId:"not accepted"}]){assert.throws(()=>parsePaymentApproval(changed));checks++;}
const extendedJSON=JSON.stringify({...JSON.parse(json),other_keys_can_be_added_here:"do not compare clientDataJSON against a template"});
const extendedPayload=Buffer.concat([authenticatorData,createHash("sha256").update(extendedJSON).digest()]);
const extendedSignature=sign("sha256",extendedPayload,{key:publicKeyPair.privateKey,dsaEncoding:"ieee-p1363"});
const extendedMetadata={authenticatorData:`0x${authenticatorData.toString("hex")}` as Hex,clientDataJSON:extendedJSON,
  challengeIndex:extendedJSON.indexOf('"challenge"'),typeIndex:extendedJSON.indexOf('"type"')};
assert.equal(verify("sha256",extendedPayload,{key:publicKeyPair.publicKey,dsaEncoding:"ieee-p1363"},extendedSignature),true);checks++;
assert.equal(toDiagnosticAssertion(`0x${extendedSignature.toString("hex")}`,extendedMetadata,challenge,METROPOLIS_ORIGIN).clientDataJSON,extendedJSON);checks++;
assert.throws(()=>toContractAssertion(`0x${extendedSignature.toString("hex")}`,extendedMetadata,challenge,METROPOLIS_ORIGIN),PasskeyCompatibilityError);checks++;
const v2Draft=parseSignedPurchase({...quote,factory:METROPOLIS_V2_DEPLOYMENT.factory});
const v2Quote=parseSignedPurchase({...v2Draft,contextSignature:await publicTestAttester.signTypedData(purchaseContext(v2Draft))});
assert.equal((await verifyPurchaseSignatures(v2Quote)).quote.factory,METROPOLIS_V2_DEPLOYMENT.factory);checks++;
const v2Auth=toDiagnosticAssertion(`0x${extendedSignature.toString("hex")}`,extendedMetadata,challenge,METROPOLIS_ORIGIN);
const v2Approval=parsePaymentApproval({...approval,quote:v2Quote,assertion:{...v2Auth,challengeIndex:v2Auth.challengeIndex.toString(),typeIndex:v2Auth.typeIndex.toString()}});
assert.equal(contractAssertion(v2Approval,challenge).clientDataJSON,extendedJSON);checks++;
assert.throws(()=>contractAssertion({...v2Approval,quote},challenge),PasskeyCompatibilityError);checks++;
for(const invalid of [extendedJSON.replace('"crossOrigin":false','"crossOrigin":true'),
  extendedJSON.replace(METROPOLIS_ORIGIN,"https://evil.invalid"),
  `${json.slice(0,-1)},"challenge":"${base64Url(challenge)}"}`]) {
  assert.throws(()=>contractAssertion({...v2Approval,assertion:{...v2Approval.assertion,clientDataJSON:invalid}},challenge));checks++;
}
assert.equal(verify("sha256",Buffer.concat([authenticatorData,createHash("sha256").update(json).digest()]),
  {key:publicKeyPair.publicKey,dsaEncoding:"ieee-p1363"},extendedSignature),false,"Removing browser fields invalidates the actual signature");checks++;
for(const invalid of [
  extendedJSON.replace('"crossOrigin":false','"crossOrigin":true'),
  extendedJSON.replace(METROPOLIS_ORIGIN,"https://evil.invalid"),
  extendedJSON.replace(base64Url(challenge),base64Url(`0x${"00".repeat(32)}`)),
  `${json.slice(0,-1)},"challenge":"${base64Url(challenge)}"}`,
  `${json.slice(0,-1)},"type":"webauthn.get"}`,
  JSON.stringify({nested:JSON.parse(json)}),
  `${extendedJSON} `,
  "null",
]) {assert.throws(()=>toDiagnosticAssertion(`0x${extendedSignature.toString("hex")}`,{...extendedMetadata,clientDataJSON:invalid},challenge,METROPOLIS_ORIGIN));checks++;}
console.log(`Purchase package PASS: ${checks} signed-context, exact amount, provenance, domain and WebAuthn checks. Synthetic fixtures only.`);
