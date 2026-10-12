import assert from "node:assert/strict";
import { encodeEventTopics,encodeFunctionData,erc20Abi,toHex,zeroAddress,type Address,type Hex } from "viem";
import { generatePrivateKey,privateKeyToAccount } from "viem/accounts";
import { MONAD_CONTRACTS } from "../../lib/monad/config.ts";
import { getMonadReadClient } from "../../lib/monad/erc8004.ts";
import { readinessTask,READINESS_P256_VECTOR } from "../../lib/monad/readiness.ts";
import { readinessAgentUri } from "../../lib/monad/readiness-registration.ts";
import { checkReadinessTrialOrder,parseReadinessTrialPlan,planReadinessTrial,readinessTrialOrder,verifyReadinessTrialReceipt,planReadinessTrialAssessment,type ReadinessTrialDelivery } from "../../lib/monad/readiness-trial.ts";
import { keccak256,stringToHex } from "viem";

// Cryptographic order tests and deliberately synthetic read-only receipt responses.
// Real native execution and token transfers are tested only on the disposable Monad fork.
const buyer=privateKeyToAccount(generatePrivateKey()),other=privateKeyToAccount(generatePrivateKey());
const owner="0x0000000000000000000000000000000000000777" as const;
const task=readinessTask({publicKey:`0x${READINESS_P256_VECTOR.qx.slice(2)}${READINESS_P256_VECTOR.qy.slice(2)}`,budgetUsdc:"0.02"});
const txHash=`0x${"33".repeat(32)}` as Hex,observedHash=`0x${"11".repeat(32)}` as Hex,blockHash=`0x${"22".repeat(32)}` as Hex;
const data=encodeFunctionData({abi:erc20Abi,functionName:"transfer",args:[owner,12000n]});
const plan=parseReadinessTrialPlan({kind:"veyra.metropolis.readiness-trial-plan",version:1,chainId:10143,buyer:buyer.address,
  provider:{agentId:"2083",registry:MONAD_CONTRACTS[10143].identityRegistry,owner,payee:owner,agentUriHash:keccak256(stringToHex(readinessAgentUri()))},
  task,amountUnits:"12000",amountUsdc:"0.012",observation:{blockNumber:"10",blockHash:observedHash,timestamp:"1000"},expiresAt:"2800",
  transaction:{chainId:10143,from:buyer.address,to:MONAD_CONTRACTS[10143].usdc,nonce:4,value:"0",data,type:"eip1559",gas:"120000",maxFeePerGas:"122000000000",maxPriorityFeePerGas:"2000000000"},
  authorization:"separately_reviewed_manual_trial",policyDecision:"REVIEW_REQUIRED",clearanceIssued:false,passkeyApproval:false,signed:false,broadcast:false});
const signature=await buyer.signTypedData(readinessTrialOrder(plan));
let checks=0;
for(const input of [null,{...plan,chainId:143},{...plan,provider:{...plan.provider,agentId:"0"}},
  {...plan,buyer:owner,transaction:{...plan.transaction,from:owner}}, {...plan,amountUsdc:"0.03",amountUnits:"30000"},
  {...plan,amountUnits:"12001"},{...plan,transaction:{...plan.transaction,data:`${data}00`}},
  {...plan,transaction:{...plan.transaction,value:"1"}}, {...plan,transaction:{...plan.transaction,gas:"300001"}},
  {...plan,transaction:{...plan.transaction,nonce:-1}}, {...plan,expiresAt:"2801"},
  {...plan,policyDecision:"ALLOW"},{...plan,clearanceIssued:true},{...plan,passkeyApproval:true},
  {...plan,provider:{...plan.provider,agentUriHash:txHash}},{...plan,extra:"untrusted"}]) {
  assert.throws(()=>parseReadinessTrialPlan(input));checks++;
}
const log={address:MONAD_CONTRACTS[10143].usdc,topics:encodeEventTopics({abi:erc20Abi,eventName:"Transfer",args:{from:buyer.address,to:owner}}),
  data:toHex(12000n,{size:32}),blockHash,blockNumber:11n,transactionHash:txHash,logIndex:2,transactionIndex:0,removed:false};
const receipt={status:"success",transactionHash:txHash,blockNumber:11n,blockHash,effectiveGasPrice:102000000000n,gasUsed:120000n,logs:[log]};
const transaction={hash:txHash,blockNumber:11n,blockHash,chainId:10143,from:buyer.address,to:MONAD_CONTRACTS[10143].usdc as Address,value:0n,input:data,
  nonce:4,type:"eip1559",gas:120000n,maxFeePerGas:122000000000n,maxPriorityFeePerGas:2000000000n};
type Options={receipt?:Partial<typeof receipt>;transaction?:Partial<typeof transaction>;timestamp?:bigint;observedHash?:Hex;observedNumber?:bigint;finalized?:bigint;owner?:string;wallet?:string;uri?:string;buyerCode?:Hex;chain?:number;
  nonce?:number;pending?:boolean;balance?:bigint;monBalance?:bigint;baseFee?:bigint;simulation?:boolean;estimate?:bigint};
