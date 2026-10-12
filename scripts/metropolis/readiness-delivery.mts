import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, isAddress, type Hex } from "viem";
import { PaymentError } from "../../lib/monad/payment.ts";
import { fulfillReadinessPurchase, planReadinessAssessment, verifyReadinessDelivery } from "../../lib/monad/readiness-delivery.ts";

function publicJson(path: string) {
  if (statSync(path).size > 65536) throw new PaymentError("The public input file is too large.");
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const values = new Map<string, string>(), args = process.argv.slice(2);
    const allowed = ["--approval", "--tx", "--delivery", "--reporter", "--score"];
    for (let i = 0; i < args.length; i += 2) {
      if (!allowed.includes(args[i]) || values.has(args[i]) || !args[i + 1]) throw new PaymentError("Invalid readiness-delivery arguments.");
      values.set(args[i], args[i + 1]);
    }
    const hash = values.get("--tx");
    if (!values.has("--approval") || !hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)
      || values.size !== 2 && values.size !== 5) throw new PaymentError("Use --approval APPROVAL_JSON --tx HASH [--delivery SAVED_DELIVERY_JSON --reporter PUBLIC_ADDRESS --score 0..100].");
    const approval = publicJson(values.get("--approval")!);
    if (values.size === 2) {
      console.log(JSON.stringify(await fulfillReadinessPurchase(approval, hash as Hex), null, 2));
    } else {
      const reporter = values.get("--reporter"), score = values.get("--score");
      if (!reporter || !isAddress(reporter) || !score || !/^(0|[1-9]\d?|100)$/.test(score)) throw new PaymentError("Choose a non-provider reporter and a human usefulness score from zero to 100.");
      const delivery = await verifyReadinessDelivery(publicJson(values.get("--delivery")!), approval, hash as Hex);
      console.log(JSON.stringify(planReadinessAssessment(delivery, getAddress(reporter), Number(score)), null, 2));
    }
  } catch (error) { console.error(error instanceof PaymentError ? error.message : "Delivery verification failed. No assessment was signed or transaction sent."); process.exitCode = 1; }
}
