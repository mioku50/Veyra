import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, isAddress } from "viem";
import { PaymentError } from "../../lib/monad/payment.ts";
import { planReadinessRegistration } from "../../lib/monad/readiness-registration.ts";

// Emits unsigned register(string) calldata. It cannot sign, pay, publish or broadcast.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== "--owner" || !isAddress(args[1])) throw new PaymentError("Use --owner PUBLIC_PROVIDER_OWNER_ADDRESS.");
    console.log(JSON.stringify(await planReadinessRegistration(getAddress(args[1])), null, 2));
  } catch (error) { console.error(error instanceof PaymentError ? error.message : "Registration planning failed. No transaction was signed or sent."); process.exitCode = 1; }
}
