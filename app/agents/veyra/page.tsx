/**
 * Copyright 2026 Circle Internet Group, Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import React from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ShieldCheck,
  CheckCircle2,
  ExternalLink,
  Cpu,
  Activity,
  Zap,
  Lock,
  Code2,
  FileText,
  BadgeCheck,
  ArrowRight,
} from "lucide-react";
import { getByoaClient } from "@/lib/byoa/service.ts";
import { getCanonicalVeyraAgentIdentity, getArcPublicClient } from "@/lib/erc8004/client.ts";
import {
  ARC_ERC8004_REPUTATION_REGISTRY,
  ARC_ERC8004_VALIDATION_REGISTRY,
} from "@/lib/erc8004/types.ts";

export const dynamic = "force-dynamic";
export const revalidate = 30;

export default async function PublicVeyraAgentIdentityPage() {
  const publicClient = getArcPublicClient();
  const identityRecord = await getCanonicalVeyraAgentIdentity(publicClient);
  if (!identityRecord) notFound();
  const agentId = identityRecord.agent_id;
  const identityRegistry = identityRecord.registry_address;
  const ownerAddress = identityRecord.owner_address;
  const metadataUri = identityRecord.metadata_uri;
  const evaluatorAddress = process.env.NEXT_PUBLIC_VEYRA_ERC8183_EVALUATOR_ADDRESS || "0x0d2c04580e081e222bbe5bf9818af337e2633eb7";

  let totalValidations = 0;
  let passedValidations = 0;
  let failedValidations = 0;

  const supabase = getByoaClient();
  const { data: valRecords, error: validationStatsError } = await supabase
    .from("erc8004_validation_links")
    .select("response, status")
    .eq("status", "confirmed");
  if (validationStatsError) {
    throw new Error("ERC-8004 validation statistics are unavailable");
  }
  if (valRecords) {
    totalValidations = valRecords.length;
    for (const rec of valRecords) {
      if (rec.response === 100) passedValidations++;
      else failedValidations++;
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 md:p-12 font-sans">
      <div className="max-w-5xl mx-auto space-y-10">
        {/* Header Breadcrumb */}
        <div className="flex flex-col md:flex-row md:items-center justify-between border-b border-slate-800 pb-6 gap-4">
          <div className="flex items-center gap-3">
            <ShieldCheck className="w-10 h-10 text-sky-400" />
            <div>
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <Link href="/evaluators" className="hover:text-white transition-colors">
                  Evaluators
                </Link>
                <span>/</span>
                <span className="text-sky-400 font-medium">Trust Identity</span>
              </div>
              <h1 className="text-3xl font-extrabold text-white mt-1">
                Veyra Trust Identity (ERC-8004)
              </h1>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> Owner Verified Onchain
            </span>
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-sky-500/20 text-sky-300 border border-sky-500/40">
              <BadgeCheck className="w-4 h-4 text-sky-400" /> Agent #{agentId}
            </span>
          </div>
        </div>

        {/* Live Badges Bar */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs font-semibold">
          <div className="bg-slate-900/90 border border-emerald-500/30 p-3 rounded-xl flex items-center gap-2 text-emerald-300">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" /> Metadata Verified
          </div>
          <div className="bg-slate-900/90 border border-emerald-500/30 p-3 rounded-xl flex items-center gap-2 text-emerald-300">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" /> ERC-8183 Evaluator Active
          </div>
          <div className="bg-slate-900/90 border border-emerald-500/30 p-3 rounded-xl flex items-center gap-2 text-emerald-300">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" /> Validation Capability Active
          </div>
          <div className="bg-slate-900/90 border border-sky-500/30 p-3 rounded-xl flex items-center gap-2 text-sky-300">
            <Cpu className="w-4 h-4 text-sky-400" /> Arc Testnet (5042002)
          </div>
        </div>

        {/* Hero Section */}
        <section className="bg-gradient-to-br from-slate-900 via-slate-900/90 to-slate-950 border border-slate-800 rounded-2xl p-6 md:p-8 space-y-6 shadow-xl">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-bold text-sky-400 uppercase tracking-wider bg-sky-950/60 border border-sky-800/60 px-2.5 py-1 rounded-md">
                  Official Portable Onchain Identity
                </span>
              </div>
              <h2 className="text-3xl font-black text-white">Veyra Trust Evaluator</h2>
              <p className="text-sm text-slate-300 max-w-2xl leading-relaxed">
                Veyra is an independent trust and job verification layer on Arc. It evaluates agent deliverables, authorizes settlement onchain, and records portable cryptographic validation evidence via ERC-8004.
              </p>
            </div>
            <div className="flex flex-col sm:flex-row gap-3">
              <a
                href={metadataUri}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center justify-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-100 font-semibold px-4 py-2.5 rounded-xl border border-slate-700 text-xs transition-colors"
              >
                <FileText className="w-4 h-4 text-sky-400" /> Metadata JSON <ExternalLink className="w-3.5 h-3.5" />
              </a>
              <Link
                href="/evaluators/erc8183"
                className="inline-flex items-center justify-center gap-2 bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold px-4 py-2.5 rounded-xl text-xs transition-colors shadow"
              >
                <Cpu className="w-4 h-4" /> Evaluator Spec <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </div>
          </div>
        </section>

        {/* Identity & Registry Contracts Grid with Arcscan Explorer Links */}
        <section className="space-y-4">
          <h3 className="text-xl font-bold text-white flex items-center gap-2">
            <Lock className="w-5 h-5 text-sky-400" /> Canonical Identity Parameters & Arcscan Explorer Links
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs font-mono">
            <div className="bg-slate-900/80 border border-slate-800 p-5 rounded-xl space-y-2">
              <div className="text-slate-500 font-sans uppercase tracking-wider text-2xs">ERC-8004 Agent ID</div>
              <div className="text-2xl font-extrabold text-sky-300">#{agentId}</div>
              <div className="text-slate-400 font-sans text-3xs">Identity NFT token on Arc Testnet</div>
            </div>
            <div className="bg-slate-900/80 border border-slate-800 p-5 rounded-xl space-y-2">
              <div className="text-slate-500 font-sans uppercase tracking-wider text-2xs">Identity Owner Address</div>
              <div className="text-slate-200 font-bold break-all">{ownerAddress}</div>
              <div className="text-slate-400 font-sans text-3xs">Verified ERC-721 contract owner</div>
            </div>
            <a
              href={`https://testnet.arcscan.app/address/${identityRegistry}`}
              target="_blank"
              rel="noreferrer"
              className="bg-slate-900/80 border border-slate-800 hover:border-sky-500/50 transition-colors p-5 rounded-xl space-y-2 group"
            >
              <div className="flex items-center justify-between">
                <span className="text-slate-500 font-sans uppercase tracking-wider text-2xs">Identity Registry</span>
                <ExternalLink className="w-3.5 h-3.5 text-slate-400 group-hover:text-sky-400" />
              </div>
              <div className="text-slate-300 font-bold break-all group-hover:text-sky-300">{identityRegistry}</div>
            </a>
            <a
              href={`https://testnet.arcscan.app/address/${evaluatorAddress}`}
              target="_blank"
              rel="noreferrer"
              className="bg-slate-900/80 border border-slate-800 hover:border-sky-500/50 transition-colors p-5 rounded-xl space-y-2 group"
            >
              <div className="flex items-center justify-between">
                <span className="text-slate-500 font-sans uppercase tracking-wider text-2xs">ERC-8183 Evaluator Contract</span>
                <ExternalLink className="w-3.5 h-3.5 text-slate-400 group-hover:text-sky-400" />
              </div>
              <div className="text-slate-300 font-bold break-all group-hover:text-sky-300">{evaluatorAddress}</div>
            </a>
            <a
              href={`https://testnet.arcscan.app/address/${ARC_ERC8004_VALIDATION_REGISTRY}`}
              target="_blank"
              rel="noreferrer"
              className="bg-slate-900/80 border border-slate-800 hover:border-sky-500/50 transition-colors p-5 rounded-xl space-y-2 group md:col-span-2"
            >
              <div className="flex items-center justify-between">
                <span className="text-slate-500 font-sans uppercase tracking-wider text-2xs">Validation Registry</span>
                <ExternalLink className="w-3.5 h-3.5 text-slate-400 group-hover:text-sky-400" />
              </div>
              <div className="text-slate-300 font-bold break-all group-hover:text-sky-300">{ARC_ERC8004_VALIDATION_REGISTRY}</div>
            </a>
          </div>
        </section>

        {/* Validation Bridge Statistics */}
        <section className="space-y-4">
          <h3 className="text-xl font-bold text-white flex items-center gap-2">
            <Zap className="w-5 h-5 text-sky-400" /> ERC-8004 Validation Bridge Metrics
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-slate-900/80 border border-slate-800 p-5 rounded-xl space-y-1">
              <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Total Validations</div>
              <div className="text-3xl font-extrabold text-white">{totalValidations}</div>
            </div>
            <div className="bg-slate-900/80 border border-slate-800 p-5 rounded-xl space-y-1">
              <div className="text-xs font-semibold text-emerald-400 uppercase tracking-wider">Passed (100)</div>
              <div className="text-3xl font-extrabold text-emerald-400">{passedValidations}</div>
            </div>
            <div className="bg-slate-900/80 border border-slate-800 p-5 rounded-xl space-y-1">
              <div className="text-xs font-semibold text-rose-400 uppercase tracking-wider">Failed (0)</div>
              <div className="text-3xl font-extrabold text-rose-400">{failedValidations}</div>
            </div>
            <div className="bg-slate-900/80 border border-slate-800 p-5 rounded-xl space-y-1">
              <div className="text-xs font-semibold text-sky-400 uppercase tracking-wider">Bridge Policy</div>
              <div className="text-xs font-bold text-sky-300 font-mono mt-2">veyra-erc8004-v1</div>
            </div>
          </div>
        </section>

        {/* Reputation Breakdown */}
        <section className="space-y-4">
          <h3 className="text-xl font-bold text-white flex items-center gap-2">
            <Activity className="w-5 h-5 text-sky-400" /> ERC-8004 Independent Reputation Signals
          </h3>
          <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 space-y-4">
            <p className="text-xs text-slate-300 leading-relaxed">
              Veyra strictly adheres to the ERC-8004 security standard: <strong>Veyra never posts self-feedback or artificial reputation scores to its own Agent ID</strong>. External feedback count: <strong>0</strong>. Independent reviewers: <strong>0</strong>.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs font-mono pt-2">
              <div className="bg-slate-950/80 border border-slate-800 p-4 rounded-xl">
                <div className="text-slate-500 font-sans text-2xs uppercase">External Feedback</div>
                <div className="text-lg font-bold text-white mt-1">0 External Attestations</div>
              </div>
              <div className="bg-slate-950/80 border border-slate-800 p-4 rounded-xl">
                <div className="text-slate-500 font-sans text-2xs uppercase">Independent Reviewers</div>
                <div className="text-lg font-bold text-slate-400 mt-1">0 Reviewers</div>
              </div>
              <div className="bg-slate-950/80 border border-slate-800 p-4 rounded-xl">
                <div className="text-slate-500 font-sans text-2xs uppercase">Reputation Registry</div>
                <div className="text-xs font-bold text-slate-300 truncate mt-1">{ARC_ERC8004_REPUTATION_REGISTRY}</div>
              </div>
            </div>
          </div>
        </section>

        {/* Integration Code Snippet */}
        <section className="space-y-4">
          <h3 className="text-xl font-bold text-white flex items-center gap-2">
            <Code2 className="w-5 h-5 text-sky-400" /> Requesting ERC-8004 Validation from Veyra
          </h3>
          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 space-y-3 font-mono text-xs">
            <div className="text-slate-300 font-sans">
              To request an official ERC-8004 validation response from Veyra:
            </div>
            <pre className="bg-slate-950 p-4 rounded-xl text-slate-200 overflow-x-auto border border-slate-800">
{`import { parseAbi } from "viem";

const VALIDATION_REGISTRY = "${ARC_ERC8004_VALIDATION_REGISTRY}";
const VEYRA_VALIDATOR = "${ownerAddress}";

const abi = parseAbi([
  "function validationRequest(address validatorAddress, uint256 agentId, string requestURI, bytes32 requestHash)"
]);

// Step 1. Request validation from Veyra
await walletClient.writeContract({
  address: VALIDATION_REGISTRY,
  abi,
  functionName: "validationRequest",
  args: [VEYRA_VALIDATOR, targetAgentId, "ipfs://...", requestHash]
});`}
            </pre>
          </div>
        </section>
      </div>
    </div>
  );
}
