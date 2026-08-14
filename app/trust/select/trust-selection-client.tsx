"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { stringToHex, type Hex } from "viem";
import { BadgeCheck, FileKey2, Loader2, Search, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getProvider, useArcWallet } from "@/components/wallet/use-arc-wallet";

type DiscoveryCandidate = {
  agentId: string;
  ownerAddress: string;
  verifiedOnchain: true;
  services: Array<{
    serviceId: string;
    workflowType: string;
    advertisedPriceUsdc: number;
    capabilityMatch: string;
  }>;
};

type CandidateResult = {
  rank: number;
  identity?: { agentId: string; ownerAddress: string } | null;
  eligibility: string;
  trustScore: number;
  rankingScore: number;
  confidence: number;
  evidenceCoverage: number;
  recommendedMaxExposureUsdc: number;
  rejectionReason?: string;
};

type SelectionResult = {
  selectionId: string;
  publicId: string;
  visibility: "public" | "private";
  publicUrl?: string;
  recommendedAgentId: string;
  recommendedWallet: string;
  recommendedMaxExposureUsdc: number;
  decision: string;
  canonicalHash: string;
  winnerExplanation: string;
  candidates: CandidateResult[];
};

async function api(path: string, init?: RequestInit) {
  const response = await fetch(path, {
    ...init,
    headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...(init?.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error?.message || body?.error || body?.reason || `Request failed (${response.status})`);
  }
  return body;
}

function parseExplicitCandidates(value: string) {
  return value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean).map((item) => {
    if (/^agent:\d+$/i.test(item)) return { agentId: item.slice(6) };
    if (/^wallet:0x[0-9a-f]{40}$/i.test(item)) return { wallet: item.slice(7) };
    if (/^service:[a-z0-9_-]+$/i.test(item)) return { serviceId: item.slice(8) };
    if (/^\d+$/.test(item)) return { agentId: item };
    if (/^0x[0-9a-f]{40}$/i.test(item)) return { wallet: item };
    if (/^svc_[a-z0-9]+$/i.test(item)) return { serviceId: item };
    throw new Error(`Unrecognized candidate: ${item}`);
  });
}

