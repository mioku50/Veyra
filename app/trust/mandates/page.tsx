"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useArcWallet } from "@/components/wallet/use-arc-wallet";
import { AlertCircle, CheckCircle2, KeyRound, Loader2, Shield, XCircle } from "lucide-react";

export default function ExecutionMandatesPage() {
  const { address, connect } = useArcWallet();
  const isConnected = Boolean(address);
  const [mandates, setMandates] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Form state
  const [subjectAgentId, setSubjectAgentId] = useState("agent_buyer_01");
  const [subjectWallet, setSubjectWallet] = useState("");
  const [mode, setMode] = useState<"PREPARE" | "AUTOPILOT">("AUTOPILOT");
  const [capabilities, setCapabilities] = useState("github_due_diligence, code_review");
  const [maxPerTx, setMaxPerTx] = useState("2.0");
  const [maxDaily, setMaxDaily] = useState("10.0");
  const [maxTotal, setMaxTotal] = useState("50.0");
  const [minTrustScore, setMinTrustScore] = useState("75");

  useEffect(() => {
    if (address) {
      setSubjectWallet((prev) => prev || address);
      fetchMandates(address);
    }
  }, [address]);

  async function fetchMandates(owner: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/execution/v1/mandates?ownerWallet=${encodeURIComponent(owner)}`);
      const data = await res.json();
      if (res.ok) {
        setMandates(data.mandates || []);
      } else {
        setError(data.error || "Failed to load mandates");
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateMandate() {
    if (!address) {
      setError("Please connect your wallet first");
      return;
    }
    setCreating(true);
    setError(null);
    setSuccess(null);

    try {
      const allowedCaps = capabilities.split(",").map((c) => c.trim()).filter(Boolean);
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

      // 1. Create challenge
      const createRes = await fetch("/api/execution/v1/mandates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ownerWallet: address,
          subjectAgentId,
          subjectWallet: subjectWallet || address,
          mode,
          allowedCapabilities: allowedCaps,
          allowedRails: ["erc8183", "x402"],
          maxPerTransactionUsdc: Number(maxPerTx),
          maxPerDayUsdc: Number(maxDaily),
          maxTotalUsdc: Number(maxTotal),
          minimumTrustScore: Number(minTrustScore),
          minimumConfidence: 60,
          requireVerifiedIdentity: true,
          expiresAt,
        }),
      });

      const challenge = await createRes.json();
      if (!createRes.ok) {
        throw new Error(challenge.error || "Failed to create mandate challenge");
      }

      // 2. Sign EIP-712 payload with window.ethereum
      if (!window.ethereum) {
        throw new Error("No web3 wallet provider detected for signing");
      }

      const rawSig = await window.ethereum.request({
        method: "eth_signTypedData_v4",
        params: [address, JSON.stringify(challenge.eip712Payload)],
      });

      // 3. Activate mandate
      const activateRes = await fetch(`/api/execution/v1/mandates/${challenge.mandateId}/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ownerWallet: address,
          subjectAgentId,
          subjectWallet: subjectWallet || address,
          mode,
          allowedCapabilities: allowedCaps,
          allowedRails: ["erc8183", "x402"],
          maxPerTransactionUsdc: Number(maxPerTx),
          maxPerDayUsdc: Number(maxDaily),
          maxTotalUsdc: Number(maxTotal),
          minimumTrustScore: Number(minTrustScore),
          minimumConfidence: 60,
          requireVerifiedIdentity: true,
          signature: rawSig,
          expiresAt,
        }),
      });

      const activateData = await activateRes.json();
      if (!activateRes.ok) {
        throw new Error(activateData.error || "Failed to activate mandate");
      }

      setSuccess(`Mandate ${challenge.mandateId} activated successfully!`);
      await fetchMandates(address);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(mandateId: string) {
    if (!address) return;
    if (!confirm(`Are you sure you want to revoke mandate ${mandateId}?`)) return;

    try {
      const res = await fetch(`/api/execution/v1/mandates/${mandateId}/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerWallet: address }),
      });
      const data = await res.json();
      if (res.ok) {
        setSuccess(`Mandate ${mandateId} revoked.`);
        await fetchMandates(address);
      } else {
        setError(data.error || "Failed to revoke mandate");
      }
    } catch (err: any) {
      setError(err.message);
    }
  }

  return (
    <div className="container max-w-6xl py-8 space-y-8">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b pb-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Execution Mandates</h1>
          <p className="text-muted-foreground mt-1">
            Authorise AI agents to execute trust-routed tasks with cryptographically bounded spending caps and policy rules.
          </p>
        </div>
        <div>
          {!isConnected ? (
            <Button onClick={connect} className="gap-2">
              <KeyRound className="h-4 w-4" />
              Connect Wallet
            </Button>
          ) : (
            <Badge variant="outline" className="text-sm px-3 py-1 font-mono">
              {address?.slice(0, 6)}...{address?.slice(-4)}
            </Badge>
          )}
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-4 bg-destructive/10 text-destructive rounded-lg border border-destructive/20 text-sm">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {success && (
        <div className="flex items-center gap-2 p-4 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 rounded-lg border border-emerald-500/20 text-sm">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>{success}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Create Mandate Card */}
        <Card className="lg:col-span-1 border shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Shield className="h-5 w-5 text-primary" />
              Issue New Mandate
            </CardTitle>
            <CardDescription>
              Sign an EIP-712 authorization to constrain agent spending and policy boundaries.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="subjectAgentId">Authorized Agent ID</Label>
              <Input
                id="subjectAgentId"
                value={subjectAgentId}
                onChange={(e) => setSubjectAgentId(e.target.value)}
                placeholder="agent_buyer_01"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="subjectWallet">Executor / Agent Wallet</Label>
              <Input
                id="subjectWallet"
                value={subjectWallet}
                onChange={(e) => setSubjectWallet(e.target.value)}
                placeholder="0x..."
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="mode">Execution Mode</Label>
              <select
                id="mode"
                className="w-full h-10 px-3 rounded-md border bg-background text-sm"
                value={mode}
                onChange={(e) => setMode(e.target.value as any)}
              >
                <option value="AUTOPILOT">AUTOPILOT (Autonomous under limits)</option>
                <option value="PREPARE">PREPARE (Preflight approval required)</option>
              </select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="capabilities">Allowed Capabilities (comma-separated)</Label>
              <Input
                id="capabilities"
                value={capabilities}
                onChange={(e) => setCapabilities(e.target.value)}
                placeholder="github_due_diligence, code_review"
              />
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div className="space-y-1">
                <Label htmlFor="maxPerTx" className="text-xs">Max/Tx ($)</Label>
                <Input
                  id="maxPerTx"
                  type="number"
                  step="0.1"
                  value={maxPerTx}
                  onChange={(e) => setMaxPerTx(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="maxDaily" className="text-xs">Max/Day ($)</Label>
                <Input
                  id="maxDaily"
                  type="number"
                  step="1"
                  value={maxDaily}
                  onChange={(e) => setMaxDaily(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="maxTotal" className="text-xs">Max Total ($)</Label>
                <Input
                  id="maxTotal"
                  type="number"
                  step="1"
                  value={maxTotal}
                  onChange={(e) => setMaxTotal(e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="minTrustScore">Min Trust Score (0-100)</Label>
              <Input
                id="minTrustScore"
                type="number"
                value={minTrustScore}
                onChange={(e) => setMinTrustScore(e.target.value)}
              />
            </div>

            <Button
              className="w-full mt-4"
              disabled={creating || !isConnected}
              onClick={handleCreateMandate}
            >
              {creating ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Signing & Activating...
                </>
              ) : (
                "Sign & Activate Mandate"
              )}
            </Button>
          </CardContent>
        </Card>

        {/* Existing Mandates List */}
        <div className="lg:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold">Active & Historical Mandates</h2>
            {address && (
              <Button variant="ghost" size="sm" onClick={() => fetchMandates(address)}>
                Refresh
              </Button>
            )}
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin mr-2" />
              Loading mandates...
            </div>
          ) : mandates.length === 0 ? (
            <Card className="p-8 text-center text-muted-foreground">
              No execution mandates found for this wallet. Create your first mandate above.
            </Card>
          ) : (
            <div className="space-y-4">
              {mandates.map((m) => {
                const isRevoked = Boolean(m.revokedAt);
                const isExpired = new Date(m.expiresAt).getTime() < Date.now();
                const status = isRevoked ? "REVOKED" : isExpired ? "EXPIRED" : "ACTIVE";

                return (
                  <Card key={m.mandateId} className="border shadow-sm">
                    <CardHeader className="py-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-medium text-sm">{m.mandateId}</span>
                          <Badge
                            variant={
                              status === "ACTIVE"
                                ? "default"
                                : status === "REVOKED"
                                ? "destructive"
                                : "secondary"
                            }
                          >
                            {status}
                          </Badge>
                          <Badge variant="outline">{m.mode}</Badge>
                        </div>
                        {status === "ACTIVE" && (
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => handleRevoke(m.mandateId)}
                          >
                            Revoke
                          </Button>
                        )}
                      </div>
                    </CardHeader>
                    <CardContent className="py-2 space-y-2 text-sm">
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs text-muted-foreground">
                        <div>
                          <span className="font-medium text-foreground">Subject: </span>
                          {m.subjectAgentId}
                        </div>
                        <div>
                          <span className="font-medium text-foreground">Max/Tx: </span>
                          ${m.maxPerTransactionUsdc}
                        </div>
                        <div>
                          <span className="font-medium text-foreground">Daily Cap: </span>
                          ${m.maxPerDayUsdc}
                        </div>
                        <div>
                          <span className="font-medium text-foreground">Total Cap: </span>
                          ${m.maxTotalUsdc}
                        </div>
                      </div>

                      <div className="text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">Capabilities: </span>
                        {m.allowedCapabilities.join(", ")}
                      </div>

                      <div className="text-xs font-mono text-muted-foreground truncate">
                        <span className="font-medium text-foreground">Hash: </span>
                        {m.canonicalHash}
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
