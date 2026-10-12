import { z } from "zod";
import { encodeAbiParameters, encodeFunctionData, erc20Abi, getAddress, hashTypedData, isAddress, keccak256,
  parseAbi, recoverTypedDataAddress, toHex, zeroAddress, type Hex } from "viem";
import { EIP712_CLEARANCE_TYPES, getTrustGateEip712Domain } from "../trust-gate/sign.ts";
import { TRUST_DECISION_EXPIRY_SECONDS } from "../trust-gate/types.ts";
import { METROPOLIS_TRUST_VERSION } from "./freshness.ts";
import { METROPOLIS_DEPLOYMENT, METROPOLIS_V2_DEPLOYMENT, metropolisAccountProfile, readAccountSetup } from "./account.ts";
import { MONAD_CONTRACTS } from "./config.ts";
import { getMonadReadClient, MONAD_IDENTITY_ABI, readMonadAgentIdentity } from "./erc8004.ts";
import { METROPOLIS_ORIGIN, toContractAssertion } from "./passkey.ts";
import { toPasskeyV2Assertion } from "./passkey-v2.ts";

const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(value => value.toLowerCase() as Hex);
const signature = z.string().regex(/^0x[0-9a-fA-F]{130}$/).transform(value => value.toLowerCase() as Hex);
const address = z.string().refine(value => isAddress(value) && value.toLowerCase() !== zeroAddress)
  .transform(value => getAddress(value));
