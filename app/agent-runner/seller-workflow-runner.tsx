"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { ArrowLeft, Braces, CreditCard, LoaderCircle, Wallet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { useArcWallet } from "@/components/wallet/use-arc-wallet";
import type { PublicSellerWorkflow } from "@/lib/seller/marketplace";
import type { WorkflowPaymentDescriptor } from "@/lib/commerce/workflow-payment";

type SellerQuote = {
  id: string;
  requesterWallet: string;
  inputSha256: string;
  paymentMode: "sponsored" | "paid";
  treasuryAddress: string;
  payment: WorkflowPaymentDescriptor | null;
  expiresAt: string;
  pricing: {
    estimatedProviderCostUsdc: number;
    listPriceUsdc: number;
    amountDueUsdc: number;
  };
  sellerSnapshot: { serviceId: string; serviceVersion: number } | null;
};

function exampleInput(workflow: PublicSellerWorkflow) {
  if (workflow.workflowType === "seller_project_update_intelligence") {
    return JSON.stringify({
      projectName: "Example Project",
      updateText: "We shipped the new onboarding flow. A provider dependency remains a delivery risk. Next, we will complete production monitoring.",
    }, null, 2);
  }
  const properties = workflow.inputSchema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return "{}";
  return JSON.stringify(Object.fromEntries(Object.entries(properties).map(([key, schema]) => {
    const type = schema && typeof schema === "object" && !Array.isArray(schema) ? (schema as Record<string, unknown>).type : null;
    return [key, type === "number" || type === "integer" ? 0 : type === "boolean" ? false : type === "array" ? [] : ""];
  })), null, 2);
}

