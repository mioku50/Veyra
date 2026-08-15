/**
 * Copyright 2026 Circle Internet Group, Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import React from "react";
import Link from "next/link";
import { ShieldCheck, ExternalLink, ArrowRight, CheckCircle2, Cpu, FileCode2, Scale } from "lucide-react";

export const revalidate = 60;

export default function EvaluatorsLandingPage() {
  const evaluatorAddress = process.env.NEXT_PUBLIC_VEYRA_ERC8183_EVALUATOR_ADDRESS || "0x0d2c04580e081e222bbe5bf9818af337e2633eb7";
  const commerceAddress = process.env.NEXT_PUBLIC_ARC_ERC8183_COMMERCE_ADDRESS || "0x0747EEf0706327138c69792bF28Cd525089e4583";

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 md:p-12 font-sans">
      <div className="max-w-5xl mx-auto space-y-12">
        {/* Header */}
        <header className="flex items-center justify-between border-b border-slate-800 pb-6">
          <div className="flex items-center gap-3">
            <ShieldCheck className="w-10 h-10 text-sky-400" />
            <div>
              <span className="text-xs font-semibold tracking-wider text-sky-400 uppercase">Veyra Trust Layer</span>
              <h1 className="text-3xl font-extrabold tracking-tight text-white">Veyra Evaluators</h1>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <Link
              href="/evaluations"
              className="text-xs font-medium text-slate-300 hover:text-white bg-slate-900 border border-slate-700 px-4 py-2 rounded-lg transition-colors"
            >
              Evaluations Explorer
            </Link>
          </div>
        </header>

        {/* Hero Section */}
        <section className="space-y-4 text-center md:text-left">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold bg-sky-500/10 text-sky-400 border border-sky-500/20">
            <Scale className="w-3.5 h-3.5" />
            <span>Agentic Commerce Verification</span>
          </div>
          <h2 className="text-4xl md:text-5xl font-black text-white leading-tight">
            Independent evaluation for agentic commerce
          </h2>
          <p className="text-lg text-slate-400 max-w-3xl">
            Use Veyra as an ERC-8183 evaluator to independently verify agent deliverables before settlement on Arc Testnet.
          </p>
        </section>

        {/* Featured Evaluator Card */}
        <section className="space-y-6">
          <div className="flex items-center justify-between">
            <h3 className="text-xl font-bold text-white flex items-center gap-2">
              <Cpu className="w-5 h-5 text-sky-400" /> Veyra Arc Testnet Evaluator
            </h3>
            <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-400 bg-emerald-950/60 border border-emerald-800/60 px-3 py-1 rounded-full">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              Active Capability
            </span>
          </div>

          <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-6 md:p-8 space-y-6 shadow-xl backdrop-blur-sm">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-6">
              <div>
                <div className="text-xs font-semibold text-sky-400 uppercase tracking-wider">ERC-8183 Standard</div>
                <h4 className="text-2xl font-bold text-white mt-1">Veyra ERC-8183 Evaluator</h4>
                <p className="text-sm text-slate-400 mt-1">
                  Deterministic offchain policy verification engine with onchain EIP-712 settlement authorization.
                </p>
              </div>
              <div className="flex items-center gap-3">
                <Link
                  href="/evaluators/erc8183"
                  className="inline-flex items-center gap-2 bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold px-5 py-2.5 rounded-xl transition-all shadow-lg text-sm"
                >
                  Inspect Capability Profile <ArrowRight className="w-4 h-4" />
                </Link>
              </div>
            </div>

            {/* Spec Matrix Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 text-xs font-mono">
              <div className="bg-slate-950/60 border border-slate-800 p-4 rounded-xl">
                <div className="text-slate-500 font-sans text-2xs uppercase tracking-wider mb-1">Network</div>
                <div className="text-slate-200 font-bold">Arc Testnet (5042002)</div>
              </div>
              <div className="bg-slate-950/60 border border-slate-800 p-4 rounded-xl">
                <div className="text-slate-500 font-sans text-2xs uppercase tracking-wider mb-1">Policy</div>
                <div className="text-sky-300 font-bold">structured-deliverable-v1</div>
              </div>
              <div className="bg-slate-950/60 border border-slate-800 p-4 rounded-xl">
                <div className="text-slate-500 font-sans text-2xs uppercase tracking-wider mb-1">Evaluation Type</div>
                <div className="text-slate-200 font-bold">Deterministic Engine</div>
              </div>
              <div className="bg-slate-950/60 border border-slate-800 p-4 rounded-xl">
                <div className="text-slate-500 font-sans text-2xs uppercase tracking-wider mb-1">Settlement Mode</div>
                <div className="text-emerald-400 font-bold">EIP-712 Complete/Reject</div>
              </div>
            </div>

            {/* Contract Addresses */}
            <div className="space-y-3 pt-2">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between text-xs bg-slate-950/80 p-3 rounded-lg border border-slate-800 font-mono">
                <span className="text-slate-400 font-sans">Evaluator Contract:</span>
                <span className="text-sky-300 truncate">{evaluatorAddress}</span>
              </div>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between text-xs bg-slate-950/80 p-3 rounded-lg border border-slate-800 font-mono">
                <span className="text-slate-400 font-sans">Agentic Commerce Contract:</span>
                <span className="text-slate-300 truncate">{commerceAddress}</span>
              </div>
            </div>

            {/* Actions Bar */}
            <div className="flex flex-wrap items-center justify-between gap-4 pt-4 border-t border-slate-800 text-xs font-medium">
              <div className="flex items-center gap-4">
                <a
                  href={`https://testnet.arcscan.app/address/${evaluatorAddress}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-slate-300 hover:text-sky-400 transition-colors"
                >
                  View on Arcscan <ExternalLink className="w-3.5 h-3.5" />
                </a>
                <Link
                  href="/evaluations"
                  className="inline-flex items-center gap-1.5 text-slate-300 hover:text-sky-400 transition-colors"
                >
                  View Evaluations <ArrowRight className="w-3.5 h-3.5" />
                </Link>
              </div>
              <Link
                href="/evaluators/erc8183#integration"
                className="inline-flex items-center gap-1.5 text-sky-400 hover:text-sky-300 font-semibold"
              >
                <FileCode2 className="w-4 h-4" /> Use Veyra as Evaluator
              </Link>
            </div>
          </div>
        </section>

        {/* Benefits Grid */}
        <section className="grid grid-cols-1 md:grid-cols-3 gap-6 pt-6">
          <div className="bg-slate-900/40 border border-slate-800 p-6 rounded-2xl space-y-3">
            <CheckCircle2 className="w-8 h-8 text-sky-400" />
            <h4 className="font-bold text-white text-base">Deterministic Policy Rules</h4>
            <p className="text-xs text-slate-400 leading-relaxed">
              Every job deliverable is validated against cryptographic hashes, HTTP protocol requirements, payload schemas, and job status checks.
            </p>
          </div>
          <div className="bg-slate-900/40 border border-slate-800 p-6 rounded-2xl space-y-3">
            <ShieldCheck className="w-8 h-8 text-emerald-400" />
            <h4 className="font-bold text-white text-base">Cryptographic Proof Trail</h4>
            <p className="text-xs text-slate-400 leading-relaxed">
              Attester EIP-712 signatures authorization guarantees tamper-proof verdicts submitted directly on Arc Testnet via relayers.
            </p>
          </div>
          <div className="bg-slate-900/40 border border-slate-800 p-6 rounded-2xl space-y-3">
            <Scale className="w-8 h-8 text-purple-400" />
            <h4 className="font-bold text-white text-base">Fail-Closed Settlement</h4>
            <p className="text-xs text-slate-400 leading-relaxed">
              Escrowed funds are strictly guarded. Settlements require positive proof of compliance before calling onchain complete().
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