const uint = z.string().regex(/^(0|[1-9]\d{0,77})$/).refine(value => BigInt(value) < (BigInt(1) << BigInt(256)));
const timestamp = uint.refine(value => BigInt(value) < (BigInt(1) << BigInt(64)));
const publicKey = z.string().regex(/^0x[0-9a-fA-F]{128}$/).transform(value => value.toLowerCase() as Hex);
const amount = z.string().regex(/^(0|[1-9]\d{0,8})(\.\d{1,6})?$/);
const text = z.string().trim().min(1).max(2000);
const taskSchema = z.object({serviceId:z.string().regex(/^[a-zA-Z0-9_.:-]{1,120}$/), request:text, deliverable:text}).strict();
const clearanceSchema = z.object({
  decisionId:hash, subject:address, executor:address, counterparty:address, actionHash:hash,
  requestedAmount:uint, maxAmount:uint, snapshotHash:hash, policyVersion:hash,
  evaluator:z.literal(zeroAddress), issuedAt:timestamp, expiresAt:timestamp,
}).strict();
const quoteSchema = z.object({
  kind:z.literal("veyra.metropolis.purchase"), version:z.literal(1), chainId:z.literal(10143),
  origin:z.literal(METROPOLIS_ORIGIN), factory:z.enum([METROPOLIS_DEPLOYMENT.factory,METROPOLIS_V2_DEPLOYMENT.factory]),
  trustGate:z.literal(METROPOLIS_DEPLOYMENT.trustGate), usdc:z.literal(MONAD_CONTRACTS[10143].usdc),
  accountAddress:address, publicKey, task:taskSchema, budgetUsdc:amount,
  provider:z.object({agentId:uint.refine(value => BigInt(value)>BigInt(0)), payee:address, demonstration:z.boolean()}).strict(),
  policy:z.object({decision:z.enum(["ALLOW","ALLOW_WITH_LIMITS"]), score:z.number().finite().min(0).max(100),
    confidence:z.number().finite().min(0).max(1), coverage:z.number().finite().min(0).max(1),
    reasons:z.array(z.string().max(500)).max(32), disclosures:z.array(z.string().max(2000)).max(64)}).strict(),
  clearance:clearanceSchema, nonce:uint, deadline:timestamp, attester:address,
  clearanceSignature:signature, contextSignature:signature,
}).strict();
export type PurchaseTask = z.infer<typeof taskSchema>;
export type SignedPurchase = z.infer<typeof quoteSchema>;
export type ContractClearance = ReturnType<typeof clearanceMessage>;
export class PaymentError extends Error {
  constructor(message:string) {super(message);this.name="PaymentError";}
}
export const PURCHASE_CONTEXT_TYPES = { PurchaseContext:[
  {name:"quoteHash",type:"bytes32"},{name:"clearanceDigest",type:"bytes32"},
  {name:"nonce",type:"uint256"},{name:"deadline",type:"uint64"},
]} as const;
const clearanceTuple = `(${EIP712_CLEARANCE_TYPES.TrustClearance.map(field=>`${field.type} ${field.name}`).join(",")})`;
export const PAYMENT_ACCOUNT_ABI = parseAbi([
  "function nonce() view returns(uint256)",
  `function approvalChallenge(${clearanceTuple} clearance,uint256 approvalNonce,uint64 deadline) view returns(bytes32)`,
  `function executePayment(${clearanceTuple} clearance,bytes veyraSignature,uint256 approvalNonce,uint64 deadline,(bytes32 r,bytes32 s,uint256 challengeIndex,uint256 typeIndex,bytes authenticatorData,string clientDataJSON) assertion)`,
  "event PaymentExecuted(bytes32 indexed clearanceDigest,address indexed counterparty,uint256 amount,uint256 nonce)",
]);
export const PAYMENT_GATE_ABI = parseAbi([
  `function hashClearance(${clearanceTuple} clearance) view returns(bytes32)`,
  `function verifyClearance(${clearanceTuple} clearance,bytes signature) view returns(bool valid,address signer)`,
  "function consumedClearances(bytes32 digest) view returns(bool)",
  "event TrustClearanceConsumed(bytes32 indexed clearanceDigest,address indexed subject,address indexed counterparty,bytes32 decisionId,bytes32 actionHash,uint256 amount,bytes32 reputationSnapshotHash)",
]);
export function parsePurchaseTask(value:unknown):PurchaseTask {
  const parsed=taskSchema.safeParse(value);
  if(!parsed.success)throw new PaymentError("Provide a service ID, a concrete request and the expected deliverable.");
  return parsed.data;
}
export function purchaseRequestHash(task:PurchaseTask):Hex {
  return keccak256(toHex(JSON.stringify(parsePurchaseTask(task))));
}
export function clearanceMessage(quote:Pick<SignedPurchase,"clearance">) {
  const c=quote.clearance;
  return {...c,requestedAmount:BigInt(c.requestedAmount),maxAmount:BigInt(c.maxAmount),issuedAt:BigInt(c.issuedAt),expiresAt:BigInt(c.expiresAt)};
}
export function purchaseClearance(quote:SignedPurchase) {
  const message=clearanceMessage(quote), domain=getTrustGateEip712Domain(10143,quote.trustGate);
  return {message,domain,digest:hashTypedData({domain,types:EIP712_CLEARANCE_TYPES,primaryType:"TrustClearance",message})};
}
/** Sign the complete displayed context too: clearance alone does not authenticate task prose or score. */
export function purchaseContext(quote:SignedPurchase) {
  const {contextSignature:_,...body}=quote;
  const quoteHash=keccak256(toHex(JSON.stringify(body)));
  return {domain:{name:"Veyra Metropolis Purchase",version:"1",chainId:10143,verifyingContract:quote.accountAddress} as const,
    types:PURCHASE_CONTEXT_TYPES,primaryType:"PurchaseContext" as const,
    message:{quoteHash,clearanceDigest:purchaseClearance(quote).digest,nonce:BigInt(quote.nonce),deadline:BigInt(quote.deadline)}};
}
function amountUnits(value:string) {
  const [whole,fraction=""]=value.split(".");return BigInt(whole)*BigInt(1_000_000)+BigInt(fraction.padEnd(6,"0"));
}
/** Strict canonical parsing prevents display-only fields being injected outside the signed manifest. */
export function parseSignedPurchase(value:unknown):SignedPurchase {
  const parsed=quoteSchema.safeParse(value);
  if(!parsed.success)throw new PaymentError("The purchase package has an invalid or unsupported format.");
  const quote=parsed.data,c=clearanceMessage(quote);
  const action=keccak256(paymentActionEncoding(quote.provider.payee,c.requestedAmount));
  if(c.executor!==quote.accountAddress||c.subject!==quote.provider.payee||c.counterparty!==quote.provider.payee
    ||c.counterparty===quote.accountAddress||c.requestedAmount<=BigInt(0)||c.requestedAmount>c.maxAmount
    ||c.requestedAmount>amountUnits(quote.budgetUsdc)||c.maxAmount>amountUnits(quote.budgetUsdc)
    ||BigInt(c.decisionId)===BigInt(0)||BigInt(c.snapshotHash)===BigInt(0)||c.actionHash!==action
    ||c.policyVersion!==keccak256(toHex(METROPOLIS_TRUST_VERSION))
    ||c.expiresAt<=c.issuedAt||c.expiresAt-c.issuedAt>BigInt(TRUST_DECISION_EXPIRY_SECONDS)
    ||BigInt(quote.deadline)<=c.issuedAt||BigInt(quote.deadline)>c.expiresAt) {
    throw new PaymentError("The purchase does not bind a valid exact USDC payment and spending limit.");
  }
  return quote;
}
function paymentActionEncoding(payee:SignedPurchase["provider"]["payee"],units:bigint) {
  return encodeAbiParameters([{type:"address"},{type:"uint256"},{type:"bytes"}],
    [MONAD_CONTRACTS[10143].usdc,BigInt(0),encodeFunctionData({abi:erc20Abi,functionName:"transfer",args:[payee,units]})]);
}
export async function verifyPurchaseSignatures(value:unknown) {
  const quote=parseSignedPurchase(value), clearance=purchaseClearance(quote), context=purchaseContext(quote);
  const [signer,contextSigner]=await Promise.all([
    recoverTypedDataAddress({...clearance,types:EIP712_CLEARANCE_TYPES,primaryType:"TrustClearance",signature:quote.clearanceSignature}),
    recoverTypedDataAddress({...context,signature:quote.contextSignature}),
  ]);
  if(signer!==quote.attester||contextSigner!==quote.attester)throw new PaymentError("Veyra's signature does not match this task and payment.");
  return {quote,clearance,context};
}
/** Fresh finalized identity, account and authority reads before each device approval or relay. */
export async function verifyPurchaseState(value:unknown,credentialKey?:Hex,client=getMonadReadClient()) {
  const verified=await verifyPurchaseSignatures(value), {quote,clearance}=verified;
  if(credentialKey&&credentialKey.toLowerCase()!==quote.publicKey)throw new PaymentError("This purchase belongs to a different saved passkey.");
  const setup=await readAccountSetup(quote.publicKey,quote.origin,client,undefined,quote.factory);
  if(!setup.accountDeployed||setup.accountAddress!==quote.accountAddress)throw new PaymentError("The personal account is not deployed for this passkey.");
  const blockNumber=BigInt(setup.observedBlock);
  const [latest,identity,currentPayee,currentOwner,nonce,onchainDigest,gateCheck,challenge]=await Promise.all([
    client.getBlock({blockTag:"latest"}),
    readMonadAgentIdentity(BigInt(quote.provider.agentId),client,"finalized"),
    client.readContract({address:MONAD_CONTRACTS[10143].identityRegistry,abi:MONAD_IDENTITY_ABI,functionName:"getAgentWallet",args:[BigInt(quote.provider.agentId)],blockTag:"latest"}),
    client.readContract({address:MONAD_CONTRACTS[10143].identityRegistry,abi:MONAD_IDENTITY_ABI,functionName:"ownerOf",args:[BigInt(quote.provider.agentId)],blockTag:"latest"}),
    client.readContract({address:quote.accountAddress,abi:PAYMENT_ACCOUNT_ABI,functionName:"nonce",blockNumber}),
    client.readContract({address:quote.trustGate,abi:PAYMENT_GATE_ABI,functionName:"hashClearance",args:[clearance.message],blockNumber}),
    client.readContract({address:quote.trustGate,abi:PAYMENT_GATE_ABI,functionName:"verifyClearance",args:[clearance.message,quote.clearanceSignature],blockNumber}),
    client.readContract({address:quote.accountAddress,abi:PAYMENT_ACCOUNT_ABI,functionName:"approvalChallenge",args:[clearance.message,BigInt(quote.nonce),BigInt(quote.deadline)],blockNumber}),
  ]);
  if(latest.timestamp<clearance.message.issuedAt
    ||latest.timestamp>=BigInt(quote.deadline)||BigInt(Math.floor(Date.now()/1000))>=BigInt(quote.deadline)) {
    throw new PaymentError("The purchase has expired or is not yet valid. Prepare a fresh proposal.");
  }
  if(nonce!==BigInt(quote.nonce))throw new PaymentError("The account nonce changed. Prepare a fresh proposal.");
  if(onchainDigest!==clearance.digest||!gateCheck[0]||gateCheck[1]!==quote.attester)throw new PaymentError("TrustGate rejected this clearance or it was already consumed.");
  const expectedChallenge=keccak256(encodeAbiParameters([
    {type:"bytes32"},{type:"uint256"},{type:"address"},{type:"address"},
    {type:"bytes32"},{type:"bytes32"},{type:"uint256"},{type:"uint64"},
  ],[keccak256(toHex("VeyraPasskeyPayment(uint256 chainId,address account,address trustGate,bytes32 clearanceDigest,bytes32 actionHash,uint256 nonce,uint64 deadline)")),
    BigInt(10143),quote.accountAddress,quote.trustGate,clearance.digest,clearance.message.actionHash,BigInt(quote.nonce),BigInt(quote.deadline)]));
  if(challenge!==expectedChallenge)throw new PaymentError("The deployed account returned an unexpected approval challenge.");
  if(identity.paymentWallet!==quote.provider.payee||currentPayee!==identity.paymentWallet||currentOwner!==identity.owner) {
    throw new PaymentError("The provider's current ERC-8004 owner or payee has changed.");
  }
  if(BigInt(setup.usdcBalanceUnits)<clearance.message.requestedAmount)throw new PaymentError("The account has insufficient Testnet USDC for this purchase.");
  return {...verified,setup,challenge,blockNumber};
}
const assertionSchema=z.object({r:hash,s:hash,challengeIndex:uint,typeIndex:uint,
  authenticatorData:z.string().regex(/^0x(?:[0-9a-fA-F]{2}){37,4096}$/).transform(value=>value.toLowerCase() as Hex),
  clientDataJSON:z.string().max(4096)}).strict();
