"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  CalendarClock,
  ExternalLink,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  Wallet,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useArcWallet } from "@/components/wallet/use-arc-wallet";
import type { WorkflowPaymentDescriptor } from "@/lib/commerce/workflow-payment";
import { PROJECT_360_MODULE_LABELS, type Project360Module } from "@/lib/project-360/types";

type HostedQuote = {
  id: string;
  paymentMode: "sponsored" | "paid";
  pricing: { amountDueUsdc: number; listPriceUsdc: number };
  treasuryAddress: string;
  payment: WorkflowPaymentDescriptor | null;
};

type Project360Suggestion = {
  id: string;
  module: Project360Module;
  moduleLabel: string;
  type: string;
  value: string;
  confidence: string;
  confidenceScore: number;
  status: string;
  reviewUrl: string;
};

type Project360Monitor = {
  id: string;
  profileId: string;
  label: string;
  modules: Project360Module[];
  sources: Array<{ type: string; module: Project360Module; value: string }>;
  cadence: "manual" | "daily" | "weekly";
  status: "active" | "paused";
  visibility: "private" | "public";
  nextRecheckAt: string | null;
  lastRecheckAt: string | null;
  currentScore: number | null;
  confidence: number | null;
  coverage: string | null;
  verificationStatus: string | null;
  publicHistoryUrl: string;
  suggestions: Project360Suggestion[];
  history: Array<{
    snapshotId: string;
    jobId: string;
    score: number | null;
    coverage: string;
    confidence: number;
    observedAt: string;
    verificationStatus: string;
  }>;
};

async function api(path: string, init: RequestInit = {}) {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown> & {
    error?: string | { message?: string };
  };
  if (!response.ok) {
    throw new Error(typeof body.error === "string" ? body.error : body.error?.message ?? `Request failed (${response.status})`);
  }
  return body;
}

