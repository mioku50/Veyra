import { decodeEventLog, encodeEventTopics, encodeFunctionData, erc20Abi, formatEther, formatUnits, getAddress,
  hashTypedData, isAddress, keccak256, recoverTypedDataAddress, stringToHex, zeroAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import { MONAD_CONTRACTS } from "./config.ts";
import { canonicalMonadHash, deepFreeze, MONAD_ASSESSMENT_TYPES, monadAssessmentDomain } from "./evidence.ts";
import { getMonadReadClient, verifyMonadInfrastructure } from "./erc8004.ts";
import { PaymentError, purchaseRequestHash } from "./payment.ts";
import { generateReadinessReport, readinessResponseHash } from "./readiness.ts";
import { parseReadinessTask } from "./readiness-task.ts";
import { readRegisteredReadinessAgent, readinessAgentUri } from "./readiness-registration.ts";
import { parseMonadUsdc } from "./trust.ts";

// This is an explicit, separately reviewed EOA trial. It cannot issue a clearance,
// execute the passkey account, load signing material or broadcast a transaction.
const MAX_TRIAL_GAS = BigInt(300000);
const TRIAL_WINDOW_SECONDS = BigInt(1800);
const TRIAL_DISCLOSURES=["Separately reviewed manual EOA trial. It is not a Veyra clearance or a passkey payment.",
  "Veyra controls this demonstration provider; separate addresses do not establish independent organizational ownership.",
  "The result is reproducible, but usefulness still requires a human buyer assessment. No favorable ERC-8004 feedback was produced."];
type Client = ReturnType<typeof getMonadReadClient>;
const uint = z.string().regex(/^(0|[1-9]\d{0,19})$/);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(value => value.toLowerCase() as Hex);
const address = z.string().refine(value => isAddress(value) && value !== zeroAddress).transform(value => getAddress(value));
const planSchema = z.object({
  kind: z.literal("veyra.metropolis.readiness-trial-plan"), version: z.literal(1), chainId: z.literal(10143),
  buyer: address,
  provider: z.object({agentId:uint,registry:z.literal(MONAD_CONTRACTS[10143].identityRegistry),owner:address,payee:address,agentUriHash:hash}).strict(),
  task: z.unknown(), amountUnits:uint, amountUsdc:z.string(),
  observation:z.object({blockNumber:uint,blockHash:hash,timestamp:uint}).strict(),
  expiresAt:uint,
  transaction:z.object({chainId:z.literal(10143),from:address,to:z.literal(MONAD_CONTRACTS[10143].usdc),nonce:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    value:z.literal("0"),data:z.string().regex(/^0x[0-9a-fA-F]{136}$/).transform(value=>value.toLowerCase() as Hex),type:z.literal("eip1559"),
    gas:uint,maxFeePerGas:uint,maxPriorityFeePerGas:uint}).strict(),
  authorization:z.literal("separately_reviewed_manual_trial"), policyDecision:z.literal("REVIEW_REQUIRED"),
  clearanceIssued:z.literal(false),passkeyApproval:z.literal(false),signed:z.literal(false),broadcast:z.literal(false),
}).strict();
const uriHash = () => keccak256(stringToHex(readinessAgentUri()));
function transferData(payee:Address,amount:bigint) {
  return encodeFunctionData({abi:erc20Abi,functionName:"transfer",args:[payee,amount]});
}
export function parseReadinessTrialPlan(value:unknown) {
  const parsed=planSchema.safeParse(value);
  if(!parsed.success)throw new PaymentError("Invalid manual readiness trial plan.");
  const plan=parsed.data,{task,request}=parseReadinessTask(plan.task),amount=parseMonadUsdc(plan.amountUsdc);
  const tx=plan.transaction;
  if(BigInt(plan.provider.agentId)<=BigInt(0) || BigInt(plan.observation.blockNumber)<=BigInt(0) || plan.provider.agentUriHash!==uriHash()
    || [plan.provider.owner,plan.provider.payee].some(item=>item.toLowerCase()===plan.buyer.toLowerCase())
    || tx.from!==plan.buyer || tx.data!==transferData(plan.provider.payee,amount) || amount.toString()!==plan.amountUnits
    || plan.amountUsdc!==formatUnits(amount,6) || amount>parseMonadUsdc(request.budgetUsdc)
    || BigInt(plan.expiresAt)!==BigInt(plan.observation.timestamp)+TRIAL_WINDOW_SECONDS
    || BigInt(tx.gas)<=BigInt(0) || BigInt(tx.gas)>MAX_TRIAL_GAS || BigInt(tx.maxFeePerGas)<=BigInt(0)
    || BigInt(tx.maxPriorityFeePerGas)>BigInt(tx.maxFeePerGas))throw new PaymentError("Manual trial task, buyer, provider, budget or transaction binding is invalid.");
  return deepFreeze({...plan,task});
}
export type ReadinessTrialPlan = ReturnType<typeof parseReadinessTrialPlan>;

/** Public reads and simulation only. A new identity never becomes policy-allowed here. */
export async function planReadinessTrial(input:{buyer:Address;agentId:bigint;task:unknown;amountUsdc:string},client:Client=getMonadReadClient()) {
  if(client.chain.id!==10143 || await client.getChainId()!==10143)throw new PaymentError("Manual readiness trials support Monad Testnet only.");
  if(!isAddress(input.buyer) || input.buyer===zeroAddress)throw new PaymentError("Provide a non-provider public EOA buyer address.");
  const buyer=getAddress(input.buyer),{task,request}=parseReadinessTask(input.task),amount=parseMonadUsdc(input.amountUsdc);
  if(amount>parseMonadUsdc(request.budgetUsdc))throw new PaymentError("The trial amount exceeds the task budget.");
  const infrastructure=await verifyMonadInfrastructure(client,"finalized");
  const block=await client.getBlock({blockNumber:infrastructure.blockNumber});
  if(!block.hash || block.number!==infrastructure.blockNumber)throw new PaymentError("The trial has no canonical finalized observation.");
  const provider=await readRegisteredReadinessAgent(input.agentId,block.number,client);
  if(provider.tokenURI!==readinessAgentUri() || [provider.owner,provider.wallet].some(item=>item.toLowerCase()===buyer.toLowerCase())) {
    throw new PaymentError("Select the registered readiness demo and a buyer distinct from its owner and payment wallet.");
  }
  // Validate the public P256 key and deployed infrastructure even for an EOA-funded trial.
  await generateReadinessReport(task,client,block.number);
  const [nonce,pending,code,balance,monBalance,fees]=await Promise.all([
    client.getTransactionCount({address:buyer,blockTag:"latest"}),client.getTransactionCount({address:buyer,blockTag:"pending"}),
    client.getCode({address:buyer}),client.readContract({address:MONAD_CONTRACTS[10143].usdc,abi:erc20Abi,functionName:"balanceOf",args:[buyer],blockNumber:block.number}),
    client.getBalance({address:buyer}),client.estimateFeesPerGas(),
  ]);
  if(nonce!==pending || code && code!=="0x")throw new PaymentError("The manual trial buyer must be an EOA without pending transactions.");
  if(balance<amount)throw new PaymentError("The buyer needs finalized Testnet USDC for the exact trial amount.");
  if(fees.maxFeePerGas<=BigInt(0) || fees.maxPriorityFeePerGas<BigInt(0) || fees.maxPriorityFeePerGas>fees.maxFeePerGas)throw new PaymentError("Invalid RPC fee estimate.");
  const simulation=await client.simulateContract({address:MONAD_CONTRACTS[10143].usdc,abi:erc20Abi,functionName:"transfer",args:[provider.wallet,amount],account:buyer});
  if(simulation.result!==true)throw new PaymentError("The USDC transfer simulation did not succeed.");
  const data=transferData(provider.wallet,amount);
  const estimate=await client.estimateGas({account:buyer,to:MONAD_CONTRACTS[10143].usdc,data,value:BigInt(0),...fees});
  const gas=estimate+(estimate+BigInt(19))/BigInt(20);
  if(estimate<=BigInt(0) || gas>MAX_TRIAL_GAS)throw new PaymentError("The trial exceeds its explicit gas ceiling.");
  if(monBalance<gas*fees.maxFeePerGas)throw new PaymentError("The buyer needs MON for the reviewed gas limit.");
  const plan=parseReadinessTrialPlan({
    kind:"veyra.metropolis.readiness-trial-plan",version:1,chainId:10143,buyer,
    provider:{agentId:input.agentId.toString(),registry:MONAD_CONTRACTS[10143].identityRegistry,owner:provider.owner,payee:provider.wallet,agentUriHash:uriHash()},
    task,amountUnits:amount.toString(),amountUsdc:formatUnits(amount,6),
    observation:{blockNumber:block.number.toString(),blockHash:block.hash,timestamp:block.timestamp.toString()},expiresAt:(block.timestamp+TRIAL_WINDOW_SECONDS).toString(),
    transaction:{chainId:10143,from:buyer,to:MONAD_CONTRACTS[10143].usdc,nonce,value:"0",data,type:"eip1559",gas:gas.toString(),
      maxFeePerGas:fees.maxFeePerGas.toString(),maxPriorityFeePerGas:fees.maxPriorityFeePerGas.toString()},
    authorization:"separately_reviewed_manual_trial",policyDecision:"REVIEW_REQUIRED",clearanceIssued:false,passkeyApproval:false,signed:false,broadcast:false,
  });
  return deepFreeze({plan,buyerOrder:readinessTrialOrder(plan),summary:{amountUsdc:plan.amountUsdc,
    maximumFeeMon:formatEther(gas*fees.maxFeePerGas),requestHash:purchaseRequestHash(task),callDataHash:keccak256(data),
    simulation:"Exact USDC transfer passed eth_call without state overrides.",
    disclosures:["A separately reviewed manual trial; Veyra has not allowed a passkey purchase or autonomous spending.",
      "The task binding is an offchain buyer signature. USDC.transfer does not put the request hash onchain.",
      "A transfer alone proves no delivery. No favorable review or usefulness score is selected automatically."]}});
}

export const READINESS_TRIAL_TYPES={ManualReadinessTrial:[
  {name:"planHash",type:"bytes32"},{name:"buyer",type:"address"},{name:"agentId",type:"uint256"},
  {name:"payee",type:"address"},{name:"token",type:"address"},{name:"amount",type:"uint256"},
  {name:"requestHash",type:"bytes32"},{name:"nonce",type:"uint256"},{name:"issuedAt",type:"uint64"},{name:"expiresAt",type:"uint64"},
]} as const;
export function readinessTrialOrder(value:unknown) {
  const plan=parseReadinessTrialPlan(value);
  return {domain:{name:"Veyra Metropolis Manual Trial",version:"1",chainId:10143,verifyingContract:MONAD_CONTRACTS[10143].identityRegistry},
    types:READINESS_TRIAL_TYPES,primaryType:"ManualReadinessTrial" as const,
    message:{planHash:canonicalMonadHash(plan),buyer:plan.buyer,agentId:BigInt(plan.provider.agentId),payee:plan.provider.payee,
      token:MONAD_CONTRACTS[10143].usdc,amount:BigInt(plan.amountUnits),requestHash:purchaseRequestHash(plan.task),nonce:BigInt(plan.transaction.nonce),
      issuedAt:BigInt(plan.observation.timestamp),expiresAt:BigInt(plan.expiresAt)}};
}
async function signedTrial(value:unknown,signature:Hex) {
  const plan=parseReadinessTrialPlan(value),order=readinessTrialOrder(plan);
  if(!/^0x[0-9a-fA-F]{130}$/.test(signature) || (await recoverTypedDataAddress({...order,signature})).toLowerCase()!==plan.buyer.toLowerCase()) {
    throw new PaymentError("The buyer must sign this exact manual trial task, transaction and fee ceiling.");
  }
  return {plan,order};
}
/** Fresh, read-only preflight of the buyer-signed order before a separately approved EOA send. */
export async function checkReadinessTrialOrder(value:unknown,signature:Hex,client:Client=getMonadReadClient()) {
  const {plan,order}=await signedTrial(value,signature);
  if(client.chain.id!==10143 || await client.getChainId()!==10143)throw new PaymentError("Manual readiness trials support Monad Testnet only.");
  const tx=plan.transaction;
  const [latest,nonce,pending,code,balance,monBalance]=await Promise.all([
    client.getBlock({blockTag:"latest"}),client.getTransactionCount({address:plan.buyer,blockTag:"latest"}),
    client.getTransactionCount({address:plan.buyer,blockTag:"pending"}),client.getCode({address:plan.buyer}),
    client.readContract({address:tx.to,abi:erc20Abi,functionName:"balanceOf",args:[plan.buyer]}),client.getBalance({address:plan.buyer}),
  ]);
  if(latest.timestamp<BigInt(plan.observation.timestamp) || latest.timestamp>BigInt(plan.expiresAt)
    || nonce!==tx.nonce || pending!==nonce || code && code!=="0x" || balance<BigInt(plan.amountUnits)
    || monBalance<BigInt(tx.gas)*BigInt(tx.maxFeePerGas) || latest.baseFeePerGas===null
    || latest.baseFeePerGas+BigInt(tx.maxPriorityFeePerGas)>BigInt(tx.maxFeePerGas))throw new PaymentError("The buyer nonce, funds, fee cap or trial window changed; prepare a new reviewable plan.");
  const identity=await readRegisteredReadinessAgent(BigInt(plan.provider.agentId),latest.number,client);
  if(identity.owner!==plan.provider.owner || identity.wallet!==plan.provider.payee || identity.tokenURI!==readinessAgentUri())throw new PaymentError("The provider identity changed; prepare a new trial plan.");
  const simulation=await client.simulateContract({address:tx.to,abi:erc20Abi,functionName:"transfer",args:[plan.provider.payee,BigInt(plan.amountUnits)],
    account:plan.buyer,gas:BigInt(tx.gas),maxFeePerGas:BigInt(tx.maxFeePerGas),maxPriorityFeePerGas:BigInt(tx.maxPriorityFeePerGas)});
  const estimate=await client.estimateGas({account:plan.buyer,to:tx.to,data:tx.data,value:BigInt(0),maxFeePerGas:BigInt(tx.maxFeePerGas),maxPriorityFeePerGas:BigInt(tx.maxPriorityFeePerGas)});
  if(simulation.result!==true || estimate<=BigInt(0) || estimate>BigInt(tx.gas))throw new PaymentError("The exact transfer no longer fits the buyer-approved gas limit.");
  return deepFreeze({orderHash:hashTypedData(order),buyer:plan.buyer,amountUsdc:plan.amountUsdc,
    simulation:"Exact transfer passed eth_call within the signed fee and gas ceilings.",clearanceIssued:false,transactionSent:false});
}
/** A successful EOA token transfer bound to a real buyer's signed trial; no TrustGate/passkey claim. */
export async function verifyReadinessTrialReceipt(value:unknown,signature:Hex,transactionHash:Hex,client:Client=getMonadReadClient()) {
  const {plan,order}=await signedTrial(value,signature);
  if(client.chain.id!==10143 || await client.getChainId()!==10143 || !/^0x[0-9a-fA-F]{64}$/.test(transactionHash))throw new PaymentError("Provide a Monad Testnet trial transaction hash.");
  const [receipt,tx,finalized]=await Promise.all([client.getTransactionReceipt({hash:transactionHash}),client.getTransaction({hash:transactionHash}),client.getBlock({blockTag:"finalized"})]);
  if(receipt.status!=="success" || receipt.transactionHash.toLowerCase()!==transactionHash.toLowerCase()
    || finalized.number<receipt.blockNumber+BigInt(1))throw new PaymentError("The trial transfer failed or is not sufficiently finalized.");
  const [block,observed,identity,code]=await Promise.all([
    client.getBlock({blockNumber:receipt.blockNumber}),client.getBlock({blockNumber:BigInt(plan.observation.blockNumber)}),
    readRegisteredReadinessAgent(BigInt(plan.provider.agentId),finalized.number,client),client.getCode({address:plan.buyer,blockNumber:receipt.blockNumber}),
  ]);
  const expected=plan.transaction;
  if(block.number!==receipt.blockNumber || block.hash!==receipt.blockHash || observed.number!==BigInt(plan.observation.blockNumber) || observed.hash!==plan.observation.blockHash
    || observed.timestamp!==BigInt(plan.observation.timestamp) || receipt.blockNumber<BigInt(plan.observation.blockNumber)
    || block.timestamp<BigInt(plan.observation.timestamp) || block.timestamp>BigInt(plan.expiresAt)
    || tx.hash.toLowerCase()!==transactionHash.toLowerCase() || tx.blockNumber!==receipt.blockNumber || tx.blockHash!==receipt.blockHash
    || tx.chainId!==10143 || tx.from.toLowerCase()!==plan.buyer.toLowerCase() || tx.to?.toLowerCase()!==expected.to.toLowerCase()
    || tx.value!==BigInt(0) || tx.input!==expected.data || tx.nonce!==expected.nonce || tx.type!=="eip1559"
    || tx.gas<=BigInt(0) || tx.gas>BigInt(expected.gas) || tx.maxFeePerGas>BigInt(expected.maxFeePerGas)
    || tx.maxPriorityFeePerGas>BigInt(expected.maxPriorityFeePerGas) || receipt.effectiveGasPrice>BigInt(expected.maxFeePerGas)
    || code && code!=="0x" || identity.owner!==plan.provider.owner || identity.wallet!==plan.provider.payee || identity.tokenURI!==readinessAgentUri()) {
    throw new PaymentError("The receipt, current identity or fee does not match the exact signed manual trial.");
  }
  for(const height of [BigInt(plan.observation.blockNumber),receipt.blockNumber]) {
    const historical=await readRegisteredReadinessAgent(BigInt(plan.provider.agentId),height,client);
    if(historical.owner!==plan.provider.owner || historical.wallet!==plan.provider.payee || historical.tokenURI!==readinessAgentUri())throw new PaymentError("The provider identity changed during the trial.");
  }
  if(receipt.logs.some(log=>log.removed || log.blockHash!==receipt.blockHash || log.blockNumber!==receipt.blockNumber
    || log.transactionHash.toLowerCase()!==transactionHash.toLowerCase()))throw new PaymentError("Trial receipt log provenance mismatch.");
  const topic=encodeEventTopics({abi:erc20Abi,eventName:"Transfer"})[0];
  const transfers=receipt.logs.filter(log=>log.address.toLowerCase()===expected.to.toLowerCase() && log.topics[0]===topic);
  if(transfers.length!==1)throw new PaymentError("The trial requires one unambiguous canonical USDC Transfer.");
  const transfer=decodeEventLog({abi:erc20Abi,eventName:"Transfer",data:transfers[0].data,topics:transfers[0].topics});
  if(transfer.args.from!==plan.buyer || transfer.args.to!==plan.provider.payee || transfer.args.value!==BigInt(plan.amountUnits))throw new PaymentError("The USDC event does not match the exact trial amount and parties.");
  return deepFreeze({kind:"veyra.metropolis.readiness-trial-receipt" as const,version:1,chainId:10143,transactionHash:receipt.transactionHash,
    blockNumber:receipt.blockNumber.toString(),blockHash:receipt.blockHash,finalizedBlock:finalized.number.toString(),buyer:plan.buyer,provider:plan.provider,
    task:plan.task,amountUnits:plan.amountUnits,amountUsdc:plan.amountUsdc,orderHash:hashTypedData(order),requestHash:purchaseRequestHash(plan.task),
    chargedGasMon:formatEther(tx.gas*receipt.effectiveGasPrice),usdcTransferLogIndex:transfers[0].logIndex,payment:"confirmed",delivery:"not_assessed",
    authorization:"manual_eoa_trial",clearanceIssued:false,passkeyApproval:false});
}

const deliveries=new WeakSet<object>();
export async function fulfillReadinessTrial(plan:unknown,signature:Hex,hash:Hex,client:Client=getMonadReadClient()) {
  const payment=await verifyReadinessTrialReceipt(plan,signature,hash,client);
  const report=await generateReadinessReport(payment.task,client);
  if(BigInt(report.observation.blockNumber)<=BigInt(payment.blockNumber))throw new PaymentError("The trial result must observe a finalized block after its payment.");
  const delivery=deepFreeze({kind:"veyra.metropolis.readiness-trial-delivery" as const,version:1,chainId:10143,payment,report,
    requestHash:payment.requestHash,responseHash:readinessResponseHash(report),result:"available",assessment:"not_signed",
    disclosures:[...TRIAL_DISCLOSURES]});
  deliveries.add(delivery);return delivery;
}
export type ReadinessTrialDelivery=Awaited<ReturnType<typeof fulfillReadinessTrial>>;
export async function verifyReadinessTrialDelivery(value:unknown,plan:unknown,signature:Hex,hash:Hex,client:Client=getMonadReadClient()) {
  const candidate=z.object({kind:z.literal("veyra.metropolis.readiness-trial-delivery"),version:z.literal(1),chainId:z.literal(10143),
    payment:z.record(z.unknown()),report:z.unknown(),
    requestHash:z.string(),responseHash:z.string(),result:z.literal("available"),assessment:z.literal("not_signed"),disclosures:z.array(z.string())}).strict().safeParse(value);
  if(!candidate.success)throw new PaymentError("Invalid manual trial delivery artifact.");
  const data=candidate.data,payment=await verifyReadinessTrialReceipt(plan,signature,hash,client);
  // Preserve the exact generated JSON report while separately checking its bound.
  // Parsing the whole report as a passthrough object would reorder its fields.
  const observation=z.object({observation:z.object({blockNumber:uint}).passthrough()}).passthrough().safeParse(data.report);
  if(!observation.success)throw new PaymentError("The trial report has no valid observation block.");
  const height=BigInt(observation.data.observation.blockNumber);
  if(height<=BigInt(payment.blockNumber))throw new PaymentError("A free prepayment preview cannot serve as paid trial delivery.");
  const report=await generateReadinessReport(payment.task,client,height);
  const {finalizedBlock:oldHeight,...oldPayment}=data.payment,{finalizedBlock:_,...currentPayment}=payment;
  if(data.requestHash!==payment.requestHash || data.responseHash!==readinessResponseHash(report)
    || canonicalMonadHash(data.report)!==canonicalMonadHash(report) || canonicalMonadHash(oldPayment)!==canonicalMonadHash(currentPayment)
    || typeof oldHeight!=="string" || !uint.safeParse(oldHeight).success || BigInt(oldHeight)<BigInt(payment.blockNumber)+BigInt(1)
    || BigInt(oldHeight)>BigInt(payment.finalizedBlock))throw new PaymentError("The saved trial result or payment does not match the canonical task and snapshot.");
  const delivery=deepFreeze({...data,payment,report,requestHash:payment.requestHash,responseHash:readinessResponseHash(report),
    disclosures:[...TRIAL_DISCLOSURES]});deliveries.add(delivery);return delivery;
}
/** Only the actual buyer can assess this manual trial. The human supplies the score. */
export function planReadinessTrialAssessment(delivery:ReadinessTrialDelivery,score:number,now=new Date()) {
  if(!deliveries.has(delivery))throw new PaymentError("Reverify the manual trial payment and result before assessment.");
  if(!Number.isInteger(score) || score<0 || score>100)throw new PaymentError("A human usefulness score from zero to 100 is required.");
  const assessedAt=Math.floor(now.getTime()/1000);
  if(!Number.isSafeInteger(assessedAt) || BigInt(assessedAt)<BigInt(delivery.report.observation.timestamp))throw new PaymentError("The assessment must follow the delivered result.");
  const p=delivery.payment;
  return deepFreeze({kind:"veyra.metropolis.readiness-trial-assessment-plan",version:1,reporter:p.buyer,
    typedData:{domain:monadAssessmentDomain(),types:MONAD_ASSESSMENT_TYPES,primaryType:"DeliveryAssessment" as const,
      message:{agentId:p.provider.agentId,buyer:p.buyer,seller:p.provider.payee,amount:p.amountUnits,paymentTx:p.transactionHash,
        requestHash:delivery.requestHash,responseHash:delivery.responseHash,delivered:true,score,assessedAt:assessedAt.toString()}},
    paymentReference:{transactionHash:p.transactionHash,logIndex:p.usdcTransferLogIndex},unsigned:true,broadcast:false,
    disclosure:"Actual buyer assessment of a Veyra-created demo; not independent validation or an ERC-8004 review."});
}
