"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useArcWallet } from "@/components/wallet/use-arc-wallet";
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  Clock,
  ExternalLink,
  Filter,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
  XCircle,
  Zap,
} from "lucide-react";
import type { ExecutionAttempt, ExecutionState } from "@/lib/execution/types";

function getStatusBadge(state: ExecutionState) {
  switch (state) {
    case "COMPLETED":
      return (
        <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 gap-1.5 py-0.5">
          <CheckCircle2 className="size-3" />
          COMPLETED
        </Badge>
      );
    case "COMPLETED_UNPROVEN":
      return (
        <Badge className="bg-cyan-500/15 text-cyan-400 border-cyan-500/30 gap-1.5 py-0.5">
          <CheckCircle2 className="size-3" />
          COMPLETED (UNPROVEN)
        </Badge>
      );
    case "WAITING_FOR_PROVIDER":
      return (
        <Badge className="bg-amber-500/15 text-amber-400 border-amber-500/30 gap-1.5 py-0.5">
          <Clock className="size-3" />
          WAITING FOR PROVIDER
        </Badge>
      );
    case "EXECUTING":
    case "EVALUATING":
    case "SETTLING":
    case "SUBMITTED":
      return (
        <Badge className="bg-blue-500/15 text-blue-400 border-blue-500/30 gap-1.5 py-0.5">
          <Loader2 className="size-3 animate-spin" />
          {state}
        </Badge>
      );
    case "PREPARED":
    case "AUTHORIZED":
      return (
        <Badge className="bg-purple-500/15 text-purple-400 border-purple-500/30 gap-1.5 py-0.5">
          <Clock className="size-3" />
          {state}
        </Badge>
      );
    case "SETTLEMENT_UNVERIFIED":
      return (
        <Badge className="bg-amber-500/15 text-amber-400 border-amber-500/30 gap-1.5 py-0.5">
          <Clock className="size-3" />
          SETTLEMENT UNVERIFIED
        </Badge>
      );
    case "SETTLED_SERVICE_FAILED":
      return (
        <Badge className="bg-orange-500/15 text-orange-400 border-orange-500/30 gap-1.5 py-0.5">
          <XCircle className="size-3" />
          SETTLED (SERVICE FAILED)
        </Badge>
      );
    case "FAILED":
    case "REJECTED":
    case "SETTLEMENT_FAILED":
    case "EVALUATION_REJECTED":
    case "CANCELLED":
    case "EXPIRED":
      return (
        <Badge variant="destructive" className="gap-1.5 py-0.5">
          <XCircle className="size-3" />
          {state}
        </Badge>
      );
    default:
      return <Badge variant="secondary">{state}</Badge>;
  }
}

