import { readFileSync,statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatEther,getAddress,isAddress,keccak256,zeroAddress,type Address } from "viem";
import { getMonadReadClient } from "../../lib/monad/erc8004.ts";
import { PaymentError,simulatePaymentApproval } from "../../lib/monad/payment.ts";

/** No key loading or broadcast. Only a real owner assertion and successful live execution simulation. */
export async function planApprovedPayment(value:unknown,sender:Address,client=getMonadReadClient()) {
  if(!isAddress(sender)||sender===zeroAddress)throw new PaymentError("Provide the public relayer address.");
  const {approval,state,data}=await simulatePaymentApproval(value,client);
  const [nonce,pending,balance,code,fees]=await Promise.all([
    client.getTransactionCount({address:sender,blockTag:"latest"}),client.getTransactionCount({address:sender,blockTag:"pending"}),
    client.getBalance({address:sender}),client.getCode({address:sender}),client.estimateFeesPerGas(),
  ]);
  if(nonce!==pending||code&&code!=="0x")throw new PaymentError("The relayer must be an EOA with no pending transaction.");
  if(fees.maxFeePerGas<=BigInt(0)||fees.maxPriorityFeePerGas<BigInt(0)||fees.maxPriorityFeePerGas>fees.maxFeePerGas)throw new PaymentError("Invalid RPC fee estimate.");
  const estimated=await client.estimateGas({account:sender,to:approval.quote.accountAddress,data,value:BigInt(0),
    maxFeePerGas:fees.maxFeePerGas,maxPriorityFeePerGas:fees.maxPriorityFeePerGas});
  const gas=estimated+(estimated+BigInt(19))/BigInt(20),maximumFee=gas*fees.maxFeePerGas;
  if(estimated<=BigInt(0)||gas>BigInt(1_000_000))throw new PaymentError("The payment exceeds the prototype's relayer gas ceiling.");
  if(balance<maximumFee)throw new PaymentError("The relayer needs more MON for the reviewed gas limit.");
  return {summary:{network:"Monad Testnet",chainId:10143,account:approval.quote.accountAddress,provider:approval.quote.provider,
    task:approval.quote.task,decision:approval.quote.policy.decision,amountUnits:approval.quote.clearance.requestedAmount,
    clearanceDigest:state.clearance.digest,quoteHash:state.context.message.quoteHash,accountNonce:approval.quote.nonce,
    deadline:approval.quote.deadline,relayer:sender,relayerNonce:nonce,callDataHash:keccak256(data),gasLimit:gas.toString(),
    maximumFeeMon:formatEther(maximumFee),simulation:"executePayment passed via eth_call without state overrides",
    broadcast:false,delivery:"not assessed"},
    transaction:{chainId:10143,from:sender,to:approval.quote.accountAddress,nonce,value:"0",data,type:"eip1559",
      gas:gas.toString(),maxFeePerGas:fees.maxFeePerGas.toString(),maxPriorityFeePerGas:fees.maxPriorityFeePerGas.toString()}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const args=process.argv.slice(2);
    if(args.length!==4||args[0]!=="--approval"||args[2]!=="--sender"||!isAddress(args[3]))throw new PaymentError("Use --approval LOCAL_APPROVAL_JSON --sender PUBLIC_RELAYER_ADDRESS.");
    if(statSync(args[1]).size>65536)throw new PaymentError("The approval file is too large.");
    console.log(JSON.stringify(await planApprovedPayment(JSON.parse(readFileSync(args[1],"utf8")),getAddress(args[3])),null,2));
  } catch(error) {
    console.error(error instanceof PaymentError?error.message:"Payment planning failed. No transaction was signed or sent.");process.exitCode=1;
  }
}
