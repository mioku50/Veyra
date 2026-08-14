import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getExecutionAttempt } from "@/lib/execution/db";
import { CheckCircle2, ExternalLink, FileText, Layers, ShieldCheck, XCircle } from "lucide-react";

type RouteContext = { params: Promise<{ publicId: string }> };

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: RouteContext): Promise<Metadata> {
  const { publicId } = await params;
  return {
    title: `Execution Receipt ${publicId} | Veyra`,
    description: "Verifiable trust-routed execution receipt and onchain settlement proof on Arc Testnet.",
  };
}

export default async function ExecutionReceiptPage({ params }: RouteContext) {
  const { publicId } = await params;
  const execution = await getExecutionAttempt(publicId);

  if (!execution) {
    notFound();
  }

  const isCompleted = execution.state === "COMPLETED";
  const isFailed = ["FAILED", "REJECTED", "SETTLEMENT_FAILED", "EVALUATION_REJECTED"].includes(
    execution.state
  );

  return (
    <div className="container max-w-4xl py-12 space-y-8">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b pb-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Badge variant="outline" className="font-mono text-xs">
              {execution.rail.toUpperCase()} RAIL
            </Badge>
            <Badge
              variant={isCompleted ? "default" : isFailed ? "destructive" : "secondary"}
            >
              {execution.state}
            </Badge>
          </div>
          <h1 className="text-3xl font-bold tracking-tight">Execution Receipt</h1>
          <p className="text-muted-foreground font-mono text-sm mt-1">{execution.executionId}</p>
        </div>

        <Button asChild variant="outline">
          <Link href="/trust/mandates">View Mandates</Link>
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card className="border shadow-sm">
          <CardHeader className="py-3">
            <CardTitle className="text-xs font-medium text-muted-foreground">
              Requested Amount
            </CardTitle>
          </CardHeader>
          <CardContent className="py-2">
            <div className="text-2xl font-bold font-mono">
              ${execution.requestedAmountUsdc.toFixed(2)}
              <span className="text-xs text-muted-foreground ml-1">USDC</span>
            </div>
          </CardContent>
        </Card>

        <Card className="border shadow-sm">
          <CardHeader className="py-3">
            <CardTitle className="text-xs font-medium text-muted-foreground">
              Actual Settled
            </CardTitle>
          </CardHeader>
          <CardContent className="py-2">
            <div className="text-2xl font-bold font-mono text-emerald-600 dark:text-emerald-400">
              ${(execution.actualSettledAmountUsdc ?? 0).toFixed(2)}
              <span className="text-xs text-muted-foreground ml-1">USDC</span>
            </div>
          </CardContent>
        </Card>

        <Card className="border shadow-sm">
          <CardHeader className="py-3">
            <CardTitle className="text-xs font-medium text-muted-foreground">
              Settlement Rail
            </CardTitle>
          </CardHeader>
          <CardContent className="py-2">
            <div className="text-2xl font-bold">
              {execution.rail === "erc8183" ? "ERC-8183" : "x402"}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Execution Details Card */}
      <Card className="border shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            Execution Parameters & Provenance
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 border-b pb-4">
            <div>
              <span className="text-muted-foreground text-xs block">Counterparty Agent</span>
              <span className="font-semibold">{execution.counterpartyAgentId}</span>
            </div>
            <div>
              <span className="text-muted-foreground text-xs block">Counterparty Wallet</span>
              <span className="font-mono text-xs break-all">{execution.counterpartyWallet}</span>
            </div>
            <div>
              <span className="text-muted-foreground text-xs block">Capability</span>
              <span className="font-medium">{execution.capability}</span>
            </div>
            <div>
              <span className="text-muted-foreground text-xs block">Associated Mandate</span>
              <span className="font-mono text-xs">{execution.mandateId || "Direct / Prepared"}</span>
            </div>
          </div>

          <div className="space-y-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
              Cryptographic Proof Trail
            </h3>

            <div className="space-y-2 font-mono text-xs">
              <div className="p-3 bg-muted/40 rounded-lg flex items-center justify-between">
                <span className="text-muted-foreground">Selection Hash:</span>
                <span className="truncate max-w-xs">{execution.selectionHash}</span>
              </div>

              {execution.clearanceDigest && (
                <div className="p-3 bg-muted/40 rounded-lg flex items-center justify-between">
                  <span className="text-muted-foreground">Clearance Digest:</span>
                  <span className="truncate max-w-xs">{execution.clearanceDigest}</span>
                </div>
              )}

              {execution.canonicalHash && (
                <div className="p-3 bg-muted/40 rounded-lg flex items-center justify-between">
                  <span className="text-muted-foreground">Execution Canonical Hash:</span>
                  <span className="truncate max-w-xs">{execution.canonicalHash}</span>
                </div>
              )}

              {execution.completeTx && (
                <div className="p-3 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 rounded-lg flex items-center justify-between">
                  <span className="font-semibold">Arc Settlement Tx:</span>
                  <a
                    href={`https://explorer.testnet.arc.network/tx/${execution.completeTx}`}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 hover:underline truncate max-w-xs"
                  >
                    {execution.completeTx}
                    <ExternalLink className="h-3 w-3 inline" />
                  </a>
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
