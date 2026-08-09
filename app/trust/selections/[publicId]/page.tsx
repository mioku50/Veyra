import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BadgeCheck, ExternalLink, Fingerprint, Scale, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchPublicCounterpartySelection } from "@/lib/counterparty-selection/db";
import { sanitizePublicSelection } from "@/lib/counterparty-selection/service";
import { BRAND } from "@/lib/brand";
import { ShareSelectionButton } from "./share-selection-button";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ publicId: string }> };

async function receipt(publicId: string) {
  if (!/^vcr_[0-9a-f]{16}$/.test(publicId)) notFound();
  const selection = await fetchPublicCounterpartySelection(publicId);
  if (!selection) notFound();
  return sanitizePublicSelection(selection);
}

export async function generateMetadata({ params }: Context): Promise<Metadata> {
  const data = await receipt((await params).publicId);
  const description = `${data.capability} · Agent ${data.recommendedAgentId} · Trust ${data.trustScore} · ${data.decision}`;
  return {
    title: `${BRAND.name} Counterparty Selection`,
    description,
    alternates: { canonical: `/trust/selections/${data.publicId}` },
    openGraph: { title: `${BRAND.name} Counterparty Selection`, description },
  };
}

function short(value: string) {
  return value.length > 20 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
}

export default async function SelectionReceiptPage({ params }: Context) {
  const data = await receipt((await params).publicId);
  const winner = data.candidates.find((candidate) => candidate.agentId === data.recommendedAgentId);
  return (
    <main className="min-h-screen bg-background">
      <section className="border-b bg-secondary/20">
        <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
          <div className="flex flex-wrap gap-2">
            <Badge>Veyra Selection Receipt</Badge>
            <Badge variant="outline">Arc Testnet</Badge>
            <Badge variant="outline">{data.rankingVersion}</Badge>
            {data.proof?.proofStatus === "verified" ? <Badge className="bg-emerald-500/10 text-emerald-400"><BadgeCheck className="mr-1 size-3.5" />Arc verified</Badge> : null}
          </div>
          <h1 className="mt-5 max-w-4xl text-3xl font-bold sm:text-5xl">Deterministic counterparty recommendation</h1>
          <p className="mt-4 max-w-3xl text-muted-foreground">An immutable, evidence-backed decision receipt. It records selection only; it is not a payment, execution, endorsement, or guarantee.</p>
          <div className="mt-6 flex flex-wrap gap-2"><Button asChild><Link href="/trust/select"><Scale />Run another selection</Link></Button><ShareSelectionButton /></div>
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl gap-5 px-4 py-8 sm:px-6 lg:grid-cols-3">
        <Card className="lg:col-span-2"><CardHeader><CardTitle>Recommended counterparty</CardTitle></CardHeader><CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div><p className="text-xs text-muted-foreground">Agent ID</p><p className="mt-1 font-mono text-xl">{data.recommendedAgentId}</p></div>
            <div><p className="text-xs text-muted-foreground">Trust score</p><p className="mt-1 font-mono text-xl">{data.trustScore}/100</p></div>
            <div><p className="text-xs text-muted-foreground">Ranking score</p><p className="mt-1 font-mono text-xl">{data.rankingScore}/100</p></div>
          </div>
          <p>{data.winnerExplanation}</p>
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div><dt className="text-muted-foreground">Owner</dt><dd className="break-all font-mono">{data.recommendedWallet}</dd></div>
            <div><dt className="text-muted-foreground">Service</dt><dd className="font-mono">{data.recommendedServiceId || "Identity-level selection"}</dd></div>
            <div><dt className="text-muted-foreground">ERC-8004 registry</dt><dd className="break-all font-mono">{winner?.registryAddress || "Verified registry"}</dd></div>
            <div><dt className="text-muted-foreground">Identity metadata</dt><dd className="break-all font-mono">{winner?.metadataUri || "Verified onchain"}</dd></div>
            <div><dt className="text-muted-foreground">Decision</dt><dd>{data.decision}</dd></div>
            <div><dt className="text-muted-foreground">Maximum exposure</dt><dd>{data.recommendedMaxExposureUsdc.toFixed(6)} USDC</dd></div>
          </dl>
        </CardContent></Card>
        <Card><CardHeader><CardTitle className="flex items-center gap-2"><ShieldCheck className="size-5" />Receipt integrity</CardTitle></CardHeader><CardContent className="space-y-3 text-sm">
          <div><p className="text-muted-foreground">Canonical hash</p><p className="break-all font-mono">{data.canonicalHash}</p></div>
          <div><p className="text-muted-foreground">Capability</p><p className="font-mono">{data.capability}</p></div>
          <div><p className="text-muted-foreground">Budget considered</p><p>{data.requestedBudgetUsdc.toFixed(6)} USDC</p></div>
          <div><p className="text-muted-foreground">Selected at</p><p>{new Date(data.createdAt).toLocaleString()}</p></div>
          <div><p className="text-muted-foreground">Expires</p><p>{new Date(data.expiresAt).toLocaleString()}</p></div>
          {data.proof ? <><p className="text-muted-foreground">This proof reuses verified economic evidence from ERC-8183 job {data.proof.evidenceSourceId} ({data.proof.evidenceAmountUsdc.toFixed(6)} USDC). Selection itself charged 0 USDC.</p><Button asChild variant="outline" size="sm"><a href={`https://testnet.arcscan.app/tx/${data.proof.proofTx}`} target="_blank" rel="noreferrer"><ExternalLink />View Arc proof</a></Button></> : <p className="text-muted-foreground">Arc publication was not requested.</p>}
        </CardContent></Card>

        <Card className="lg:col-span-3"><CardHeader><CardTitle>Ranked candidates</CardTitle></CardHeader><CardContent className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm"><thead className="border-b text-muted-foreground"><tr><th className="py-3">Rank</th><th>Agent</th><th>Eligibility</th><th>Trust</th><th>Ranking</th><th>Confidence</th><th>Evidence</th></tr></thead><tbody>
            {data.candidates.map((candidate) => <tr key={`${candidate.rank}:${candidate.evidenceHash}`} className="border-b last:border-0"><td className="py-4 font-mono">#{candidate.rank}</td><td><p className="font-mono">{candidate.agentId || "Unresolved"}</p><p className="font-mono text-xs text-muted-foreground">{candidate.wallet ? short(candidate.wallet) : "—"}</p></td><td><Badge variant="outline">{candidate.eligibility}</Badge>{candidate.rejectionReason ? <p className="mt-1 text-xs text-muted-foreground">{candidate.rejectionReason}</p> : null}</td><td>{candidate.trustScore}</td><td>{candidate.rankingScore}</td><td>{candidate.confidence}%</td><td><p>{candidate.evidenceCoverage}% coverage</p><p className="font-mono text-xs text-muted-foreground">{short(candidate.evidenceHash)}</p></td></tr>)}
          </tbody></table>
        </CardContent></Card>

        <Card className="lg:col-span-3"><CardContent className="flex gap-3 p-5 text-sm text-muted-foreground"><Fingerprint className="mt-0.5 size-5 shrink-0" /><p>The canonical hash commits to the requester, intent hash, candidate set, evidence hashes, TrustGate decisions, final ranking, winner, policy versions, and expiry. No task text, credential ID, payment record, or private owner data is published.</p></CardContent></Card>
      </section>
    </main>
  );
}
