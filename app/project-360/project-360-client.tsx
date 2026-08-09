"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  CircleDollarSign,
  FileSearch,
  GitBranch,
  LoaderCircle,
  LockKeyhole,
  MapPin,
  Radar,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useArcWallet } from "@/components/wallet/use-arc-wallet";
import { BRAND } from "@/lib/brand";
import type { WorkflowPaymentDescriptor } from "@/lib/commerce/workflow-payment";
import {
  PROJECT_360_MODULE_LABELS,
  PROJECT_360_MODULES,
  PROJECT_360_SOURCE_TYPES,
  type Project360Module,
  type Project360SourceType,
} from "@/lib/project-360/types";

type Candidate = {
  id: string;
  type: Project360SourceType;
  module: Project360Module;
  value: string;
  provenance: {
    origin: "primary" | "github_file" | "public_record";
    repository: string | null;
    file: string | null;
    lineStart: number | null;
    lineEnd: number | null;
    excerpt: string | null;
  };
  confidence: "high" | "medium" | "low";
  confidenceScore: number;
  validationStatus: "valid" | "unsupported" | "blocked";
  included: false;
};

type Discovery = {
  id: string;
  status: "running" | "ready" | "failed" | "expired";
  revision: number;
  free: true;
  paymentRequired: false;
  candidatesHash: string | null;
  candidates: Candidate[];
  warnings: string[];
  expiresAt: string;
};

type HostedQuote = {
  id: string;
  paymentMode: "sponsored" | "paid";
  treasuryAddress: string;
  payment: WorkflowPaymentDescriptor | null;
  pricing: {
    estimatedProviderCostUsdc: number;
    platformFeeUsdc: number;
    listPriceUsdc: number;
    amountDueUsdc: number;
  };
  expiresAt: string;
};

type ProjectQuote = {
  discoveryId: string;
  selectionHash: string;
  selectedModules: Project360Module[];
  lineItems: Array<{
    module: Project360Module | "project_360_finalization";
    label: string;
    serviceSlugs: string[];
    priceUsdc: number;
    sharedEvidence: boolean;
  }>;
  expectedCoverage: { selected: number; total: 5 };
  warnings: string[];
};

const SOURCE_LABELS: Record<Project360SourceType, string> = {
  github_repository: "GitHub repository",
  project_wallet: "Project wallet",
  agent_id: "Agent ID",
  arc_contract: "Arc contract",
  public_api_endpoint: "Public API endpoint",
};

const SOURCE_PLACEHOLDERS: Record<Project360SourceType, string> = {
  github_repository: "https://github.com/owner/repository",
  project_wallet: "0x…",
  agent_id: "agt_…",
  arc_contract: "0x…",
  public_api_endpoint: "https://api.example.com/v1",
};

async function api(url: string, init?: RequestInit) {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body?.error?.message ?? body?.error ?? "Project 360 request failed.";
    throw new Error(String(message));
  }
  return body as Record<string, any>;
}

