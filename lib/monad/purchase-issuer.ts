import { type Hex, type LocalAccount } from "viem";
import { METROPOLIS_DEPLOYMENT, readAccountSetup } from "./account.ts";
import { MONAD_CONTRACTS } from "./config.ts";
import { getMonadReadClient } from "./erc8004.ts";
import { METROPOLIS_ORIGIN } from "./passkey.ts";
import { parsePurchaseTask, parseSignedPurchase, PaymentError, PAYMENT_ACCOUNT_ABI, purchaseContext,
  purchaseRequestHash, verifyPurchaseState, type PurchaseTask, type SignedPurchase } from "./payment.ts";
import { parseMonadUsdc, signMonadClearance, type MonadTrustDecision } from "./trust.ts";

/** Operator-side only: result must retain the existing trust engine's issuance provenance. */
export async function issuePurchaseQuote(result:MonadTrustDecision,
  input:{publicKey:Hex;task:PurchaseTask;budgetUsdc:string;agentId:string;demonstration:boolean},
  signer:LocalAccount,client=getMonadReadClient(),now=new Date()):Promise<SignedPurchase> {
  const task=parsePurchaseTask(input.task);
  const agent=`eip155:10143:${MONAD_CONTRACTS[10143].identityRegistry.toLowerCase()}:${input.agentId}`;
  if(result.requestHash!==purchaseRequestHash(task)||result.decision.request.serviceId!==task.serviceId
    ||result.decision.subject.agentId!==agent)throw new PaymentError("The task and provider do not match the server's trust decision.");
  if(parseMonadUsdc(input.budgetUsdc)!==result.ownerBudgetUnits)throw new PaymentError("The displayed budget does not match the server's trust decision.");
  // This function rejects copied/serialized results and REVIEW_REQUIRED/DENY at the signing boundary.
  const signed=await signMonadClearance(result,METROPOLIS_DEPLOYMENT.trustGate,signer,now);
  const setup=await readAccountSetup(input.publicKey,METROPOLIS_ORIGIN,client);
  if(!setup.accountDeployed||setup.accountAddress!==signed.message.executor)throw new PaymentError("The issued clearance does not match this deployed account.");
  const nonce=await client.readContract({address:setup.accountAddress,abi:PAYMENT_ACCOUNT_ABI,functionName:"nonce",blockNumber:BigInt(setup.observedBlock)});
  const m=signed.message;
  const quote=parseSignedPurchase({kind:"veyra.metropolis.purchase",version:1,chainId:10143,origin:METROPOLIS_ORIGIN,
    factory:METROPOLIS_DEPLOYMENT.factory,trustGate:METROPOLIS_DEPLOYMENT.trustGate,usdc:MONAD_CONTRACTS[10143].usdc,
    accountAddress:setup.accountAddress,publicKey:input.publicKey,task,budgetUsdc:input.budgetUsdc,
    provider:{agentId:input.agentId,payee:m.counterparty,demonstration:input.demonstration},
    policy:{decision:result.decision.decision,score:result.decision.trust.score,confidence:result.decision.trust.confidence,
      coverage:result.decision.trust.coverage,reasons:[...result.reasons],disclosures:[...result.disclosures]},
    clearance:{...m,requestedAmount:m.requestedAmount.toString(),maxAmount:m.maxAmount.toString(),
      issuedAt:m.issuedAt.toString(),expiresAt:m.expiresAt.toString()},
    nonce:nonce.toString(),deadline:m.expiresAt.toString(),attester:signer.address,
    clearanceSignature:signed.signature,contextSignature:`0x${"00".repeat(65)}`});
  const contextSignature=await signer.signTypedData(purchaseContext(quote));
  const output=parseSignedPurchase({...quote,contextSignature});
  // Role, current canonical payee, balances, nonce and full domain bindings are checked again.
  await verifyPurchaseState(output,input.publicKey,client);
  return output;
}
