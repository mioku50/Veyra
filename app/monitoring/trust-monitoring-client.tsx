"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  BellRing,
  CalendarClock,
  CheckCircle2,
  ExternalLink,
  Globe2,
  LoaderCircle,
  Lock,
  Pause,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
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

type Watchlist = {
  id: string;
  profileId: string;
  label: string;
  input: Record<string, string | undefined>;
  objectType: string;
  visibility: "private" | "public";
  cadence: "manual" | "daily" | "weekly";
  status: "active" | "paused";
  nextRecheckAt: string | null;
  lastRecheckAt: string | null;
  lastJobId: string | null;
  lastErrorCode: string | null;
  currentScore: number | null;
  trustStatus: string | null;
  verificationStatus: string | null;
  latestSnapshotId: string | null;
  publicHistoryUrl: string;
  createdAt: string;
};

type HostedQuote = {
  id: string;
  requesterWallet: string;
  paymentMode: "sponsored" | "paid";
  pricing: {
    estimatedProviderCostUsdc: number;
    listPriceUsdc: number;
    amountDueUsdc: number;
  };
  treasuryAddress: string;
  payment: WorkflowPaymentDescriptor | null;
  expiresAt: string;
};

async function jsonFetch(path: string, init: RequestInit = {}) {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = (await response.json().catch(() => ({}))) as {
    error?: string | { message?: string; code?: string };
    [key: string]: unknown;
  };
  if (!response.ok) {
    const message =
      typeof body.error === "string"
        ? body.error
        : body.error?.message ?? `Request failed (${response.status})`;
    throw new Error(message);
  }
  return body;
}

