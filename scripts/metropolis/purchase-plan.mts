import { readFileSync,statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { isAddress,type Hex } from "viem";
import { parseAccountSetup,readAccountSetup } from "../../lib/monad/account.ts";
import { collectMonadEvidence,type MonadEvidencePolicy } from "../../lib/monad/evidence.ts";
import { parsePurchaseTask,purchaseRequestHash,PaymentError } from "../../lib/monad/payment.ts";
import { evaluateMonadPurchase,parseMonadUsdc } from "../../lib/monad/trust.ts";
import { getMonadReadClient } from "../../lib/monad/erc8004.ts";

const address=z.string().refine(isAddress).transform(value=>value as `0x${string}`);
const hash=z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(value=>value as Hex);
const uint=z.string().regex(/^(0|[1-9]\d{0,77})$/).transform(value=>BigInt(value));
const policySchema=z.object({feedbackClients:z.array(address).max(32).optional(),assessmentReporters:z.array(address).max(32).optional(),
  payments:z.array(z.object({transactionHash:hash,logIndex:z.number().int().nonnegative()}).strict()).max(32).optional(),
  assessments:z.array(z.object({message:z.object({agentId:uint,buyer:address,seller:address,amount:uint,paymentTx:hash,requestHash:hash,responseHash:hash,
    delivered:z.boolean(),score:z.number().int().min(0).max(100),assessedAt:uint}).strict(),
    signature:z.string().regex(/^0x[0-9a-fA-F]{130}$/).transform(value=>value as Hex)}).strict()).max(32).optional(),
  minPaymentConfirmations:z.number().int().min(2).max(1000).optional()}).strict();
export function parseOperatorEvidencePolicy(value:unknown):MonadEvidencePolicy {
  const parsed=policySchema.safeParse(value);
  if(!parsed.success)throw new PaymentError("Invalid operator-selected evidence policy.");
  return parsed.data;
}
function readPublicJson(path:string) {
  if(statSync(path).size>65536)throw new PaymentError("Public input file is too large.");
  return JSON.parse(readFileSync(path,"utf8")) as unknown;
}
export async function preparePurchasePlan(input:{setup:unknown;task:unknown;agentId:string;amountUsdc:string;budgetUsdc:string;policy?:MonadEvidencePolicy},
  client=getMonadReadClient()) {
  if(!/^[1-9]\d{0,76}$/.test(input.agentId))throw new PaymentError("Provide an ERC-8004 agent ID.");
  const proposed=await parseAccountSetup(input.setup),task=parsePurchaseTask(input.task);
  const publicKey=`0x${proposed.qx.slice(2)}${proposed.qy.slice(2)}` as Hex;
  const setup=await readAccountSetup(publicKey,proposed.origin,client,undefined,proposed.factory);
  if(setup.accountAddress!==proposed.accountAddress)throw new PaymentError("The proposed account does not match its verified factory and passkey.");
  const amount=parseMonadUsdc(input.amountUsdc);parseMonadUsdc(input.budgetUsdc);
  const bundle=await collectMonadEvidence(BigInt(input.agentId),input.policy??{},client);
  const decision=evaluateMonadPurchase(bundle,{executor:setup.accountAddress,amountUsdc:input.amountUsdc,budgetUsdc:input.budgetUsdc,
    serviceId:task.serviceId,requestHash:purchaseRequestHash(task)});
  const reasons=[...decision.reasons];
  if(!setup.accountDeployed)reasons.push("ACCOUNT_NOT_DEPLOYED");
  if(BigInt(setup.usdcBalanceUnits)<amount)reasons.push("INSUFFICIENT_USDC_BALANCE");
  return {decision,plan:{kind:"veyra.metropolis.purchase-plan",version:1,chainId:10143,task,account:setup.accountAddress,
    accountDeployed:setup.accountDeployed,balanceUnits:setup.usdcBalanceUnits,provider:{agentId:input.agentId,payee:bundle.identity.paymentWallet},
    amountUsdc:input.amountUsdc,budgetUsdc:input.budgetUsdc,requestHash:decision.requestHash,evidenceHash:bundle.evidenceHash,
    policyVersion:decision.decision.policy.version,stateAgeSeconds:decision.decision.trust.snapshotAgeSeconds,
    securitySnapshot:{blockNumber:bundle.identity.blockNumber.toString(),...bundle.securitySnapshot},history:decision.history,
    decision:decision.decision.decision,score:decision.decision.trust.score,coverage:decision.decision.trust.coverage,
    eligible:decision.executable&&setup.accountDeployed&&BigInt(setup.usdcBalanceUnits)>=amount,reasons,disclosures:decision.disclosures,
    signed:false,broadcast:false,serviceDelivered:false}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const values=new Map<string,string>(),allowed=["--setup","--task","--agent-id","--amount","--budget","--evidence-policy"];
    const args=process.argv.slice(2);
    for(let i=0;i<args.length;i+=2){if(!allowed.includes(args[i])||values.has(args[i])||!args[i+1])throw new PaymentError("Use --setup PUBLIC_SETUP_JSON --task TASK_JSON --agent-id ID --amount USDC --budget USDC [--evidence-policy OPERATOR_POLICY_JSON].");values.set(args[i],args[i+1]);}
    if(allowed.slice(0,5).some(name=>!values.has(name)))throw new PaymentError("Missing public purchase-plan arguments.");
    const {plan}=await preparePurchasePlan({setup:readPublicJson(values.get("--setup")!),task:readPublicJson(values.get("--task")!),
      agentId:values.get("--agent-id")!,amountUsdc:values.get("--amount")!,budgetUsdc:values.get("--budget")!,
      policy:values.has("--evidence-policy")?parseOperatorEvidencePolicy(readPublicJson(values.get("--evidence-policy")!)):undefined});
    console.log(JSON.stringify(plan,null,2));
  }catch(error){console.error(error instanceof PaymentError?error.message:"Purchase planning failed. No signature or transaction was produced.");process.exitCode=1;}
}
