"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowUpFromLine, LoaderCircle, RefreshCw, WalletCards } from "lucide-react";
import { type Address, type Hex } from "viem";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BRAND } from "@/lib/brand";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useArcWallet } from "@/components/wallet/use-arc-wallet";

type SellerBalance = {
  wallet: string;
  chain: "arcTestnet";
  availableUsdc: string;
  withdrawingUsdc: string;
  withdrawableUsdc: string;
  nativeGasUsdc: string;
};

type Withdrawal = {
  id: string;
  amountUsdc: string;
  destinationWallet: string;
  status: string;
  failureCode: string | null;
  mintTransactionHash: string | null;
  expiresAt: string;
  confirmedAt: string | null;
  createdAt: string;
};

type TypedData = {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
};

async function responseJson(response: Response) {
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `Request failed (${response.status}).`);
  return body;
}

function shortHash(value: string | null) {
  return value ? `${value.slice(0, 10)}…${value.slice(-6)}` : "—";
}

export function SellerWithdrawalClient({ ownerWallet }: { ownerWallet: string }) {
  const wallet = useArcWallet();
  const [balance, setBalance] = useState<SellerBalance | null>(null);
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([]);
  const [amount, setAmount] = useState("0.001");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/seller/withdrawals", { cache: "no-store" });
      const body = await responseJson(response);
      setBalance(body.balance as SellerBalance);
      setWithdrawals((body.withdrawals ?? []) as Withdrawal[]);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function confirmWithRetry(withdrawalId: string, transactionHash: Hex) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await fetch(`/api/seller/withdrawals/${withdrawalId}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transactionHash }),
      });
      if (response.ok) return responseJson(response);
      if (response.status !== 425 || attempt === 19) return responseJson(response);
      await new Promise((resolve) => window.setTimeout(resolve, 2_000));
    }
    throw new Error("Arc confirmation timed out.");
  }

  async function withdraw() {
    setError(null);
    setNotice(null);
    if (!wallet.address) {
      setError("Connect the verified seller owner wallet first.");
      return;
    }
    if (wallet.address.toLowerCase() !== ownerWallet.toLowerCase()) {
      setError("Connected wallet does not match the verified seller owner wallet.");
      return;
    }
    if (!wallet.isArcTestnet) {
      setError("Switch the connected wallet to Arc Testnet first.");
      return;
    }
    setBusy(true);
    try {
      const prepared = await responseJson(await fetch("/api/seller/withdrawals", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `seller-withdrawal:${crypto.randomUUID()}`,
        },
        body: JSON.stringify({ amountUsdc: amount }),
      }));
      await finishWithdrawal(prepared.withdrawal as Withdrawal, prepared);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function finishWithdrawal(withdrawal: Withdrawal, detail: Record<string, unknown>) {
    let transaction = detail.transaction as { to: Address; data: Hex } | undefined;
    if (!transaction) {
      if (!detail.typedData) throw new Error("Withdrawal is not ready to resume.");
      const signature = await wallet.signTypedData(detail.typedData as TypedData);
      const authorized = await responseJson(await fetch(`/api/seller/withdrawals/${withdrawal.id}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signature }),
      }));
      transaction = authorized.transaction as { to: Address; data: Hex };
    }
    if (!transaction?.to || !transaction.data) throw new Error("Gateway mint transaction is unavailable.");
    const transactionHash = await wallet.sendTransaction({ to: transaction.to, data: transaction.data });
    await confirmWithRetry(withdrawal.id, transactionHash);
    setNotice(`Withdrawal confirmed on Arc Testnet: ${shortHash(transactionHash)}`);
    await Promise.all([load(), wallet.refresh()]);
  }

  async function resume(withdrawal: Withdrawal) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (!wallet.address || wallet.address.toLowerCase() !== ownerWallet.toLowerCase() || !wallet.isArcTestnet) {
        throw new Error("Connect the verified seller wallet on Arc Testnet before resuming.");
      }
      const detail = await responseJson(await fetch(`/api/seller/withdrawals/${withdrawal.id}`, { cache: "no-store" }));
      await finishWithdrawal(withdrawal, detail);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  const walletMatches = Boolean(wallet.address && wallet.address.toLowerCase() === ownerWallet.toLowerCase());

  return (
    <section className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2"><WalletCards className="size-5 text-primary" /><h2 className="text-2xl font-bold">Gateway withdrawal</h2></div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading || busy}><RefreshCw className={loading ? "animate-spin" : ""} />Refresh</Button>
      </div>
      <Card>
        <CardHeader><CardTitle>Non-custodial Arc Testnet withdrawal</CardTitle></CardHeader>
        <CardContent className="grid gap-5">
          <p className="text-sm leading-6 text-muted-foreground">x402 already pays the registered seller wallet directly in Gateway. This flow only moves that seller-owned Gateway balance back to the same Arc wallet. The browser wallet signs the burn intent and submits the mint transaction; {BRAND.name} never receives a seller private key.</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">Available Gateway USDC</p><p className="mt-1 font-mono text-lg">{balance?.availableUsdc ?? "—"}</p></div>
            <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">Withdrawing</p><p className="mt-1 font-mono text-lg">{balance?.withdrawingUsdc ?? "—"}</p></div>
            <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">Arc gas balance</p><p className="mt-1 font-mono text-lg">{balance?.nativeGasUsdc ?? "—"}</p></div>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid min-w-52 gap-2"><Label htmlFor="withdrawal-amount">Amount (USDC)</Label><Input id="withdrawal-amount" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} /></div>
            {!wallet.address ? <Button type="button" variant="outline" onClick={() => void wallet.connect()} disabled={wallet.connecting}>{wallet.connecting ? <LoaderCircle className="animate-spin" /> : <WalletCards />}Connect wallet</Button> : null}
            {wallet.address && !wallet.isArcTestnet ? <Button type="button" variant="outline" onClick={() => void wallet.switchToArc()} disabled={wallet.switching}>{wallet.switching ? <LoaderCircle className="animate-spin" /> : null}Switch to Arc Testnet</Button> : null}
            <Button type="button" onClick={() => void withdraw()} disabled={busy || !walletMatches || !wallet.isArcTestnet || !balance}>{busy ? <LoaderCircle className="animate-spin" /> : <ArrowUpFromLine />}{busy ? "Signing & confirming…" : "Withdraw to owner wallet"}</Button>
          </div>
          <p className="break-all text-xs text-muted-foreground">Verified owner: {ownerWallet}. Connected: {wallet.address ?? "none"}.</p>
          {wallet.error ? <p className="text-sm text-destructive">{wallet.error}</p> : null}
          {error ? <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p> : null}
          {notice ? <p className="rounded-md border border-sky-500/30 bg-sky-500/5 p-3 text-sm text-sky-700 dark:text-sky-300">{notice}</p> : null}
        </CardContent>
      </Card>
      <Card><CardContent className="overflow-x-auto p-0"><Table><TableHeader><TableRow><TableHead>Created</TableHead><TableHead>Amount</TableHead><TableHead>Status</TableHead><TableHead>Arc transaction</TableHead><TableHead>Action</TableHead></TableRow></TableHeader><TableBody>{withdrawals.length ? withdrawals.map((row) => <TableRow key={row.id}><TableCell className="min-w-36 text-xs">{new Date(row.createdAt).toLocaleString()}</TableCell><TableCell className="font-mono">{row.amountUsdc}</TableCell><TableCell><Badge variant={row.status === "confirmed" ? "default" : "secondary"}>{row.status}</Badge>{row.failureCode ? <span className="ml-2 text-xs text-destructive">{row.failureCode}</span> : null}</TableCell><TableCell className="font-mono text-xs">{shortHash(row.mintTransactionHash)}</TableCell><TableCell>{["awaiting_signature", "ready_to_mint", "submitted"].includes(row.status) ? <Button type="button" size="sm" variant="outline" onClick={() => void resume(row)} disabled={busy}>Resume</Button> : "—"}</TableCell></TableRow>) : <TableRow><TableCell colSpan={5} className="p-6 text-muted-foreground">No withdrawal intents yet.</TableCell></TableRow>}</TableBody></Table></CardContent></Card>
    </section>
  );
}