function formatDate(value: string | null) {
  if (!value) return "Not checked yet";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function subjectSummary(input: Watchlist["input"]) {
  return (
    input.agentId ??
    input.repositoryUrl?.replace("https://github.com/", "") ??
    input.agentWallet ??
    input.contractAddress ??
    input.serviceEndpoint ??
    "Public trust subject"
  );
}

export function TrustMonitoringClient({
  initialInput = {},
}: {
  initialInput?: Partial<Record<
    "agentId" | "agentWallet" | "repositoryUrl" | "contractAddress" | "serviceEndpoint",
    string
  >>;
}) {
  const wallet = useArcWallet();
  const [ownerWallet, setOwnerWallet] = useState<string | null>(null);
  const [watchlists, setWatchlists] = useState<Watchlist[]>([]);
  const [label, setLabel] = useState("");
  const [agentId, setAgentId] = useState(initialInput.agentId ?? "");
  const [agentWallet, setAgentWallet] = useState(initialInput.agentWallet ?? "");
  const [repositoryUrl, setRepositoryUrl] = useState(initialInput.repositoryUrl ?? "");
  const [contractAddress, setContractAddress] = useState(initialInput.contractAddress ?? "");
  const [serviceEndpoint, setServiceEndpoint] = useState(initialInput.serviceEndpoint ?? "");
  const [cadence, setCadence] = useState<Watchlist["cadence"]>("weekly");
  const [visibility, setVisibility] =
    useState<Watchlist["visibility"]>("public");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const idempotencyKeys = useRef(new Map<string, string>());

  const loadSession = useCallback(async () => {
    const session = await jsonFetch("/api/byoa/management/session");
    const authenticated = session.authenticated === true;
    setOwnerWallet(
      authenticated && typeof session.ownerWallet === "string"
        ? session.ownerWallet
        : null,
    );
    return authenticated;
  }, []);

  const loadWatchlists = useCallback(async () => {
    const body = await jsonFetch("/api/monitoring/watchlists");
    setWatchlists((body.watchlists ?? []) as Watchlist[]);
  }, []);

  useEffect(() => {
    void loadSession()
      .then((authenticated) => (authenticated ? loadWatchlists() : undefined))
      .catch(() => undefined);
  }, [loadSession, loadWatchlists]);

  const input = useMemo(
    () => ({
      agentId: agentId.trim() || undefined,
      agentWallet: agentWallet.trim() || undefined,
      repositoryUrl: repositoryUrl.trim() || undefined,
      contractAddress: contractAddress.trim() || undefined,
      serviceEndpoint: serviceEndpoint.trim() || undefined,
    }),
    [agentId, agentWallet, repositoryUrl, contractAddress, serviceEndpoint],
  );

  async function act(key: string, action: () => Promise<void>) {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  async function verifyOwner() {
    await act("auth", async () => {
      if (!wallet.address) throw new Error("Connect your owner wallet first.");
      if (!wallet.isArcTestnet) await wallet.switchToArc();
      const created = await jsonFetch("/api/byoa/management/challenges", {
        method: "POST",
        body: JSON.stringify({ wallet: wallet.address }),
      });
      const challenge = created.challenge as { id: string; message: string };
      const signature = await wallet.signMessage(challenge.message);
      const session = await jsonFetch("/api/byoa/management/session", {
        method: "POST",
        body: JSON.stringify({
          challengeId: challenge.id,
          message: challenge.message,
          signature,
        }),
      });
      setOwnerWallet(session.ownerWallet as string);
      await loadWatchlists();
    });
  }

  async function createWatchlist() {
    await act("create", async () => {
      if (!Object.values(input).some(Boolean)) {
        throw new Error(
          "Provide an Agent ID, wallet, GitHub repository, Arc contract, or service endpoint.",
        );
      }
      const result = await jsonFetch("/api/monitoring/watchlists", {
        method: "POST",
        body: JSON.stringify({ label, input, cadence, visibility }),
      });
      setNotice(
        (result.created as boolean)
          ? "Watchlist saved. Run the first check when ready."
          : "This subject is already on your watchlist.",
      );
      setLabel("");
      await loadWatchlists();
    });
  }

  async function deleteWatchlist(watchlist: Watchlist) {
    if (!window.confirm(
      `Delete "${watchlist.label}" and its monitoring snapshots? This cannot be undone.`,
    )) return;
    await act(`delete:${watchlist.id}`, async () => {
      await jsonFetch(`/api/monitoring/watchlists/${watchlist.id}`, {
        method: "DELETE",
      });
      setNotice("Watchlist deleted. Its public trust profile is no longer published by this watchlist.");
      await loadWatchlists();
    });
  }

  async function updateWatchlist(
    watchlist: Watchlist,
    patch: Partial<Pick<Watchlist, "status" | "cadence" | "visibility">>,
  ) {
    await act(`update:${watchlist.id}`, async () => {
      await jsonFetch(`/api/monitoring/watchlists/${watchlist.id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      await loadWatchlists();
    });
  }

  async function runRecheck(watchlist: Watchlist) {
    await act(`run:${watchlist.id}`, async () => {
      if (!wallet.address || !ownerWallet) {
        throw new Error("Verify the connected owner wallet first.");
      }
      if (wallet.address.toLowerCase() !== ownerWallet.toLowerCase()) {
        throw new Error("Connect the same wallet that owns this watchlist.");
      }
      const key =
        idempotencyKeys.current.get(watchlist.id) ??
        `monitor-${crypto.randomUUID()}`;
      idempotencyKeys.current.set(watchlist.id, key);
      const quoted = await jsonFetch(
        `/api/monitoring/watchlists/${watchlist.id}/rechecks`,
        {
          method: "POST",
          headers: { "Idempotency-Key": key },
          body: "{}",
        },
      );
      const quote = quoted.quote as HostedQuote;
      let signature: string | null = null;
      let transactionHash: string | null = null;
      if (quote.paymentMode === "sponsored") {
        const message = quoted.sponsoredAuthorizationMessage;
        if (typeof message !== "string") {
          throw new Error("Sponsored authorization message is unavailable.");
        }
        signature = await wallet.signMessage(message);
      } else {
        if (!wallet.isArcTestnet) await wallet.switchToArc();
        transactionHash = await wallet.sendWorkflowPayment({
          treasuryAddress: quote.treasuryAddress,
          amountUsdc: quote.pricing.amountDueUsdc,
          payment: quote.payment,
        });
      }
      const launched = await jsonFetch(
        `/api/monitoring/rechecks/${String(quoted.recheckId)}/confirm`,
        {
          method: "POST",
          body: JSON.stringify({ signature, transactionHash }),
        },
      );
      idempotencyKeys.current.delete(watchlist.id);
      setNotice("Recheck started. The trust history will update after Arc verification.");
      const jobId = String(launched.jobId);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        const view = await jsonFetch(`/api/hosted-agent/jobs/${jobId}`);
        const status = (view.job as { status?: string } | undefined)?.status;
        if (status === "failed") throw new Error("The recheck failed safely.");
        if (status === "completed") {
          await loadWatchlists();
          window.location.assign(`/trust/${watchlist.profileId}`);
          return;
        }
      }
      throw new Error("The recheck is still running. Open Trust History in a moment.");
    });
  }

  if (!ownerWallet) {
    return (
      <section className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6">
        <Card className="rounded-lg">
          <CardContent className="grid gap-5 p-6 sm:p-8">
            <div className="flex size-12 items-center justify-center rounded-full bg-primary/10">
              <Wallet className="size-6 text-primary" />
            </div>
            <div>
              <h2 className="text-2xl font-semibold">Verify the watchlist owner</h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                Sign a one-time wallet challenge. The signature creates an HttpOnly
                management session and never authorizes a payment.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              {!wallet.address ? (
                <Button onClick={wallet.connect} disabled={wallet.connecting}>
                  {wallet.connecting ? <LoaderCircle className="animate-spin" /> : <Wallet />}
                  Connect Wallet
                </Button>
              ) : (
                <Button onClick={verifyOwner} disabled={busy === "auth"}>
                  {busy === "auth" ? <LoaderCircle className="animate-spin" /> : <ShieldCheck />}
                  Verify ownership
                </Button>
              )}
              {wallet.address ? (
                <Badge variant="outline" className="max-w-full break-all font-mono">
                  {wallet.address}
                </Badge>
              ) : null}
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </CardContent>
        </Card>
      </section>
    );
  }

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-7 px-4 py-10 sm:px-6">
      <Card className="rounded-lg">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>Add to watchlist</CardTitle>
              <p className="mt-2 text-sm text-muted-foreground">
                All monitored inputs must be public and non-sensitive.
              </p>
            </div>
            <Badge variant="outline" className="max-w-full break-all font-mono">
              Owner · {ownerWallet}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="grid gap-5">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="grid gap-2">
              <Label htmlFor="monitor-label">Label</Label>
              <Input
                id="monitor-label"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="Payments Agent"
                maxLength={100}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="monitor-cadence">Schedule</Label>
              <select
                id="monitor-cadence"
                value={cadence}
                onChange={(event) =>
                  setCadence(event.target.value as Watchlist["cadence"])
                }
                className="h-10 rounded-md border bg-background px-3 text-sm"
              >
                <option value="manual">Manual only</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="monitor-visibility">Trust profile</Label>
              <select
                id="monitor-visibility"
                value={visibility}
                onChange={(event) =>
                  setVisibility(event.target.value as Watchlist["visibility"])
                }
                className="h-10 rounded-md border bg-background px-3 text-sm"
              >
                <option value="public">Public profile</option>
                <option value="private">Private watchlist</option>
              </select>
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <div className="grid gap-2">
              <Label htmlFor="monitor-agent-id">Public Agent ID</Label>
              <Input
                id="monitor-agent-id"
                value={agentId}
                onChange={(event) => setAgentId(event.target.value)}
                placeholder="agt_..."
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="monitor-wallet">Agent wallet</Label>
              <Input
                id="monitor-wallet"
                value={agentWallet}
                onChange={(event) => setAgentWallet(event.target.value)}
                placeholder="0x..."
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="monitor-repository">GitHub repository</Label>
              <Input
                id="monitor-repository"
                value={repositoryUrl}
                onChange={(event) => setRepositoryUrl(event.target.value)}
                placeholder="github.com/owner/repository"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="monitor-contract">Arc contract</Label>
              <Input
                id="monitor-contract"
                value={contractAddress}
                onChange={(event) => setContractAddress(event.target.value)}
                placeholder="0x..."
              />
            </div>
            <div className="grid gap-2 md:col-span-2">
              <Label htmlFor="monitor-endpoint">Public HTTPS endpoint</Label>
              <Input
                id="monitor-endpoint"
                value={serviceEndpoint}
                onChange={(event) => setServiceEndpoint(event.target.value)}
                placeholder="https://api.example.com/health"
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={createWatchlist} disabled={busy === "create"}>
              {busy === "create" ? <LoaderCircle className="animate-spin" /> : <Plus />}
              Save watchlist
            </Button>
            <p className="text-xs text-muted-foreground">
              Scheduled checks are Veyra-sponsored and drain up to three due watches
              sequentially per scheduler tick.
            </p>
          </div>
        </CardContent>
      </Card>

      {error ? (
        <Card className="border-destructive/30 bg-destructive/5">
          <CardContent className="p-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      ) : null}
      {notice ? (
        <Card className="border-emerald-500/30 bg-emerald-500/5">
          <CardContent className="flex items-center gap-2 p-4 text-sm text-emerald-400">
            <CheckCircle2 className="size-4" />
            {notice}
          </CardContent>
        </Card>
      ) : null}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold">Your watchlist</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {watchlists.length} of 10 subjects monitored
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/alerts"><BellRing /> Trust alerts</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href="#webhooks"><ExternalLink /> Webhooks</Link>
          </Button>
          <Button variant="outline" size="sm" onClick={loadWatchlists}>
            <RefreshCw /> Refresh
          </Button>
        </div>
      </div>

      {watchlists.length === 0 ? (
        <Card className="rounded-lg">
          <CardContent className="grid place-items-center gap-3 p-10 text-center">
            <Activity className="size-8 text-muted-foreground" />
            <p className="font-medium">No monitored subjects yet.</p>
            <p className="text-sm text-muted-foreground">
              Save a public project or agent above, then run its first check.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          {watchlists.map((watchlist) => (
            <Card key={watchlist.id} className="rounded-lg">
              <CardContent className="grid gap-5 p-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge>{watchlist.cadence}</Badge>
                      <Badge variant={watchlist.status === "active" ? "secondary" : "outline"}>
                        {watchlist.status}
                      </Badge>
                      <Badge variant="outline">
                        {watchlist.visibility === "public" ? (
                          <Globe2 className="mr-1 size-3" />
                        ) : (
                          <Lock className="mr-1 size-3" />
                        )}
                        {watchlist.visibility}
                      </Badge>
                      {watchlist.verificationStatus === "verified" ? (
                        <Badge className="border border-emerald-500/30 bg-emerald-500/10 text-emerald-400">
                          Arc verified
                        </Badge>
                      ) : null}
                    </div>
                    <h3 className="mt-3 truncate text-xl font-semibold">
                      {watchlist.label}
                    </h3>
                    <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                      {subjectSummary(watchlist.input)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-mono text-3xl font-semibold">
                      {watchlist.currentScore ?? "—"}
                    </p>
                    <p className="text-xs text-muted-foreground">Trust Score</p>
                  </div>
                </div>
                <div className="grid gap-3 rounded-md border bg-secondary/10 p-4 text-sm sm:grid-cols-2">
                  <div>
                    <p className="text-xs text-muted-foreground">Last check</p>
                    <p className="mt-1">{formatDate(watchlist.lastRecheckAt)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Next scheduled</p>
                    <p className="mt-1">
                      {watchlist.status === "paused"
                        ? "Paused"
                        : watchlist.nextRecheckAt
                          ? formatDate(watchlist.nextRecheckAt)
                          : "Manual only"}
                    </p>
                  </div>
                </div>
                {watchlist.lastErrorCode ? (
                  <p className="text-sm text-amber-400">
                    Last scheduled attempt: {watchlist.lastErrorCode.replaceAll("_", " ")}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    onClick={() => runRecheck(watchlist)}
                    disabled={busy === `run:${watchlist.id}`}
                  >
                    {busy === `run:${watchlist.id}` ? (
                      <LoaderCircle className="animate-spin" />
                    ) : (
                      <Play />
                    )}
                    {watchlist.currentScore === null ? "Run first check" : "Recheck now"}
                  </Button>
                  {watchlist.visibility === "public" ? (
                    <Button asChild size="sm" variant="outline">
                      <Link href={watchlist.publicHistoryUrl}>
                        <ExternalLink /> Trust profile
                      </Link>
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        updateWatchlist(watchlist, { visibility: "public" })
                      }
                      disabled={busy === `update:${watchlist.id}`}
                    >
                      <Globe2 /> Publish profile
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      updateWatchlist(watchlist, {
                        status: watchlist.status === "active" ? "paused" : "active",
                      })
                    }
                    disabled={busy === `update:${watchlist.id}`}
                  >
                    {watchlist.status === "active" ? <Pause /> : <CalendarClock />}
                    {watchlist.status === "active" ? "Pause" : "Resume"}
                  </Button>
                  {watchlist.visibility === "public" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        updateWatchlist(watchlist, { visibility: "private" })
                      }
                      disabled={busy === `update:${watchlist.id}`}
                    >
                      <Lock /> Make private
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => void deleteWatchlist(watchlist)}
                    disabled={busy === `delete:${watchlist.id}`}
                  >
                    <Trash2 /> Delete
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}