function fake(options:Options={}) {
  return {...getMonadReadClient(),getChainId:async()=>options.chain??10143,
    getTransactionReceipt:async()=>({...receipt,...options.receipt}),getTransaction:async()=>({...transaction,...options.transaction}),
    getCode:async()=>options.buyerCode??"0x",
    getTransactionCount:async(input:{blockTag?:string})=>options.nonce??(input.blockTag==="pending" && options.pending?5:4),
    getBalance:async()=>options.monBalance??1000000000000000000n,
    simulateContract:async()=>({result:options.simulation??true}),estimateGas:async()=>options.estimate??100000n,
    getBlock:async(input:{blockNumber?:bigint;blockTag?:string})=>input.blockTag==="latest"?{number:13n,hash:txHash,timestamp:options.timestamp??1003n,baseFeePerGas:options.baseFee??100000000000n}
      : input.blockTag==="finalized"?{number:options.finalized??13n,hash:txHash,timestamp:1003n}
      : input.blockNumber===10n?{number:options.observedNumber??10n,hash:options.observedHash??observedHash,timestamp:1000n}
      : {number:11n,hash:blockHash,timestamp:options.timestamp??1001n},
    readContract:async(input:{functionName:string})=>input.functionName==="balanceOf"?options.balance??12000n:input.functionName==="ownerOf"?options.owner??owner
      : input.functionName==="getAgentWallet"?options.wallet??owner:options.uri??readinessAgentUri(),
  } as unknown as ReturnType<typeof getMonadReadClient>;
}
const verified=await verifyReadinessTrialReceipt(plan,signature,txHash,fake());
assert.equal(verified.buyer,buyer.address);assert.equal(verified.amountUsdc,"0.012");assert.equal(verified.usdcTransferLogIndex,2);checks++;
assert.equal(verified.clearanceIssued,false);assert.equal(verified.passkeyApproval,false);checks++;
const bad=await other.signTypedData(readinessTrialOrder(plan));
await assert.rejects(verifyReadinessTrialReceipt(plan,bad,txHash,fake()),/buyer must sign/);checks++;
await assert.rejects(verifyReadinessTrialReceipt({...plan,task:readinessTask({...JSON.parse(task.request),budgetUsdc:"0.03"})},signature,txHash,fake()),/buyer must sign/);checks++;
await assert.rejects(verifyReadinessTrialReceipt(plan,"0x" as Hex,txHash,fake()),/buyer must sign/);checks++;
for(const option of [
  {chain:143},{finalized:11n},{observedHash:txHash},{observedNumber:12n},{timestamp:999n},{timestamp:2801n},{buyerCode:"0x6000" as Hex},
  {owner:other.address},{wallet:other.address},{uri:"https://unrelated.invalid"},
  {receipt:{status:"reverted"}},{receipt:{transactionHash:observedHash}},{receipt:{blockHash:observedHash}},
  {receipt:{effectiveGasPrice:123000000000n}},{receipt:{logs:[]}},{receipt:{logs:[log,log]}},
  {receipt:{logs:[{...log,removed:true}]}},{receipt:{logs:[{...log,transactionHash:observedHash}]}},
  {receipt:{logs:[{...log,data:toHex(12001n,{size:32})}]}},
  {receipt:{logs:[{...log,topics:encodeEventTopics({abi:erc20Abi,eventName:"Transfer",args:{from:zeroAddress,to:owner}})}]}},
  {transaction:{from:other.address}},{transaction:{to:other.address}},{transaction:{nonce:5}},
  {transaction:{input:`${data}00` as Hex}},{transaction:{gas:120001n}},{transaction:{value:1n}},
  {transaction:{maxFeePerGas:123000000000n}},{transaction:{maxPriorityFeePerGas:3000000000n}},
  {transaction:{chainId:143}},{transaction:{type:"legacy"}},{transaction:{hash:observedHash}},
] satisfies Options[]) {await assert.rejects(verifyReadinessTrialReceipt(plan,signature,txHash,fake(option)));checks++;}
await assert.rejects(verifyReadinessTrialReceipt(plan,signature,observedHash,fake()));checks++;
assert.throws(()=>planReadinessTrialAssessment({} as ReadinessTrialDelivery,95),/Reverify/);checks++;
await assert.rejects(planReadinessTrial({buyer:owner,agentId:2083n,task,amountUsdc:"0.012"},getMonadReadClient(143)),/Testnet/);checks++;
await assert.rejects(planReadinessTrial({buyer:zeroAddress,agentId:2083n,task,amountUsdc:"0.012"},fake()),/non-provider/);checks++;
await assert.rejects(planReadinessTrial({buyer:buyer.address,agentId:2083n,task,amountUsdc:"0.03"},fake()),/budget/);checks++;
assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.transaction));checks++;
assert.equal((await checkReadinessTrialOrder(plan,signature,fake())).transactionSent,false);checks++;
for(const option of [{chain:143},{nonce:5},{pending:true},{buyerCode:"0x6000" as Hex},{balance:11999n},{monBalance:0n},
  {timestamp:999n},{timestamp:2801n},{baseFee:123000000000n},{wallet:other.address},{owner:other.address},{uri:"unrelated"},
  {simulation:false},{estimate:120001n},{estimate:0n}] satisfies Options[]) {
  await assert.rejects(checkReadinessTrialOrder(plan,signature,fake(option)));checks++;
}
await assert.rejects(checkReadinessTrialOrder(plan,bad,fake()),/buyer must sign/);checks++;
console.log(`Manual readiness trial guards PASS: ${checks} checks; real EIP-712 signatures, synthetic read-only receipts, no external writes.`);
