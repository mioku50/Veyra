/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { BRAND } from "@/lib/brand";
import { INTEREST_CATALOG, MAX_INTERESTS } from "@/lib/nova/interests";
import type { NovaBrief, NovaSignal } from "@/lib/nova/types";

/**
 * The personal agent, and the front door.
 *
 * Deliberately not a dashboard. Veyra's other screens are built from cards,
 * badges and panels because they answer many questions at once; this one
 * answers a single question every morning -- what changed, and is any of it
 * worth a cent -- so it reads top to bottom in one column.
 *
 * Two rules it keeps.
 *
 * Every number can be opened. "3 worth your attention" and "4 held back as
 * noise" are both backed by rows, and the noise expands, because a filtering
 * claim nobody can check is only a claim about how clever the filter is.
 *
 * Machine values are set in monospace and prose is not. A price, an address or
 * a state is something a person may need to compare character by character; a
 * sentence is not. Mixing the two typefaces is how you tell them apart without
 * a legend.
 */

const STORAGE = { id: "veyra.nova.id", key: "veyra.nova.key" } as const;

type Stage = "loading" | "create" | "working" | "brief";

function readStored(): { publicId: string; ownerSecret: string } | null {
  try {
    const publicId = window.localStorage.getItem(STORAGE.id);
    const ownerSecret = window.localStorage.getItem(STORAGE.key);
    return publicId && ownerSecret ? { publicId, ownerSecret } : null;
  } catch {
    // Private windows and blocked site data are a normal state, not an error.
    return null;
  }
}

const RELEVANCE_CHIP: Record<NovaSignal["relevance"], { label: string; className: string }> = {
  high: { label: "high relevance", className: "border-state-warn/40 bg-state-warn/10 text-state-warn" },
  medium: { label: "worth reading", className: "border-primary/40 bg-primary/10 text-primary" },
  low: { label: "low relevance", className: "border-border bg-muted/40 text-muted-foreground" },
  noise: { label: "noise", className: "border-border bg-muted/40 text-muted-foreground" },
};

/** The capability a signal's subject settles under, handed to Veyra's selection
 *  flow so a person is not asked to retype a question Nova already framed. */
function investigationLink(signal: NovaSignal): string {
  const subject = signal.evidence?.subject as Record<string, unknown> | undefined;
  const capability = typeof subject?.capability === "string" ? subject.capability : null;
  const params = new URLSearchParams({ intent: `${signal.headline}. ${signal.detail}`.slice(0, 300) });
  if (capability) params.set("capability", capability);
  return `/run?${params.toString()}`;
}