export function TrustSelectionClient() {
  const wallet = useArcWallet();
  const [authenticated, setAuthenticated] = useState(false);
  const [capability, setCapability] = useState("github_due_diligence");
  const [budget, setBudget] = useState("0.10");
  const [task, setTask] = useState("");
  const [explicit, setExplicit] = useState("");
  const [visibility, setVisibility] = useState<"private" | "public">("public");
  const [discovered, setDiscovered] = useState<DiscoveryCandidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selection, setSelection] = useState<SelectionResult | null>(null);
  const [clearance, setClearance] = useState<Record<string, unknown> | null>(null);
  const [proof, setProof] = useState<Record<string, unknown> | null>(null);
  const [evidence, setEvidence] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { void api("/api/byoa/management/session").then((body) => setAuthenticated(body.authenticated === true)).catch(() => undefined); }, []);

  async function act(name: string, action: () => Promise<void>) {
    setBusy(name); setError(null);
    try { await action(); } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(null); }
  }

  async function verifyOwner() {
    await act("auth", async () => {
      const provider = getProvider();
      if (!provider) throw new Error("No injected EVM wallet was detected.");
      if (!wallet.address) await wallet.connect();
      const accounts = await provider.request<string[]>({ method: "eth_accounts" });
      const address = accounts[0] || wallet.address;
      if (!address) throw new Error("Connect an owner wallet first.");
      if (!wallet.isArcTestnet) await wallet.switchToArc();
      const created = await api("/api/byoa/management/challenges", { method: "POST", body: JSON.stringify({ wallet: address }) });
      const challenge = created.challenge as { id: string; message: string };
      const signature = await provider.request<Hex>({
        method: "personal_sign",
        params: [stringToHex(challenge.message), address],
      });
      await api("/api/byoa/management/session", { method: "POST", body: JSON.stringify({ challengeId: challenge.id, message: challenge.message, signature }) });
      setAuthenticated(true);
    });
  }

  async function discover() {
    await act("discover", async () => {
      const body = await api("/api/trust/v1/counterparties/discover", { method: "POST", body: JSON.stringify({ capability, network: "eip155:5042002", limit: 10 }) });
      setDiscovered(body.candidates || []);
      setSelected(new Set());
    });
  }

  const chosen = useMemo(() => discovered.filter((item) => selected.has(item.agentId)), [discovered, selected]);

  async function selectCounterparty() {
    await act("select", async () => {
      const candidates = [
        ...parseExplicitCandidates(explicit),
        ...chosen.map((item) => {
          const service = item.services.find((entry) => entry.capabilityMatch === "exact") || item.services[0];
          return service ? { agentId: item.agentId, serviceId: service.serviceId } : { agentId: item.agentId };
        }),
      ];
      if (candidates.length === 0) throw new Error("Choose or enter at least one candidate.");
      const body = await api("/api/trust/v1/counterparties/select", {
        method: "POST",
        headers: { "Idempotency-Key": `ui-selection-${crypto.randomUUID()}` },
        body: JSON.stringify({ capability, task: task || undefined, budgetUsdc: Number(budget), candidates, network: "eip155:5042002", visibility }),
      });
      setSelection(body.selection);
      setClearance(null); setProof(null); setEvidence(null);
    });
  }

  async function issueClearance() {
    if (!selection) return;
    await act("clearance", async () => setClearance(await api(`/api/trust/v1/selections/${selection.selectionId}/clearance`, { method: "POST" })));
  }

  async function publishProof() {
    if (!selection || !window.confirm("Publish this immutable selection hash to Arc Testnet? This is optional and does not execute or pay the winner.")) return;
    await act("proof", async () => setProof(await api(`/api/trust/v1/selections/${selection.selectionId}/proof`, { method: "POST" })));
  }

  async function viewEvidence() {
    if (!selection) return;
    await act("evidence", async () => setEvidence(await api(`/api/trust/v1/selections/${selection.selectionId}/evidence`)));
  }

  return <section className="mx-auto grid max-w-6xl gap-6 px-4 py-8 sm:px-6 lg:grid-cols-[0.9fr_1.1fr]">
    <Card><CardHeader><CardTitle>1. Intent and candidates</CardTitle></CardHeader><CardContent className="space-y-5">
      {!authenticated ? <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4"><p className="text-sm">Verify an owner wallet session to create tenant-isolated receipts. Veyra will request Arc Testnet when needed.</p><Button className="mt-3" onClick={() => void verifyOwner()} disabled={Boolean(busy)}>{busy === "auth" ? <Loader2 className="animate-spin" /> : <ShieldCheck />}Verify owner wallet</Button></div> : <Badge className="bg-emerald-500/10 text-emerald-400"><BadgeCheck className="mr-1 size-3.5" />Owner session verified</Badge>}
      <div className="space-y-2"><Label htmlFor="capability">Required capability</Label><Input id="capability" value={capability} onChange={(e) => setCapability(e.target.value)} /></div>
      <div className="grid gap-4 sm:grid-cols-3"><div className="space-y-2"><Label htmlFor="budget">Maximum budget (USDC)</Label><Input id="budget" type="number" min="0.000001" step="0.000001" value={budget} onChange={(e) => setBudget(e.target.value)} /></div><div className="space-y-2"><Label htmlFor="network">Network</Label><Input id="network" value="Arc Testnet · eip155:5042002" disabled /></div><div className="space-y-2"><Label htmlFor="visibility">Receipt visibility</Label><select id="visibility" className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={visibility} onChange={(e) => setVisibility(e.target.value as "private" | "public")}><option value="public">Public receipt</option><option value="private">Private receipt</option></select></div></div>
      <div className="space-y-2"><Label htmlFor="task">Task summary (optional, hashed only)</Label><textarea id="task" className="min-h-20 w-full rounded-md border bg-background p-3 text-sm" value={task} onChange={(e) => setTask(e.target.value)} placeholder="Review repository security posture" /></div>
      <div className="space-y-2"><Label htmlFor="candidates">Explicit candidates</Label><textarea id="candidates" className="min-h-28 w-full rounded-md border bg-background p-3 font-mono text-sm" value={explicit} onChange={(e) => setExplicit(e.target.value)} placeholder={"agent:867528\nwallet:0x…\nservice:svc_…"} /><p className="text-xs text-muted-foreground">1–10 Agent IDs, wallets, or service IDs. Values must resolve to an exact on-chain ERC-8004 identity.</p></div>
      <Button variant="outline" onClick={() => void discover()} disabled={!authenticated || Boolean(busy)}>{busy === "discover" ? <Loader2 className="animate-spin" /> : <Search />}Discover known candidates</Button>
      {discovered.length > 0 ? <div className="space-y-2"><p className="text-sm font-medium">Discovered candidates — all off by default</p>{discovered.map((item) => <label key={item.agentId} className="flex cursor-pointer items-start gap-3 rounded-lg border p-3"><input type="checkbox" className="mt-1" checked={selected.has(item.agentId)} onChange={(e) => setSelected((current) => { const next = new Set(current); e.target.checked ? next.add(item.agentId) : next.delete(item.agentId); return next; })} /><span className="min-w-0"><span className="block font-mono">Agent {item.agentId}</span><span className="block break-all text-xs text-muted-foreground">{item.ownerAddress}</span><span className="block text-xs text-muted-foreground">{item.services.length} matching/known services · ERC-8004 verified</span></span></label>)}</div> : null}
      <Button onClick={() => void selectCounterparty()} disabled={!authenticated || Boolean(busy)}>{busy === "select" ? <Loader2 className="animate-spin" /> : <FileKey2 />}Create immutable selection</Button>
      {error ? <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-300">{error}</p> : null}
    </CardContent></Card>

    <Card><CardHeader><CardTitle>2. Evidence-backed result</CardTitle></CardHeader><CardContent>
      {!selection ? <div className="py-16 text-center text-muted-foreground"><Search className="mx-auto mb-3 size-8" /><p>No selection created yet.</p><p className="mt-1 text-sm">Discovery and ranking do not initiate payment or execution.</p></div> : <div className="space-y-5">
        <div className="rounded-xl border border-primary/30 bg-primary/5 p-5"><p className="text-xs uppercase tracking-wide text-muted-foreground">Recommended</p><p className="mt-2 text-2xl font-bold">Agent {selection.recommendedAgentId}</p><p className="mt-1 break-all font-mono text-xs text-muted-foreground">{selection.recommendedWallet}</p><p className="mt-4 text-sm">{selection.winnerExplanation}</p><div className="mt-4 flex flex-wrap gap-2"><Badge>{selection.decision}</Badge><Badge variant="outline">Max {selection.recommendedMaxExposureUsdc.toFixed(6)} USDC</Badge></div></div>
        <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-sm"><thead className="border-b text-left text-muted-foreground"><tr><th className="py-2">Rank</th><th>Agent</th><th>Eligibility</th><th>Trust</th><th>Score</th><th>Confidence</th><th>Coverage</th></tr></thead><tbody>{selection.candidates.map((item) => <tr key={`${item.rank}:${item.identity?.agentId || "invalid"}`} className="border-b"><td className="py-3">#{item.rank}</td><td className="font-mono">{item.identity?.agentId || "Unresolved"}</td><td>{item.eligibility}{item.rejectionReason ? <span className="block text-xs text-muted-foreground">{item.rejectionReason}</span> : null}</td><td>{item.trustScore}</td><td>{item.rankingScore}</td><td>{item.confidence}%</td><td>{item.evidenceCoverage}%</td></tr>)}</tbody></table></div>
        <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Canonical selection hash</p><p className="break-all font-mono text-xs">{selection.canonicalHash}</p></div>
        <div className="flex flex-wrap gap-2">
          {selection.visibility === "public" ? <Button asChild variant="outline"><Link href={`/trust/selections/${selection.publicId}`}>View public receipt</Link></Button> : null}
          <Button variant="outline" onClick={() => void viewEvidence()} disabled={Boolean(busy)}>{busy === "evidence" ? <Loader2 className="animate-spin" /> : <Search />}View evidence</Button>
          <Button variant="outline" onClick={() => void issueClearance()} disabled={Boolean(busy)}>{busy === "clearance" ? <Loader2 className="animate-spin" /> : <ShieldCheck />}Issue winner-bound clearance</Button>
          <Button variant="outline" onClick={() => void publishProof()} disabled={Boolean(busy)}>{busy === "proof" ? <Loader2 className="animate-spin" /> : <BadgeCheck />}Publish optional Arc proof</Button>
          <Button asChild className="gap-2">
            <Link href="/trust/mandates">
              <ShieldCheck className="size-4" />
              Execute with Mandate
            </Link>
          </Button>
        </div>
        {evidence ? <details className="rounded-lg border p-3"><summary className="cursor-pointer text-sm font-medium">Sanitized evidence matrix</summary><pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs text-muted-foreground">{JSON.stringify(evidence, null, 2)}</pre></details> : null}
        {clearance ? <p className="text-sm text-emerald-400">Clearance issued and verified by the Arc TrustGate. No execution was started.</p> : null}{proof ? <p className="text-sm text-emerald-400">Selection proof is verified on Arc. No payment or job was created.</p> : null}
      </div>}
    </CardContent></Card>
  </section>;
}
