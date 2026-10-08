import { decodeEventLog, erc20Abi, formatEther, formatUnits, getAddress, keccak256, zeroAddress, type Hex } from "viem";
import { getMonadReadClient } from "./erc8004.ts";
import { readAccountSetup } from "./account.ts";
import { PAYMENT_ACCOUNT_ABI, PAYMENT_GATE_ABI, PaymentError, parsePaymentApproval,
  verifyPurchaseSignatures, contractAssertion } from "./payment.ts";
import { monadApprovalChallenge } from "./trust.ts";
import { encodeFunctionData } from "viem";

/** A confirmed transfer is recorded separately from an unassessed service result. */
export async function verifyPaymentReceipt(value:unknown,transactionHash:Hex,client=getMonadReadClient()) {
  if(!/^0x[0-9a-fA-F]{64}$/.test(transactionHash))throw new PaymentError("Provide a transaction hash.");
  const approval=parsePaymentApproval(value),{quote,clearance,context}=await verifyPurchaseSignatures(approval.quote);
  const setup=await readAccountSetup(quote.publicKey,quote.origin,client);
  if(!setup.accountDeployed||setup.accountAddress!==quote.accountAddress)throw new PaymentError("The receipt account does not match this passkey.");
  const [receipt,tx,finalized]=await Promise.all([client.getTransactionReceipt({hash:transactionHash}),
    client.getTransaction({hash:transactionHash}),client.getBlock({blockTag:"finalized"})]);
  if(receipt.status!=="success"||receipt.transactionHash.toLowerCase()!==transactionHash.toLowerCase()
    ||finalized.number<receipt.blockNumber+BigInt(1))throw new PaymentError("The payment failed or is not sufficiently finalized yet.");
  const block=await client.getBlock({blockNumber:receipt.blockNumber});
  if(block.hash!==receipt.blockHash||block.timestamp<clearance.message.issuedAt||block.timestamp>BigInt(quote.deadline)) {
    throw new PaymentError("The payment receipt is outside its canonical approval window.");
  }
  const challenge=monadApprovalChallenge(clearance,BigInt(quote.nonce),BigInt(quote.deadline));
  const assertion=contractAssertion(approval,challenge);
  const data=encodeFunctionData({abi:PAYMENT_ACCOUNT_ABI,functionName:"executePayment",
    args:[clearance.message,quote.clearanceSignature,BigInt(quote.nonce),BigInt(quote.deadline),assertion]});
  if(tx.chainId!==10143||getAddress(tx.to??zeroAddress)!==quote.accountAddress||tx.value!==BigInt(0)||keccak256(tx.input)!==keccak256(data)) {
    throw new PaymentError("The transaction does not execute this exact approved payment.");
  }
  const relevant=(address:string)=>receipt.logs.filter(log=>log.address.toLowerCase()===address.toLowerCase());
  const payments=relevant(quote.accountAddress).map(log=>decodeEventLog({abi:PAYMENT_ACCOUNT_ABI,data:log.data,topics:log.topics}));
  const transfers=relevant(quote.usdc).map(log=>decodeEventLog({abi:erc20Abi,data:log.data,topics:log.topics}));
  const gates=relevant(quote.trustGate).map(log=>decodeEventLog({abi:PAYMENT_GATE_ABI,data:log.data,topics:log.topics}));
  if(payments.length!==1||transfers.length!==1||gates.length!==1
    ||payments[0].eventName!=="PaymentExecuted"||transfers[0].eventName!=="Transfer"||gates[0].eventName!=="TrustClearanceConsumed") {
    throw new PaymentError("The receipt is missing an unambiguous account, TrustGate and USDC event.");
  }
  const p=payments[0].args,t=transfers[0].args,g=gates[0].args,m=clearance.message;
  if(p.clearanceDigest!==clearance.digest||p.counterparty!==quote.provider.payee||p.amount!==m.requestedAmount||p.nonce!==BigInt(quote.nonce)
    ||t.from!==quote.accountAddress||t.to!==quote.provider.payee||t.value!==m.requestedAmount
    ||g.clearanceDigest!==clearance.digest||g.subject!==m.subject||g.counterparty!==m.counterparty
    ||g.decisionId!==m.decisionId||g.actionHash!==m.actionHash||g.amount!==m.requestedAmount||g.reputationSnapshotHash!==m.snapshotHash
    ||receipt.logs.some(log=>log.removed||log.blockHash!==receipt.blockHash||log.blockNumber!==receipt.blockNumber||log.transactionHash!==receipt.transactionHash)) {
    throw new PaymentError("The confirmed events do not match the signed purchase.");
  }
  return {kind:"veyra.metropolis.payment-receipt" as const,version:1,chainId:10143,transactionHash:receipt.transactionHash,
    blockNumber:receipt.blockNumber.toString(),blockHash:receipt.blockHash,finalizedBlock:finalized.number.toString(),
    quoteHash:context.message.quoteHash,clearanceDigest:clearance.digest,account:quote.accountAddress,provider:quote.provider,
    task:quote.task,amountUnits:m.requestedAmount.toString(),amountUsdc:formatUnits(m.requestedAmount,6),
    relayer:tx.from,chargedGasMon:formatEther(tx.gas*receipt.effectiveGasPrice),
    payment:"confirmed" as const,delivery:"not_assessed" as const,
    usdcTransferLogIndex:receipt.logs.find(log=>log.address.toLowerCase()===quote.usdc.toLowerCase())!.logIndex};
}
