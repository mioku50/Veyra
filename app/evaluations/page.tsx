/**
 * Copyright 2026 Circle Internet Group, Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import React from "react";
import Link from "next/link";
import { ShieldCheck, CheckCircle2, XCircle, Clock, ExternalLink, Filter, Search, ArrowRight } from "lucide-react";
import { getByoaClient } from "@/lib/byoa/service.ts";
import type { Erc8183EvaluationRecord } from "@/lib/erc8183/types.ts";

export const revalidate = 15;

export default async function PublicEvaluationsExplorerPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; q?: string; page?: string }>;
}) {
  const params = await searchParams;
  const currentFilter = (params.filter || "all").toLowerCase();
  const searchQuery = (params.q || "").trim();
  const page = Math.max(1, parseInt(params.page || "1", 10));
  const limit = 20;

  let evaluations: Erc8183EvaluationRecord[] = [];
  let totalCount = 0;

  const supabase = getByoaClient();
  let query = supabase
    .from("erc8183_evaluations")
    .select("public_id,job_id,decision,status,policy_id,report_hash,created_at", { count: "exact" })
    .in("status", ["completed", "rejected"]);

  if (currentFilter === "completed") {
    query = query.eq("status", "completed").eq("decision", "complete");
  } else if (currentFilter === "rejected") {
    query = query.eq("status", "rejected").eq("decision", "reject");
  }

  if (searchQuery) {
    query = query.or(
      `public_id.ilike.%${searchQuery}%,job_id.ilike.%${searchQuery}%,report_hash.ilike.%${searchQuery}%`
    );
  }

  const { data, count, error } = await query
    .order("created_at", { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  if (error) {
    throw new Error("Public evaluation explorer is unavailable");
  }
  if (data) {
    evaluations = data as Erc8183EvaluationRecord[];
  }
  if (count !== null) {
    totalCount = count;
  }

  const totalPages = Math.ceil(totalCount / limit);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 md:p-12 font-sans">
      <div className="max-w-6xl mx-auto space-y-8">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-6">
          <div className="flex items-center gap-3">
            <ShieldCheck className="w-10 h-10 text-sky-400" />
            <div>
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <Link href="/evaluators" className="hover:text-white transition-colors">
                  Evaluators
                </Link>
                <span>/</span>
                <span className="text-sky-400 font-medium">Explorer</span>
              </div>
              <h1 className="text-3xl font-extrabold text-white mt-1">
                Veyra Evaluations Explorer
              </h1>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/evaluators/erc8183"
              className="text-xs font-semibold text-slate-300 hover:text-white bg-slate-900 border border-slate-700 px-4 py-2 rounded-xl transition-colors"
            >
              Evaluator Profile & Spec
            </Link>
          </div>
        </div>

        {/* Filters and Search Bar */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          {/* Decision Filter Tabs */}
          <div className="flex flex-wrap items-center gap-1.5 bg-slate-900/80 p-1.5 rounded-xl border border-slate-800 text-xs font-medium">
            {[
              { id: "all", label: "All Evaluations" },
              { id: "completed", label: "Completed" },
              { id: "rejected", label: "Rejected" },
            ].map((tab) => {
              const isActive = currentFilter === tab.id;
              return (
                <Link
                  key={tab.id}
                  href={`/evaluations?filter=${tab.id}${searchQuery ? `&q=${encodeURIComponent(searchQuery)}` : ""}`}
                  className={`px-3.5 py-1.5 rounded-lg transition-all ${
                    isActive
                      ? "bg-sky-500 text-slate-950 font-bold shadow"
                      : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/50"
                  }`}
                >
                  {tab.label}
                </Link>
              );
            })}
          </div>

          {/* Search Form */}
          <form method="GET" action="/evaluations" className="relative flex-1 max-w-md">
            <input type="hidden" name="filter" value={currentFilter} />
            <Search className="w-4 h-4 text-slate-500 absolute left-3.5 top-3" />
            <input
              type="text"
              name="q"
              defaultValue={searchQuery}
              placeholder="Search Public ID, Job ID, or Hash..."
              className="w-full bg-slate-900 border border-slate-800 text-slate-100 text-xs rounded-xl pl-10 pr-4 py-2.5 focus:outline-none focus:border-sky-500 transition-colors placeholder:text-slate-600"
            />
          </form>
        </div>

        {/* Evaluations Explorer Table */}
        <div className="bg-slate-900/60 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-950/80 text-slate-400 font-mono uppercase tracking-wider border-b border-slate-800">
                <tr>
                  <th className="p-4">Public ID</th>
                  <th className="p-4">Job ID</th>
                  <th className="p-4">Decision / Status</th>
                  <th className="p-4">Policy</th>
                  <th className="p-4">Canonical Hash</th>
                  <th className="p-4">Timestamp</th>
                  <th className="p-4 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-mono">
                {evaluations.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="p-8 text-center text-slate-500 font-sans">
                      No evaluations match the criteria.
                    </td>
                  </tr>
                ) : (
                  evaluations.map((item) => {
                    const isComplete = item.decision === "complete" || item.status === "completed";
                    const isRejected = item.decision === "reject" || item.status === "rejected";
                    return (
                      <tr key={item.id} className="hover:bg-slate-800/30 transition-colors">
                        <td className="p-4 font-bold text-sky-400">
                          <Link href={`/evaluations/${item.public_id}`} className="hover:underline">
                            {item.public_id}
                          </Link>
                        </td>
                        <td className="p-4 text-slate-200">{item.job_id}</td>
                        <td className="p-4">
                          {isComplete ? (
                            <span className="inline-flex items-center gap-1 text-emerald-400 bg-emerald-950/60 border border-emerald-800/60 px-2.5 py-0.5 rounded-full font-sans font-semibold text-3xs">
                              <CheckCircle2 className="w-3 h-3" /> Completed
                            </span>
                          ) : isRejected ? (
                            <span className="inline-flex items-center gap-1 text-rose-400 bg-rose-950/60 border border-rose-800/60 px-2.5 py-0.5 rounded-full font-sans font-semibold text-3xs">
                              <XCircle className="w-3 h-3" /> Rejected
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-sky-400 bg-sky-950/60 border border-sky-800/60 px-2.5 py-0.5 rounded-full font-sans font-semibold text-3xs">
                              <Clock className="w-3 h-3 animate-spin" /> {item.status}
                            </span>
                          )}
                        </td>
                        <td className="p-4 text-slate-400">{item.policy_id}</td>
                        <td className="p-4 text-slate-400 max-w-[140px] truncate" title={item.report_hash || ""}>
                          {item.report_hash ? `${item.report_hash.slice(0, 10)}...` : "N/A"}
                        </td>
                        <td className="p-4 text-slate-400 font-sans">
                          {item.created_at ? new Date(item.created_at).toLocaleString() : "N/A"}
                        </td>
                        <td className="p-4 text-right font-sans">
                          <Link
                            href={`/evaluations/${item.public_id}`}
                            className="inline-flex items-center gap-1 text-sky-400 hover:text-sky-300 font-semibold"
                          >
                            Receipt <ArrowRight className="w-3 h-3" />
                          </Link>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination Footer */}
          {totalPages > 1 && (
            <div className="p-4 border-t border-slate-800 flex items-center justify-between text-xs text-slate-400 font-mono">
              <div>
                Page {page} of {totalPages} ({totalCount} evaluations)
              </div>
              <div className="flex items-center gap-2">
                {page > 1 && (
                  <Link
                    href={`/evaluations?filter=${currentFilter}&page=${page - 1}${searchQuery ? `&q=${encodeURIComponent(searchQuery)}` : ""}`}
                    className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded"
                  >
                    Previous
                  </Link>
                )}
                {page < totalPages && (
                  <Link
                    href={`/evaluations?filter=${currentFilter}&page=${page + 1}${searchQuery ? `&q=${encodeURIComponent(searchQuery)}` : ""}`}
                    className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded"
                  >
                    Next
                  </Link>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
