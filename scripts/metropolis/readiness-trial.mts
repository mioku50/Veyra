import { readFileSync,statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress,isAddress,type Hex } from "viem";
import { PaymentError } from "../../lib/monad/payment.ts";
import { checkReadinessTrialOrder,fulfillReadinessTrial,parseReadinessTrialPlan,planReadinessTrial,planReadinessTrialAssessment,
  readinessTrialOrder,verifyReadinessTrialDelivery,verifyReadinessTrialReceipt } from "../../lib/monad/readiness-trial.ts";

function publicJson(path:string):unknown {
  if(statSync(path).size>65536)throw new PaymentError("The public input file is too large.");
  return JSON.parse(readFileSync(path,"utf8"));
}
function loadPlan(path:string) {
  const data=publicJson(path);
  return parseReadinessTrialPlan(data && typeof data==="object" && "plan" in data ? data.plan : data);
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const values=new Map<string,string>(),args=process.argv.slice(2);
    const allowed=["--mode","--buyer","--agent-id","--task","--amount","--plan","--signature","--tx","--delivery","--score"];
    for(let i=0;i<args.length;i+=2) {
      if(!allowed.includes(args[i]) || values.has(args[i]) || !args[i+1])throw new PaymentError("Invalid manual-trial arguments.");
      values.set(args[i],args[i+1]);
    }
    const mode=values.get("--mode");
    const expected=mode==="plan" ? ["--mode","--buyer","--agent-id","--task","--amount"]
      : mode==="order" ? ["--mode","--plan"]
      : mode==="check" ? ["--mode","--plan","--signature"]
      : mode==="receipt" || mode==="deliver" ? ["--mode","--plan","--signature","--tx"]
      : mode==="assessment" ? ["--mode","--plan","--signature","--tx","--delivery","--score"] : [];
    if(!expected.length || values.size!==expected.length || expected.some(key=>!values.has(key))) {
      throw new PaymentError("Use --mode plan|order|check|receipt|deliver|assessment with its public inputs. This CLI cannot sign or broadcast.");
    }
    let output:unknown;
    if(mode==="plan") {
      const buyer=values.get("--buyer")!,agentId=values.get("--agent-id")!;
      if(!isAddress(buyer) || !/^[1-9]\d{0,19}$/.test(agentId))throw new PaymentError("Provide a public EOA buyer address and positive agent ID.");
      output=await planReadinessTrial({buyer:getAddress(buyer),agentId:BigInt(agentId),task:publicJson(values.get("--task")!),amountUsdc:values.get("--amount")!});
    } else {
      const plan=loadPlan(values.get("--plan")!);
      if(mode==="order")output=readinessTrialOrder(plan);
      else {
        const sig=publicJson(values.get("--signature")!),tx=values.get("--tx");
        if(!sig || typeof sig!=="object" || Object.keys(sig).length!==1 || !("signature" in sig) || typeof sig.signature!=="string"
          || !/^0x[0-9a-fA-F]{130}$/.test(sig.signature) || mode!=="check" && (!tx || !/^0x[0-9a-fA-F]{64}$/.test(tx)))throw new PaymentError("Provide a public buyer signature JSON and, for receipt/delivery, the trial transaction hash.");
        const signature=sig.signature as Hex,hash=tx as Hex;
        if(mode==="check")output=await checkReadinessTrialOrder(plan,signature);
        else if(mode==="receipt")output=await verifyReadinessTrialReceipt(plan,signature,hash);
        else if(mode==="deliver")output=await fulfillReadinessTrial(plan,signature,hash);
        else {
          const score=values.get("--score")!;
          if(!/^(0|[1-9]\d?|100)$/.test(score))throw new PaymentError("Supply the human buyer's usefulness score, zero to 100.");
          const delivery=await verifyReadinessTrialDelivery(publicJson(values.get("--delivery")!),plan,signature,hash);
          output=planReadinessTrialAssessment(delivery,Number(score));
        }
      }
    }
    console.log(JSON.stringify(output,(_,value)=>typeof value==="bigint"?value.toString():value,2));
  } catch(error) {
    console.error(error instanceof PaymentError?error.message:"Manual trial preparation or verification failed. No signature or transaction was produced.");process.exitCode=1;
  }
}
