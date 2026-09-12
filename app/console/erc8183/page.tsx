"use client";

/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from "react";
import Link from "next/link";
import { ArrowLeft, CheckCircle2, XCircle, ShieldCheck, ExternalLink, Loader2, Play, FileJson } from "lucide-react";

export default function Erc8183ConsolePage() {
  const [commerceAddress, setCommerceAddress] = useState(
    process.env.NEXT_PUBLIC_ARC_ERC8183_AGENTIC_COMMERCE_ADDRESS || "0x0747EEf0706327138c69792bF28Cd525089e4583"
  );
  const [jobId, setJobId] = useState("1");
  const [contentUri, setContentUri] = useState("https://raw.githubusercontent.com/circlefin/skills/master/README.md");
  const [contentHash, setContentHash] = useState("0x3600000000000000000000000000000000000000000000000000000000000000");

  const [loading, setLoading] = useState(false);
  const [evaluating, setEvaluating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);

  const handlePrepare = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/erc8183/v1/deliverables/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contentUri,
          contentHash,
          contentType: "application/json",
          schemaId: "veyra://schemas/structured-deliverable-v1",
          policyId: "structured-deliverable-v1",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Prepare failed");
      setResult((prev: any) => ({ ...prev, prepared: data }));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleEvaluate = async () => {
    setEvaluating(true);
    setError(null);
    try {
      const prepRes = await fetch("/api/erc8183/v1/deliverables/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contentUri,
          contentHash,
          contentType: "application/json",
          schemaId: "veyra://schemas/structured-deliverable-v1",
          policyId: "structured-deliverable-v1",
        }),
      });
      const prepData = await prepRes.json();
      if (!prepRes.ok) throw new Error(prepData.message || "Deliverable preparation failed");

      // For canary console demo, trigger evaluation endpoint
      const evalRes = await fetch("/api/erc8183/v1/evaluations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `canary-${Date.now()}`,
          Authorization: "Bearer mock-canary-key",
        },
        body: JSON.stringify({
          chainId: 5042002,
          agenticCommerce: commerceAddress,
          jobId,
          deliverable: prepData.deliverable,
        }),
      });

      const evalData = await evalRes.json();
      if (!evalRes.ok) throw new Error(evalData.message || "Evaluation failed");
      setResult((prev: any) => ({ ...prev, evaluation: evalData }));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setEvaluating(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 md:p-12 font-sans">
      <div className="max-w-5xl mx-auto space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 pb-6">
          <div>
            <Link
              href="/console"
              className="inline-flex items-center text-xs font-semibold text-emerald-400 hover:text-emerald-300 mb-2 transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5 mr-1" /> Back to Console
            </Link>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-white flex items-center gap-3">
              <ShieldCheck className="w-8 h-8 text-emerald-400" />
              ERC-8183 Job Evaluator Canary
            </h1>
            <p className="text-sm text-slate-400 mt-1">
              Veyra production-ready offchain EIP-712 evaluator for ERC-8183 agentic jobs on Arc Testnet (5042002).
            </p>
          </div>
          <span className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-xs px-3 py-1 rounded-full font-mono">
            Canary Mode
          </span>
        </div>

        {/* Inputs Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Card 1: Job Target */}
          <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-6 space-y-4 backdrop-blur">
            <h2 className="text-base font-semibold text-white flex items-center gap-2 border-b border-slate-800 pb-3">
              <FileJson className="w-4 h-4 text-emerald-400" /> ERC-8183 Target Job
            </h2>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                ERC-8183 Contract Address
              </label>
              <input
                type="text"
                value={commerceAddress}
                onChange={(e) => setCommerceAddress(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 focus:outline-none focus:border-emerald-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Job ID</label>
              <input
                type="text"
                value={jobId}
                onChange={(e) => setJobId(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 focus:outline-none focus:border-emerald-500"
              />
            </div>
            <div className="pt-2">
              <div className="text-xs text-slate-400 space-y-1 bg-slate-950/40 p-3 rounded-lg border border-slate-800 font-mono">
                <div>Chain ID: 5042002 (Arc Testnet)</div>
                <div>Policy: structured-deliverable-v1</div>
              </div>
            </div>
          </div>

          {/* Card 2: Deliverable Commitment */}
          <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-6 space-y-4 backdrop-blur">
            <h2 className="text-base font-semibold text-white flex items-center gap-2 border-b border-slate-800 pb-3">
              <FileJson className="w-4 h-4 text-emerald-400" /> Deliverable Commitment V1
            </h2>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Content URI (HTTPS)</label>
              <input
                type="text"
                value={contentUri}
                onChange={(e) => setContentUri(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 focus:outline-none focus:border-emerald-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Content Hash (keccak256 raw bytes)
              </label>
              <input
                type="text"
                value={contentHash}
                onChange={(e) => setContentHash(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 focus:outline-none focus:border-emerald-500"
              />
            </div>
            <div className="flex gap-3 pt-2">
              <button
                onClick={handlePrepare}
                disabled={loading}
                className="flex-1 bg-slate-800 hover:bg-slate-700 text-white text-xs font-medium py-2.5 px-4 rounded-lg transition-colors flex items-center justify-center gap-2 border border-slate-700 disabled:opacity-50"
              >
                {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Compute Commitment"}
              </button>
              <button
                onClick={handleEvaluate}
                disabled={evaluating}
                className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium py-2.5 px-4 rounded-lg transition-colors flex items-center justify-center gap-2 shadow-lg shadow-emerald-950 disabled:opacity-50"
              >
                {evaluating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5 fill-current" />}
                Evaluate Job
              </button>
            </div>
          </div>
        </div>

        {/* Error Alert */}
        {error && (
          <div className="bg-red-950/50 border border-red-800/80 rounded-xl p-4 text-red-300 text-xs flex items-center gap-3">
            <XCircle className="w-5 h-5 text-red-400 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Output Section */}
        {result && (
          <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-6 space-y-6">
            <h3 className="text-base font-semibold text-white border-b border-slate-800 pb-3">
              Evaluation Execution Output
            </h3>

            {result.prepared && (
              <div className="space-y-2">
                <div className="text-xs font-semibold text-slate-400">Deliverable Commitment V1:</div>
                <pre className="bg-slate-950 p-4 rounded-lg text-xs font-mono text-emerald-300 border border-slate-800 overflow-x-auto">
                  {JSON.stringify(result.prepared, null, 2)}
                </pre>
              </div>
            )}

            {result.evaluation && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-400">Result Status:</span>
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    {result.evaluation.status}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-400">Evaluation Public ID:</span>
                  <span className="font-mono text-slate-200">{result.evaluation.evaluationId}</span>
                </div>
                <div className="pt-2">
                  <Link
                    href={`/evaluations/${result.evaluation.evaluationId}`}
                    target="_blank"
                    className="inline-flex items-center gap-1.5 text-xs text-emerald-400 hover:text-emerald-300 font-medium"
                  >
                    View Public Evaluation Report Page <ExternalLink className="w-3.5 h-3.5" />
                  </Link>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
