import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { metropolisAccountProfile, parseAccountSetup } from "../../lib/monad/account.ts";
import { generateReadinessReport, readinessTask, renderReadinessReport, readinessResponseHash } from "../../lib/monad/readiness.ts";

// Public inputs and finalized RPC reads only. Never loads an environment file or a signer.
export async function reportFromSetup(value: unknown, budgetUsdc: string) {
  const setup = await parseAccountSetup(value);
  const version = metropolisAccountProfile(setup.factory).accountVersion;
  return generateReadinessReport(readinessTask({ publicKey: `0x${setup.qx.slice(2)}${setup.qy.slice(2)}`, budgetUsdc,
    ...(version === 2 ? { accountVersion: 2 } : {}) }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if ((args.length !== 4 && args.length !== 6) || args[0] !== "--setup" || args[2] !== "--budget"
      || args.length === 6 && (args[4] !== "--format" || !["json", "markdown", "task"].includes(args[5]))) {
      throw new Error("Use --setup PUBLIC_SETUP_JSON --budget USDC [--format json|markdown|task].");
    }
    if (statSync(args[1]).size > 65536) throw new Error("The public setup file is too large.");
    const report = await reportFromSetup(JSON.parse(readFileSync(args[1], "utf8")), args[3]);
    console.log(args[5] === "markdown" ? renderReadinessReport(report) : JSON.stringify(args[5] === "task" ? report.task : { report, responseHash: readinessResponseHash(report) }, null, 2));
  } catch { console.error("Readiness reporting failed. Check the public setup, budget and RPC; no transaction was sent."); process.exitCode = 1; }
}