export default function ExecutionsPage() {
  const { address, connect } = useArcWallet();
  const [executions, setExecutions] = useState<ExecutionAttempt[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterState, setFilterState] = useState<string>("ALL");
  const [onlyMyWallet, setOnlyMyWallet] = useState(false);

  useEffect(() => {
    fetchExecutions();
  }, [address, onlyMyWallet]);

  async function fetchExecutions() {
    setLoading(true);
    try {
      let url = "/api/execution/v1";
      if (onlyMyWallet && address) {
        url += `?counterpartyWallet=${encodeURIComponent(address)}`;
      }
      const res = await fetch(url);
      const data = await res.json();
      if (res.ok) {
        setExecutions(data.executions || []);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }

  const filteredExecutions = executions.filter((item) => {
    if (filterState !== "ALL" && item.state !== filterState) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (
        item.executionId.toLowerCase().includes(q) ||
        item.capability.toLowerCase().includes(q) ||
        item.counterpartyWallet.toLowerCase().includes(q) ||
        (item.mandateId && item.mandateId.toLowerCase().includes(q))
      );
    }
    return true;
  });

  return (
    <div className="container max-w-6xl py-10 space-y-8">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-border/60 pb-6">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-primary/10 text-primary border border-primary/20">
              <Zap className="size-3" />
              Trust-Routed Execution
            </span>
            <span className="text-xs text-muted-foreground">Arc Testnet</span>
          </div>
          <h1 className="text-3xl font-bold tracking-tight">Execution History</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Real-time audit log of all trust-routed actions, authorizations, and onchain settlements.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={fetchExecutions} disabled={loading}>
            <RefreshCw className={`size-4 mr-2 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button asChild size="sm">
            <Link href="/trust/mandates">Manage Mandates</Link>
          </Button>
        </div>
      </div>

      {/* Controls: Search & Filters */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="relative w-full sm:w-80">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            placeholder="Search execution ID, wallet, capability..."
            className="pl-9 h-9 text-sm"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
          {["ALL", "COMPLETED", "WAITING_FOR_PROVIDER", "EXECUTING", "FAILED"].map((st) => (
            <Button
              key={st}
              variant={filterState === st ? "default" : "outline"}
              size="sm"
              className="text-xs h-8"
              onClick={() => setFilterState(st)}
            >
              {st === "ALL" ? "All Statuses" : st.replace(/_/g, " ")}
            </Button>
          ))}
          {address && (
            <Button
              variant={onlyMyWallet ? "secondary" : "ghost"}
              size="sm"
              className="text-xs h-8"
              onClick={() => setOnlyMyWallet(!onlyMyWallet)}
            >
              My Wallet
            </Button>
          )}
        </div>
      </div>

      {/* Execution List / Table */}
      {loading ? (
        <div className="py-20 flex flex-col items-center justify-center gap-3 text-muted-foreground">
          <Loader2 className="size-8 animate-spin text-primary" />
          <p className="text-sm">Loading verified execution history...</p>
        </div>
      ) : filteredExecutions.length === 0 ? (
        <Card className="border border-dashed border-border/80 text-center py-16">
          <CardContent className="space-y-4">
            <div className="size-12 rounded-full bg-muted/60 flex items-center justify-center mx-auto text-muted-foreground">
              <Activity className="size-6" />
            </div>
            <div className="space-y-1">
              <h3 className="text-base font-semibold">No executions found</h3>
              <p className="text-sm text-muted-foreground max-w-md mx-auto">
                {searchQuery || filterState !== "ALL"
                  ? "No executions match the current search or status filter."
                  : "No execution attempts recorded yet. Create an execution mandate or trigger an execution through an AI agent."}
              </p>
            </div>
            <Button asChild variant="outline" size="sm">
              <Link href="/trust/mandates">Configure Mandates</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {filteredExecutions.map((exec) => (
            <Card
              key={exec.executionId}
              className="border border-border/70 hover:border-primary/40 transition-all duration-200 hover:shadow-md bg-card/60"
            >
              <CardContent className="p-4 sm:p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div className="space-y-2 min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {getStatusBadge(exec.state)}
                    <Badge variant="outline" className="font-mono text-xs uppercase">
                      {exec.rail}
                    </Badge>
                    <span className="font-mono text-xs text-muted-foreground truncate max-w-[200px]">
                      {exec.executionId}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs pt-1">
                    <div>
                      <span className="text-muted-foreground block">Capability</span>
                      <span className="font-medium font-mono">{exec.capability}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground block">Counterparty</span>
                      <span className="font-mono truncate block" title={exec.counterpartyWallet}>
                        {exec.counterpartyWallet.slice(0, 6)}...{exec.counterpartyWallet.slice(-4)}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground block">Authorized / Settled</span>
                      <span className="font-medium">
                        ${exec.authorizedAmountUsdc.toFixed(2)}{" "}
                        <span className="text-muted-foreground">
                          / ${typeof exec.actualSettledAmountUsdc === "number" ? exec.actualSettledAmountUsdc.toFixed(2) : "0.00"}
                        </span>
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground block">Updated</span>
                      <span>{new Date(exec.updatedAt || exec.createdAt).toLocaleTimeString()}</span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 self-end md:self-center shrink-0">
                  <Button asChild size="sm" variant="ghost" className="gap-1.5 text-xs">
                    <Link href={`/execution/${exec.executionId}`}>
                      View Receipt
                      <ArrowRight className="size-3.5" />
                    </Link>
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
