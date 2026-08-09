"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Copy, KeyRound, RefreshCw, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { BRAND } from "@/lib/brand";

const machineCoreScopes = ["workflows:read", "quotes:create", "runs:create", "results:read"] as const;
const trustAutomationScopes = [
  "alerts:read",
  "alerts:write",
  "webhooks:read",
  "webhooks:write",
] as const;

type AgentSummary = {
  id: string;
  displayName: string;
  publicId: string;
  status: string;
};

type MachineCredential = {
  id: string;
  label: string;
  prefix: string;
  credentialType: "machine_api" | "byoa_workflow";
  scopes: string[];
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
};

async function jsonFetch(path: string, init: RequestInit = {}) {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message = typeof body.error === "string" ? body.error : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return body;
}

export function MachineCredentialsClient() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [credentials, setCredentials] = useState<MachineCredential[]>([]);
  const [oneTimeSecret, setOneTimeSecret] = useState<string | null>(null);
  const [trustAutomation, setTrustAutomation] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) ?? null,
    [agents, selectedAgentId],
  );

  const loadCredentials = useCallback(async (agentId: string) => {
    const body = await jsonFetch(`/api/byoa/management/agents/${agentId}/credentials`);
    setCredentials(
      ((body.credentials ?? []) as MachineCredential[]).filter(
        (credential) => credential.credentialType === "machine_api",
      ),
    );
  }, []);

  const load = useCallback(async () => {
    const session = await jsonFetch("/api/byoa/management/session");
    if (session.authenticated !== true) {
      setAuthenticated(false);
      return;
    }
    setAuthenticated(true);
    const body = await jsonFetch("/api/byoa/management/agents");
    const nextAgents = (body.agents ?? []) as AgentSummary[];
    setAgents(nextAgents);
    setSelectedAgentId((current) => current || nextAgents[0]?.id || "");
  }, []);

  useEffect(() => {
    void load().catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
  }, [load]);

  useEffect(() => {
    setOneTimeSecret(null);
    if (!selectedAgentId) {
      setCredentials([]);
      return;
    }
    void loadCredentials(selectedAgentId).catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
  }, [loadCredentials, selectedAgentId]);

  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function createCredential() {
    if (!selectedAgentId) return;
    await act(async () => {
      const body = await jsonFetch(`/api/byoa/management/agents/${selectedAgentId}/credentials`, {
        method: "POST",
        body: JSON.stringify({
          credentialType: "machine_api",
          label: `${BRAND.agentApi} Credential`,
          scopes: [
            ...machineCoreScopes,
            ...(trustAutomation ? trustAutomationScopes : []),
          ],
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000).toISOString(),
        }),
      });
      setOneTimeSecret(String(body.token));
      await loadCredentials(selectedAgentId);
    });
  }

  async function rotateCredential(credentialId: string) {
    await act(async () => {
      const body = await jsonFetch(
        `/api/byoa/management/agents/${selectedAgentId}/credentials/${credentialId}`,
        { method: "POST", body: "{}" },
      );
      setOneTimeSecret(String(body.token));
      await loadCredentials(selectedAgentId);
    });
  }

  async function revokeCredential(credentialId: string) {
    await act(async () => {
      await jsonFetch(
        `/api/byoa/management/agents/${selectedAgentId}/credentials/${credentialId}`,
        { method: "DELETE" },
      );
      setOneTimeSecret(null);
      await loadCredentials(selectedAgentId);
    });
  }

  if (authenticated === null) {
    return <p className="text-sm text-muted-foreground">Loading credential manager…</p>;
  }

  if (!authenticated) {
    return (
      <div className="rounded-md border p-4 text-sm">
        <p className="font-medium">A verified owner session is required.</p>
        <p className="mt-1 text-muted-foreground">Connect and verify the owner wallet in Agent Credentials first.</p>
        <Button asChild className="mt-3"><Link href="/console/agents">Open Agent Credentials</Link></Button>
      </div>
    );
  }

  return (
    <div className="grid gap-5">
      {error ? (
        <div role="alert" className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <ShieldAlert className="size-4" /> {error}
        </div>
      ) : null}

      <div className="grid gap-2">
        <Label htmlFor="machine-agent">Agent</Label>
        <select
          id="machine-agent"
          value={selectedAgentId}
          onChange={(event) => setSelectedAgentId(event.target.value)}
          className="h-10 rounded-md border bg-background px-3 text-sm"
        >
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>{agent.displayName} · {agent.publicId}</option>
          ))}
        </select>
      </div>

      {agents.length === 0 ? (
        <div className="rounded-md border p-4 text-sm">
          <p className="font-medium">Create an active agent namespace first.</p>
          <p className="mt-1 text-muted-foreground">The namespace owns workflow policy, limits, and all quotes, runs, and reports created by its credential.</p>
          <Button asChild className="mt-3" variant="outline"><Link href="/console/agents">Register agent namespace</Link></Button>
        </div>
      ) : (
        <div className="grid gap-3">
          <label className="flex items-start gap-3 rounded-md border p-3 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={trustAutomation}
              onChange={(event) => setTrustAutomation(event.target.checked)}
            />
            <span>
              <span className="block font-medium">Enable Trust Alerts & Webhooks</span>
              <span className="mt-1 block text-xs text-muted-foreground">
                Explicitly adds alerts:read/write and webhooks:read/write. Existing
                credentials are never upgraded automatically.
              </span>
            </span>
          </label>
          <Button onClick={() => void createCredential()} disabled={busy || selectedAgent?.status !== "active"}>
            <KeyRound className="mr-2 size-4" /> Create {BRAND.agentApi} Credential
          </Button>
        </div>
      )}

      {oneTimeSecret ? (
        <div className="grid gap-2 rounded-md border border-amber-400/40 bg-amber-400/10 p-4 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold text-amber-600">Secret shown once — copy it now</span>
            <Button size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(oneTimeSecret).catch(() => undefined)}>
              <Copy className="mr-1 size-3" /> Copy once
            </Button>
          </div>
          <code className="break-all rounded bg-black/40 p-2 font-mono text-[11px]">{oneTimeSecret}</code>
        </div>
      ) : null}

      <div className="grid gap-3">
        {credentials.map((credential) => (
          <div key={credential.id} className="grid gap-2 rounded-md border p-4 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold">{credential.label} · …{credential.id.slice(-8)}</span>
              <Badge variant={credential.revokedAt ? "destructive" : "outline"}>{credential.revokedAt ? "Revoked" : "Active"}</Badge>
            </div>
            <span className="text-muted-foreground">Created: {new Date(credential.createdAt).toLocaleString()}</span>
            <span className="text-muted-foreground">Expires: {new Date(credential.expiresAt).toLocaleString()}</span>
            <details>
              <summary className="cursor-pointer font-medium">Technical scopes</summary>
              <code className="mt-2 block break-words text-muted-foreground">{credential.scopes.join(", ")}</code>
            </details>
            {!credential.revokedAt ? (
              <div className="mt-1 flex gap-2">
                <Button size="sm" variant="outline" onClick={() => void rotateCredential(credential.id)} disabled={busy}>
                  <RefreshCw className="mr-1 size-3" /> Rotate
                </Button>
                <Button size="sm" variant="destructive" onClick={() => void revokeCredential(credential.id)} disabled={busy}>Revoke</Button>
              </div>
            ) : null}
          </div>
        ))}
      </div>

      <Button asChild variant="outline"><a href="#quickstart">Open TypeScript, Python, and cURL examples</a></Button>
    </div>
  );
}

export function ProductionSmokeInstructions() {
  return (
    <Card className="rounded-lg">
      <CardHeader>
        <CardTitle>Production A/B smoke setup</CardTitle>
        <CardDescription>
          Use two active {BRAND.agentApi} credentials belonging to two different agents. BYOA, same-agent, incomplete-scope, expired, or revoked credentials are rejected by the smoke verifier.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <pre className="overflow-x-auto rounded-md bg-black/80 p-4 text-xs text-zinc-100"><code>{`read -rsp "Credential A: " MACHINE_API_SMOKE_TOKEN_A; echo
read -rsp "Credential B: " MACHINE_API_SMOKE_TOKEN_B; echo
export MACHINE_API_SMOKE_TOKEN_A MACHINE_API_SMOKE_TOKEN_B
npm run machine:production-smoke -- --confirm-production https://YOUR_PRODUCTION_HOST
unset MACHINE_API_SMOKE_TOKEN_A MACHINE_API_SMOKE_TOKEN_B`}</code></pre>
        <p className="text-xs text-muted-foreground">The script never prints secrets and verifies idempotent run replay plus cross-credential 404 isolation.</p>
      </CardContent>
    </Card>
  );
}
