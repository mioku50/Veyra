/**
 * Copyright 2026 Circle Internet Group, Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import React from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CheckCircle2, XCircle, ExternalLink, ShieldCheck, FileCheck2, AlertCircle } from "lucide-react";
import { getByoaClient } from "@/lib/byoa/service";
import type { Erc8183EvaluationRecord } from "@/lib/erc8183/types";

export const revalidate = 0;

export default async function PublicEvaluationReportPage({
  params,
}: {
  params: Promise<{ publicId: string }>;
}) {
  const { publicId } = await params;

  if (!publicId || !publicId.trim()) {
    notFound();
  }

  const supabase = getByoaClient();
  const { data: record, error } = await supabase
    .from("erc8183_evaluations")
    .select("public_id,chain_id,agentic_commerce,job_id,evaluator_contract,deliverable_hash,policy_id,decision,status,canonical_report,report_hash,settlement_tx_hash,created_at,evaluated_at,settled_at")
    .eq("public_id", publicId.trim())
    .in("status", ["completed", "rejected"])
    .maybeSingle();

  if (error) {
    throw new Error("Public evaluation report is unavailable");
  }

  if (!record) {
    notFound();
  }

  const evaluation = record as Erc8183EvaluationRecord;
  const canonicalReport = evaluation.canonical_report as any;

  const isComplete = evaluation.decision === "complete" || evaluation.status === "completed";
  const checks: any[] = canonicalReport?.checks ?? [];
  const evidence: any[] = canonicalReport?.evidence ?? [];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 md:p-12 font-sans">
      <div className="max-w-4xl mx-auto space-y-8">
        {/* Header Branding */}
        <div className="flex items-center justify-between border-b border-slate-800 pb-6">
          <div className="flex items-center gap-3">
            <ShieldCheck className="w-10 h-10 text-sky-400" />
            <div>
              <div className="flex items-center gap-2 text-xs text-slate-400 mb-1">
                <Link href="/evaluators" className="hover:text-white transition-colors">
                  Evaluators
                </Link>
                <span>/</span>
                <Link href="/evaluations" className="hover:text-white transition-colors">
                  Explorer
                </Link>
                <span>/</span>
                <span className="text-sky-400 font-medium">Receipt</span>
              </div>
              <h1 className="text-2xl font-bold tracking-tight text-white">Veyra Canonical Evaluation Report</h1>
              <p className="text-xs text-slate-400">Independent ERC-8183 Job Verification Layer on Arc Testnet</p>
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs text-slate-500 font-mono">Public ID: {evaluation.public_id}</div>
            <div className="text-xs text-slate-400 mt-1 font-mono">Chain ID: {evaluation.chain_id}</div>
          </div>
        </div>

        {/* Verdict Hero Card */}
        <div className={`border rounded-2xl p-6 md:p-8 backdrop-blur flex flex-col md:flex-row items-start md:items-center justify-between gap-6 ${
          isComplete ? "bg-emerald-950/20 border-emerald-500/30" : "bg-red-950/20 border-red-500/30"
        }`}>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              {isComplete ? (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                  <CheckCircle2 className="w-4 h-4" /> VERDICT COMPLETE
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-red-500/20 text-red-300 border border-red-500/40">
                  <XCircle className="w-4 h-4" /> VERDICT REJECTED
                </span>
              )}
              <span className="text-xs font-mono text-slate-400">Policy: {evaluation.policy_id}</span>
            </div>
            <h2 className="text-xl font-bold text-white">
              {isComplete ? "Job Executed Successfully & Proven Onchain" : "Job Execution Failed Verification"}
            </h2>
            <p className="text-xs text-slate-300">
              ERC-8183 Job #{evaluation.job_id} evaluated by Veyra ERC8183Evaluator smart contract.
            </p>
          </div>

          {evaluation.settlement_tx_hash && (
            <Link
              href={`https://testnet.arcscan.app/tx/${evaluation.settlement_tx_hash}`}
              target="_blank"
              className="inline-flex items-center gap-2 bg-slate-900 hover:bg-slate-800 border border-slate-700 text-sky-400 text-xs px-4 py-3 rounded-xl transition-colors font-mono shrink-0 shadow-md"
            >
              Arc Settlement Tx <ExternalLink className="w-3.5 h-3.5" />
            </Link>
          )}
        </div>

        {/* Technical Hashes */}
        <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between border-b border-slate-800 pb-2">
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <FileCheck2 className="w-4 h-4 text-sky-400" /> Proof Hashes & Addresses
            </h3>
            <Link
              href="/agents/veyra"
              className="inline-flex items-center gap-1.5 text-xs text-sky-400 hover:text-sky-300 font-semibold"
            >
              Veyra ERC-8004 Identity <ExternalLink className="w-3.5 h-3.5" />
            </Link>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs font-mono">
            <div>
              <span className="text-slate-400 block mb-0.5">ERC-8183 Contract:</span>
              <span className="text-slate-200 break-all">{evaluation.agentic_commerce}</span>
            </div>
            <div>
              <span className="text-slate-400 block mb-0.5">Evaluator Contract:</span>
              <span className="text-slate-200 break-all">{evaluation.evaluator_contract}</span>
            </div>
            <div>
              <span className="text-slate-400 block mb-0.5">Canonical Report Hash:</span>
              <span className="text-sky-300 break-all">{evaluation.report_hash || "N/A"}</span>
            </div>
            <div>
              <span className="text-slate-400 block mb-0.5">Deliverable Hash:</span>
              <span className="text-slate-200 break-all">{evaluation.deliverable_hash}</span>
            </div>
          </div>
        </div>

        {/* Deterministic Checks Table */}
        <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-6 space-y-4">
          <h3 className="text-sm font-semibold text-white border-b border-slate-800 pb-2">
            Deterministic Evaluation Policy Checks ({checks.length})
          </h3>
          <div className="space-y-3">
            {checks.map((check: any) => (
              <div
                key={check.id}
                className="flex items-start justify-between bg-slate-950/60 border border-slate-800 p-3 rounded-lg text-xs"
              >
                <div className="space-y-1">
                  <div className="font-semibold text-slate-200 flex items-center gap-2">
                    <span>{check.name}</span>
                    <span className="text-[10px] text-slate-500 font-mono">({check.id})</span>
                  </div>
                  <div className="text-slate-400">{check.message}</div>
                </div>
                <span
                  className={`px-2.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider ${
                    check.passed
                      ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                      : "bg-red-500/10 text-red-400 border border-red-500/20"
                  }`}
                >
                  {check.passed ? "Passed" : "Failed"}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Evidence Section */}
        {evidence.length > 0 && (
          <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-6 space-y-4">
            <h3 className="text-sm font-semibold text-white border-b border-slate-800 pb-2">
              Deliverable Evidence Artifacts
            </h3>
            <div className="space-y-2 text-xs">
              {evidence.map((ev: any, idx: number) => (
                <div key={idx} className="bg-slate-950 p-3 rounded-lg border border-slate-800 space-y-1 font-mono">
                  <div className="text-sky-300 font-bold">{ev.type}: {ev.description}</div>
                  {ev.uri && <div className="text-slate-400 break-all">URI: {ev.uri}</div>}
                  {ev.hash && <div className="text-slate-500 break-all">Hash: {ev.hash}</div>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Disclaimer */}
        <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-4 text-xs text-slate-400 flex items-start gap-3">
          <AlertCircle className="w-4 h-4 text-slate-500 shrink-0 mt-0.5" />
          <div>
            <strong>Veyra Evaluation Disclaimer:</strong> This evaluation report was produced deterministically by the Veyra Offchain Evaluator engine and settled via EIP-712 signature verification on Arc Testnet (chain ID 5042002).
          </div>
        </div>
      </div>
    </div>
  );
}
