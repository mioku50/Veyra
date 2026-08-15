"use client";

import React, { useState } from "react";
import Link from "next/link";
import { Shield, ShieldAlert, ShieldCheck, AlertTriangle, ExternalLink, ArrowRight } from "lucide-react";
import type { TrustAction, TrustDecision, TrustRiskCode } from "@/lib/trust-gate/types.ts";

export default function TrustGatePage() {
  const [agentId, setAgentId] = useState("");
  const [counterparty, setCounterparty] = useState("");
  const [action, setAction] = useState<TrustAction>("erc8183_job");
  const [amountUsdc, setAmountUsdc] = useState("");
  const [loading, setLoading] = useState(false);
  const [decision, setDecision] = useState<TrustDecision | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleEvaluate = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setDecision(null);

    try {
      const res = await fetch("/api/trust/v1/decisions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subjectAgentId: agentId,
          counterpartyAgentId: counterparty || undefined,
          action,
          requestedValueUsdc: Number(amountUsdc) || 0,
        }),
      });

      if (!res.ok) {
        throw new Error(`Failed to evaluate trust: ${res.statusText}`);
      }

      const data = await res.json();
      setDecision(data);
    } catch (err: any) {
      setError(err.message || "An error occurred");
    } finally {
      setLoading(false);
    }
  };

  const getDecisionColor = (level: string) => {
    switch (level) {
      case "ALLOW": return "text-emerald-400 bg-emerald-500/10 border-emerald-500/20";
      case "ALLOW_WITH_LIMITS": return "text-amber-400 bg-amber-500/10 border-amber-500/20";
      case "REQUIRE_EVALUATOR": return "text-blue-400 bg-blue-500/10 border-blue-500/20";
      case "REVIEW_REQUIRED": return "text-orange-400 bg-orange-500/10 border-orange-500/20";
      case "DENY": return "text-red-400 bg-red-500/10 border-red-500/20";
      default: return "text-slate-400 bg-slate-500/10 border-slate-500/20";
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 text-slate-100 p-6 md:p-12 font-sans selection:bg-sky-500/30">
      <div className="max-w-3xl mx-auto space-y-8">
        <header className="border-b border-white/10 pb-6 mb-8">
          <div className="flex items-center gap-3 mb-2">
            <Shield className="w-8 h-8 text-sky-400" />
            <h1 className="text-2xl font-bold text-white tracking-tight">Veyra Trust Gate</h1>
          </div>
          <p className="text-slate-400">Evidence-backed trust decisions for agentic commerce</p>
        </header>

        <form onSubmit={handleEvaluate} className="space-y-6 bg-white/5 backdrop-blur-sm border border-white/10 rounded-2xl p-6 md:p-8">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-300">Agent ID / Wallet</label>
              <input
                type="text"
                required
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2 text-white focus:ring-2 focus:ring-sky-500 focus:border-transparent outline-none transition-all"
                placeholder="0x... or Agent ID"
              />
            </div>
            
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-300">Counterparty (Optional)</label>
              <input
                type="text"
                value={counterparty}
                onChange={(e) => setCounterparty(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2 text-white focus:ring-2 focus:ring-sky-500 focus:border-transparent outline-none transition-all"
                placeholder="0x... or Agent ID"
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-300">Action</label>
              <select
                value={action}
                onChange={(e) => setAction(e.target.value as TrustAction)}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2 text-white focus:ring-2 focus:ring-sky-500 focus:border-transparent outline-none transition-all"
              >
                <option value="erc8183_job">ERC-8183 Job</option>
                <option value="x402_payment">x402 Payment</option>
                <option value="paid_api_call">Paid API Call</option>
                <option value="service_purchase">Service Purchase</option>
              </select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-300">USDC Amount</label>
              <input
                type="number"
                min="0"
                step="0.01"
                required
                value={amountUsdc}
                onChange={(e) => setAmountUsdc(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2 text-white focus:ring-2 focus:ring-sky-500 focus:border-transparent outline-none transition-all"
                placeholder="0.00"
              />
            </div>
          </div>

          <div className="flex flex-col sm:flex-row items-center gap-3 pt-2">
            <button
              type="button"
              onClick={() => {
                setAgentId("agent_github_auditor");
                setAction("erc8183_job");
                setAmountUsdc("1.50");
              }}
              className="w-full sm:w-auto px-4 py-3 rounded-lg border border-slate-700 bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-white text-sm font-medium transition-colors"
            >
              Try Example
            </button>
            <button
              type="submit"
              disabled={loading || !agentId || !amountUsdc}
              className="w-full flex-1 bg-gradient-to-r from-sky-500 to-blue-600 hover:from-sky-400 hover:to-blue-500 text-white font-semibold py-3 rounded-lg shadow-lg shadow-sky-500/20 transition-all disabled:opacity-50 flex justify-center items-center gap-2"
            >
              {loading ? (
                <span className="animate-pulse">Evaluating...</span>
              ) : (
                <>Evaluate Trust <ArrowRight className="w-4 h-4" /></>
              )}
            </button>
          </div>
        </form>

        {error && (
          <div className="bg-red-500/10 border border-red-500/20 text-red-400 p-4 rounded-xl flex items-start gap-3 animate-in fade-in slide-in-from-bottom-2">
            <ShieldAlert className="w-5 h-5 flex-shrink-0 mt-0.5" />
            <p>{error}</p>
          </div>
        )}

        {decision && (
          <div className="bg-white/5 backdrop-blur-md border border-white/10 rounded-2xl overflow-hidden shadow-2xl animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="p-6 md:p-8 space-y-6">
              <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 pb-6">
                <h2 className="text-lg font-medium text-slate-300">Evaluation Result</h2>
                <div className={`px-4 py-1.5 rounded-full font-bold tracking-wider text-sm border flex items-center gap-2 ${getDecisionColor(decision.decision)}`}>
                  {decision.decision === "ALLOW" ? <ShieldCheck className="w-4 h-4" /> : <ShieldAlert className="w-4 h-4" />}
                  {decision.decision.replace(/_/g, " ")}
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="space-y-1">
                  <div className="text-xs text-slate-500 uppercase tracking-wider">Trust Score</div>
                  <div className="text-2xl font-semibold text-white">{decision.trust.score}/100</div>
                </div>
                <div className="space-y-1">
                  <div className="text-xs text-slate-500 uppercase tracking-wider">Confidence</div>
                  <div className="text-2xl font-semibold text-white">{Math.round(decision.trust.confidence * 100)}%</div>
                </div>
                <div className="space-y-1">
                  <div className="text-xs text-slate-500 uppercase tracking-wider">Coverage</div>
                  <div className="text-2xl font-semibold text-white">{Math.round(decision.trust.coverage * 100)}%</div>
                </div>
                <div className="space-y-1">
                  <div className="text-xs text-slate-500 uppercase tracking-wider">Max Exposure</div>
                  <div className="text-2xl font-semibold text-white">{decision.policy.maxValueUsdc} USDC</div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm text-slate-300 pt-4 border-t border-white/5">
                <div className="flex justify-between">
                  <span className="text-slate-500">Evaluator Required:</span>
                  <span className="font-medium text-white">{decision.policy.evaluatorRequired ? "Yes" : "No"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Decision Expiry:</span>
                  <span className="font-medium text-white">
                    {Math.round((new Date(decision.expiresAt).getTime() - new Date().getTime()) / 60000)} min
                  </span>
                </div>
              </div>

              {decision.riskSignals && decision.riskSignals.length > 0 && (
                <div className="pt-6 border-t border-white/5">
                  <h3 className="text-sm font-medium text-slate-400 mb-3 flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-500" />
                    Risk Signals
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {decision.riskSignals.map((signal, idx) => (
                      <span key={idx} className="bg-amber-500/10 text-amber-300 border border-amber-500/20 px-3 py-1 rounded-md text-xs font-mono">
                        ⚠️ {signal}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
            
            <div className="bg-slate-900/50 p-4 md:px-8 border-t border-white/5 flex flex-wrap gap-4">
              <Link href={`/reputation/${decision.subject.agentId}`} className="text-sm text-sky-400 hover:text-sky-300 flex items-center gap-1.5 transition-colors">
                View Reputation Profile <ExternalLink className="w-3.5 h-3.5" />
              </Link>
              <a href="#" className="text-sm text-sky-400 hover:text-sky-300 flex items-center gap-1.5 transition-colors">
                View Arc Proof <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>
          </div>
        )}
        
        <footer className="pt-8 text-center text-xs text-slate-600 flex items-center justify-center gap-2">
          <AlertTriangle className="w-4 h-4" />
          This is an evidence-backed trust assessment, not a guarantee of financial safety.
        </footer>
      </div>
    </div>
  );
}