export function SellerWorkflowRunner({ workflow }: { workflow: PublicSellerWorkflow }) {
  const router = useRouter();
  const wallet = useArcWallet();
  const [inputText, setInputText] = useState(() => exampleInput(workflow));
  const [quote, setQuote] = useState<SellerQuote | null>(null);
  const [authorizationMessage, setAuthorizationMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idempotencyKey = useRef<string | null>(null);
  const paymentHash = useRef<string | null>(null);
  const sponsoredSignature = useRef<string | null>(null);

  function parsedInput() {
    const value = JSON.parse(inputText);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Input must be a JSON object.");
    return value as Record<string, unknown>;
  }

  function invalidate() {
    setQuote(null);
    setAuthorizationMessage(null);
    setError(null);
    idempotencyKey.current = null;
    paymentHash.current = null;
    sponsoredSignature.current = null;
  }

  async function createQuote() {
    if (!wallet.address) {
      setError("Connect a wallet before creating an immutable quote.");
      return;
    }
    setBusy(true);
    setError(null);
    idempotencyKey.current ??= crypto.randomUUID();
    try {
      const response = await fetch("/api/seller-workflows/quotes", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey.current },
        body: JSON.stringify({ serviceId: workflow.serviceId, input: parsedInput(), requesterWallet: wallet.address }),
      });
      const data = await response.json() as { quote?: SellerQuote; sponsoredAuthorizationMessage?: string | null; error?: string };
      if (!response.ok || !data.quote) throw new Error(data.error ?? "Unable to create seller workflow quote.");
      setQuote(data.quote);
      setAuthorizationMessage(data.sponsoredAuthorizationMessage ?? null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function launch() {
    if (!quote || !wallet.address || !idempotencyKey.current) return;
    setBusy(true);
    setError(null);
    try {
      if (Date.parse(quote.expiresAt) <= Date.now()) throw new Error("The quote expired. Create a new quote before paying.");
      if (wallet.address.toLowerCase() !== quote.requesterWallet.toLowerCase()) throw new Error("The connected wallet does not own this quote.");
      if (quote.paymentMode === "paid" && !paymentHash.current) {
        if (!wallet.isArcTestnet) await wallet.switchToArc();
        paymentHash.current = await wallet.sendWorkflowPayment({
          treasuryAddress: quote.treasuryAddress,
          amountUsdc: quote.pricing.amountDueUsdc,
          payment: quote.payment,
        });
      }
      if (quote.paymentMode === "sponsored" && !sponsoredSignature.current) {
        if (!authorizationMessage) throw new Error("Sponsored authorization is unavailable.");
        sponsoredSignature.current = await wallet.signMessage(authorizationMessage);
      }
      const response = await fetch(`/api/seller-workflows/quotes/${quote.id}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey.current },
        body: JSON.stringify({ input: parsedInput(), transactionHash: paymentHash.current, signature: sponsoredSignature.current }),
      });
      const data = await response.json() as { jobId?: string; error?: string };
      if (!response.ok || !data.jobId) throw new Error(data.error ?? "Unable to launch seller workflow.");
      router.push(`/agent-runner/${data.jobId}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-background">
      <section className="border-b bg-secondary/20">
        <div className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6">
          <Button asChild variant="ghost" className="mb-5 -ml-3"><Link href="/agent-runner"><ArrowLeft /> New Report</Link></Button>
          <div className="flex flex-wrap gap-2"><Badge>External Service</Badge><Badge variant="outline">{workflow.category}</Badge></div>
          <h1 className="mt-4 text-4xl font-bold">{workflow.name}</h1>
          <p className="mt-3 max-w-3xl leading-7 text-muted-foreground">{workflow.description}</p>
        </div>
      </section>
      <section className="mx-auto grid w-full max-w-5xl gap-6 px-4 py-8 sm:px-6 lg:grid-cols-[1.1fr_0.9fr]">
        <Card className="rounded-lg">
          <CardHeader><CardTitle className="flex items-center gap-2"><Braces className="size-5" /> Workflow input</CardTitle></CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="seller-json-input">JSON input</Label>
              <textarea id="seller-json-input" value={inputText} onChange={(event) => { setInputText(event.target.value); invalidate(); }} className="min-h-64 rounded-md border bg-background p-3 font-mono text-sm" spellCheck={false} />
              <p className="text-xs text-muted-foreground">Input is validated against the seller&apos;s declared schema. Do not submit credentials or private data.</p>
            </div>
            {!wallet.address ? (
              <Button type="button" variant="outline" onClick={() => void wallet.connect()} disabled={wallet.connecting}><Wallet />{wallet.connecting ? "Connecting…" : "Connect Wallet"}</Button>
            ) : null}
            {error ? <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p> : null}
            {!quote ? (
              <Button type="button" onClick={() => void createQuote()} disabled={busy || !wallet.address}>{busy ? <LoaderCircle className="animate-spin" /> : <CreditCard />}Create immutable quote</Button>
            ) : (
              <Button type="button" onClick={() => void launch()} disabled={busy}>{busy ? <LoaderCircle className="animate-spin" /> : <CreditCard />}{quote.paymentMode === "sponsored" ? "Authorize & run" : `Pay ${quote.pricing.amountDueUsdc} USDC & run`}</Button>
            )}
          </CardContent>
        </Card>
        <Card className="rounded-lg">
          <CardHeader><CardTitle>Price & version</CardTitle></CardHeader>
          <CardContent className="grid gap-4 text-sm">
            <div><p className="text-muted-foreground">Service price</p><p className="mt-1 font-mono">{workflow.priceUsdc} USDC</p></div>
            <div><p className="text-muted-foreground">Immutable version</p><p className="mt-1 font-mono">v{quote?.sellerSnapshot?.serviceVersion ?? workflow.serviceVersion}</p></div>
            {quote ? <div className="border-t pt-4"><p className="text-muted-foreground">Total</p><p className="mt-1 font-mono text-xl font-semibold">{quote.pricing.listPriceUsdc} USDC</p></div> : null}
            <p className="rounded-md border bg-secondary/10 p-3 text-xs leading-5 text-muted-foreground">The endpoint and authorization credential stay server-only. Execution starts only after checkout succeeds.</p>
          </CardContent>
        </Card>
      </section>
    </main>
  );
}
