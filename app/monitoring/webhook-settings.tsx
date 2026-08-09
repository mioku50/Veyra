"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Copy,
  KeyRound,
  LoaderCircle,
  Pause,
  Play,
  RotateCw,
  Send,
  Trash2,
  Webhook,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const eventTypes = [
  "trust_score_changed",
  "trust_status_changed",
  "risk_added",
  "risk_resolved",
  "verification_failed",
  "recheck_failed",
  "subject_unavailable",
] as const;

type Watchlist = { profileId: string; label: string };
type Delivery = {
  id: string;
  eventType: string;
  attemptNumber: number;
  httpStatus: number | null;
  durationMs: number | null;
  status: string;
  nextRetryAt: string | null;
  createdAt?: string;
};
type WebhookSubscription = {
  id: string;
  name: string;
  endpointUrl: string;
  endpointDomain: string;
  profileIds: string[];
  eventTypes: string[];
  status: "active" | "paused";
  lastSuccessfulDelivery: string | null;
  lastFailedDelivery: string | null;
};

async function api(path: string, init?: RequestInit) {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const error = body.error as { message?: string } | string | undefined;
    throw new Error(
      typeof error === "string"
        ? error
        : error?.message ?? `Request failed (${response.status})`,
    );
  }
  return body;
}

export function WebhookSettings() {
  const [authenticated, setAuthenticated] = useState(false);
  const [watchlists, setWatchlists] = useState<Watchlist[]>([]);
  const [webhooks, setWebhooks] = useState<WebhookSubscription[]>([]);
  const [name, setName] = useState("Trust changes");
  const [endpointUrl, setEndpointUrl] = useState("");
  const [profileId, setProfileId] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<Record<string, Delivery[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const session = await api("/api/byoa/management/session");
    if (session.authenticated !== true) {
      setAuthenticated(false);
      return;
    }
    setAuthenticated(true);
    const [watchlistBody, webhookBody] = await Promise.all([
      api("/api/monitoring/watchlists"),
      api("/api/monitoring/webhooks"),
    ]);
    const nextWatchlists = (watchlistBody.watchlists ?? []) as Watchlist[];
    setWatchlists(nextWatchlists);
    setProfileId((current) => current || nextWatchlists[0]?.profileId || "");
    setWebhooks((webhookBody.webhooks ?? []) as WebhookSubscription[]);
  }, []);

  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  async function act(key: string, action: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  async function createWebhook() {
    await act("create", async () => {
      const result = await api("/api/monitoring/webhooks", {
        method: "POST",
        body: JSON.stringify({
          name,
          endpointUrl,
          profileIds: [profileId],
          eventTypes,
        }),
      });
      setSecret(String(result.secret));
      setEndpointUrl("");
      await load();
    });
  }

  async function patch(webhook: WebhookSubscription, patch: Record<string, unknown>) {
    await act(webhook.id, async () => {
      await api(`/api/monitoring/webhooks/${webhook.id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      await load();
    });
  }

  async function remove(webhook: WebhookSubscription) {
    if (!window.confirm(`Delete webhook "${webhook.name}"?`)) return;
    await act(webhook.id, async () => {
      await api(`/api/monitoring/webhooks/${webhook.id}`, { method: "DELETE" });
      await load();
    });
  }

  async function rotate(webhook: WebhookSubscription) {
    await act(webhook.id, async () => {
      const result = await api(
        `/api/monitoring/webhooks/${webhook.id}/rotate-secret`,
        { method: "POST" },
      );
      setSecret(String(result.secret));
      await load();
    });
  }

  async function test(webhook: WebhookSubscription) {
    await act(webhook.id, async () => {
      await api(`/api/monitoring/webhooks/${webhook.id}/test`, { method: "POST" });
      window.setTimeout(() => void showDeliveries(webhook), 1200);
    });
  }

  async function showDeliveries(webhook: WebhookSubscription) {
    await act(`deliveries:${webhook.id}`, async () => {
      const result = await api(
        `/api/monitoring/webhooks/${webhook.id}/deliveries`,
      );
      setDeliveries((current) => ({
        ...current,
        [webhook.id]: (result.deliveries ?? []) as Delivery[],
      }));
    });
  }

  if (!authenticated) return null;

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-5 px-4 pb-12 sm:px-6">
      <div id="webhooks" className="scroll-mt-20">
        <Badge variant="outline">Monitoring → Settings → Webhooks</Badge>
        <h2 className="mt-3 text-2xl font-semibold">Signed webhooks</h2>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          Deliver public-safe trust changes with HMAC-SHA256 signatures. HTTPS,
          DNS pinning, private-network blocking, bounded retries, and one-time
          secrets are enforced server-side.
        </p>
      </div>

      {error ? (
        <Card className="border-destructive/30">
          <CardContent className="p-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader><CardTitle>Create webhook</CardTitle></CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <div className="grid gap-2">
            <Label htmlFor="webhook-name">Name</Label>
            <Input id="webhook-name" value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="webhook-url">Public HTTPS endpoint</Label>
            <Input
              id="webhook-url"
              value={endpointUrl}
              onChange={(event) => setEndpointUrl(event.target.value)}
              placeholder="https://example.com/veyra-events"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="webhook-profile">Trust Profile</Label>
            <select
              id="webhook-profile"
              value={profileId}
              onChange={(event) => setProfileId(event.target.value)}
              className="h-10 rounded-md border bg-background px-3 text-sm"
            >
              {watchlists.map((watchlist) => (
                <option key={watchlist.profileId} value={watchlist.profileId}>
                  {watchlist.label} · {watchlist.profileId}
                </option>
              ))}
            </select>
          </div>
          <div className="md:col-span-3">
            <Button
              onClick={createWebhook}
              disabled={busy === "create" || !profileId || !endpointUrl}
            >
              {busy === "create" ? <LoaderCircle className="animate-spin" /> : <Webhook />}
              Create signed webhook
            </Button>
          </div>
        </CardContent>
      </Card>

      {secret ? (
        <Card className="border-amber-400/30 bg-amber-400/5">
          <CardContent className="grid gap-3 p-5">
            <p className="font-semibold text-amber-300">
              Secret shown once — copy it now
            </p>
            <code className="break-all rounded bg-black/40 p-3 text-xs">{secret}</code>
            <Button
              variant="outline"
              className="w-fit"
              onClick={() => void navigator.clipboard.writeText(secret).catch(() => undefined)}
            >
              <Copy /> Copy secret
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4">
        {webhooks.map((webhook) => (
          <Card key={webhook.id}>
            <CardContent className="grid gap-4 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold">{webhook.name}</h3>
                    <Badge variant={webhook.status === "active" ? "default" : "outline"}>
                      {webhook.status}
                    </Badge>
                  </div>
                  <p className="mt-2 font-mono text-xs text-muted-foreground">
                    {webhook.endpointDomain} · {webhook.id}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Profiles: {webhook.profileIds.join(", ")}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => test(webhook)} disabled={busy === webhook.id}>
                    <Send /> Send test
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      patch(webhook, {
                        status: webhook.status === "active" ? "paused" : "active",
                      })
                    }
                    disabled={busy === webhook.id}
                  >
                    {webhook.status === "active" ? <Pause /> : <Play />}
                    {webhook.status === "active" ? "Pause" : "Resume"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => rotate(webhook)} disabled={busy === webhook.id}>
                    <RotateCw /> Rotate secret
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => remove(webhook)} disabled={busy === webhook.id}>
                    <Trash2 /> Delete
                  </Button>
                </div>
              </div>
              <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                <p>Last success: {webhook.lastSuccessfulDelivery ? new Date(webhook.lastSuccessfulDelivery).toLocaleString() : "—"}</p>
                <p>Last final failure: {webhook.lastFailedDelivery ? new Date(webhook.lastFailedDelivery).toLocaleString() : "—"}</p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="w-fit"
                onClick={() => showDeliveries(webhook)}
                disabled={busy === `deliveries:${webhook.id}`}
              >
                <KeyRound /> View deliveries
              </Button>
              {deliveries[webhook.id] ? (
                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full min-w-[680px] text-left text-xs">
                    <thead className="bg-secondary/40">
                      <tr>
                        <th className="p-3">Event</th>
                        <th className="p-3">Attempt</th>
                        <th className="p-3">HTTP</th>
                        <th className="p-3">Duration</th>
                        <th className="p-3">Status</th>
                        <th className="p-3">Retry</th>
                      </tr>
                    </thead>
                    <tbody>
                      {deliveries[webhook.id].map((delivery) => (
                        <tr key={delivery.id} className="border-t">
                          <td className="p-3">{delivery.eventType}</td>
                          <td className="p-3">{delivery.attemptNumber}</td>
                          <td className="p-3">{delivery.httpStatus ?? "—"}</td>
                          <td className="p-3">{delivery.durationMs ?? "—"} ms</td>
                          <td className="p-3">{delivery.status}</td>
                          <td className="p-3">{delivery.nextRetryAt ? new Date(delivery.nextRetryAt).toLocaleString() : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}