export function Project360Client({
  initialSource = { type: "github_repository", value: "" },
}: {
  initialSource?: { type: Project360SourceType; value: string };
}) {
  const wallet = useArcWallet();
  const [ownerWallet, setOwnerWallet] = useState<string | null>(null);
  const [sourceType, setSourceType] = useState<Project360SourceType>(initialSource.type);
  const [sourceValue, setSourceValue] = useState(initialSource.value);
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [quote, setQuote] = useState<HostedQuote | null>(null);
  const [projectQuote, setProjectQuote] = useState<ProjectQuote | null>(null);
  const [sponsoredMessage, setSponsoredMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const discoveryKey = useRef<string | null>(null);
  const quoteKey = useRef<string | null>(null);

  const loadSession = useCallback(async () => {
    const session = await api("/api/byoa/management/session");
    const authenticated = session.authenticated === true;
    setOwnerWallet(authenticated ? String(session.ownerWallet) : null);
    return authenticated;
  }, []);

  useEffect(() => {
    void loadSession().catch(() => undefined);
  }, [loadSession]);

  const selectedCandidates = useMemo(
    () => discovery?.candidates.filter((candidate) => selectedIds.includes(candidate.id)) ?? [],
    [discovery, selectedIds],
  );
  const selectedModules = useMemo(
    () => PROJECT_360_MODULES.filter((module) =>
      selectedCandidates.some((candidate) => candidate.module === module),
    ),
    [selectedCandidates],
  );

  async function act(name: string, operation: () => Promise<void>) {
    setBusy(name);
    setError(null);
    try {
      await operation();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  async function verifyOwner() {
    await act("auth", async () => {
      if (!wallet.address) {
        await wallet.connect();
        throw new Error("Wallet connected. Click Verify owner wallet once more.");
      }
      if (!wallet.isArcTestnet) await wallet.switchToArc();
      const created = await api("/api/byoa/management/challenges", {
        method: "POST",
        body: JSON.stringify({ wallet: wallet.address }),
      });
      const challenge = created.challenge as { id: string; message: string };
      const signature = await wallet.signMessage(challenge.message);
      const session = await api("/api/byoa/management/session", {
        method: "POST",
        body: JSON.stringify({
          challengeId: challenge.id,
          message: challenge.message,
          signature,
        }),
      });
      setOwnerWallet(String(session.ownerWallet));
    });
  }

  function resetAfterInput() {
    setDiscovery(null);
    setSelectedIds([]);
    setQuote(null);
    setProjectQuote(null);
    setSponsoredMessage(null);
    discoveryKey.current = null;
    quoteKey.current = null;
  }

  async function runDiscovery() {
    await act("discovery", async () => {
      if (!ownerWallet) throw new Error("Verify the owner wallet first.");
      if (!sourceValue.trim()) throw new Error("Provide one project identifier.");
      discoveryKey.current ??= `project360-discovery-${crypto.randomUUID()}`;
      const result = await api("/api/project-360/discoveries", {
        method: "POST",
        headers: { "Idempotency-Key": discoveryKey.current },
        body: JSON.stringify({ type: sourceType, value: sourceValue.trim() }),
      });
      const next = result.discovery as Discovery;
      setDiscovery(next);
      setSelectedIds([]);
      setQuote(null);
      setProjectQuote(null);
      quoteKey.current = null;
    });
  }

  function toggleCandidate(candidate: Candidate) {
    if (candidate.validationStatus !== "valid") return;
    setSelectedIds((current) => {
      if (current.includes(candidate.id)) {
        return current.filter((id) => id !== candidate.id);
      }
      const sameModuleIds = new Set(
        discovery?.candidates
          .filter((item) => item.module === candidate.module)
          .map((item) => item.id) ?? [],
      );
      return [...current.filter((id) => !sameModuleIds.has(id)), candidate.id];
    });
    setQuote(null);
    setProjectQuote(null);
    setSponsoredMessage(null);
    quoteKey.current = null;
  }

  async function createQuote() {
    await act("quote", async () => {
      if (!discovery || discovery.status !== "ready") {
        throw new Error("Run free discovery first.");
      }
      if (selectedIds.length === 0) {
        throw new Error("Explicitly include at least one source.");
      }
      quoteKey.current ??= `project360-quote-${crypto.randomUUID()}`;
      const result = await api(
        `/api/project-360/discoveries/${discovery.id}/quote`,
        {
          method: "POST",
          headers: { "Idempotency-Key": quoteKey.current },
          body: JSON.stringify({
            revision: discovery.revision,
            selectedCandidateIds: selectedIds,
            modules: selectedModules,
          }),
        },
      );
      setQuote(result.quote as HostedQuote);
      setProjectQuote(result.project360 as ProjectQuote);
      setSponsoredMessage(
        typeof result.sponsoredAuthorizationMessage === "string"
          ? result.sponsoredAuthorizationMessage
          : null,
      );
    });
  }

  async function confirmAndRun() {
    await act("confirm", async () => {
      if (!quote || !projectQuote || !quoteKey.current) {
        throw new Error("Create the immutable quote first.");
      }
      if (!wallet.address || !ownerWallet || wallet.address.toLowerCase() !== ownerWallet.toLowerCase()) {
        throw new Error("Connect the verified owner wallet before confirmation.");
      }
      let signature: string | null = null;
      let transactionHash: string | null = null;
      if (quote.paymentMode === "sponsored") {
        if (!sponsoredMessage) throw new Error("Sponsored authorization message is unavailable.");
        signature = await wallet.signMessage(sponsoredMessage);
      } else {
        if (!wallet.isArcTestnet) await wallet.switchToArc();
        transactionHash = await wallet.sendWorkflowPayment({
          treasuryAddress: quote.treasuryAddress,
          amountUsdc: quote.pricing.amountDueUsdc,
          payment: quote.payment,
        });
      }
      const launched = await api(`/api/project-360/quotes/${quote.id}/confirm`, {
        method: "POST",
        headers: { "Idempotency-Key": quoteKey.current },
        body: JSON.stringify({ signature, transactionHash }),
      });
      window.location.assign(String(launched.reportUrl));
    });
  }

  if (!ownerWallet) {
    return (
      <main className="min-h-screen bg-background">
        <section className="mx-auto grid min-h-[70vh] w-full max-w-3xl place-items-center px-4 py-12">
          <Card className="w-full rounded-2xl border-white/10 bg-[#090c13]">
            <CardContent className="grid gap-5 p-8 text-center">
              <ShieldCheck className="mx-auto size-10 text-cyan-400" />
              <div>
                <h1 className="text-3xl font-bold">{BRAND.name} Project 360</h1>
                <p className="mt-2 text-sm text-muted-foreground">
                  Verify the owner wallet once. Discovery remains free and cannot initiate a payment.
                </p>
              </div>
              <Button onClick={() => void verifyOwner()} disabled={busy === "auth"} className="mx-auto">
                {busy === "auth" ? <LoaderCircle className="size-4 animate-spin" /> : <Wallet className="size-4" />}
                Verify owner wallet
              </Button>
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
            </CardContent>
          </Card>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <section className="border-b border-white/5 bg-gradient-to-b from-[#0a0d15] to-[#07090e]">
        <div className="mx-auto w-full max-w-7xl px-4 py-12 sm:px-6">
          <Badge className="mb-4 border-cyan-500/30 bg-cyan-500/10 text-cyan-300">P4.2 · Orchestrated Due Diligence</Badge>
          <h1 className="max-w-4xl text-3xl font-extrabold tracking-tight sm:text-5xl">
            Discover first. Confirm evidence. Pay once.
          </h1>
          <p className="mt-4 max-w-3xl text-sm leading-6 text-muted-foreground sm:text-base">
            Project 360 combines only the modules you explicitly choose. Missing evidence stays unknown, every charge is quoted, and the final report receives one aggregate Arc proof.
          </p>
          <div className="mt-5 flex flex-wrap gap-2 text-xs">
            <Badge variant="outline"><Radar className="mr-1 size-3" /> Free Discovery</Badge>
            <Badge variant="outline"><LockKeyhole className="mr-1 size-3" /> Candidates off by default</Badge>
            <Badge variant="outline"><CircleDollarSign className="mr-1 size-3" /> Immutable line-item quote</Badge>
          </div>
        </div>
      </section>

      <section className="mx-auto grid w-full min-w-0 max-w-7xl grid-cols-[minmax(0,1fr)] gap-6 px-4 py-8 sm:px-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
        <div className="grid min-w-0 content-start gap-6">
          <Card className="min-w-0 rounded-2xl border-white/10 bg-[#090c13]">
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><FileSearch className="size-5 text-cyan-400" /> 1. Free Discovery</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="grid gap-3 sm:grid-cols-[0.42fr_1fr]">
                <select
                  value={sourceType}
                  onChange={(event) => { setSourceType(event.target.value as Project360SourceType); resetAfterInput(); }}
                  className="h-11 rounded-xl border border-white/10 bg-[#06080d] px-3 text-sm"
                >
                  {PROJECT_360_SOURCE_TYPES.map((type) => <option key={type} value={type}>{SOURCE_LABELS[type]}</option>)}
                </select>
                <input
                  value={sourceValue}
                  onChange={(event) => { setSourceValue(event.target.value); resetAfterInput(); }}
                  placeholder={SOURCE_PLACEHOLDERS[sourceType]}
                  className="h-11 rounded-xl border border-white/10 bg-[#06080d] px-3 font-mono text-xs"
                />
              </div>
              <Button onClick={() => void runDiscovery()} disabled={busy === "discovery" || !sourceValue.trim()}>
                {busy === "discovery" ? <LoaderCircle className="size-4 animate-spin" /> : <Radar className="size-4" />}
                Run free discovery
              </Button>
              <p className="text-xs text-muted-foreground">
                No checkout, hosted-payer call, endpoint credential, or paid module is available to this stage.
              </p>
            </CardContent>
          </Card>

          <Card className="min-w-0 rounded-2xl border-white/10 bg-[#090c13]">
            <CardHeader>
              <CardTitle className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2"><GitBranch className="size-5 text-cyan-400" /> 2. Confirm sources</span>
                <Badge variant="outline">{selectedIds.length} included</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
              {!discovery ? (
                <p className="rounded-xl border border-dashed border-white/10 p-6 text-center text-sm text-muted-foreground">Candidates appear here after free Discovery.</p>
              ) : discovery.candidates.map((candidate) => {
                const checked = selectedIds.includes(candidate.id);
                return (
                  <label key={candidate.id} className={`grid min-w-0 grid-cols-[minmax(0,1fr)] cursor-pointer gap-3 rounded-xl border p-4 transition-colors ${checked ? "border-cyan-500/40 bg-cyan-500/5" : "border-white/10 bg-white/[0.02]"}`}>
                    <div className="flex min-w-0 items-start gap-3">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleCandidate(candidate)}
                        disabled={candidate.validationStatus !== "valid"}
                        className="mt-1 size-4 accent-cyan-500"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="secondary">{SOURCE_LABELS[candidate.type]}</Badge>
                          <Badge variant="outline">{candidate.confidence} · {Math.round(candidate.confidenceScore * 100)}%</Badge>
                          {candidate.provenance.origin === "primary" ? <Badge>Entered by you</Badge> : null}
                        </div>
                        <p className="mt-2 break-all font-mono text-xs">{candidate.value}</p>
                        <p className="mt-2 text-xs text-muted-foreground">Module: {PROJECT_360_MODULE_LABELS[candidate.module]}</p>
                        {candidate.provenance.file ? (
                          <p className="mt-1 flex min-w-0 items-start gap-1 break-all text-xs text-muted-foreground">
                            <MapPin className="mt-0.5 size-3 shrink-0" /> {candidate.provenance.file}:{candidate.provenance.lineStart}
                          </p>
                        ) : null}
                        {candidate.provenance.excerpt ? <p className="mt-2 line-clamp-2 break-all rounded bg-black/20 p-2 font-mono text-[11px] text-muted-foreground">{candidate.provenance.excerpt}</p> : null}
                      </div>
                    </div>
                  </label>
                );
              })}
              {discovery ? (
                <Button onClick={() => void createQuote()} disabled={busy === "quote" || selectedIds.length === 0} className="mt-2">
                  {busy === "quote" ? <LoaderCircle className="size-4 animate-spin" /> : <CircleDollarSign className="size-4" />}
                  Build transparent quote
                </Button>
              ) : null}
            </CardContent>
          </Card>
        </div>

        <div className="grid min-w-0 content-start gap-6 lg:sticky lg:top-20">
          <Card className="min-w-0 rounded-2xl border-white/10 bg-[#090c13]">
            <CardHeader><CardTitle>3. Project 360 Quote</CardTitle></CardHeader>
            <CardContent className="grid gap-5">
              {!quote || !projectQuote ? (
                <p className="rounded-xl border border-dashed border-white/10 p-7 text-center text-sm text-muted-foreground">Nothing is payable until you include sources and create this immutable quote.</p>
              ) : (
                <>
                  <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-semibold">Expected coverage</span>
                      <span className="text-lg font-bold">{projectQuote.expectedCoverage.selected} / 5 modules</span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{projectQuote.expectedCoverage.selected === 5 ? "Complete coverage expected" : "Partial Project 360 Report"}</p>
                  </div>
                  <div className="grid gap-2">
                    {projectQuote.lineItems.map((item) => (
                      <div key={item.module} className="rounded-xl border border-white/10 p-3 text-xs">
                        <div className="flex items-start justify-between gap-3">
                          <span className="min-w-0 break-words font-semibold">{item.label}</span>
                          <span className="shrink-0 font-mono">{item.priceUsdc.toFixed(4)} USDC</span>
                        </div>
                        <p className="mt-1 break-all text-muted-foreground">{item.serviceSlugs.join(" + ")}</p>
                        {item.sharedEvidence ? <p className="mt-1 text-emerald-400">Shared GitHub evidence is not charged twice.</p> : null}
                      </div>
                    ))}
                  </div>
                  <div className="grid gap-2 border-t border-white/10 pt-4 text-sm">
                    <div className="flex justify-between"><span className="text-muted-foreground">Provider subtotal</span><span>{quote.pricing.estimatedProviderCostUsdc.toFixed(4)} USDC</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Platform fee</span><span>{quote.pricing.platformFeeUsdc.toFixed(4)} USDC</span></div>
                    <div className="flex justify-between text-lg font-bold"><span>Total quote price</span><span>{quote.pricing.listPriceUsdc.toFixed(4)} USDC</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Amount due now</span><span>{quote.pricing.amountDueUsdc.toFixed(4)} USDC</span></div>
                    {quote.paymentMode === "sponsored" ? <Badge className="w-fit bg-emerald-500/15 text-emerald-300">Sponsored quota · amount due 0</Badge> : null}
                  </div>
                  {projectQuote.warnings.length ? (
                    <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-200">
                      <p className="font-semibold">Incomplete-data warnings</p>
                      <ul className="mt-2 grid gap-1 text-muted-foreground">
                        {projectQuote.warnings.map((warning) => <li key={warning}>• {warning.replaceAll("_", " ")}</li>)}
                      </ul>
                    </div>
                  ) : null}
                  <Button onClick={() => void confirmAndRun()} disabled={busy === "confirm"} className="h-12 bg-gradient-to-r from-emerald-500 to-teal-600 font-bold text-white">
                    {busy === "confirm" ? <LoaderCircle className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
                    {quote.paymentMode === "sponsored" ? "Confirm once and run" : `Pay ${quote.pricing.amountDueUsdc.toFixed(4)} USDC and run`}
                    <ArrowRight className="size-4" />
                  </Button>
                </>
              )}
              {error ? <p className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</p> : null}
            </CardContent>
          </Card>
        </div>
      </section>
    </main>
  );
}
