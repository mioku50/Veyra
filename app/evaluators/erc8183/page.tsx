/**
 * Copyright 2026 Circle Internet Group, Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import React from "react";
import Link from "next/link";
import {
  ShieldCheck,
  CheckCircle2,
  XCircle,
  ExternalLink,
  Cpu,
  Code2,
  FileCheck2,
  Activity,
  Zap,
  Lock,
  ArrowRight,
} from "lucide-react";
import { getByoaClient } from "@/lib/byoa/service.ts";

export const revalidate = 30;

export default async function Erc8183EvaluatorProfilePage() {
  const evaluatorAddress = (process.env.NEXT_PUBLIC_VEYRA_ERC8183_EVALUATOR_ADDRESS ||
    "0x0d2c04580e081e222bbe5bf9818af337e2633eb7") as `0x${string}`;
  const commerceAddress = (process.env.NEXT_PUBLIC_ARC_ERC8183_COMMERCE_ADDRESS ||
    "0x0747EEf0706327138c69792bF28Cd525089e4583") as `0x${string}`;

  // Load real aggregated evaluation statistics from Supabase
  let totalEvaluations = 0;
  let completedCount = 0;
  let rejectedCount = 0;
  let latestEvaluationTime: string | null = null;

  const supabase = getByoaClient();
  const { data: records, error: recordsError } = await supabase
    .from("erc8183_evaluations")
    .select("decision, status, created_at")
    .in("status", ["completed", "rejected"])
    .order("created_at", { ascending: false });
  if (recordsError) {
    throw new Error("Evaluator statistics are unavailable");
  }

  if (records && records.length > 0) {
    totalEvaluations = records.length;
    latestEvaluationTime = records[0].created_at;
    for (const rec of records) {
      if (rec.decision === "complete" || rec.status === "completed") {
        completedCount++;
      } else if (rec.decision === "reject" || rec.status === "rejected") {
        rejectedCount++;
      }
    }
  }

  const completionRate =
    totalEvaluations > 0 ? ((completedCount / totalEvaluations) * 100).toFixed(1) : "100.0";

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 md:p-12 font-sans">
      <div className="max-w-5xl mx-auto space-y-12">
        {/* Header Breadcrumbs */}
        <div className="flex items-center justify-between border-b border-slate-800 pb-6">
          <div className="flex items-center gap-3">
            <ShieldCheck className="w-9 h-9 text-sky-400" />
            <div>
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <Link href="/evaluators" className="hover:text-white transition-colors">
                  Evaluators
                </Link>
                <span>/</span>
                <span className="text-sky-400 font-medium">ERC-8183</span>
              </div>
              <h1 className="text-3xl font-extrabold text-white mt-1">
                Veyra ERC-8183 Evaluator Profile
              </h1>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1.5 text-xs font-semibold text-emerald-400 bg-emerald-950/60 border border-emerald-800/60 px-3 py-1.5 rounded-full">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              Verified Canary
            </span>
          </div>
        </div>

        {/* Overview Section */}
        <section className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 md:p-8 space-y-4">
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <Cpu className="w-5 h-5 text-sky-400" /> Capability Overview
          </h2>
          <p className="text-sm text-slate-300 leading-relaxed">
            The <strong>Veyra ERC-8183 Evaluator</strong> acts as an independent, non-custodial verification layer for AI agent jobs on Arc Testnet. When a client instantiates an ERC-8183 job, it configures Veyra&apos;s evaluator contract address as its designated evaluator.
          </p>
          <p className="text-sm text-slate-400 leading-relaxed">
            Upon provider submission of job deliverables, Veyra fetches the committed artifact, runs an isolated deterministic evaluation policy engine, constructs a canonical report digest, and signs an EIP-712 structured verdict. A relayer then submits this verdict onchain to invoke settlement (<code className="text-emerald-300 font-mono">complete()</code> or <code className="text-rose-300 font-mono">reject()</code>).
          </p>
        </section>

        {/* Live Aggregated Statistics */}
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-bold text-white flex items-center gap-2">
              <Activity className="w-5 h-5 text-sky-400" /> Production Evaluation Metrics
            </h2>
            {totalEvaluations === 0 && (
              <span className="text-xs text-amber-400 bg-amber-950/50 border border-amber-800/50 px-3 py-1 rounded-full">
                Limited production observations
              </span>
            )}
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-slate-900/80 border border-slate-800 p-5 rounded-xl space-y-1">
              <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Total Evaluations</div>
              <div className="text-3xl font-extrabold text-white">{totalEvaluations}</div>
            </div>
            <div className="bg-slate-900/80 border border-slate-800 p-5 rounded-xl space-y-1">
              <div className="text-xs font-semibold text-emerald-400 uppercase tracking-wider">Completed</div>
              <div className="text-3xl font-extrabold text-emerald-400">{completedCount}</div>
            </div>
            <div className="bg-slate-900/80 border border-slate-800 p-5 rounded-xl space-y-1">
              <div className="text-xs font-semibold text-rose-400 uppercase tracking-wider">Rejected</div>
              <div className="text-3xl font-extrabold text-rose-400">{rejectedCount}</div>
            </div>
            <div className="bg-slate-900/80 border border-slate-800 p-5 rounded-xl space-y-1">
              <div className="text-xs font-semibold text-sky-400 uppercase tracking-wider">Completion Rate</div>
              <div className="text-3xl font-extrabold text-sky-400">{completionRate}%</div>
            </div>
          </div>
        </section>

        {/* Contract Parameters */}
        <section className="space-y-4">
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <Lock className="w-5 h-5 text-sky-400" /> Onchain Contract Parameters
          </h2>
          <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-6 space-y-4 font-mono text-xs">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1">
                <span className="text-slate-500 font-sans">Network:</span>
                <div className="text-slate-200 font-bold">Arc Testnet</div>
              </div>
              <div className="space-y-1">
                <span className="text-slate-500 font-sans">Chain ID:</span>
                <div className="text-slate-200 font-bold">5042002</div>
              </div>
              <div className="space-y-1">
                <span className="text-slate-500 font-sans">Evaluator Contract:</span>
                <div className="text-sky-300 font-bold break-all">{evaluatorAddress}</div>
              </div>
              <div className="space-y-1">
                <span className="text-slate-500 font-sans">Agentic Commerce Contract:</span>
                <div className="text-slate-300 font-bold break-all">{commerceAddress}</div>
              </div>
            </div>
            <div className="pt-4 border-t border-slate-800 flex items-center justify-between font-sans text-xs">
              <span className="text-slate-400">Canonical Policy Standard: <code className="text-sky-300 font-mono">structured-deliverable-v1</code></span>
              <a
                href={`https://testnet.arcscan.app/address/${evaluatorAddress}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-sky-400 hover:text-sky-300 font-semibold"
              >
                Inspect on Arcscan <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>
          </div>
        </section>

        {/* Human-Readable Policy Rules Breakdown */}
        <section className="space-y-4">
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <FileCheck2 className="w-5 h-5 text-sky-400" /> Evaluation Policy Breakdown (<code className="text-sky-300 font-mono text-base">structured-deliverable-v1</code>)
          </h2>
          <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 space-y-3">
            {[
              { id: "1", title: "ERC-8183 Onchain Job Exists", desc: "Verifies the job ID exists on Arc Testnet commerce contract." },
              { id: "2", title: "Evaluator Configuration Match", desc: "Confirms Veyra evaluator contract address is configured on the job." },
              { id: "3", title: "Active Job Eligibility", desc: "Checks job status is active for evaluation (Submitted / status 2)." },
              { id: "4", title: "Deliverable Submission Check", desc: "Verifies provider deliverableHash was recorded onchain." },
              { id: "5", title: "Artifact Keccak256 Hash Matching", desc: "Validates keccak256 hash of deliverable matches submitted deliverableHash." },
              { id: "6", title: "HTTPS Transport Enforcement", desc: "Requires artifact content URI to utilize secure HTTPS protocol." },
              { id: "7", title: "Schema Structural Compliance", desc: "Validates JSON payload against veyra.structured-deliverable.v1 schema." },
              { id: "8", title: "Content Size Limits", desc: "Enforces max payload size boundaries to prevent memory exhaustion." },
              { id: "9", title: "Job Expiration Boundaries", desc: "Verifies job expiredAt timestamp has not elapsed." },
              { id: "10", title: "Deterministic Policy Outcome", desc: "Calculates canonical report hash for complete/reject decision." },
            ].map((rule) => (
              <div key={rule.id} className="flex items-start gap-3 p-3 bg-slate-950/60 border border-slate-800/80 rounded-xl">
                <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                <div>
                  <div className="text-sm font-semibold text-white">{rule.id}. {rule.title}</div>
                  <div className="text-xs text-slate-400 mt-0.5">{rule.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Visual Settlement Flow */}
        <section className="space-y-4">
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <Zap className="w-5 h-5 text-sky-400" /> How Settlement Works
          </h2>
          <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-6 md:p-8 text-xs font-mono">
            <div className="flex flex-wrap items-center justify-between gap-3 text-center">
              <div className="bg-slate-950 border border-slate-800 px-4 py-3 rounded-xl">
                <div className="text-slate-400 font-sans text-2xs uppercase">Step 1</div>
                <div className="text-sky-300 font-bold mt-1">Client</div>
                <div className="text-slate-500 text-3xs mt-0.5">createJob()</div>
              </div>
              <ArrowRight className="w-4 h-4 text-slate-600 hidden sm:block" />
              <div className="bg-slate-950 border border-slate-800 px-4 py-3 rounded-xl">
                <div className="text-slate-400 font-sans text-2xs uppercase">Step 2</div>
                <div className="text-sky-300 font-bold mt-1">Provider</div>
                <div className="text-slate-500 text-3xs mt-0.5">submit()</div>
              </div>
              <ArrowRight className="w-4 h-4 text-slate-600 hidden sm:block" />
              <div className="bg-slate-950 border border-slate-800 px-4 py-3 rounded-xl">
                <div className="text-slate-400 font-sans text-2xs uppercase">Step 3</div>
                <div className="text-sky-300 font-bold mt-1">Deliverable</div>
                <div className="text-slate-500 text-3xs mt-0.5">deliverableHash</div>
              </div>
              <ArrowRight className="w-4 h-4 text-slate-600 hidden sm:block" />
              <div className="bg-slate-950 border border-slate-800 px-4 py-3 rounded-xl border-sky-500/40">
                <div className="text-sky-400 font-sans text-2xs uppercase">Step 4</div>
                <div className="text-white font-bold mt-1">Veyra Engine</div>
                <div className="text-sky-300 text-3xs mt-0.5">EIP-712 Verdict</div>
              </div>
              <ArrowRight className="w-4 h-4 text-slate-600 hidden sm:block" />
              <div className="bg-slate-950 border border-slate-800 px-4 py-3 rounded-xl">
                <div className="text-slate-400 font-sans text-2xs uppercase">Step 5</div>
                <div className="text-emerald-400 font-bold mt-1">Settlement</div>
                <div className="text-emerald-300 text-3xs mt-0.5">complete()</div>
              </div>
            </div>
          </div>
        </section>

        {/* Code Integration Section */}
        <section id="integration" className="space-y-4 pt-4 border-t border-slate-800">
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <Code2 className="w-5 h-5 text-sky-400" /> Integration Code Snippets
          </h2>
          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 space-y-4">
            <div className="text-xs text-slate-300 font-medium">
              Specify <code className="text-sky-300 font-mono">{evaluatorAddress}</code> as evaluator during ERC-8183 job creation:
            </div>

            {/* TypeScript Code Block */}
            <div className="space-y-2">
              <div className="text-2xs font-semibold text-slate-400 uppercase tracking-wider">TypeScript / Viem</div>
              <pre className="bg-slate-950 p-4 rounded-xl text-xs font-mono text-slate-200 overflow-x-auto border border-slate-800">
{`import { createWalletClient, http, parseAbi } from "viem";
import { arcTestnet } from "viem/chains";

const VEYRA_EVALUATOR = "${evaluatorAddress}";
const COMMERCE_ADDRESS = "${commerceAddress}";

const abi = parseAbi([
  "function createJob(address provider, address evaluator, uint256 expiredAt, string description, address token) returns (uint256 jobId)"
]);

// 1. Create Job with Veyra Evaluator
const hash = await walletClient.writeContract({
  address: COMMERCE_ADDRESS,
  abi,
  functionName: "createJob",
  args: [providerAddress, VEYRA_EVALUATOR, expiredAtTimestamp, "Agent Task Description", "0x0000000000000000000000000000000000000000"]
});`}
              </pre>
            </div>

            {/* Solidity Code Block */}
            <div className="space-y-2 pt-2">
              <div className="text-2xs font-semibold text-slate-400 uppercase tracking-wider">Solidity Interface</div>
              <pre className="bg-slate-950 p-4 rounded-xl text-xs font-mono text-slate-200 overflow-x-auto border border-slate-800">
{`interface IERC8183AgenticCommerce {
    function createJob(
        address provider,
        address evaluator,
        uint256 expiredAt,
        string calldata description,
        address token
    ) external returns (uint256 jobId);
}

address constant VEYRA_EVALUATOR = ${evaluatorAddress};`}
              </pre>
            </div>

            {/* Machine API cURL Code Block */}
            <div className="space-y-2 pt-2">
              <div className="text-2xs font-semibold text-slate-400 uppercase tracking-wider">Machine API (cURL)</div>
              <pre className="bg-slate-950 p-4 rounded-xl text-xs font-mono text-slate-200 overflow-x-auto border border-slate-800">
{`# Fetch safe evaluator metadata
curl -X GET https://agent-commerce-six.vercel.app/api/erc8183/v1/evaluator

# Submit evaluation request
curl -X POST https://agent-commerce-six.vercel.app/api/erc8183/v1/evaluations \\
  -H "Content-Type: application/json" \\
  -d '{"jobId": "171197", "contentUri": "https://agent-commerce-six.vercel.app/canary-deliverable.json"}'`}
              </pre>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
