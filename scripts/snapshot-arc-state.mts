/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import { readLiveArcStateReport, saveMonthlyArcStateSnapshot } from "../lib/discovery/arc-state.ts";

const dryRun = process.argv.includes("--dry-run");
const atArg = process.argv.find((arg) => arg.startsWith("--at="))?.slice("--at=".length);
const snapshotAt = atArg ? new Date(atArg) : new Date();
if (Number.isNaN(snapshotAt.getTime())) {
  throw new Error(`Invalid --at timestamp: ${atArg}`);
}

const report = await readLiveArcStateReport(snapshotAt);
if (!report) {
  throw new Error("Could not compute live Arc x402 state report.");
}

if (dryRun) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const saved = await saveMonthlyArcStateSnapshot(report);
  console.log(JSON.stringify({ saved, latency: report.latency, drift: report.drift, concentration: { top1Host: report.concentration.top1Host, top1Share: report.concentration.top1Share, top5Share: report.concentration.top5Share } }, null, 2));
}
