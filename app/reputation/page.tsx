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
  BadgeCheck,
  FileText,
  AlertTriangle,
  ArrowRight,
  TrendingUp,
} from "lucide-react";
import { getArcPublicClient, getCanonicalVeyraAgentIdentity } from "@/lib/erc8004/client.ts";
import { fetchLatestReputationSnapshot, fetchReputationEvidenceForAgent, fetchReputationSnapshotHistory } from "@/lib/reputation/db.ts";
import { computeAgentReputation, createReputationSnapshot, sanitizeEvidenceForPublic } from "@/lib/reputation/engine.ts";

export const dynamic = "force-dynamic";
export const revalidate = 30;

export default async function PublicAgentReputationPage() {
  const publicClient = getArcPublicClient();
  const canonicalIdentity = await getCanonicalVeyraAgentIdentity(publicClient);
  if (!canonicalIdentity) notFound();
  const agentId = canonicalIdentity.agent_id;

  const identity = {
    agentId,
    chainId: 5042002 as const,
    identityRegistry: canonicalIdentity.registry_address,
    owner: canonicalIdentity.owner_address,
    metadataUri: canonicalIdentity.metadata_uri,
    verifiedOnchain: true,
  };

  const evidenceList = await fetchReputationEvidenceForAgent(agentId);
  const explanation = computeAgentReputation(identity, evidenceList);
  const latestSnapshot = (await fetchLatestReputationSnapshot(agentId)) || createReputationSnapshot(identity, evidenceList, explanation);
  const snapshotHistory = await fetchReputationSnapshotHistory(agentId);
  const sanitizedEvidence = sanitizeEvidenceForPublic(evidenceList);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 md:p-12 font-sans">
      <div className="max-w-5xl mx-auto space-y-10">
        {/* Header Breadcrumb */}
        <div className="flex flex-col md:flex-row md:items-center justify-between border-b border-slate-800 pb-6 gap-4">
          <div className="flex items-center gap-3">
            <ShieldCheck className="w-10 h-10 text-sky-400" />
            <div>
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <Link href="/agents" className="hover:text-white transition-colors">
                  Agents
                </Link>
                <span>/</span>
                <span className="text-sky-400 font-medium">Reputation</span>
              </div>
              <h1 className="text-3xl font-extrabold text-white mt-1">
                Veyra Agent Reputation #{agentId}
              </h1>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> {explanation.statusLabel}
            </span>
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-sky-500/20 text-sky-300 border border-sky-500/40">
              <BadgeCheck className="w-4 h-4 text-sky-400" /> {explanation.confidence} Confidence ({explanation.coverage}%)
            </span>
          </div>
        </div>

        {/* Hero Score Section */}
        <section className="bg-gradient-to-br from-slate-900 via-slate-900/90 to-slate-950 border border-slate-800 rounded-2xl p-6 md:p-8 space-y-6 shadow-xl">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-bold text-sky-400 uppercase tracking-wider bg-sky-950/60 border border-sky-800/60 px-2.5 py-1 rounded-md">
                  Evidence-Weighted Trust Score
                </span>
                <span className="text-xs text-emerald-400 font-semibold bg-emerald-950/60 border border-emerald-800/60 px-2.5 py-1 rounded-md flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" /> Arc Testnet (5042002)
                </span>
              </div>
              <div className="flex items-baseline gap-3">
                <div className="text-6xl font-black text-white">{explanation.trustScore}</div>
                <div className="text-xl font-bold text-slate-400">/ 100</div>
              </div>
              <p className="text-sm text-slate-300 max-w-2xl leading-relaxed">
                Deterministically calculated from {evidenceList.length} verified signals across ERC-8004 identity, ERC-8183 evaluations, x402 settlement, and Arc proof records.
              </p>
            </div>
            <div className="flex flex-col sm:flex-row gap-3">
              <Link
                href={`/api/reputation/v1/agents/${agentId}`}
                target="_blank"
                className="inline-flex items-center justify-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-100 font-semibold px-4 py-2.5 rounded-xl border border-slate-700 text-xs transition-colors"
              >
                <FileText className="w-4 h-4 text-sky-400" /> Reputation JSON <ExternalLink className="w-3.5 h-3.5" />
              </Link>
            </div>
          </div>
        </section>

        {/* Compact Badges */}
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3 text-2xs font-semibold">
          <div className="bg-slate-900/90 border border-emerald-500/30 p-2.5 rounded-xl flex items-center gap-2 text-emerald-300">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> ERC-8004 Identity
          </div>
          <div className="bg-slate-900/90 border border-emerald-500/30 p-2.5 rounded-xl flex items-center gap-2 text-emerald-300">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> ERC-8183 Evaluator
          </div>
          <div className="bg-slate-900/90 border border-emerald-500/30 p-2.5 rounded-xl flex items-center gap-2 text-emerald-300">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> Verified Execution
          </div>
          <div className="bg-slate-900/90 border border-emerald-500/30 p-2.5 rounded-xl flex items-center gap-2 text-emerald-300">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> Economic History
          </div>
          <div className="bg-slate-900/90 border border-emerald-500/30 p-2.5 rounded-xl flex items-center gap-2 text-emerald-300">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> Arc Verified
          </div>
          <div className="bg-slate-900/90 border border-sky-500/30 p-2.5 rounded-xl flex items-center gap-2 text-sky-300">
            <Cpu className="w-3.5 h-3.5 text-sky-400" /> x402 Active
          </div>
        </div>

        {/* 6 Dimension Cards */}
        <section className="space-y-4">
          <h3 className="text-xl font-bold text-white flex items-center gap-2">
            <Activity className="w-5 h-5 text-sky-400" /> 6 Reputation Dimensions
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <div className="bg-slate-900/80 border border-slate-800 p-5 rounded-xl space-y-1">
              <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Identity</div>
              <div className="text-3xl font-extrabold text-white">{explanation.dimensions.identity}</div>
              <div className="text-3xs text-slate-500 font-sans">ERC-8004 & Ownership</div>
            </div>
            <div className="bg-slate-900/80 border border-slate-800 p-5 rounded-xl space-y-1">
              <div className="text-xs font-semibold text-sky-400 uppercase tracking-wider">Execution</div>
              <div className="text-3xl font-extrabold text-sky-400">{explanation.dimensions.execution}</div>
              <div className="text-3xs text-slate-500 font-sans">ERC-8183 Completed Jobs</div>
            </div>
            <div className="bg-slate-900/80 border border-slate-800 p-5 rounded-xl space-y-1">
              <div className="text-xs font-semibold text-emerald-400 uppercase tracking-wider">Validation</div>
              <div className="text-3xl font-extrabold text-emerald-400">{explanation.dimensions.validation}</div>
              <div className="text-3xs text-slate-500 font-sans">Veyra & ERC-8004 Verdicts</div>
            </div>
            <div className="bg-slate-900/80 border border-slate-800 p-5 rounded-xl space-y-1">
              <div className="text-xs font-semibold text-amber-400 uppercase tracking-wider">Economic Reliability</div>
              <div className="text-3xl font-extrabold text-amber-400">{explanation.dimensions.economicReliability}</div>
              <div className="text-3xs text-slate-500 font-sans">x402 & Escrow Settlement</div>
            </div>
            <div className="bg-slate-900/80 border border-slate-800 p-5 rounded-xl space-y-1">
              <div className="text-xs font-semibold text-purple-400 uppercase tracking-wider">Service Quality</div>
              <div className="text-3xl font-extrabold text-purple-400">{explanation.dimensions.serviceQuality}</div>
              <div className="text-3xs text-slate-500 font-sans">Veyra Product Reports</div>
            </div>
            <div className="bg-slate-900/80 border border-slate-800 p-5 rounded-xl space-y-1">
              <div className="text-xs font-semibold text-indigo-400 uppercase tracking-wider">External Reputation</div>
              <div className="text-3xl font-extrabold text-indigo-400">{explanation.dimensions.reputation}</div>
              <div className="text-3xs text-slate-500 font-sans">ERC-8004 Feedback Signals</div>
            </div>
          </div>
        </section>

        {/* Positive Explanations & Risk Signals */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 space-y-3">
            <h4 className="text-base font-bold text-emerald-400 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" /> Top Positive Evidence
            </h4>
            <ul className="space-y-2 text-xs text-slate-300">
              {explanation.topPositiveEvidence.map((item, idx) => (
                <li key={idx} className="flex items-start gap-2">
                  <span className="text-emerald-400 font-bold">•</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 space-y-3">
            <h4 className="text-base font-bold text-amber-400 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-400" /> Risk & Attention Signals
            </h4>
            <ul className="space-y-2 text-xs text-slate-300">
              {explanation.riskSignals.map((item, idx) => (
                <li key={idx} className="flex items-start gap-2">
                  <span className="text-amber-400 font-bold">•</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Evidence Breakdown with Arcscan Links */}
        <section className="space-y-4">
          <h3 className="text-xl font-bold text-white flex items-center gap-2">
            <Zap className="w-5 h-5 text-sky-400" /> Verified Evidence Breakdown ({sanitizedEvidence.length})
          </h3>
          <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-6 space-y-3 font-mono text-xs">
            {sanitizedEvidence.length === 0 ? (
              <div className="text-slate-400 text-xs italic">No evidence recorded yet.</div>
            ) : (
              <div className="space-y-3 divide-y divide-slate-800">
                {sanitizedEvidence.map((item) => (
                  <div key={item.evidenceId} className="pt-3 flex flex-col md:flex-row md:items-center justify-between gap-2">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className={`px-2 py-0.5 rounded text-3xs font-bold uppercase ${item.positive ? "bg-emerald-950 text-emerald-400 border border-emerald-800" : "bg-rose-950 text-rose-400 border border-rose-800"}`}>
                          {item.type}
                        </span>
                        <span className="text-slate-400 text-3xs">Tier {item.tier}</span>
                      </div>
                      <div className="text-slate-300 text-2xs truncate">Hash: {item.canonicalHash}</div>
                    </div>
                    <div className="flex items-center gap-3 text-3xs">
                      {item.economicValueUsdc ? (
                        <span className="text-amber-300 font-bold">${item.economicValueUsdc.toFixed(2)} USDC</span>
                      ) : null}
                      {item.arcscanTxUrl ? (
                        <a href={item.arcscanTxUrl} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline inline-flex items-center gap-1">
                          Arcscan <ExternalLink className="w-3 h-3" />
                        </a>
                      ) : (
                        <span className="text-slate-500">Verified</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* Reputation Timeline */}
        <section className="space-y-4">
          <h3 className="text-xl font-bold text-white flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-sky-400" /> Reputation History Timeline
          </h3>
          <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-6 space-y-3 font-mono text-xs">
            {snapshotHistory.length <= 1 ? (
              <div className="text-slate-400 text-xs italic">
                Reputation history will appear after additional verified activity. (Current snapshot: {latestSnapshot.snapshotId})
              </div>
            ) : (
              <div className="space-y-3">
                {snapshotHistory.map((snap) => (
                  <div key={snap.snapshotId} className="flex items-center justify-between border-b border-slate-800 pb-2">
                    <div>
                      <div className="text-white font-bold">{snap.createdAt.substring(0, 10)} — Trust Score {snap.trustScore}</div>
                      <div className="text-slate-400 text-3xs">{snap.statusLabel} | {snap.evidenceCount} items</div>
                    </div>
                    <div className="text-sky-400 text-3xs">{snap.snapshotId}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

      </div>
    </div>
  );
}