function date(value: string | null) {
  if (!value) return "Not scheduled";
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function Project360MonitoringClient({ initialJobId = "" }: { initialJobId?: string }) {
  const wallet = useArcWallet();
  const [ownerWallet, setOwnerWallet] = useState<string | null>(null);
  const [baselineJobId, setBaselineJobId] = useState(initialJobId);
  const [label, setLabel] = useState("");
  const [cadence, setCadence] = useState<Project360Monitor["cadence"]>("weekly");
  const [visibility, setVisibility] = useState<Project360Monitor["visibility"]>("private");
  const [monitors, setMonitors] = useState<Project360Monitor[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const keys = useRef(new Map<string, string>());

  const loadSession = useCallback(async () => {
    const session = await api("/api/byoa/management/session");
    const authenticated = session.authenticated === true;
    setOwnerWallet(authenticated && typeof session.ownerWallet === "string" ? session.ownerWallet : null);
    return authenticated;
  }, []);
  const loadMonitors = useCallback(async () => {
    const body = await api("/api/project-360/monitoring");
    setMonitors((body.monitors ?? []) as Project360Monitor[]);
  }, []);

  useEffect(() => {
    void loadSession().then((authenticated) => authenticated ? loadMonitors() : undefined).catch(() => undefined);
  }, [loadMonitors, loadSession]);

  async function act(key: string, action: () => Promise<void>) {
    setBusy(key);
    setError(null);
    setNotice(null);
    try { await action(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(null); }
  }

  async function verifyOwner() {
    await act("auth360", async () => {
      if (!wallet.address) throw new Error("Connect your owner wallet first.");
      if (!wallet.isArcTestnet) await wallet.switchToArc();
      const created = await api("/api/byoa/management/challenges", { method: "POST", body: JSON.stringify({ wallet: wallet.address }) });
      const challenge = created.challenge as { id: string; message: string };
      const signature = await wallet.signMessage(challenge.message);
      const session = await api("/api/byoa/management/session", {
        method: "POST",
        body: JSON.stringify({ challengeId: challenge.id, message: challenge.message, signature }),
      });
      setOwnerWallet(String(session.ownerWallet));
      await loadMonitors();
    });
  }

  async function saveMonitor() {
    await act("save360", async () => {
      if (!/^[0-9a-f-]{36}$/i.test(baselineJobId.trim())) throw new Error("Open a completed Project 360 report and use its Monitor action.");
      const result = await api("/api/project-360/monitoring", {
        method: "POST",
        body: JSON.stringify({ baselineJobId: baselineJobId.trim(), label, cadence, visibility }),
      });
      setNotice(result.created ? "Project 360 monitoring saved with an immutable baseline." : "This Project 360 configuration is already monitored.");
      await loadMonitors();
    });
  }

  async function updateMonitor(monitor: Project360Monitor, patch: Partial<Pick<Project360Monitor, "cadence" | "status" | "visibility">>) {
    await act(`update:${monitor.id}`, async () => {
      await api(`/api/project-360/monitoring/${monitor.id}`, { method: "PATCH", body: JSON.stringify(patch) });
      await loadMonitors();
    });
  }

  async function deleteMonitor(monitor: Project360Monitor) {
    if (!window.confirm(`Delete Project 360 monitoring for "${monitor.label}"?`)) return;
    await act(`delete:${monitor.id}`, async () => {
      await api(`/api/project-360/monitoring/${monitor.id}`, { method: "DELETE" });
      await loadMonitors();
    });
  }

  async function dismissSuggestion(suggestion: Project360Suggestion) {
    await act(`suggestion:${suggestion.id}`, async () => {
      await api(`/api/project-360/monitoring/suggestions/${suggestion.id}`, { method: "PATCH", body: "{}" });
      await loadMonitors();
    });
  }

  async function runRecheck(monitor: Project360Monitor) {
    await act(`run:${monitor.id}`, async () => {
      if (!wallet.address || !ownerWallet || wallet.address.toLowerCase() !== ownerWallet.toLowerCase()) {
        throw new Error("Connect the same verified owner wallet first.");
      }
      const key = keys.current.get(monitor.id) ?? `p43-monitor-${crypto.randomUUID()}`;
      keys.current.set(monitor.id, key);
      const quoted = await api(`/api/project-360/monitoring/${monitor.id}/rechecks`, {
        method: "POST",
        headers: { "Idempotency-Key": key },
        body: "{}",
      });
      const quote = quoted.quote as HostedQuote;
      const projectQuote = quoted.project360 as {
        lineItems?: Array<{ label: string; priceUsdc: number }>;
        expectedCoverage?: { selected: number; total: number };
        warnings?: string[];
      };
      const lineItems = projectQuote.lineItems ?? [];
      const approved = window.confirm([
        "Confirm immutable Project 360 monitoring quote",
        "",
        ...lineItems.map((item) => `${item.label}: ${item.priceUsdc.toFixed(6)} USDC`),
        `Total: ${quote.pricing.listPriceUsdc.toFixed(6)} USDC`,
        `Amount due now: ${quote.pricing.amountDueUsdc.toFixed(6)} USDC`,
        `Expected coverage: ${projectQuote.expectedCoverage?.selected ?? monitor.modules.length} of ${projectQuote.expectedCoverage?.total ?? 5} modules`,
        "",
        "Only the fixed sources and modules shown above will execute.",
      ].join("\n"));
      if (!approved) return;
      let signature: string | null = null;
      let transactionHash: string | null = null;
      if (quote.paymentMode === "sponsored") {
        if (typeof quoted.sponsoredAuthorizationMessage !== "string") throw new Error("Sponsored authorization message is unavailable.");
        signature = await wallet.signMessage(quoted.sponsoredAuthorizationMessage);
      } else {
        if (!wallet.isArcTestnet) await wallet.switchToArc();
        transactionHash = await wallet.sendWorkflowPayment({
          treasuryAddress: quote.treasuryAddress,
          amountUsdc: quote.pricing.amountDueUsdc,
          payment: quote.payment,
        });
      }
      const recheck = quoted.recheck as { id: string };
      const launched = await api(`/api/project-360/monitoring/rechecks/${recheck.id}/confirm`, {
        method: "POST",
        body: JSON.stringify({ signature, transactionHash }),
      });
      keys.current.delete(monitor.id);
      setNotice("Project 360 recheck started with the fixed module/source configuration.");
      const jobId = String(launched.jobId);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 2500));
        const view = await api(`/api/hosted-agent/jobs/${jobId}`);
        const status = (view.job as { status?: string } | undefined)?.status;
        if (status === "failed") throw new Error("The Project 360 recheck failed safely.");
        if (status === "completed") {
          await loadMonitors();
          window.location.assign(`/trust/${monitor.profileId}`);
          return;
        }
      }
      throw new Error("The recheck is still running. Open the Project 360 Trust Profile shortly.");
    });
  }

  return (
    <section id="project-360-monitoring" className="mx-auto w-full max-w-7xl scroll-mt-20 px-4 py-10 sm:px-6">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <Badge className="border-violet-500/30 bg-violet-500/10 text-violet-300">Project 360 monitoring</Badge>
          <h2 className="mt-3 text-2xl font-bold sm:text-3xl">One project, one changing trust history.</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
            Recheck the exact confirmed source hashes and paid module set. Newly discovered modules appear only as suggestions and are never purchased automatically.
          </p>
        </div>
        {ownerWallet ? <Button variant="outline" size="sm" onClick={() => void loadMonitors()} disabled={busy !== null}><RefreshCw className="size-4" /> Refresh</Button> : null}
      </div>

      {!ownerWallet ? (
        <Card className="rounded-2xl border-white/10 bg-[#090c13]">
          <CardContent className="flex flex-wrap items-center justify-between gap-4 p-6">
            <div><p className="font-semibold">Verify the Project 360 owner</p><p className="mt-1 text-sm text-muted-foreground">The wallet challenge creates a private management session and does not authorize payment.</p></div>
            {!wallet.address ? (
              <Button onClick={wallet.connect} disabled={wallet.connecting}><Wallet className="size-4" /> Connect wallet</Button>
            ) : (
              <Button onClick={() => void verifyOwner()} disabled={busy === "auth360"}>{busy === "auth360" ? <LoaderCircle className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />} Verify owner</Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-6">
          <Card className="rounded-2xl border-white/10 bg-[#090c13]">
            <CardHeader><CardTitle className="flex items-center gap-2"><Plus className="size-5" /> Save completed Project 360</CardTitle></CardHeader>
            <CardContent className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_180px_180px_auto] lg:items-end">
              <div className="grid gap-2"><Label htmlFor="p360-job">Completed job ID</Label><Input id="p360-job" value={baselineJobId} onChange={(event) => setBaselineJobId(event.target.value)} placeholder="Project 360 job UUID" /></div>
              <div className="grid gap-2"><Label htmlFor="p360-cadence">Cadence</Label><select id="p360-cadence" value={cadence} onChange={(event) => setCadence(event.target.value as Project360Monitor["cadence"])} className="h-10 rounded-md border border-input bg-background px-3 text-sm"><option value="manual">Manual</option><option value="daily">Daily</option><option value="weekly">Weekly</option></select></div>
              <div className="grid gap-2"><Label htmlFor="p360-visibility">Trust Profile</Label><select id="p360-visibility" value={visibility} onChange={(event) => setVisibility(event.target.value as Project360Monitor["visibility"])} className="h-10 rounded-md border border-input bg-background px-3 text-sm"><option value="private">Private</option><option value="public">Public</option></select></div>
              <Button onClick={() => void saveMonitor()} disabled={busy === "save360"}>{busy === "save360" ? <LoaderCircle className="size-4 animate-spin" /> : <Activity className="size-4" />} Start monitoring</Button>
              <div className="grid gap-2 lg:col-span-4"><Label htmlFor="p360-label">Label (optional)</Label><Input id="p360-label" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Project name" /></div>
            </CardContent>
          </Card>

          {monitors.map((monitor) => (
            <Card key={monitor.id} className="min-w-0 rounded-2xl border-white/10 bg-[#090c13]">
              <CardContent className="grid min-w-0 gap-5 p-5 sm:p-6">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="truncate text-lg font-bold">{monitor.label}</h3><Badge variant="outline">{monitor.coverage ?? "baseline"}</Badge><Badge variant="outline">{monitor.currentScore ?? "N/A"}/100</Badge>{monitor.verificationStatus === "verified" ? <Badge className="border-emerald-500/30 bg-emerald-500/10 text-emerald-300">Arc verified</Badge> : null}</div><p className="mt-2 text-xs text-muted-foreground">Next: {date(monitor.nextRecheckAt)} · confidence {monitor.confidence ?? "N/A"}%</p></div>
                  <div className="flex flex-wrap gap-2"><Button size="sm" onClick={() => void runRecheck(monitor)} disabled={busy !== null}>{busy === `run:${monitor.id}` ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Run fresh check</Button><Button asChild size="sm" variant="outline"><Link href={monitor.publicHistoryUrl}>Trust Profile <ExternalLink className="size-4" /></Link></Button></div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">{monitor.modules.map((module) => <div key={module} className="min-w-0 rounded-xl border border-white/10 p-3"><p className="truncate text-xs font-semibold">{PROJECT_360_MODULE_LABELS[module]}</p><p className="mt-1 text-[11px] text-muted-foreground">Fixed selection</p></div>)}</div>
                <div className="flex flex-wrap items-center gap-2"><CalendarClock className="size-4 text-muted-foreground" /><select value={monitor.cadence} onChange={(event) => void updateMonitor(monitor, { cadence: event.target.value as Project360Monitor["cadence"] })} className="h-9 rounded-md border border-input bg-background px-2 text-xs"><option value="manual">Manual</option><option value="daily">Daily</option><option value="weekly">Weekly</option></select><Button size="sm" variant="outline" onClick={() => void updateMonitor(monitor, { status: monitor.status === "active" ? "paused" : "active" })}>{monitor.status === "active" ? <Pause className="size-4" /> : <Play className="size-4" />}{monitor.status === "active" ? "Pause" : "Resume"}</Button><Button size="sm" variant="outline" onClick={() => void updateMonitor(monitor, { visibility: monitor.visibility === "public" ? "private" : "public" })}>{monitor.visibility === "public" ? "Make private" : "Publish profile"}</Button><Button size="sm" variant="ghost" className="text-destructive" onClick={() => void deleteMonitor(monitor)}><Trash2 className="size-4" /> Delete</Button></div>
                {monitor.suggestions.length ? <div className="rounded-xl border border-violet-500/20 bg-violet-500/5 p-4"><div className="flex items-center gap-2"><Sparkles className="size-4 text-violet-300" /><p className="text-sm font-semibold">New modules are available</p></div><p className="mt-1 text-xs text-muted-foreground">Suggestions are free discovery results. They are off by default and cannot change this monitor.</p><div className="mt-3 grid gap-2">{monitor.suggestions.map((suggestion) => <div key={suggestion.id} className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 p-3"><div className="min-w-0"><p className="text-xs font-semibold">{suggestion.moduleLabel} · {suggestion.confidence} confidence</p><p className="mt-1 truncate text-xs text-muted-foreground">{suggestion.value}</p></div><div className="flex gap-2"><Button asChild size="sm" variant="outline"><Link href={suggestion.reviewUrl}>Review & add</Link></Button><Button size="sm" variant="ghost" onClick={() => void dismissSuggestion(suggestion)} disabled={busy === `suggestion:${suggestion.id}`}>Dismiss</Button></div></div>)}</div></div> : null}
              </CardContent>
            </Card>
          ))}
          {!monitors.length ? <Card className="rounded-2xl border-dashed border-white/10 bg-transparent"><CardContent className="p-8 text-center text-sm text-muted-foreground">No Project 360 monitor yet. Save a completed, Aggregate Arc-verified report above.</CardContent></Card> : null}
        </div>
      )}
      {notice ? <p className="mt-4 text-sm text-emerald-400">{notice}</p> : null}
      {error ? <p className="mt-4 text-sm text-destructive">{error}</p> : null}
    </section>
  );
}