function timeAgo(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

export function NovaClient() {
  const [stage, setStage] = useState<Stage>("loading");
  const [identity, setIdentity] = useState<{ publicId: string; ownerSecret: string } | null>(null);
  const [brief, setBrief] = useState<NovaBrief | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showNoise, setShowNoise] = useState(false);

  const [name, setName] = useState("Nova");
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const call = useCallback(async (
    path: string,
    init: RequestInit & { ownerSecret?: string } = {},
  ) => {
    const { ownerSecret, ...rest } = init;
    const response = await fetch(path, {
      ...rest,
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        ...(ownerSecret ? { "x-nova-key": ownerSecret } : {}),
        ...(rest.headers ?? {}),
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error?.message ?? "Nova could not be reached.");
    return payload;
  }, []);

  const loadBrief = useCallback(async (who: { publicId: string; ownerSecret: string }) => {
    const payload = await call(
      `/api/nova/v1/agents/${who.publicId}/brief?hour=${new Date().getHours()}`,
      { ownerSecret: who.ownerSecret },
    ) as NovaBrief;
    setBrief(payload);
    setStage("brief");
  }, [call]);

  useEffect(() => {
    const stored = readStored();
    if (!stored) {
      setStage("create");
      return;
    }
    setIdentity(stored);
    loadBrief(stored).catch((cause: Error) => {
      /* An agent this browser remembers but the server does not is a dead end a
         person cannot reload their way out of, so the local record goes and
         they land on the create screen rather than on an error forever. */
      try {
        window.localStorage.removeItem(STORAGE.id);
        window.localStorage.removeItem(STORAGE.key);
      } catch { /* nothing to clean up */ }
      setError(cause.message);
      setStage("create");
    });
  }, [loadBrief]);

  const toggleInterest = (label: string) => {
    setChosen((current) => current.includes(label)
      ? current.filter((entry) => entry !== label)
      : current.length >= MAX_INTERESTS ? current : [...current, label]);
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await call("/api/nova/v1/agents", {
        method: "POST",
        body: JSON.stringify({ name, interests: chosen }),
      }) as { agent: { publicId: string }; ownerSecret: string };

      const who = { publicId: created.agent.publicId, ownerSecret: created.ownerSecret };
      try {
        window.localStorage.setItem(STORAGE.id, who.publicId);
        window.localStorage.setItem(STORAGE.key, who.ownerSecret);
      } catch {
        setError("This browser will not remember your agent, so keep this tab open.");
      }
      setIdentity(who);
      setStage("working");

      await call(`/api/nova/v1/agents/${who.publicId}/refresh`, {
        method: "POST",
        ownerSecret: who.ownerSecret,
        body: JSON.stringify({ trigger: "creation" }),
      });
      await loadBrief(who);
    } catch (cause) {
      setError((cause as Error).message);
      setStage("create");
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    if (!identity) return;
    setBusy(true);
    setError(null);
    const previous = stage;
    setStage("working");
    try {
      await call(`/api/nova/v1/agents/${identity.publicId}/refresh`, {
        method: "POST",
        ownerSecret: identity.ownerSecret,
        body: JSON.stringify({ trigger: "manual" }),
      });
      await loadBrief(identity);
    } catch (cause) {
      setError((cause as Error).message);
      setStage(previous);
    } finally {
      setBusy(false);
    }
  };

  const mark = async (signalId: string, status: "seen" | "dismissed") => {
    if (!identity || !brief) return;
    // Removed locally first: a dismissal that waits for a round trip feels like
    // it did not register, and the server is the record either way.
    setBrief({
      ...brief,
      worthAttention: brief.worthAttention.filter((signal) => signal.signalId !== signalId),
    });
    try {
      await call(`/api/nova/v1/agents/${identity.publicId}/signals/${signalId}`, {
        method: "PATCH",
        ownerSecret: identity.ownerSecret,
        body: JSON.stringify({ status }),
      });
    } catch {
      /* A failed dismissal reappears in the next brief, which is the honest
         outcome: it was not recorded, so it should not look as though it was. */
    }
  };

  if (stage === "loading") {
    return (
      <Shell>
        <Panel>
          <Label>Starting</Label>
          <p className="mt-3 text-sm text-muted-foreground">Looking for your agent…</p>
        </Panel>
      </Shell>
    );
  }

  if (stage === "create") {
    return (
      <Shell>
        <header className="mb-8">
          <Label>Create your agent</Label>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
            An agent that watches so you do not have to.
          </h1>
          <p className="mt-4 max-w-xl text-sm leading-relaxed text-muted-foreground">
            It reads the agent economy every day and brings back what moved. It never spends
            anything without asking you first.
          </p>
        </header>

        {error ? <Notice tone="error">{error}</Notice> : null}

        <Panel>
          <Label>Name</Label>
          <input
            id="nova-name"
            aria-label="Agent name"
            value={name}
            maxLength={40}
            onChange={(event) => setName(event.target.value)}
            className="field mt-3 w-full max-w-xs rounded-lg px-3 py-2.5 font-mono text-base outline-none transition"
          />

          <div className="mt-8">
            <Label>What should {name.trim() || "it"} care about?</Label>
            <p className="mt-2 text-xs text-muted-foreground">
              Pick up to <span className="font-mono">{MAX_INTERESTS}</span>.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {INTEREST_CATALOG.map((interest) => {
                const active = chosen.includes(interest.label);
                return (
                  <button
                    key={interest.id}
                    type="button"
                    onClick={() => toggleInterest(interest.label)}
                    aria-pressed={active}
                    className={`rounded-lg px-4 py-2 text-sm transition ${
                      active
                        ? "border border-primary bg-primary/25 text-foreground"
                        : "field text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {interest.label}
                  </button>
                );
              })}
            </div>
          </div>

          <button
            type="button"
            onClick={create}
            disabled={busy || chosen.length === 0 || !name.trim()}
            className="mt-8 w-full rounded-lg bg-primary py-3 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Creating…" : `Create ${name.trim() || "agent"}`}
          </button>
        </Panel>

        <p className="mt-6 max-w-xl text-xs leading-relaxed text-muted-foreground">
          No account and no wallet. Your agent is remembered by this browser alone, which also
          means clearing this browser loses it.
        </p>

        <Footer />
      </Shell>
    );
  }

  if (stage === "working") {
    return (
      <Shell>
        <Panel>
          <div className="flex items-center gap-2">
            <span className="size-2 animate-pulse rounded-full bg-state-good" />
            <Label>Working</Label>
          </div>
          <h1 className="mt-4 text-2xl font-semibold tracking-tight">
            {brief?.agent.name ?? name} is looking…
          </h1>
          <p className="mt-3 max-w-lg text-sm leading-relaxed text-muted-foreground">
            Reading Circle&rsquo;s x402 catalog and public repository activity, then comparing it
            against what was there last time.
          </p>
        </Panel>
      </Shell>
    );
  }

  if (!brief) {
    return <Shell><Panel><p className="text-sm text-muted-foreground">No brief yet.</p></Panel></Shell>;
  }

  const ignores = brief.memory.filter((entry) => entry.kind === "preference" && entry.facet === "usually_ignores");
  const learnings = brief.memory.filter((entry) => entry.kind === "learning");
  const attention = brief.worthAttention;
  const blind = brief.lastRefresh?.sourcesUnavailable ?? [];

  return (
    <Shell>
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-state-good" />
            <Label>{brief.agent.name}</Label>
          </div>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight">{brief.greeting}.</h1>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            {attention.length > 0
              ? <>Found <span className="font-mono text-foreground">{attention.length}</span> {attention.length === 1 ? "thing" : "things"} worth your attention.</>
              : blind.length > 0
                ? <>Could not reach {blind.join(" and ")}, so this is an incomplete look rather than a quiet day.</>
                : <>Nothing moved across the <span className="font-mono text-foreground">{brief.lastRefresh?.subjectsChecked ?? 0}</span> things being watched for you.</>}
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={busy}
          className="rounded-lg border border-border bg-card/60 px-4 py-2 text-sm text-muted-foreground transition hover:border-primary/50 hover:text-foreground disabled:opacity-40"
        >
          {busy ? "Looking…" : "Look again"}
        </button>
      </header>

      {error ? <Notice tone="error">{error}</Notice> : null}
      {blind.length > 0 && attention.length > 0 ? (
        <Notice tone="warn">
          Could not reach {blind.join(" and ")} this time. What is below is real, but it is not
          everything.
        </Notice>
      ) : null}

      <div className="space-y-4">
        {attention.map((signal) => {
          const chip = RELEVANCE_CHIP[signal.relevance];
          return (
            <Panel key={signal.signalId}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className={`rounded-md border px-2 py-0.5 font-mono text-[11px] ${chip.className}`}>
                  {chip.label}
                </span>
                {signal.interest ? <Label>{signal.interest}</Label> : null}
                <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                  {timeAgo(signal.observedAt)}
                </span>
              </div>

              <h2 className="mt-3 text-lg font-medium leading-snug">{signal.headline}</h2>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{signal.detail}</p>

              <p className="mt-4 border-t border-border/60 pt-3 text-xs text-muted-foreground">
                <span className="font-mono text-[11px] uppercase tracking-wider">why</span>
                {"  "}{signal.relevanceReason}
              </p>

              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Link
                  href={investigationLink(signal)}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90"
                >
                  Let {brief.agent.name} investigate
                </Link>
                <button
                  type="button"
                  onClick={() => mark(signal.signalId, "dismissed")}
                  className="text-sm text-muted-foreground transition hover:text-foreground"
                >
                  Not interesting
                </button>
              </div>
            </Panel>
          );
        })}
      </div>

      {brief.lastRefresh ? (
        <Panel className="mt-4">
          <Label>{brief.lastRefresh.trigger === "creation" ? "First look" : "While you were away"}</Label>
          <dl className="mt-4 space-y-0">
            <Row label="Things checked" value={String(brief.lastRefresh.subjectsChecked)} />
            <Row label="Worth your attention" value={String(brief.lastRefresh.signalsKept)} />
            <Row label="Held back as noise" value={String(brief.lastRefresh.signalsAsNoise)} />
            {blind.length > 0 ? (
              <Row label="Could not read" value={blind.join(", ")} tone="warn" />
            ) : null}
          </dl>
          {brief.noise.length > 0 ? (
            <>
              <button
                type="button"
                onClick={() => setShowNoise((value) => !value)}
                className="mt-4 text-sm text-link underline underline-offset-4"
              >
                {showNoise ? "Hide what was held back" : "Show what was held back"}
              </button>
              {showNoise ? (
                <ul className="mt-3 space-y-2 border-t border-border/60 pt-3">
                  {brief.noise.map((signal) => (
                    <li key={signal.signalId} className="text-sm text-muted-foreground">
                      {signal.headline}
                      <span className="text-muted-foreground/70"> — {signal.relevanceReason}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : null}
        </Panel>
      ) : null}

      <Panel className="mt-4">
        <Label>What {brief.agent.name} knows about you</Label>
        <dl className="mt-4 space-y-0">
          <Row label="You care about" value={brief.agent.interests.join(" · ")} />
          {ignores.length > 0 ? (
            <Row label="You usually ignore" value={ignores.map((entry) => entry.summary).join(" · ")} />
          ) : null}
          {learnings.length > 0 ? (
            <Row label={`Verified by ${BRAND.name}`} value={`${learnings.length}`} tone="good" />
          ) : null}
        </dl>
        {ignores.length === 0 && learnings.length === 0 ? (
          <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
            Nothing learned yet. Dismissing what you do not want teaches it what to hold back.
          </p>
        ) : null}
      </Panel>

      <Standing brief={brief} />
      <Footer />
    </Shell>
  );
}

/**
 * The identity offer, and why it is not on the first screen.
 *
 * An ERC-8004 identity registered at signup records that an account was
 * created. Offered here, after a paid investigation Veyra decided and whose
 * outcome was observed, it points at a history -- which is the only thing that
 * makes a reputation worth reading.
 */
function Standing({ brief }: { brief: NovaBrief }) {
  const { standing, agent } = brief;

  if (agent.arcIdentityAddress) {
    return (
      <Panel className="mt-4">
        <Label>Arc identity</Label>
        <p className="mt-3 break-all font-mono text-sm text-foreground">{agent.arcIdentityAddress}</p>
      </Panel>
    );
  }

  const steps = [
    { label: "Verified research", value: standing.verifiedResearch },
    { label: `${BRAND.name} decision`, value: standing.veyraDecisions },
    { label: "Observed outcome", value: standing.observedOutcomes },
  ];

  return (
    <Panel className="mt-4">
      <Label>{standing.readyForArcIdentity ? "Ready for an Arc identity" : "On the way to an Arc identity"}</Label>
      <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
        {standing.readyForArcIdentity
          ? `${agent.name} has a history to point at. Registering on Arc now records something that already happened.`
          : `${agent.name} can be registered on Arc once there is something for that identity to point at.`}
      </p>
      <dl className="mt-4 space-y-0">
        {steps.map((step) => (
          <Row
            key={step.label}
            label={step.label}
            value={String(step.value)}
            tone={step.value > 0 ? "good" : "idle"}
          />
        ))}
      </dl>
    </Panel>
  );
}

/* ---- the pieces ---- */

/** A machine value against its name, hairline-separated. Values are monospace
 *  because they are meant to be compared, not read. */
function Row({
  label,
  value,
  tone = "plain",
}: {
  label: string;
  value: string;
  tone?: "plain" | "good" | "warn" | "idle";
}) {
  const toneClass = tone === "good"
    ? "text-state-good"
    : tone === "warn"
      ? "text-state-warn"
      : tone === "idle"
        ? "text-state-idle"
        : "text-foreground";
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/50 py-2.5 last:border-b-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className={`text-right font-mono text-sm ${toneClass}`}>{value}</dd>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
      {children}
    </span>
  );
}

function Panel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <section className={`panel-glow rounded-xl p-5 sm:p-6 ${className}`}>
      {children}
    </section>
  );
}

function Notice({ tone, children }: { tone: "error" | "warn"; children: React.ReactNode }) {
  return (
    <p className={`mb-4 rounded-lg border px-4 py-3 text-sm ${
      tone === "error"
        ? "border-destructive/40 bg-destructive/10 text-destructive"
        : "border-state-warn/40 bg-state-warn/10 text-state-warn"
    }`}>
      {children}
    </p>
  );
}

/** One line at the bottom. The navigation lives in the top bar the shell
 *  provides; repeating it here would be the sprawl coming back in through a
 *  different door. */
function Footer() {
  return (
    <footer className="mt-10 border-t border-border pt-6 text-xs text-muted-foreground">
      <span className="font-mono">{BRAND.name}</span> decides what is worth paying for. Circle pays.
    </footer>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-3xl px-5 py-10 sm:px-6 sm:py-12">{children}</div>
  );
}
