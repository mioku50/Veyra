/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { INTEREST_CATALOG, MAX_INTERESTS } from "@/lib/nova/interests";
import type { NovaBrief, NovaSignal } from "@/lib/nova/types";

/**
 * The personal agent, and the front door.
 *
 * This page is deliberately not a dashboard. Veyra's other screens are built
 * from cards, badges and panels because they answer many different questions;
 * this one answers a single question every morning -- what changed, and is any
 * of it worth a cent -- so it is one column of text with hairlines between
 * items, and exactly one prominent action.
 *
 * What a person is never shown: a number they cannot open. Every count here
 * ("3 worth your attention", "4 ignored as noise") is backed by rows, and the
 * noise is expandable, because a filtering claim nobody can check is just a
 * claim about how clever the filter is.
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

function relevanceLabel(relevance: NovaSignal["relevance"]): string {
  switch (relevance) {
    case "high": return "High relevance";
    case "medium": return "Worth reading";
    case "low": return "Low relevance";
    default: return "Noise";
  }
}

/** The capability a signal's subject settles under, used to hand Veyra's
 *  selection flow a head start rather than making a person retype the question. */
function investigationLink(signal: NovaSignal): string | null {
  const subject = signal.evidence?.subject as Record<string, unknown> | undefined;
  const capability = typeof subject?.capability === "string" ? subject.capability : null;
  const intent = `${signal.headline}. ${signal.detail}`.slice(0, 300);
  const params = new URLSearchParams({ intent });
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
  return days === 1 ? "yesterday" : `${days} days ago`;
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
    if (!response.ok) {
      throw new Error(payload?.error?.message ?? "Nova could not be reached.");
    }
    return payload;
  }, []);

  const loadBrief = useCallback(async (who: { publicId: string; ownerSecret: string }) => {
    const hour = new Date().getHours();
    const payload = await call(
      `/api/nova/v1/agents/${who.publicId}/brief?hour=${hour}`,
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
      /* An agent this browser remembers but the server does not is a dead end
         a person cannot escape by reloading, so the local record is cleared and
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
    // Removed locally first: a dismissal that waits for a round trip feels
    // like it did not register, and the server is the record either way.
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
      // A failed dismissal reappears on the next brief, which is the honest
      // outcome: it was not recorded, so it should not look as if it was.
    }
  };

  if (stage === "loading") {
    return <Shell><p className="text-sm text-muted-foreground">Looking for your agent…</p></Shell>;
  }

  if (stage === "create") {
    return (
      <Shell>
        <header className="mb-10">
          <p className="mb-3 text-xs uppercase tracking-[0.2em] text-muted-foreground">Create your agent</p>
          <h1 className="text-3xl font-semibold tracking-tight">An agent that watches so you do not have to.</h1>
          <p className="mt-3 max-w-lg text-sm leading-relaxed text-muted-foreground">
            It reads the agent economy every day and brings back what moved. It never spends
            anything without asking you first.
          </p>
        </header>

        {error ? <Notice tone="error">{error}</Notice> : null}

        <label className="block text-sm font-medium" htmlFor="nova-name">Name</label>
        <input
          id="nova-name"
          value={name}
          maxLength={40}
          onChange={(event) => setName(event.target.value)}
          className="mt-2 w-full max-w-xs rounded-lg border border-border bg-card px-3 py-2 text-lg outline-none focus:border-primary"
        />

        <p className="mt-8 text-sm font-medium">What should {name.trim() || "your agent"} care about?</p>
        <p className="mt-1 text-xs text-muted-foreground">Pick up to {MAX_INTERESTS}.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          {INTEREST_CATALOG.map((interest) => {
            const active = chosen.includes(interest.label);
            return (
              <button
                key={interest.id}
                type="button"
                onClick={() => toggleInterest(interest.label)}
                aria-pressed={active}
                className={`rounded-full border px-4 py-2 text-sm transition ${
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border text-foreground hover:border-primary/60"
                }`}
              >
                {interest.label}
              </button>
            );
          })}
        </div>

        <button
          type="button"
          onClick={create}
          disabled={busy || chosen.length === 0 || !name.trim()}
          className="mt-10 rounded-lg bg-primary px-6 py-3 text-sm font-medium text-primary-foreground disabled:opacity-40"
        >
          {busy ? "Creating…" : `Create ${name.trim() || "agent"}`}
        </button>

        <p className="mt-6 max-w-lg text-xs leading-relaxed text-muted-foreground">
          No account and no wallet. Your agent is remembered by this browser alone, which also
          means clearing this browser loses it.
        </p>
      </Shell>
    );
  }

  if (stage === "working") {
    return (
      <Shell>
        <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Working</p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">
          {brief?.agent.name ?? name} is looking…
        </h1>
        <p className="mt-3 max-w-lg text-sm leading-relaxed text-muted-foreground">
          Reading Circle&rsquo;s x402 catalog and public repository activity, then comparing it
          against what was there last time.
        </p>
      </Shell>
    );
  }

  if (!brief) return <Shell><p className="text-sm text-muted-foreground">No brief yet.</p></Shell>;

  const cares = brief.memory.filter((entry) => entry.kind === "preference" && entry.facet === "cares_about");
  const ignores = brief.memory.filter((entry) => entry.kind === "preference" && entry.facet === "usually_ignores");
  const learnings = brief.memory.filter((entry) => entry.kind === "learning");
  const attention = brief.worthAttention;
  const blind = brief.lastRefresh?.sourcesUnavailable ?? [];

  return (
    <Shell>
      <header className="mb-10 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{brief.greeting}.</h1>
          <p className="mt-2 text-base text-muted-foreground">
            {attention.length > 0
              ? `${brief.agent.name} found ${attention.length} ${attention.length === 1 ? "thing" : "things"} worth your attention.`
              : blind.length > 0
                ? `${brief.agent.name} could not reach ${blind.join(" and ")}, so this is an incomplete look rather than a quiet day.`
                : `Nothing moved across the ${brief.lastRefresh?.subjectsChecked ?? 0} things ${brief.agent.name} watches for you.`}
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={busy}
          className="rounded-lg border border-border px-4 py-2 text-sm text-muted-foreground transition hover:border-primary/60 hover:text-foreground disabled:opacity-40"
        >
          {busy ? "Looking…" : "Look again"}
        </button>
      </header>

      {error ? <Notice tone="error">{error}</Notice> : null}
      {blind.length > 0 && attention.length > 0 ? (
        <Notice tone="warn">
          {brief.agent.name} could not reach {blind.join(" and ")} this time. What is below is
          real, but it is not everything.
        </Notice>
      ) : null}

      <ol className="border-t border-border">
        {attention.map((signal) => (
          <li key={signal.signalId} className="border-b border-border py-6">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              {signal.subjectLabel ? (
                <span className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
                  {signal.interest ?? signal.subjectLabel}
                </span>
              ) : null}
              <span className="text-xs text-muted-foreground">{timeAgo(signal.observedAt)}</span>
            </div>

            <h2 className="mt-2 text-lg font-medium leading-snug">{signal.headline}</h2>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{signal.detail}</p>

            <p className="mt-3 text-xs text-muted-foreground">
              <span className="text-foreground/80">{relevanceLabel(signal.relevance)}</span>
              {" — "}{signal.relevanceReason}
            </p>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              {investigationLink(signal) ? (
                <Link
                  href={investigationLink(signal) as string}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
                >
                  Let {brief.agent.name} investigate
                </Link>
              ) : null}
              <button
                type="button"
                onClick={() => mark(signal.signalId, "dismissed")}
                className="text-sm text-muted-foreground underline-offset-4 hover:underline"
              >
                Not interesting
              </button>
            </div>
          </li>
        ))}
      </ol>

      {brief.lastRefresh ? (
        <section className="mt-10">
          <h3 className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
            {brief.lastRefresh.trigger === "creation" ? "First look" : "While you were away"}
          </h3>
          <p className="mt-3 text-sm text-muted-foreground">
            {brief.lastRefresh.subjectsChecked} things checked
            {" · "}{brief.lastRefresh.signalsKept} worth your attention
            {" · "}{brief.lastRefresh.signalsAsNoise} held back as noise
          </p>
          {brief.noise.length > 0 ? (
            <>
              <button
                type="button"
                onClick={() => setShowNoise((value) => !value)}
                className="mt-2 text-sm text-muted-foreground underline underline-offset-4"
              >
                {showNoise ? "Hide what was held back" : "Show what was held back"}
              </button>
              {showNoise ? (
                <ul className="mt-3 space-y-2">
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
        </section>
      ) : null}

      {(cares.length > 0 || ignores.length > 0 || learnings.length > 0) ? (
        <section className="mt-10 border-t border-border pt-8">
          <h3 className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
            What {brief.agent.name} knows about you
          </h3>
          {cares.length > 0 ? (
            <Knows title="You care about" entries={cares.map((entry) => entry.summary)} />
          ) : (
            <Knows title="You care about" entries={brief.agent.interests} />
          )}
          {ignores.length > 0 ? (
            <Knows title="You usually ignore" entries={ignores.map((entry) => entry.summary)} />
          ) : null}
          {learnings.length > 0 ? (
            <Knows title="Verified by Veyra" entries={learnings.map((entry) => entry.summary)} />
          ) : null}
        </section>
      ) : (
        <section className="mt-10 border-t border-border pt-8">
          <h3 className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
            What {brief.agent.name} knows about you
          </h3>
          <Knows title="You care about" entries={brief.agent.interests} />
          <p className="mt-4 text-xs text-muted-foreground">
            Nothing learned yet. Dismissing things you do not want teaches it what to hold back.
          </p>
        </section>
      )}

      <Standing brief={brief} />

      <footer className="mt-12 border-t border-border pt-6 text-xs text-muted-foreground">
        <Link href="/run" className="underline underline-offset-4">
          Advanced: choose and pay a counterparty yourself
        </Link>
      </footer>
    </Shell>
  );
}

/**
 * The identity offer, and why it is not on the first screen.
 *
 * An ERC-8004 identity registered at signup records that an account was
 * created. Offered here, after a paid investigation that Veyra decided and
 * whose outcome was observed, it points at a history -- which is the only thing
 * that makes a reputation worth reading.
 */
function Standing({ brief }: { brief: NovaBrief }) {
  const { standing, agent } = brief;
  if (agent.arcIdentityAddress) {
    return (
      <section className="mt-10 border-t border-border pt-8">
        <h3 className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Arc identity</h3>
        <p className="mt-3 font-mono text-sm">{agent.arcIdentityAddress}</p>
      </section>
    );
  }

  const done = [
    { label: "verified research", value: standing.verifiedResearch },
    { label: "Veyra decision", value: standing.veyraDecisions },
    { label: "observed outcome", value: standing.observedOutcomes },
  ];

  return (
    <section className="mt-10 border-t border-border pt-8">
      <h3 className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
        {standing.readyForArcIdentity ? "Ready for an Arc identity" : "On the way to an Arc identity"}
      </h3>
      <p className="mt-3 max-w-lg text-sm leading-relaxed text-muted-foreground">
        {standing.readyForArcIdentity
          ? `${agent.name} has a history to point at. Registering on Arc now records something that already happened.`
          : `${agent.name} can be registered on Arc once there is something for that identity to point at.`}
      </p>
      <ul className="mt-4 space-y-1 text-sm">
        {done.map((entry) => (
          <li key={entry.label} className={entry.value > 0 ? "text-foreground" : "text-muted-foreground"}>
            {entry.value > 0 ? "✓" : "○"} {entry.value} {entry.label}{entry.value === 1 ? "" : "s"}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Knows({ title, entries }: { title: string; entries: string[] }) {
  if (entries.length === 0) return null;
  return (
    <div className="mt-4">
      <p className="text-sm text-muted-foreground">{title}:</p>
      <ul className="mt-1 space-y-1">
        {entries.map((entry) => (
          <li key={entry} className="text-sm">• {entry}</li>
        ))}
      </ul>
    </div>
  );
}

function Notice({ tone, children }: { tone: "error" | "warn"; children: React.ReactNode }) {
  return (
    <p className={`mb-6 rounded-lg border px-4 py-3 text-sm ${
      tone === "error"
        ? "border-destructive/40 text-destructive"
        : "border-border text-muted-foreground"
    }`}>
      {children}
    </p>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto w-full max-w-2xl px-5 py-14 sm:px-6 sm:py-20">{children}</div>
    </main>
  );
}