const approvalSchema=z.object({kind:z.literal("veyra.metropolis.payment-approval"),version:z.literal(1),
  quote:quoteSchema,assertion:assertionSchema}).strict();
export type PaymentApproval=z.infer<typeof approvalSchema>;
export function parsePaymentApproval(value:unknown):PaymentApproval {
  const parsed=approvalSchema.safeParse(value);
  if(!parsed.success)throw new PaymentError("Invalid payment approval package.");
  return {...parsed.data,quote:parseSignedPurchase(parsed.data.quote)};
}
export function contractAssertion(approval:PaymentApproval,challenge:Hex) {
  const a=approval.assertion;
  if(BigInt(a.challengeIndex)>BigInt(4096)||BigInt(a.typeIndex)>BigInt(4096))throw new PaymentError("Invalid assertion indices.");
  const parseAssertion=metropolisAccountProfile(approval.quote.factory).accountVersion===2?toPasskeyV2Assertion:toContractAssertion;
  return parseAssertion(`0x${a.r.slice(2)}${a.s.slice(2)}`,{authenticatorData:a.authenticatorData,clientDataJSON:a.clientDataJSON,
    challengeIndex:Number(a.challengeIndex),typeIndex:Number(a.typeIndex)},challenge,approval.quote.origin);
}
/** Actual account execution by eth_call, with both signatures and real USDC balance. No overrides. */
export async function simulatePaymentApproval(value:unknown,client=getMonadReadClient()) {
  const approval=parsePaymentApproval(value),state=await verifyPurchaseState(approval.quote,undefined,client);
  const assertion=contractAssertion(approval,state.challenge);
  const args=[state.clearance.message,approval.quote.clearanceSignature,BigInt(approval.quote.nonce),BigInt(approval.quote.deadline),assertion] as const;
  await client.simulateContract({address:approval.quote.accountAddress,abi:PAYMENT_ACCOUNT_ABI,functionName:"executePayment",args,
    account:approval.quote.attester,blockTag:"latest"});
  return {approval,state,args,data:encodeFunctionData({abi:PAYMENT_ACCOUNT_ABI,functionName:"executePayment",args})};
}
