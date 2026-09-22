/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

"use client";

import { READING_RULES, assessmentOf, coverageSentence, paidResearchReadiness, type ValueAssessment } from "@/lib/nova/value";
import { formatUsdc } from "@/lib/execution/presentation";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { encodeFunctionData } from "viem";
import { BRAND } from "@/lib/brand";
import { INTEREST_CATALOG, MAX_INTERESTS } from "@/lib/nova/interests";
import {
  PROJECT_CONTEXT_LIMITS,
  confirmedContext as confirmedProjectContext,
  contextForPrompt,
  proposedContext as proposedProjectContext,
  readAgainst,
  splitStatements,
} from "@/lib/nova/project-context";
/* The same mapping the scorer uses. A third copy would be a third chance for
   the button to offer a ban the scorer does not honour. Null for the kinds
   that are not matters of taste -- a payee change, a rail change, an endpoint
   going dark -- so the button is absent rather than disabled: an offer a
   person cannot take reads as a promise the product is refusing to keep. */
import { categoryPhraseFor } from "@/lib/nova/relevance";
import { priorWith } from "@/lib/nova/standing";
/* The sentences that assert a state live next to the state they assert, so a
   heading cannot go stale against the panel under it. See the module header. */
import {
  agentAccessState, arcIdentityState, arcViewBlurb, briefSummary, identityExplanation,
  identityHeadline, plain, purchaseStanding, purchaseSummary, transferWarning,
  autonomyStateClaim, previewOnlyWarning, shadowDeclineClaims, shadowNightClaim,
  shadowRemainingClaim, shadowSpendClaim, shadowVerdictClaim, publishedAtOf, sinceLastVisit,
  type ArcIdentityState, type Claim,
} from "@/lib/nova/presentation";
import { IDENTITY_REGISTER_ABI, NOVA_IDENTITY_REGISTRY } from "@/lib/nova/identity";
import { PREVIEW_MANDATE, type PreviewMandateTerms } from "@/lib/nova/autonomy-mandate";
import { NOVA_WITHHOLD_REASONS } from "@/lib/nova/types";
import type { NovaBrief, NovaFeedback, NovaInvestigation, NovaMemory, NovaProjectContext, NovaSignal, NovaWithholdReason } from "@/lib/nova/types";
import { NOTE_MAX, NOVA_REASONS, REASON_LABEL, learnedSentence, type NovaLearned, type NovaReason } from "@/lib/nova/verdict";
import { missUrl, type NovaMiss } from "@/lib/nova/misses";
import type { NovaResearchProposal } from "@/lib/nova/research";
import type { TermsChange } from "@/lib/nova/research-terms";
import { useArcWallet } from "@/components/wallet/use-arc-wallet";
import { NoWalletHere } from "@/components/wallet/wallet-app-links";
import { signPaymentAuthorization, type SigningTerms } from "@/lib/x402/sign-payment";

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

function groupWatchlist(signals: NovaSignal[]): Array<[string, NovaSignal[]]> {
  const groups = new Map<string, NovaSignal[]>();
  for (const signal of signals) {
    const source = signal.subjectLabel ?? signal.subjectId ?? signal.signalId;
    const group = groups.get(source) ?? [];
    group.push(signal);
    groups.set(source, group);
  }
  return [...groups];
}

const STORAGE = { id: "veyra.nova.id", key: "veyra.nova.key" } as const;

/**
 * Which part of the agent's life this page is.
 *
 * Four destinations over one set of data, not four products. The brief is what
 * changed today; the other three are what the agent is, what it has learned
 * about the person reading it, and what it has earned on Arc. Splitting them
 * was the point of the rewrite: a single scrolling page made "what Nova knows
 * about you" a footer under the news, which is exactly backwards for the thing
 * that makes the news personal.
 */
export type NovaView = "today" | "agent" | "memory" | "arc";

const VIEW_TITLE: Record<Exclude<NovaView, "today">, string> = {
  agent: "Your agent",
  memory: "What it has learned",
  arc: "Identity & Trust",
};

/* One claim, rendered the way the invariant tests read it. Figures are set
   apart as they always were; what changed is that they now arrive inside the
   sentence instead of being re-derived beside it. */
function Said({ claim }: { claim: Claim }) {
  return (
    <>
      {claim.map((part, index) => (typeof part === "string"
        ? <span key={index}>{part}</span>
        : <span key={index} className="font-mono text-foreground">{part.figure}</span>))}
    </>
  );
}

/* Written in the second person and about the agent, not about the feature. A
   page called Memory that opens by explaining what memory is has described its
   own navigation label back to the reader. */
const VIEW_BLURB: Record<Exclude<NovaView, "today">, (name: string, state: ArcIdentityState) => Claim> = {
  agent: (name) => [`Who ${name} is, what it watches on your behalf, and the key that proves it is yours.`],
  memory: (name) => [`${name} starts from what you told it and changes from what you do. This is the difference so far.`],
  arc: (name, state) => arcViewBlurb(state, name),
};

type Stage = "unavailable" | "loading" | "create" | "working" | "brief";

/**
 * Where one item's investigation has got to.
 *
 * Two of these are results rather than errors, and the difference is the whole
 * product. "refused" is Veyra looking at the market and declining to authorise
 * any of it. "changed" is Veyra stopping between the price somebody read and
 * the signature they were about to give, because the two no longer describe the
 * same purchase.
 *
 * "paid_unverified" is the third. It is what an honest product has instead of
 * rounding a failed check up into a completed one.
 */
type ResearchState =
  | { stage: "looking" }
  | { stage: "ready"; researchId: string; proposal: NovaResearchProposal }
  | { stage: "refused"; detail: string }
  | { stage: "failed"; detail: string; proposal?: NovaResearchProposal; researchId?: string }
  | { stage: "approving"; researchId: string; proposal: NovaResearchProposal }
  | {
      stage: "changed";
      researchId: string;
      proposal: NovaResearchProposal;
      changes: TermsChange[];
      termsHash: string;
      costUsdc: number;
      detail: string;
    }
  | { stage: "signing"; researchId: string; proposal: NovaResearchProposal; terms: SigningTerms | null; note: string | null }
  | { stage: "settling"; researchId: string; proposal: NovaResearchProposal }
  | { stage: "settled"; researchId: string; proposal: NovaResearchProposal; investigation: NovaInvestigation };

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

/**
 * One string a person can keep.
 *
 * An agent is proven by a secret this browser holds; the server stores only its
 * digest and cannot hand it back. So the browser is the single copy, and
 * "remembered by this browser alone" was a promise that clearing site data
 * breaks forever -- worse once a scheduler is running, because the row keeps
 * existing, unreachable, until dormancy retires it.
 *
 * The id and the secret joined by a dot, because two fields to copy is two
 * chances to copy one of them.
 */
function recoveryKeyFor(who: { publicId: string; ownerSecret: string }): string {
  return `${who.publicId}.${who.ownerSecret}`;
}

function parseRecoveryKey(text: string): { publicId: string; ownerSecret: string } | null {
  const trimmed = text.trim();
  const dot = trimmed.indexOf(".");
  if (dot < 0) return null;
  const publicId = trimmed.slice(0, dot);
  const ownerSecret = trimmed.slice(dot + 1);
  // Shape only. Whether it is the right key is the server's answer, and asking
  // it is one request -- guessing here would just be a second, worse, check.
  if (!/^nva_[0-9a-z]{20}$/.test(publicId) || ownerSecret.length < 16) return null;
  return { publicId, ownerSecret };
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

/** Both times a card has: when its source says the thing happened, and when
 *  Nova found it. See publishedAtOf. */
function dateLine(signal: NovaSignal): string {
  const found = `found ${timeAgo(signal.observedAt)}`;
  if (signal.kind !== "official_publication" && signal.kind !== "repository_release") return found;
  const published = publishedAtOf(signal);
  return published
    ? `published ${new Date(published).toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${found}`
    : `publication date unknown · ${found}`;
}

function SinceLastVisit({ signal, seenThrough }: { signal: NovaSignal; seenThrough: string | null }) {
  const change = sinceLastVisit(signal, seenThrough);
  if (!change) return null;
  return (
    <span
      title={change === "new" ? "Found since your last visit" : "Its reading was written again since your last visit"}
      className="rounded-md border border-accent/50 px-2 py-0.5 font-mono text-[11px] text-accent"
    >
      {change}
    </span>
  );
}

/** The start of an absence, read the way a person would say it rather than the
 *  way a log would write it. */
function formatAway(iso: string): string {
  const label = timeAgo(iso);
  return label === "just now" ? "your last visit" : `your last visit ${label}`;
}

/**
 * Why a thing Nova looked at is not in the brief, in the owner's words.
 *
 * Only one of these was ever on the screen. A brief built from a goal holds
 * most of its material back at the significance gate, and a panel that counted
 * relevance alone could report "held back as noise: 0" on a day when
 * twenty-one things were filtered -- a true number doing the work of a false
 * one. "Not read yet" in particular is a coverage gap and not a verdict, which
 * is the distinction that decides whether the answer is patience or a bigger
 * reading budget.
 */
const WITHHELD_LABEL: Record<NovaWithholdReason, (goal: string | null) => string> = {
  noise: () => "Held back as noise",
  background: () => "Background context",
  not_analyzed: (goal) => (goal ? "Not read for your goal yet" : "Waiting for a goal to read it against"),
  not_significant: () => "No significant change for your goal",
  duplicate: () => "Same subject, already shown",
  over_cap: () => "Over today\u2019s cap",
};

export function NovaClient({ view = "today" }: { view?: NovaView } = {}) {
  const [stage, setStage] = useState<Stage>("loading");
  const [identity, setIdentity] = useState<{ publicId: string; ownerSecret: string } | null>(null);
  const [brief, setBrief] = useState<NovaBrief | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [memoryTab, setMemoryTab] = useState<"learned" | "purchases">("learned");
  const [showNoise, setShowNoise] = useState(false);
  const [draftContext, setDraftContext] = useState<string[] | null>(null);
  const [savingContext, setSavingContext] = useState(false);
  const [contextNote, setContextNote] = useState<string | null>(null);

  const [name, setName] = useState("Nova");
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  /* True only for the visit that created the agent. The key is worth
     interrupting someone for once; every visit after that it is a detail they
     can go and find. */
  const [justCreated, setJustCreated] = useState(false);
  const [restoreText, setRestoreText] = useState("");
  const [restoring, setRestoring] = useState(false);
  /* What the person has said about each item on this visit. Useful and Follow
     keep the item on screen -- hiding something you just called useful is the
     opposite of what the word means -- so the card has to show that it landed. */
  const [said, setSaid] = useState<Record<string, NovaFeedback>>({});
  /* What each verdict taught and why it was given, from the server's answer:
     the page says what was learned only once it has been. */
  const [verdicts, setVerdicts] = useState<Record<string, VerdictState>>({});
  /* One entry per item somebody asked Veyra to price. Keyed by signal rather
     than held as a single "current proposal" because pricing takes seconds
     against live endpoints, and a person who asks about two things should get
     two answers rather than watch the first one be replaced. */
  const [research, setResearch] = useState<Record<string, ResearchState>>({});
  /* Editing what the agent watches. Null when nobody is editing, because an
     empty array is a legitimate mid-edit state -- somebody clearing every chip
     before picking new ones -- and the two must not be the same value. */
  /* Claiming an Arc identity: one wallet transaction, then a server that
     refuses to believe the browser about its outcome. */
  const [claiming, setClaiming] = useState(false);
  const [signingMandate, setSigningMandate] = useState(false);
  const [mandateNote, setMandateNote] = useState<string | null>(null);
  const [claimNote, setClaimNote] = useState<string | null>(null);
  const [attesting, setAttesting] = useState(false);
  const [attestNote, setAttestNote] = useState<string | null>(null);
  const [goal, setGoal] = useState("");
  const [draftGoal, setDraftGoal] = useState("");
  const [reading, setReading] = useState<Record<string, boolean>>({});
  const [readNotes, setReadNotes] = useState<Record<string, string>>({});
  const [draftInterests, setDraftInterests] = useState<string[] | null>(null);
  const [savingInterests, setSavingInterests] = useState(false);
  const [interestsNote, setInterestsNote] = useState<string | null>(null);
  /* The owner's own wallet, in their own browser. Nova holds no key and never
     sees one: everything it can do with this is read an address and ask the
     wallet to sign something the person can read first. */
  const wallet = useArcWallet();

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
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "This recovery key was not accepted. Your saved key has been kept." : response.status === 404 ? "This agent was not found. Your recovery key has been kept so you can retry or restore access." : "Nova is temporarily unavailable. Your saved access has been kept.");
    return payload;
  }, []);

  const loadBrief = useCallback(async (who: { publicId: string; ownerSecret: string }) => {
    const payload = await call(
      `/api/nova/v1/agents/${who.publicId}/brief?hour=${new Date().getHours()}`,
      { ownerSecret: who.ownerSecret },
    ) as NovaBrief;
    setBrief(payload);
    /* A result belongs under the card that produced it, including on the next
       morning's visit. Without this the whole flow is a property of one browser
       session: somebody pays, closes the tab, comes back, and the item says
       "Let Nova investigate" as though nothing had ever happened to it. */
    setResearch((current) => {
      const restored: Record<string, ResearchState> = { ...current };
      for (const entry of payload.investigations ?? []) {
        if (current[entry.signalId]) continue;
        const proposal = entry.proposal as unknown as NovaResearchProposal;
        if (!proposal?.provider) continue;
        restored[entry.signalId] = entry.status === "proposed" || entry.status === "approved"
          ? { stage: "ready", researchId: entry.researchId, proposal }
          : { stage: "settled", researchId: entry.researchId, proposal, investigation: entry };
      }
      /* And a refusal belongs there too. Veyra looking and declining is the
         same kind of fact as Veyra looking and pricing -- it cost a round of
         live probes to establish, and forgetting it means paying for that
         round again to be told the same thing, in front of a card that looks
         untouched in the meantime. */
      for (const signal of [...payload.worthAttention, ...payload.noise, ...payload.watchlist]) {
        if (restored[signal.signalId] || !signal.refusal) continue;
        restored[signal.signalId] = { stage: "refused", detail: signal.refusal.detail };
      }
      return restored;
    });
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
      setError(cause.message);
      setStage("unavailable");
    });
  }, [loadBrief]);

  /**
   * Bring an agent back on a browser that has never seen it.
   *
   * Nothing new on the server: the brief endpoint already answers a key that
   * does not match with a 404, so the check that matters is the one request
   * this makes. Storage is written only after that request succeeds, so a
   * mistyped key cannot evict the agent this browser already holds.
   */
  const restore = async () => {
    setRestoring(true);
    setError(null);
    const who = parseRecoveryKey(restoreText);
    if (!who) {
      setError("That does not look like a recovery key. It starts with nva_ and has a dot in it.");
      setRestoring(false);
      return;
    }
    try {
      await loadBrief(who);
      try {
        window.localStorage.setItem(STORAGE.id, who.publicId);
        window.localStorage.setItem(STORAGE.key, who.ownerSecret);
      } catch {
        setError("Restored, but this browser will not remember it. Keep this tab open.");
      }
      setIdentity(who);
      setRestoreText("");
    } catch {
      // The server will not say whether the id exists, and neither will this.
      setError("No agent answers to that key.");
    } finally {
      setRestoring(false);
    }
  };

  const toggleInterest = (label: string) => {
    setChosen((current) => current.includes(label)
      ? current.filter((entry) => entry !== label)
      : current.length >= MAX_INTERESTS ? current : [...current, label]);
  };

  const toggleDraftInterest = (label: string) => {
    setDraftInterests((current) => {
      const list = current ?? [];
      return list.includes(label)
        ? list.filter((entry) => entry !== label)
        : list.length >= MAX_INTERESTS ? list : [...list, label];
    });
  };

  /**
   * Save what the agent should care about, then go and look for it.
   *
   * Two requests on purpose. The save answers immediately and says what it
   * dropped; the refresh re-resolves every subject against the new interests,
   * which is eight or more live reads and belongs behind its own wait. Doing
   * them as one call would leave a person staring at a spinner wondering
   * whether a checkbox had been accepted.
   */
  const saveInterests = async () => {
    if (!identity || !draftInterests || draftInterests.length === 0) return;
    setSavingInterests(true);
    setError(null);
    setInterestsNote(null);
    try {
      const saved = await call(`/api/nova/v1/agents/${identity.publicId}`, {
        method: "PATCH",
        ownerSecret: identity.ownerSecret,
        body: JSON.stringify({ interests: draftInterests, goal: draftGoal }),
      }) as { droppedInterests: string[]; retiredSignals: number };

      setDraftInterests(null);
      if (saved.droppedInterests.length > 0) {
        /* Named, and counted. Dropping an interest takes cards off a screen
           somebody was reading a moment ago, and a disappearance nobody
           announced reads as a bug. */
        setInterestsNote(
          `Stopped watching ${saved.droppedInterests.join(", ")}.`
          + (saved.retiredSignals > 0
            ? ` ${saved.retiredSignals} ${saved.retiredSignals === 1 ? "item" : "items"} left your brief; anything you paid to investigate stayed.`
            : ""),
        );
      }
      await call(`/api/nova/v1/agents/${identity.publicId}/refresh`, {
        method: "POST",
        ownerSecret: identity.ownerSecret,
        body: JSON.stringify({ trigger: "manual" }),
      });
      await loadBrief(identity);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save that.");
    } finally {
      setSavingInterests(false);
    }
  };

  /**
   * The owner's own account of where the work is.
   *
   * Sent as the whole list, because a project fact that stopped being true has
   * to be removable, and an endpoint that could only add would turn the
   * context into a place stale statements accumulate and later readings are
   * judged against.
   */
  const saveProjectContext = async () => {
    if (!identity || draftContext === null) return;
    setSavingContext(true);
    setError(null);
    setContextNote(null);
    try {
      const statements = draftContext.map((statement) => statement.trim()).filter(Boolean);
      const saved = await call(`/api/nova/v1/agents/${identity.publicId}/project-context`, {
        method: "PUT",
        ownerSecret: identity.ownerSecret,
        body: JSON.stringify({ statements }),
      }) as { context: NovaProjectContext[] };
      setDraftContext(null);
      setBrief((current) => (current ? { ...current, projectContext: saved.context } : current));
      /* Then look again. A context nobody sees the effect of is a form, not a
         memory: the pass reconsiders recent events against the new state,
         within the same reading budget. Cards it does not reach keep the
         reading they had, and each one says which state it was read
         against. */
      await call(`/api/nova/v1/agents/${identity.publicId}/refresh`, {
        method: "POST",
        ownerSecret: identity.ownerSecret,
        body: JSON.stringify({ trigger: "manual" }),
      });
      await loadBrief(identity);
      setContextNote("Saved. Nova re-read what it could against this; older readings keep, and name, the state they were judged against.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save your project context.");
    } finally {
      setSavingContext(false);
    }
  };

  /** Answer one of Nova's suggestions. Confirming is the only way an inference
   *  about the project becomes something an assessment may rely on. */
  const answerContextProposal = async (contextId: string, action: "confirm" | "dismiss") => {
    if (!identity) return;
    setError(null);
    setContextNote(null);
    try {
      const saved = await call(`/api/nova/v1/agents/${identity.publicId}/project-context`, {
        method: "POST",
        ownerSecret: identity.ownerSecret,
        body: JSON.stringify({ contextId, action }),
      }) as { context: NovaProjectContext[] };
      setBrief((current) => (current ? { ...current, projectContext: saved.context } : current));
      setContextNote(action === "confirm"
        ? "Added to your project context."
        : "Rejected, and not suggested again.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save that answer.");
    }
  };

  /** Take back one learned preference. Removed from the page on success
   *  only: a preference that is still applied must not look forgotten. */
  const forgetLearned = async (memoryId: string) => {
    if (!identity) return;
    setError(null);
    try {
      await call(`/api/nova/v1/agents/${identity.publicId}/memory/${memoryId}`, {
        method: "DELETE",
        ownerSecret: identity.ownerSecret,
      });
      setBrief((current) => (current ? { ...current, memory: current.memory.filter((entry) => entry.memoryId !== memoryId) } : current));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not forget that.");
    }
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await call("/api/nova/v1/agents", {
        method: "POST",
        body: JSON.stringify({ name, interests: chosen, goal }),
      }) as { agent: { publicId: string }; ownerSecret: string };

      const who = { publicId: created.agent.publicId, ownerSecret: created.ownerSecret };
      try {
        window.localStorage.setItem(STORAGE.id, who.publicId);
        window.localStorage.setItem(STORAGE.key, who.ownerSecret);
      } catch {
        setError("This browser will not remember your agent, so keep this tab open.");
      }
      setIdentity(who);
      setJustCreated(true);
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

  /**
   * The owner's verdict on a decision Nova would have paid for.
   *
   * Deliberately does not reload the brief. The panel keeps its own optimistic
   * state, and refetching would redraw the whole morning under somebody who is
   * halfway through reading it.
   */
  const rateDecision = useCallback(async (
    decisionId: string,
    feedback: "useful" | "not_worth_it",
  ) => {
    if (!identity) return;
    await call(`/api/nova/v1/agents/${identity.publicId}/autonomy/${decisionId}`, {
      method: "PATCH",
      ownerSecret: identity.ownerSecret,
      body: JSON.stringify({ feedback }),
    });
  }, [call, identity]);

  /**
   * Signing the limits Nova rehearses under.
   *
   * Two round trips and one wallet prompt. The server builds the terms and
   * hands back the exact typed data; the wallet shows it; the signature goes
   * back and is verified against the same message rebuilt server-side.
   *
   * No transaction, no approval, no allowance. The wallet is asked for a
   * signature over a document and nothing else, which is why the screen says
   * so before the prompt opens -- MetaMask will show eleven numeric fields and
   * no indication that none of them can be spent.
   */
  const signPreviewMandate = async () => {
    if (!identity) return;
    setMandateNote(null);
    setSigningMandate(true);
    try {
      if (!wallet.address) await wallet.connect();
      if (!wallet.isArcTestnet) await wallet.switchToArc();
      const address = wallet.address;
      if (!address) throw new Error("Connect a wallet to sign these limits.");

      const prepared = await call(`/api/nova/v1/agents/${identity.publicId}/autonomy`, {
        method: "POST",
        ownerSecret: identity.ownerSecret,
        body: JSON.stringify({
          wallet: address,
          /* The browser's own zone. It is what makes the budget day the
             owner's day rather than UTC's, and it is a signed term. */
          budgetTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      }) as {
        terms: PreviewMandateTerms;
        signing: { domain: unknown; types: unknown; primaryType: string; message: unknown };
      };

      const signature = await wallet.signTypedData({
        domain: prepared.signing.domain as never,
        types: prepared.signing.types as never,
        primaryType: prepared.signing.primaryType,
        message: prepared.signing.message as never,
      });

      await call(`/api/nova/v1/agents/${identity.publicId}/autonomy`, {
        method: "PUT",
        ownerSecret: identity.ownerSecret,
        body: JSON.stringify({ terms: prepared.terms, signature }),
      });
      await loadBrief(identity);
    } catch (cause) {
      setMandateNote((cause as Error).message);
    } finally {
      setSigningMandate(false);
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

  /**
   * Asks Veyra what it would cost to look deeper, and who would be paid.
   *
   * Nothing is spent and nothing is authorised. The answer is evidence: a
   * provider, a price, a trust score and a rail, gathered by probing the live
   * endpoints a few seconds ago. The person decides afterwards, or does not.
   */
  const readSources = async (signal: NovaSignal) => {
    if (!identity || reading[signal.signalId]) return;
    setReading(v => ({ ...v, [signal.signalId]: true }));
    setReadNotes(v => ({ ...v, [signal.signalId]: "" }));
    try {
      const result = await call(`/api/nova/v1/agents/${identity.publicId}/signals/${signal.signalId}/read`, {
        method: "POST", ownerSecret: identity.ownerSecret,
        /* The owner pressed a button asking what this event means for the
           project as it stands now. Handing back the stored paragraph would
           answer the question they asked the last time they pressed it. */
        body: JSON.stringify({ reassess: true }),
      }) as { assessment: ValueAssessment };
      // Keep the card in place until reload, so a low-value finding can explain
      // why it was held back instead of disappearing before the owner reads it.
      setBrief(previous => previous ? { ...previous,
        worthAttention: previous.worthAttention.map(s => s.signalId === signal.signalId ? { ...s, evidence: { ...s.evidence, valueAssessment: result.assessment } } : s),
        watchlist: previous.watchlist.map(s => s.signalId === signal.signalId ? { ...s, evidence: { ...s.evidence, valueAssessment: result.assessment } } : s),
      } : previous);
    } catch (cause) { setReadNotes(v => ({ ...v, [signal.signalId]: (cause as Error).message })); }
    finally { setReading(v => ({ ...v, [signal.signalId]: false })); }
  };

  const price = async (signal: NovaSignal) => {
    if (!identity) return;
    setResearch((current) => ({ ...current, [signal.signalId]: { stage: "looking" } }));
    try {
      const payload = await call(
        `/api/nova/v1/agents/${identity.publicId}/signals/${signal.signalId}/research`,
        {
          method: "POST",
          ownerSecret: identity.ownerSecret,
          /* Sent when there is one, so the rail note can be a fact about this
             wallet's Gateway balance rather than an assumption about it. */
          body: JSON.stringify({ wallet: wallet.address ?? undefined }),
        },
      ) as { ok: boolean; researchId?: string; proposal?: NovaResearchProposal; detail?: string };

      setResearch((current) => ({
        ...current,
        [signal.signalId]: payload.ok && payload.proposal && payload.researchId
          ? { stage: "ready", researchId: payload.researchId, proposal: payload.proposal }
          /* Veyra looking and refusing is an answer, not a failure, and it is
             shown as one. Rendering it as an error would blame Nova for the
             product doing its job. */
          : { stage: "refused", detail: payload.detail ?? "Veyra would not authorise any of them." },
      }));
      /* Only a card with a price is being investigated. Marking a refused one
         as under investigation put it in a state the brief reads as live work
         and the card renders as an acknowledgement, with nothing behind it. */
      if (payload.ok) void say(signal.signalId, "investigating");
    } catch (cause) {
      setResearch((current) => ({
        ...current,
        [signal.signalId]: { stage: "failed", detail: (cause as Error).message },
      }));
    }
  };

  /**
   * Pays for one investigation, and shows what it bought.
   *
   * Six steps, and the order is the product.
   *
   *   1  Veyra reads the live payment challenge for the exact endpoint and the
   *      exact request this card was priced from.
   *   2  It compares seven facts against what this card actually said:
   *      provider, endpoint, capability, price, payee, network, rail.
   *   3  Any difference stops here. Nothing is signed, nothing is substituted,
   *      and both sets of numbers go on screen for the person to accept or not.
   *   4  Only then is a clearance signed, for that exact amount and that exact
   *      wallet.
   *   5  The owner signs, in their own wallet, with their own key.
   *   6  Veyra relays the signature and checks the answer against what the
   *      endpoint declares it returns.
   *
   * `acknowledge` is the hash of terms the person has just been shown and
   * accepted. Deliberately a hash rather than a flag: a price that moves twice
   * must not be payable by a click that only ever saw it move once.
   */
  const pay = async (signal: NovaSignal, acknowledge?: string) => {
    if (!identity) return;
    const current = research[signal.signalId];
    if (!current || !("proposal" in current) || !current.proposal || !("researchId" in current) || !current.researchId) return;
    const { proposal, researchId } = current as { proposal: NovaResearchProposal; researchId: string };

    if (!wallet.address) {
      setResearch((state) => ({
        ...state,
        [signal.signalId]: {
          stage: "failed",
          researchId,
          proposal,
          detail: "Connect a wallet first. Nova cannot pay for you — you sign the amount yourself.",
        },
      }));
      return;
    }

    const at = (next: ResearchState) =>
      setResearch((state) => ({ ...state, [signal.signalId]: next }));

    at({ stage: "approving", researchId, proposal });
    try {
      const approval = await call(
        `/api/nova/v1/agents/${identity.publicId}/signals/${signal.signalId}/research/approve`,
        {
          method: "POST",
          ownerSecret: identity.ownerSecret,
          body: JSON.stringify({ wallet: wallet.address, acknowledge: acknowledge ?? null }),
        },
      ) as {
        ok: boolean;
        reason?: string;
        detail?: string;
        changes?: TermsChange[];
        termsHash?: string;
        costUsdc?: number;
        accept?: Parameters<typeof signPaymentAuthorization>[0]["accept"];
        nonce?: string;
      };

      if (!approval.ok) {
        if (approval.reason === "market_changed" && approval.termsHash) {
          at({
            stage: "changed",
            researchId,
            proposal,
            changes: approval.changes ?? [],
            termsHash: approval.termsHash,
            costUsdc: approval.costUsdc ?? proposal.costUsdc,
            detail: approval.detail ?? "",
          });
          return;
        }
        at({ stage: "failed", researchId, proposal, detail: approval.detail ?? "Veyra would not authorise that payment." });
        return;
      }
      if (!approval.accept || !approval.nonce) {
        at({ stage: "failed", researchId, proposal, detail: "Veyra cleared the payment but returned nothing to sign." });
        return;
      }

      /* The same signing step /run uses, on the same terms object. Two copies
         of this would not disagree loudly — they would disagree about which
         chain the wallet is on, once, in a popup somebody approves without
         reading. */
      at({ stage: "signing", researchId, proposal, terms: null, note: null });
      const { authorization, signature } = await signPaymentAuthorization({
        wallet,
        accept: approval.accept,
        nonce: approval.nonce,
        onSwitchingChain: (chainId) => at({
          stage: "signing",
          researchId,
          proposal,
          terms: null,
          note: `Switch your wallet to chain ${chainId} — this endpoint settles there.`,
        }),
        onTerms: (terms) => at({ stage: "signing", researchId, proposal, terms, note: null }),
      });

      at({ stage: "settling", researchId, proposal });
      const settlement = await call(
        `/api/nova/v1/agents/${identity.publicId}/signals/${signal.signalId}/research/settle`,
        {
          method: "POST",
          ownerSecret: identity.ownerSecret,
          /* The accept is not sent back. Veyra relays the one it cleared, from
             its own row, so the payment that leaves is the payment it
             authorised and not merely one that agrees with itself. */
          body: JSON.stringify({ researchId, authorization, signature }),
        },
      ) as { status: string; investigation: NovaInvestigation };

      at({ stage: "settled", researchId, proposal, investigation: settlement.investigation });
      /* Reloaded because a settled investigation moves more than this card:
         the item's own state, what Veyra has decided for this person, and —
         when the answer passed its check — a new line in what Nova knows. */
      await loadBrief(identity);
    } catch (cause) {
      at({
        stage: "failed",
        researchId,
        proposal,
        detail: (cause as Error)?.message ?? "The payment did not complete.",
      });
    }
  };

  /**
   * Says one thing about one item.
   *
   * The two families behave differently on purpose. Rejecting something folds
   * the card down to its headline, because leaving it standing after you said
   * you did not want it is the product arguing. Approving something keeps it
   * and marks it, because hiding what you just called useful is the opposite of
   * what the word means.
   *
   * A rejected card used to vanish, and a card that vanished could say neither
   * what the press taught nor ask why. The fold does both, in every list the
   * card is in, and is gone on the next load.
   */
  const say = async (signalId: string, feedback: NovaFeedback) => {
    if (!identity || !brief) return;

    // Applied locally first: feedback that waits for a round trip feels like it
    // did not register, and the server is the record either way.
    setSaid((current) => ({ ...current, [signalId]: feedback }));

    try {
      const answer = await call(`/api/nova/v1/agents/${identity.publicId}/signals/${signalId}`, {
        method: "PATCH",
        ownerSecret: identity.ownerSecret,
        body: JSON.stringify({ feedback }),
      }) as { learned?: NovaLearned | null; rated?: boolean };
      setVerdicts((current) => ({
        ...current,
        [signalId]: { learned: answer.learned ?? null, rated: answer.rated === true, reason: null, note: null },
      }));
    } catch {
      setSaid(current => { const next = { ...current }; delete next[signalId]; return next; });
      setError("Could not save your feedback. Please try again.");
    }
  };

  /* A reason or a note, sent with the verdict it belongs to -- the server
     refuses one without the other. Each send states the whole rating, so a
     reason cleared here is cleared there. */
  const explain = async (signalId: string, change: { reason?: NovaReason | null; note?: string | null }) => {
    const feedback = said[signalId];
    const prior = verdicts[signalId];
    if (!identity || !feedback || !prior) return;
    const next = { ...prior, ...change };
    setVerdicts((current) => ({ ...current, [signalId]: next }));
    try {
      await call(`/api/nova/v1/agents/${identity.publicId}/signals/${signalId}`, {
        method: "PATCH",
        ownerSecret: identity.ownerSecret,
        body: JSON.stringify({ feedback, reason: next.reason, note: next.note }),
      });
    } catch {
      setVerdicts((current) => ({ ...current, [signalId]: prior }));
      setError("Could not save your reason. Please try again.");
    }
  };

  const reportMiss = async (url: string, note: string): Promise<NovaMiss> => {
    if (!identity) throw new Error("No agent is open.");
    const payload = await call(`/api/nova/v1/agents/${identity.publicId}/misses`, {
      method: "POST",
      ownerSecret: identity.ownerSecret,
      body: JSON.stringify({ url, note }),
    }) as { miss: NovaMiss };
    return payload.miss;
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

  if (stage === "unavailable" && identity) {
    return <Shell>
      <h1 className="text-2xl font-semibold">Your agent could not be loaded</h1>
      <p className="mt-3 text-sm text-muted-foreground">Your saved access is still in this browser. Retry when the connection returns, or restore another recovery key below.</p>
      <Notice tone="error">{error ?? "Nova is unavailable."}</Notice>
      <button className="mt-4 rounded-lg border px-4 py-3" disabled={busy} onClick={async () => {
        setBusy(true); setError(null);
        try { await loadBrief(identity); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load your agent."); }
        finally { setBusy(false); }
      }}>{busy ? "Retrying…" : "Retry"}</button>
      <RecoveryKey who={identity} emphatic />
      <Panel className="mt-4"><label htmlFor="restore-unavailable" className="text-sm">Restore from another recovery key</label><input id="restore-unavailable" className="mt-2 w-full rounded-lg border bg-card p-3" type="password" autoComplete="off" value={restoreText} onChange={event => setRestoreText(event.target.value)} /><button className="mt-3 rounded-lg border px-4 py-2" disabled={restoring || !restoreText.trim()} onClick={() => void restore()}>{restoring ? "Restoring…" : "Restore"}</button></Panel>
    </Shell>;
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

          <label className="mt-6 block text-sm" htmlFor="nova-goal">What do you want Nova to help you achieve?</label>
          <textarea id="nova-goal" value={goal} onChange={e => setGoal(e.target.value)} maxLength={600} rows={3}
            placeholder="Track Arc and Circle changes that could help me build Veyra, and explain what I should do next."
            className="field mt-2 w-full rounded-lg p-3 text-sm" />
          <p className="mt-2 text-xs text-muted-foreground">A goal guides research. It never authorizes spending. Public-source research uses the app’s model; it does not charge your wallet.</p>

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
          No account and no wallet. Your agent is remembered by this browser, and you get a
          recovery key to keep somewhere else.
        </p>

        <Panel className="mt-4">
          <Label>Already have an agent?</Label>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
            Paste the recovery key you saved. This browser will remember it from then on.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <input
              aria-label="Recovery key"
              value={restoreText}
              onChange={(event) => setRestoreText(event.target.value)}
              placeholder="nva_…"
              spellCheck={false}
              autoComplete="off"
              className="field min-w-0 flex-1 rounded-lg px-3 py-2.5 font-mono text-[12.5px] outline-none transition"
            />
            <button
              type="button"
              onClick={restore}
              disabled={restoring || restoreText.trim().length === 0}
              className="rounded-lg border border-primary/50 px-4 py-2.5 text-sm text-foreground transition hover:bg-primary/15 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {restoring ? "Looking…" : "Restore"}
            </button>
          </div>
        </Panel>

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

  const preference = (facet: string) =>
    brief.memory.filter((entry) => entry.kind === "preference" && entry.facet === facet);
  const ignores = preference("usually_ignores");
  const favours = preference("cares_about");
  /* What this agent already paid to learn about whoever this card would pay.
     Read from the proposal in front of the person rather than from the signal,
     because the counterparty is only decided once a proposal exists. */
  /**
   * Mints the ERC-8004 identity from the owner's own wallet.
   *
   * `register(metadataURI)` mints to whoever calls it, so the call is made here
   * and not on a server: the person owns the token because the person sent the
   * transaction. Veyra never holds it, and no key is derived from the recovery
   * secret to stand in for one.
   *
   * The server is then told, and refuses to believe it -- it reads ownerOf off
   * Arc and stores only what the registry confirms.
   */
  const claimIdentity = async () => {
    if (!identity || !brief) return;
    setClaimNote(null);
    setClaiming(true);
    try {
      if (!wallet.address) await wallet.connect();
      if (!wallet.isArcTestnet) await wallet.switchToArc();
      const address = wallet.address;
      if (!address) throw new Error("Connect a wallet to claim the identity.");

      const metadataUri = `${window.location.origin}/api/nova/v1/agents/${identity.publicId}/card`;
      const transaction = await wallet.sendTransaction({
        to: NOVA_IDENTITY_REGISTRY as `0x${string}`,
        data: encodeFunctionData({
          abi: IDENTITY_REGISTER_ABI,
          functionName: "register",
          args: [metadataUri],
        }),
      });

      const payload = await call(
        `/api/nova/v1/agents/${identity.publicId}/identity`,
        {
          method: "POST",
          ownerSecret: identity.ownerSecret,
          body: JSON.stringify({ transaction, wallet: address }),
        },
      ) as { ok: boolean; detail?: string };

      if (!payload.ok) {
        setClaimNote(payload.detail ?? "Arc did not confirm the registration.");
      } else {
        await loadBrief(identity);
      }
    } catch (cause) {
      setClaimNote((cause as Error).message);
    } finally {
      setClaiming(false);
    }
  };

  /**
   * Asks for this agent's verified purchases to be recorded on Arc.
   *
   * A purchase attests itself as it settles, so this only ever has anything to
   * do where Arc was unreachable at that moment -- which must never cost the
   * purchase, and does not. The owner secret is the whole authority needed: it
   * is their history, and getting it onto the chain should not require a
   * deployment secret.
   */
  const attestOnArc = async () => {
    if (!identity) return;
    setAttestNote(null);
    setAttesting(true);
    try {
      const payload = await call(
        `/api/nova/v1/agents/${identity.publicId}/arc-proofs`,
        { method: "POST", ownerSecret: identity.ownerSecret },
      ) as { published: number; considered: number; unreachable: string[] };

      if (payload.published > 0) {
        await loadBrief(identity);
        setAttestNote(null);
      } else if (payload.considered === 0) {
        setAttestNote("Everything that passed its check is already on Arc.");
      } else {
        setAttestNote("Arc could not be written to just now. Nothing was lost — the purchases and their checks stand either way.");
      }
    } catch (cause) {
      setAttestNote((cause as Error).message);
    } finally {
      setAttesting(false);
    }
  };

  const priorFor = (signalId: string) => {
    const state = research[signalId];
    const provider = state && "proposal" in state ? state.proposal?.provider ?? null : null;
    return provider ? priorWith(brief.standing, provider) : null;
  };

  const follows = preference("follows");
  const attention = brief.worthAttention;
  const agentName = brief.agent.name;
  const away = brief.whileAway;
  /* Across an absence, the blind spots are the union of every pass's. The last
     pass reading GitHub fine does not undo the four before it that could not. */
  const blind = away?.sourcesUnavailable ?? brief.lastRefresh?.sourcesUnavailable ?? [];
  /* These carry a provider diagnostic now -- a WAF once answered with an HTML
     page, newlines and all, and it went straight into this sentence. The whole
     string stays in the refresh row where it is worth reading; the screen gets
     one line of it. */
  const readable = blind.map((note) => {
    const flat = note.replace(/\s+/g, " ").trim();
    return flat.length > 110 ? `${flat.slice(0, 109)}…` : flat;
  });
  /* Everything Nova is holding right now, by the reason it is held. Scoped to
     the signals behind this brief rather than to one pass, which is why it is
     not folded into the refresh counters beside it. */
  const withheldGroups = NOVA_WITHHOLD_REASONS
    .map((reason) => [reason, brief.withheld?.[reason] ?? []] as const)
    .filter(([, signals]) => signals.length > 0);
  const withheldTotal = withheldGroups.reduce((total, [, signals]) => total + signals.length, 0);
  const confirmedContext = confirmedProjectContext(brief.projectContext ?? []);
  /* Exactly what a reading started now would be told -- same function, same
     order, same truncation -- so the page can say whether the paragraph on a
     card was written about this project or an earlier one. */
  const promptContext = contextForPrompt(brief.projectContext ?? []);
  const proposedContext = proposedProjectContext(brief.projectContext ?? []);
  const splitSuggestion = (draftContext ?? []).reduce<{ index: number; parts: string[] } | null>((found, statement, index) => {
    if (found) return found;
    const parts = splitStatements(statement);
    return parts.length > 1 ? { index, parts } : null;
  }, null);

  return (
    <Shell>
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-state-good" />
            <Label>{brief.agent.name}</Label>
          </div>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight">
            {view === "today" ? `${brief.greeting}.` : VIEW_TITLE[view]}
          </h1>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            <Said claim={view !== "today"
              ? VIEW_BLURB[view](agentName, arcIdentityState(brief.agent.arcIdentity, brief.standing))
              : briefSummary({
                  inBrief: attention.length,
                  unreachable: blind,
                  watched: brief.lastRefresh?.subjectsChecked ?? 0,
                })} />
          </p>
        </div>
        {view === "today" ? (
          <button
            type="button"
            onClick={refresh}
            disabled={busy}
            className="rounded-lg border border-border bg-card/60 px-4 py-2 text-sm text-muted-foreground transition hover:border-primary/50 hover:text-foreground disabled:opacity-40"
          >
            {busy ? "Looking…" : "Look again"}
          </button>
        ) : null}
      </header>

        {view === "today" && !brief.agent.goal ? <Notice tone="warn">Set a concrete goal in <a href="/agent" className="underline">My Agent</a> so Nova can explain which events matter to you. Ordinary commits and API listings stay in background observations.</Notice> : null}
      {view === "today" && brief.agent.goal ? <p className="mb-5 text-sm text-muted-foreground"><span className="font-medium text-foreground">Your goal:</span> {brief.agent.goal}</p> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {wallet.error ? <Notice tone="error">{wallet.error}</Notice> : null}
      {justCreated && identity ? <RecoveryKey who={identity} emphatic /> : null}
      {brief.wokeFromDormancy ? (
        <Notice tone="warn">
          {agentName} had stopped watching: nobody had opened this brief in a while, and an
          agent nobody reads is not worth the requests. It is watching again from now, but
          there is a gap in what follows.
        </Notice>
      ) : null}
      {/* Also when nothing made it to Today. An empty brief caused by every
          reading failing looks exactly like an empty brief caused by a quiet
          day, and the difference is the whole message. */}
      {readable.length > 0 ? (
        <Notice tone="warn">
          Could not reach {readable.join(" and ")} this time.{" "}
          {attention.length > 0
            ? "What is below is real, but it is not everything."
            : "Nothing reached Today, and this is why -- not a quiet day."}
        </Notice>
      ) : null}

      {view === "today" ? (
      <div className="space-y-4">
        {attention.map((signal) => {
          const chip = RELEVANCE_CHIP[signal.relevance];
          const verdict = said[signal.signalId];
          if (verdict === "not_interesting" || verdict === "ignore_kind") {
            return (
              <Panel key={signal.signalId}>
                <p className="text-sm text-muted-foreground">{signal.headline}</p>
                <Verdict verdict={verdict} state={verdicts[signal.signalId]} onExplain={(change) => void explain(signal.signalId, change)} />
              </Panel>
            );
          }
          return (
            <Panel key={signal.signalId}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className={`rounded-md border px-2 py-0.5 font-mono text-[11px] ${chip.className}`}>
                  {chip.label}
                </span>
                {signal.interest ? <Label>{signal.interest}</Label> : null}
                {/* The interest is why this is on screen. The network is where
                    the money would actually go, and the two are not the same
                    word -- ARC sat directly above "$0.01" on an endpoint that
                    settles on Base, because Circle's catalogue publishes
                    nothing on Arc at all. */}
                {signal.settlesOn ? (
                  <span className="font-mono text-[11px] text-muted-foreground">
                    pays on {signal.settlesOn}
                  </span>
                ) : null}
                <SinceLastVisit signal={signal} seenThrough={brief.seenThrough ?? null} />
                <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                  {dateLine(signal)}
                </span>
              </div>

              <h2 className="mt-3 text-lg font-medium leading-snug">{signal.headline}</h2>
              {assessmentOf(signal)?.goal !== brief.agent.goal ? <>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{signal.detail}</p>
                <p className="mt-4 border-t border-border/60 pt-3 text-xs text-muted-foreground">{signal.relevanceReason}</p>
              </> : null}

              <PublicReading signal={signal} goal={brief.agent.goal} context={promptContext} unrefreshed={Boolean(readNotes[signal.signalId])} />
              {readNotes[signal.signalId] ? <p role="status" className="mt-3 text-sm text-state-warn">{readNotes[signal.signalId]}</p> : null}
              <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-3">
                {(signal.kind === "repository_release" || signal.kind === "official_publication") ? <button type="button" onClick={() => void readSources(signal)} disabled={reading[signal.signalId]}
                  className="rounded-lg border px-4 py-2 text-sm disabled:opacity-50">{reading[signal.signalId] ? "Reading sources…" : assessmentOf(signal) ? "Reassess for my project" : "Read the public sources"}</button> : null}
                {!research[signal.signalId] && paidResearchReadiness(signal, brief.agent.goal).ready ? <button type="button" onClick={() => void price(signal)} className="rounded-lg border px-4 py-2 text-sm">Find a tool for this open question</button> : null}

                {/* Nothing for "investigating": the priced proposal below is the
                    acknowledgement, and a chip above it saying so would be the
                    screen telling a person something the screen is already
                    showing them. */}
                {verdict === "useful" || verdict === "follow" ? (
                  <div className="w-full">
                    <span className="font-mono text-[11px] uppercase tracking-wider text-state-good">
                      {verdict === "follow" ? "following" : "marked useful"}
                    </span>
                    <Verdict verdict={verdict} state={verdicts[signal.signalId]} onExplain={(change) => void explain(signal.signalId, change)} />
                  </div>
                ) : verdict === "investigating" ? null : (
                  <>
                    <Verb onClick={() => say(signal.signalId, "useful")}>Useful</Verb>
                    <DropdownMenu><DropdownMenuTrigger asChild><button className="rounded-lg border px-3 py-2 text-sm" aria-label={`More actions for ${signal.headline}`}>More</button></DropdownMenuTrigger><DropdownMenuContent>
                      <DropdownMenuItem onSelect={() => void say(signal.signalId, "follow")}>Follow {signal.subjectLabel ?? "this"}</DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => void say(signal.signalId, "not_interesting")}>Not interesting</DropdownMenuItem>
                      {categoryPhraseFor(signal.kind) && <DropdownMenuItem onSelect={() => void say(signal.signalId, "ignore_kind")}>Ignore {categoryPhraseFor(signal.kind)}</DropdownMenuItem>}
                    </DropdownMenuContent></DropdownMenu>
                  </>
                )}
              </div>

              {research[signal.signalId] ? (
                <DeeperResearch
                  state={research[signal.signalId]}
                  agentName={brief.agent.name}
                  fallbackHref={investigationLink(signal)}
                  walletAddress={wallet.address}
                  onConnect={() => void wallet.connect()}
                  connecting={wallet.connecting}
                  walletReady={wallet.providerAvailable || !wallet.providerSettled}
                  onPay={(acknowledge) => void pay(signal, acknowledge)}
                  refusedAt={signal.refusal?.at ?? null}
                  onLookAgain={() => void price(signal)}
                  prior={priorFor(signal.signalId)}
                />
              ) : null}
            </Panel>
          );
        })}
      </div>
      ) : null}

      {view === "today" && (away || brief.lastRefresh) ? (
        <Panel className="mt-4">
          <Label>
            {away
              ? "While you were away"
              : brief.lastRefresh?.trigger === "creation"
                ? "First look"
                : "Last look"}
          </Label>
          {away ? (
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              {agentName} looked{" "}
              <span className="font-mono text-foreground">{away.refreshes}</span>{" "}
              {away.refreshes === 1 ? "time" : "times"} since {formatAway(away.since)},
              held back{" "}
              <span className="font-mono text-foreground">{away.signalsAsNoise}</span>{" "}
              {away.signalsAsNoise === 1 ? "signal" : "signals"} as noise, and kept{" "}
              <span className="font-mono text-foreground">{away.signalsKept}</span>.
            </p>
          ) : null}
          <dl className="mt-4 space-y-0">
            <Row label="Things checked" value={String(away?.subjectsChecked ?? brief.lastRefresh?.subjectsChecked ?? 0)} />
            <Row label="In today’s brief" value={String(attention.length)} />
            <Row label="Held back" value={String(withheldTotal)} />
            {blind.length > 0 ? (
              <Row label="Could not read" value={readable.join(", ")} tone="warn" />
            ) : null}
          </dl>
          {withheldTotal > 0 ? (
            <>
              <button
                type="button"
                onClick={() => setShowNoise((value) => !value)}
                className="mt-4 text-sm text-link underline underline-offset-4"
              >
                {showNoise ? "Hide what was held back" : "Show what was held back"}
              </button>
              {showNoise ? (
                <div className="mt-3 space-y-5 border-t border-border/60 pt-3">
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Everything {agentName} is holding, and why. Relevance rejects some of it; most
                    of a brief built from a goal is decided at the reading that judges significance,
                    and a thing nobody read yet is a gap in coverage rather than a verdict about it.
                  </p>
                  {withheldGroups.map(([reason, signals]) => (
                    <div key={reason}>
                      <p className="text-xs uppercase tracking-wider text-muted-foreground">
                        {WITHHELD_LABEL[reason](brief.agent.goal ?? null)}{" "}
                        <span className="font-mono text-foreground">{signals.length}</span>
                      </p>
                      <ul className="mt-2 space-y-2">
                        {signals.map((signal) => (
                          <li key={signal.signalId} className="text-sm text-muted-foreground">
                            {signal.headline}
                            {reason === "noise" && signal.relevanceReason ? (
                              <span className="text-muted-foreground/70"> — {signal.relevanceReason}</span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}
          <MissForm agentName={agentName} onReport={reportMiss} />
        </Panel>
      ) : null}

      {view === "today" ? <ShadowNight brief={brief} onFeedback={rateDecision} /> : null}


      {view === "agent" && <Panel className="mt-4"><Label>Mode and budget</Label><p className="mt-3 text-sm">{brief.shadow.state === "watching" ? "Autonomy preview on · no automatic payments" : "Manual approval · asks before spending"}</p>{brief.shadow.limits && <p className="mt-2 text-sm text-muted-foreground">{formatUsdc(brief.shadow.limits.perActionUsdc)} USDC per action · {formatUsdc(brief.shadow.limits.dailyUsdc)} USDC per day</p>}</Panel>}
      {view === "agent" ? (
        <Panel className="mt-4">
          <Label>What {brief.agent.name} watches</Label>

          {draftInterests === null ? (
            <>
              <dl className="mt-4 space-y-0">
                <Row label="Your goal" value={brief.agent.goal || "Not set yet"} />
                <Row label="You care about" value={brief.agent.interests.join(" · ")} />
                <Row label="Things watched" value={String(brief.lastRefresh?.subjectsChecked ?? 0)} />
                <Row label="Watching since" value={new Date(brief.agent.createdAt).toLocaleDateString()} />
              </dl>
              {/* Not a Verb. Those are deliberately quiet because they sit
                  beside the one button that can spend money; here there is no
                  such button and quiet just means unfindable -- somebody read
                  this panel and did not see it. */}
              <button
                type="button"
                onClick={() => { setInterestsNote(null); setDraftInterests(brief.agent.interests); setDraftGoal(brief.agent.goal ?? ""); }}
                className="field mt-5 w-full rounded-lg px-4 py-3 text-left text-sm transition hover:border-primary/60 hover:text-foreground"
              >
                <span className="font-medium text-foreground">Change goal and sources</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Set a goal and choose topics. {brief.agent.name} keeps its memory and everything you
                  have paid for.
                </span>
              </button>
            </>
          ) : (
            <>
              <label htmlFor="nova-edit-goal" className="mt-4 block text-sm">What result should Nova help you achieve?</label>
              <textarea id="nova-edit-goal" value={draftGoal} onChange={e => setDraftGoal(e.target.value)} maxLength={600} rows={3} className="field mt-2 w-full rounded-lg p-3 text-sm"
                placeholder="Track Arc and Circle changes that could help me build Veyra." />
              <p className="mt-2 text-xs text-muted-foreground">Choose topics below to select sources. The goal guides their analysis; changing it does not change any signed spending limits.</p>
              <p className="mt-3 text-xs text-muted-foreground">
                Pick up to <span className="font-mono">{MAX_INTERESTS}</span>. {brief.agent.name} keeps
                everything it has learned and everything it has paid for either way.
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                {INTEREST_CATALOG.map((interest) => {
                  const active = draftInterests.includes(interest.label);
                  return (
                    <button
                      key={interest.id}
                      type="button"
                      onClick={() => toggleDraftInterest(interest.label)}
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

              {/* Said before the button, not after it. Choosing Arc and being
                  shown Base is the question this product gets asked most, and
                  the honest answer is one sentence about where the sellers
                  are. */}
              {draftInterests.some((entry) => entry.toLowerCase() === "arc") ? (
                <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
                  Arc finds endpoints whose work is about Arc, USDC and stablecoins. They settle
                  where the sellers are. Each card says which chain it pays on.
                </p>
              ) : null}

              <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-3">
                <button
                  type="button"
                  onClick={saveInterests}
                  disabled={savingInterests || draftInterests.length === 0}
                  className="rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {savingInterests ? "Saving and looking again…" : "Save and look again"}
                </button>
                <Verb onClick={() => setDraftInterests(null)}>Cancel</Verb>
                {draftInterests.length === 0 ? (
                  <span className="text-xs text-muted-foreground">Pick at least one.</span>
                ) : null}
              </div>
            </>
          )}

          {interestsNote ? (
            <p className="mt-4 text-xs leading-relaxed text-state-warn">{interestsNote}</p>
          ) : null}

          {/* Everything else Nova watches.
              The brief caps at five so a daily read stays a daily read, and
              that is right. What was wrong is that the rest went nowhere:
              relevance-rejected items land in "held back", but an item that
              lost only the cap was neither shown nor held back, and "Things
              watched: 34" was a number nobody could open. Twenty-two paid
              endpoints, five reachable. */}
          {brief.watchlist.length > 0 && draftInterests === null ? (
            <div className="mt-6 border-t border-border/60 pt-5">
              <Label>Also watching</Label>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {brief.watchlist.length} more {brief.watchlist.length === 1 ? "thing" : "things"} that
                did not make today&apos;s brief. The brief stays short on purpose; this is the rest
                of it.
              </p>
              <ul className="mt-4 space-y-3">
                {groupWatchlist(brief.watchlist).map(([source, signals]) => <li key={source}><details className="rounded-lg border p-3"><summary className="cursor-pointer text-sm">{source} · {signals.length} {signals.length === 1 ? "update" : "updates"}</summary><ul className="mt-3 space-y-3">{signals.map((signal) => said[signal.signalId] === "not_interesting" ? (
                  <li key={signal.signalId} className="border-t border-border/40 pt-3 first:border-t-0 first:pt-0">
                    <span className="text-sm text-muted-foreground">{signal.headline}</span>
                    <Verdict verdict="not_interesting" state={verdicts[signal.signalId]} onExplain={(change) => void explain(signal.signalId, change)} />
                  </li>
                ) : (
                  <li key={signal.signalId} className="border-t border-border/40 pt-3 first:border-t-0 first:pt-0">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="text-sm text-foreground">{signal.headline}</span><SinceLastVisit signal={signal} seenThrough={brief.seenThrough ?? null} /><time className="text-xs text-muted-foreground" dateTime={signal.observedAt}>{dateLine(signal)}</time>
                      {signal.settlesOn ? (
                        <span className="font-mono text-[11px] text-muted-foreground">
                          pays on {signal.settlesOn}
                        </span>
                      ) : null}
                      {signal.interest ? (
                        <span className="ml-auto font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                          {signal.interest}
                        </span>
                      ) : null}
                    </div>
                    {research[signal.signalId] ? (
                      <DeeperResearch
                        state={research[signal.signalId]}
                        agentName={brief.agent.name}
                        fallbackHref={investigationLink(signal)}
                        walletAddress={wallet.address}
                        onConnect={() => void wallet.connect()}
                        connecting={wallet.connecting}
                        walletReady={wallet.providerAvailable || !wallet.providerSettled}
                        onPay={(acknowledge) => void pay(signal, acknowledge)}
                        refusedAt={signal.refusal?.at ?? null}
                        onLookAgain={() => void price(signal)}
                        prior={priorFor(signal.signalId)}
                      />
                    ) : (
                      <div className="mt-2">
                        <PublicReading signal={signal} goal={brief.agent.goal} context={promptContext} unrefreshed={Boolean(readNotes[signal.signalId])} />
                        {(signal.kind === "repository_release" || signal.kind === "official_publication") ? <button type="button" onClick={() => void readSources(signal)} disabled={reading[signal.signalId]} className="mt-3 rounded-lg border px-3 py-2 text-sm">{reading[signal.signalId] ? "Reading…" : assessmentOf(signal) ? "Reassess for my project" : "Read the public sources"}</button> : null}
                        {paidResearchReadiness(signal, brief.agent.goal).ready ? <button type="button" onClick={() => void price(signal)} className="ml-2 mt-3 rounded-lg border px-3 py-2 text-sm">Find a tool for this open question</button> : null}
                        {readNotes[signal.signalId] ? <p role="status" className="mt-2 text-sm text-state-warn">{readNotes[signal.signalId]}</p> : null}
                        {/* Acknowledged where it was pressed. Saved and silent is
                            indistinguishable from broken, and the owner who
                            found it so pressed it fourteen times. */}
                        {said[signal.signalId] === "useful"
                          ? <div className="mt-3"><p className="font-mono text-[11px] uppercase tracking-wider text-state-good">marked useful</p><Verdict verdict="useful" state={verdicts[signal.signalId]} onExplain={(change) => void explain(signal.signalId, change)} /></div>
                          : <div className="mt-3 flex gap-3"><Verb onClick={() => void say(signal.signalId, "useful")}>Useful result</Verb><Verb onClick={() => void say(signal.signalId, "not_interesting")}>Not useful</Verb></div>}
                      </div>
                    )}
                  </li>
                ))}</ul></details></li>)}
              </ul>
            </div>
          ) : null}

          <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
            {brief.agent.name} looks on a schedule, whether or not anyone is reading. It stops
            after a fortnight with nobody here, and starts again the moment you come back — an
            agent nobody reads is not worth the requests it costs.
          </p>
        </Panel>
      ) : null}

      {view === "agent" ? (
        <Panel className="mt-4">
          <Label>Project context</Label>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            What is already true about your work. Your goal says where you are going; this says
            where you are, and it is the difference between {brief.agent.name} telling you a thing
            exists and telling you what it changes for what you have built. Short facts, and only
            the ones you confirm.
          </p>

          {draftContext === null ? (
            <>
              {confirmedContext.length > 0 ? (
                <ul className="mt-4 space-y-2">
                  {confirmedContext.map((entry) => (
                    <li key={entry.contextId} className="field rounded-lg px-4 py-3 text-sm">
                      {entry.statement}
                      {entry.origin !== "owner" ? (
                        <span className="ml-2 text-xs text-muted-foreground">you confirmed this suggestion</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-4 text-sm text-muted-foreground">
                  Nothing yet. Until there is, a reading can only judge an event against your goal.
                </p>
              )}
              <button
                type="button"
                onClick={() => { setContextNote(null); setDraftContext(confirmedContext.map((entry) => entry.statement)); }}
                className="field mt-4 w-full rounded-lg px-4 py-3 text-left text-sm transition hover:border-primary/60 hover:text-foreground"
              >
                <span className="font-medium text-foreground">Edit project context</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Up to {PROJECT_CONTEXT_LIMITS.confirmed} facts, {PROJECT_CONTEXT_LIMITS.statement} characters each.
                </span>
              </button>
            </>
          ) : (
            <>
              <ul className="mt-4 space-y-2">
                {draftContext.map((statement, index) => (
                  <li key={index} className="flex items-start gap-2">
                    <textarea
                      value={statement}
                      onChange={(event) => setDraftContext((current) => (current ?? []).map((entry, at) => at === index ? event.target.value : entry))}
                      maxLength={PROJECT_CONTEXT_LIMITS.statement}
                      rows={2}
                      className="field min-w-0 flex-1 rounded-lg p-3 text-sm"
                      placeholder="ERC-8183 escrow is tested on Arc Testnet."
                    />
                    <Verb onClick={() => setDraftContext((current) => (current ?? []).filter((_, at) => at !== index))}>Remove</Verb>
                  </li>
                ))}
              </ul>
              {/* Four facts in one row read the same to the model and cannot be
                  corrected one at a time -- and being correctable is what
                  keeps this list from going stale. Offered, not applied:
                  rewriting what somebody typed about their own project is not
                  ours to do silently. */}
              {splitSuggestion ? (
                <div className="mt-3 rounded-lg border p-3">
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Line {splitSuggestion.index + 1} looks like {splitSuggestion.parts.length} separate
                    facts. Kept as one, you cannot retire a single line of it later.
                  </p>
                  <Verb onClick={() => setDraftContext((current) => {
                    const rows = [...(current ?? [])];
                    rows.splice(splitSuggestion.index, 1, ...splitSuggestion.parts);
                    return rows.slice(0, PROJECT_CONTEXT_LIMITS.confirmed);
                  })}>Split into {splitSuggestion.parts.length} facts</Verb>
                </div>
              ) : null}
              <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-3">
                {draftContext.length < PROJECT_CONTEXT_LIMITS.confirmed ? (
                  <Verb onClick={() => setDraftContext((current) => [...(current ?? []), ""])}>Add a fact</Verb>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {PROJECT_CONTEXT_LIMITS.confirmed} is the limit. A working memory nobody rereads is one nobody corrects.
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => void saveProjectContext()}
                  disabled={savingContext}
                  className="rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {savingContext ? "Saving and looking again…" : "Save and look again"}
                </button>
                <Verb onClick={() => setDraftContext(null)}>Cancel</Verb>
              </div>
            </>
          )}

          {/* Nova's own reading of the project, held as a question.
              It never enters an analysis before this button is pressed: an
              inference that could confirm itself would be indistinguishable,
              a week later, from something its owner said. */}
          {proposedContext.length > 0 && draftContext === null ? (
            <div className="mt-6 border-t border-border/60 pt-5">
              <Label>{brief.agent.name} suggests</Label>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                Read from public sources, not from your project. Nothing here counts until you say so.
              </p>
              <ul className="mt-4 space-y-3">
                {proposedContext.map((entry) => (
                  <li key={entry.contextId} className="rounded-lg border p-3">
                    <p className="text-sm text-foreground">{entry.statement}</p>
                    {typeof entry.evidence.why === "string" ? (
                      <p className="mt-1 text-xs text-muted-foreground">{entry.evidence.why}</p>
                    ) : null}
                    {typeof entry.evidence.headline === "string" ? (
                      <p className="mt-1 text-xs text-muted-foreground">From: {entry.evidence.headline}</p>
                    ) : null}
                    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                      <Verb onClick={() => void answerContextProposal(entry.contextId, "confirm")}>That is true</Verb>
                      <Verb onClick={() => void answerContextProposal(entry.contextId, "dismiss")}>Not true</Verb>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {contextNote ? (
            <p className="mt-4 text-xs leading-relaxed text-muted-foreground">{contextNote}</p>
          ) : null}
        </Panel>
      ) : null}

      {view === "agent" ? (
        <details className="mt-4 rounded-xl border p-5"><summary className="cursor-pointer font-medium">Autonomy · mode and spending limits</summary><AutonomyPanel
          brief={brief}
          onSign={() => void signPreviewMandate()}
          signing={signingMandate}
          note={mandateNote}
          walletReady={wallet.providerAvailable || !wallet.providerSettled}
        /></details>
      ) : null}

      {view === "memory" && <div className="mt-4 flex gap-2" aria-label="Memory sections">{(["learned", "purchases"] as const).map(tab => <button key={tab} aria-pressed={memoryTab === tab} onClick={() => setMemoryTab(tab)} className={`rounded-lg px-4 py-3 text-sm ${memoryTab === tab ? "bg-primary/20" : "border"}`}>{tab === "learned" ? "Learned" : "Purchases"}</button>)}</div>}
      {view === "memory" && memoryTab === "learned" ? (
      <Panel className="mt-4">
        <Label>What {brief.agent.name} knows about you</Label>
        <dl className="mt-4 space-y-0">
          {follows.length > 0 ? (
            <Row label="You follow" value={<Learned entries={follows} onForget={forgetLearned} />} tone="good" />
          ) : null}
          {favours.length > 0 ? (
            <Row label="You find useful" value={<Learned entries={favours} onForget={forgetLearned} />} />
          ) : null}
          {ignores.length > 0 ? (
            /* Said more than once is shown as said more than once. A preference
               asserted from a single click is a guess, and presenting it with
               the same confidence as one a person has repeated five times is
               how "what Nova knows about you" stops being true. */
            <Row label="You usually ignore" value={<Learned entries={ignores} onForget={forgetLearned} counted />} />
          ) : null}
        </dl>
        {/* What was bought is no longer counted here. It has a panel below that
            shows the purchases themselves, and a number standing in for them
            was the whole problem: the row behind "Verified by Veyra — 1" held
            the provider, the endpoint, the amount, the verdict and the
            transaction, and this page rendered its length. */}
        {ignores.length === 0 && favours.length === 0 && follows.length === 0 ? (
          <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
            Nothing learned yet. Saying what is useful, what to follow and what to hold back is
            what makes this brief yours rather than everyone&apos;s.
          </p>
        ) : null}
      </Panel>
      ) : null}

      {view === "memory" && memoryTab === "purchases" ? <Receipts brief={brief} /> : null}

      {view === "arc" ? (
        <>
          <Standing
          brief={brief}
          onClaim={() => void claimIdentity()}
          claiming={claiming}
          claimNote={claimNote}
          onAttest={() => void attestOnArc()}
          attesting={attesting}
          attestNote={attestNote}
          walletReady={wallet.providerAvailable || !wallet.providerSettled}
        />
          {/* Said here because the brief cannot avoid raising it: somebody picks
              Arc as an interest, gets shown a payment, and the payment settles
              on Base. That looks like a contradiction until you know which half
              of the transaction Arc holds, and nobody should have to guess. */}
          <details className="mt-4 rounded-xl border p-5"><summary className="cursor-pointer text-sm font-medium">Payment networks and Arc records</summary><p className="mt-3 text-sm text-muted-foreground">Each purchase names the seller’s network and source of funds before you sign. Payments can use mainnet USDC even when this agent’s identity is on Arc Testnet. Arc attestations record the decision and evidence separately from the payment.</p></details>
        </>
      ) : null}
      {view === "agent" && !justCreated && identity
        ? <RecoveryKey who={identity} emphatic={false} />
        : null}
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
function Standing({
  brief,
  onClaim,
  claiming,
  claimNote,
  onAttest,
  attesting,
  attestNote,
  walletReady,
}: {
  brief: NovaBrief;
  onClaim: () => void;
  claiming: boolean;
  claimNote: string | null;
  onAttest: () => void;
  attesting: boolean;
  attestNote: string | null;
  /** False only once detection has settled on there being no wallet here.
   *  Gates claiming, which mints from the owner's own wallet; attesting is
   *  signed by Veyra and does not. */
  walletReady: boolean;
}) {
  const { standing, agent } = brief;
  const identity = agent.arcIdentity;
  /* One value with three cases, so the heading, the explanation and the button
     cannot disagree about which of them this agent is in. */
  const identityState = arcIdentityState(identity, standing);
  const access = agentAccessState(identity);


  /* Counted from the purchases, not from three proxies for one of them. The
     old row printed "verified research 1 / decision 1 / outcome 1" off a
     single Exa call, which reads as a history and is one line of it. */

  /* What is actually on Arc, as opposed to what Veyra says about itself. The
     three numbers above are read out of Veyra's own database; these are
     transactions anyone can fetch from the chain and check. Keeping them in
     separate blocks is the point -- a page that mixed them would be asking to
     be believed about the half that needs no belief. */
  const proofs = brief.investigations.filter((entry) => entry.arcProof);
  const unattested = brief.investigations
    .filter((entry) => entry.status === "verified" && !entry.arcProof).length;

  return (
    <Panel className="mt-4">
      <Label>Arc identity</Label>
      {identityState.kind === "claimed" ? (
        /* A registry and an agent id, which is what an ERC-8004 identity is.
           The owner is shown separately and on purpose: it is the part that can
           change, and the agent does not change with it. */
        <>
          <p className="mt-3 text-lg font-medium leading-snug">
            <Said claim={identityHeadline(identityState, agent.name)} />
          </p>
          <p className="mt-2 max-w-xl text-xs leading-relaxed text-muted-foreground">
            <Said claim={identityExplanation(identityState, agent.name)} />
          </p>
          <dl className="mt-4 space-y-0">
            <Row label="Owned by" value={`${identityState.owner.slice(0, 6)}…${identityState.owner.slice(-4)}`} tone="good" />
            <Row label="Registry" value={`eip155:${identityState.chainId}:${identityState.registry.slice(0, 10)}…`} />
          </dl>
          <p className="mt-3 max-w-xl text-xs leading-relaxed text-muted-foreground">
            <Said claim={transferWarning(access, agent.name, BRAND.name)} />
          </p>
          <a
            href={`https://testnet.arcscan.app/address/${identityState.registry}`}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-3 inline-block text-sm text-link underline underline-offset-4"
          >
            View on Arc ↗
          </a>
        </>
      ) : (
        <>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
            <Said claim={identityExplanation(identityState, agent.name)} />
          </p>
          {identityState.kind === "earned_not_claimed" ? (
            <div className="mt-4">
              {walletReady ? (
                <button
                  type="button"
                  onClick={onClaim}
                  disabled={claiming}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-60"
                >
                  {claiming ? "Claiming…" : "Claim Arc identity"}
                </button>
              ) : (
                <NoWalletHere what="this identity" />
              )}
              <p className="mt-3 max-w-xl text-xs leading-relaxed text-muted-foreground">
                You will own this identity — your wallet mints it, and {BRAND.name} never holds it.
                {agent.name}&apos;s memory and history stay with the agent, not with the wallet.
                Your wallet needs to be on Arc Testnet, where gas is paid in USDC (about $0.006).
              </p>
              {claimNote ? (
                <p className="mt-3 max-w-xl text-xs leading-relaxed text-state-warn">{claimNote}</p>
              ) : null}
            </div>
          ) : null}
        </>
      )}

      {standing.providers.length > 0 ? (
        <div className="mt-6 border-t border-border/60 pt-5">
          <Label>Who {agent.name} has dealt with</Label>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
            Bought with your money, not inferred from a catalogue. This is the only part of{" "}
            {BRAND.name}&apos;s view of a seller that {agent.name} paid to learn.
          </p>
          <ul className="mt-4 space-y-2">
            {standing.providers.map((record) => (
              <li key={record.provider} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-sm text-foreground">{record.provider}</span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  ${formatUsdc(record.spentUsdc)}
                </span>
                <span
                  className={`ml-auto font-mono text-[11px] uppercase tracking-wider ${
                    record.passed > 0 && record.failedAfterPaying === 0
                      ? "text-state-good"
                      : record.paid === 0 ? "text-state-idle" : "text-state-warn"
                  }`}
                >
                  {/* Counts, never a percentage. One bad morning is not a rate,
                      and printing it as one would invent a confidence nobody
                      has earned yet. */}
                  {record.paid === 0
                    ? `${record.nothingMoved} signed, nothing moved`
                    : `${record.passed} of ${record.paid} passed`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Verified, and not yet on Arc. A purchase attests itself as it settles,
          so anything here is a moment when the chain could not be reached --
          which never costs the purchase, and leaves something worth finishing. */}
      {unattested > 0 ? (
        <div className="mt-6 border-t border-border/60 pt-5">
          <Label>Not yet on Arc</Label>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
            {unattested === 1
              ? "One purchase passed its check but is not recorded on Arc yet."
              : `${unattested} purchases passed their checks but are not recorded on Arc yet.`}{" "}
            Recording costs you nothing: {BRAND.name} signs its own attestation, and your wallet is
            not involved.
          </p>
          <button
            type="button"
            onClick={onAttest}
            disabled={attesting}
            className="mt-4 rounded-lg border border-border px-4 py-2 text-sm font-medium transition hover:bg-foreground/5 disabled:opacity-60"
          >
            {attesting ? "Recording…" : "Record on Arc"}
          </button>
          {attestNote ? (
            <p className="mt-3 max-w-xl text-xs leading-relaxed text-muted-foreground">{attestNote}</p>
          ) : null}
        </div>
      ) : null}

      {proofs.length > 0 ? (
        <div className="mt-6 border-t border-border/60 pt-5">
          <Label>Already on Arc</Label>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
            {proofs.length === 1 ? "One purchase is" : `${proofs.length} purchases are`} recorded in
            the proof registry on Arc: who paid, who was paid, how much, and the hashes of what was
            asked and what came back. These are {BRAND.name}&apos;s attestations — {BRAND.name}
            reached the verdict and signed it. Arc does not make the verdict independent of{" "}
            {BRAND.name}; it makes the record tamper-evident, and readable by anyone without{" "}
            {BRAND.name}&apos;s help.
          </p>
          <ul className="mt-4 space-y-2">
            {proofs.map((entry) => (
              <li key={entry.researchId} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-sm text-foreground">{entry.provider ?? "an endpoint"}</span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  ${formatUsdc(entry.paidUsdc ?? 0)}
                </span>
                <a
                  href={entry.arcProof!.explorerUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="ml-auto font-mono text-[11px] text-link underline underline-offset-4"
                >
                  {entry.arcProof!.transaction
                    ? `${entry.arcProof!.transaction.slice(0, 10)}…`
                    : "in the registry"}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Panel>
  );
}

/* ---- the pieces ---- */

/** A machine value against its name, hairline-separated. Values are monospace
 *  because they are meant to be compared, not read. */
/**
 * The limits Nova rehearses under, before and after they are signed.
 *
 * The offer is a fixed set of terms rather than a form. Every number here is
 * one somebody has to reason about with no evidence yet -- this is the week
 * that produces the evidence -- and a form would ask them to guess seven times
 * before they have seen a single decision. After a week of real decisions the
 * brief says what these should have been, and that is when they become
 * editable.
 *
 * Two things are said out loud that the wallet will not say. The mode is
 * PREVIEW, so no money can move under this signature at all; and enabling real
 * spending later takes a new one. MetaMask shows eleven numeric fields and no
 * indication of either.
 */
function AutonomyPanel({
  brief,
  onSign,
  signing,
  note,
  walletReady,
}: {
  brief: NovaBrief;
  onSign: () => void;
  signing: boolean;
  note: string | null;
  /** False only once detection has settled on there being no wallet here.
   *  Stays true while the answer is still open. See NoWalletHere. */
  walletReady: boolean;
}) {
  const shadow = brief.shadow;
  const limits = shadow.limits;
  const days = PREVIEW_MANDATE.daysValid;

  return (
    <Panel className="mt-4">
      <Label>{shadow.state === "watching" ? "Autonomy preview · on" : "Autonomy preview"}</Label>
      <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
        <Said claim={autonomyStateClaim(shadow, brief.agent.name)} />
      </p>

      {shadow.state === "watching" && limits ? (
        <>
          <dl className="mt-4 space-y-0">
            <Row label="Signed by" value={`${limits.signedBy.slice(0, 6)}…${limits.signedBy.slice(-4)}`} tone="good" />
            <Row label="Mode" value={limits.mode} />
            <Row label="Allowed" value={capabilityList(limits.capabilities)} />
            <Row label="Expires" value={new Date(limits.expiresAt).toLocaleDateString()} />
            <Row label="Per investigation" value={`$${formatUsdc(limits.perActionUsdc)}`} />
            <Row label="Daily budget" value={`$${formatUsdc(limits.dailyUsdc)}`} />
            <Row label="Total preview budget" value={`$${formatUsdc(limits.totalUsdc)}`} />
            <Row label="Attempts per day" value={String(limits.attemptsPerDay)} />
            <Row label="Minimum trust" value={String(limits.minimumTrustScore)} />
            <Row label="Budget day" value={limits.timezone} />
          </dl>

          {/* A signature cannot be edited, so when the offer changes the only
              way to adopt it is to sign again -- and until now nothing on this
              screen said so. An owner who signed once saw their old limits for
              ever and had no way to reach the new ones, which is the worst
              shape this can take: terms that moved, in force, unmentioned. */}
          {limits.isCurrentOffer ? null : (
            <div className="mt-5 rounded-lg border border-state-warn/40 bg-state-warn/5 p-4">
              <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
                These are not the limits this page offers any more. What you signed stays in
                force until you sign again — nothing changes on its own, and nothing is
                revoked. The terms now on offer:
              </p>
              <dl className="mt-3 space-y-0">
                <Row label="Allowed" value={capabilityList([...PREVIEW_MANDATE.allowedCapabilities])} />
                <Row label="Max per investigation" value={`$${formatUsdc(PREVIEW_MANDATE.maxPerTransactionUsdc)}`} />
                <Row label="Daily budget" value={`$${formatUsdc(PREVIEW_MANDATE.maxPerDayUsdc)}`} />
                <Row label="Total preview budget" value={`$${formatUsdc(PREVIEW_MANDATE.maxTotalUsdc)}`} />
                <Row label="Attempts per day" value={String(PREVIEW_MANDATE.maxAutonomousAttemptsPerDay)} />
                <Row label="Minimum trust" value={String(PREVIEW_MANDATE.minimumTrustScore)} />
              </dl>
              <div className="mt-4">
                {walletReady ? (
                  <button
                    type="button"
                    onClick={onSign}
                    disabled={signing}
                    className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-60"
                  >
                    {signing ? "Waiting for your wallet…" : "Sign the updated mandate"}
                  </button>
                ) : (
                  <NoWalletHere what="the updated limits" />
                )}
              </div>
              <p className="mt-3 max-w-xl text-xs leading-relaxed text-muted-foreground">
                Signing replaces which limits are in force. The one you signed before stays in
                the record, and the decisions made under it stay attached to it.
              </p>
            </div>
          )}
        </>
      ) : (
        <>
          <p className="mt-4 max-w-xl text-sm leading-relaxed text-muted-foreground">
            See what {brief.agent.name} would do with money before giving it any. It decides for
            real — live prices, {BRAND.name}&apos;s own trust decision, your limits — and stops one
            step before the step that costs anything.
          </p>
          <div className="mt-5">
            <Label>Allowed</Label>
            {/* Read off the mandate rather than written beside it. This line
                said "Research & search" while the signed list said something
                else, which is the same class of drift as a screen naming a
                model nobody had called in months. */}
            <p className="mt-2 text-sm text-muted-foreground">
              {capabilityList([...PREVIEW_MANDATE.allowedCapabilities])} · x402 · Base
            </p>
          </div>
          <dl className="mt-4 space-y-0">
            <Row label="Max per investigation" value={`$${formatUsdc(PREVIEW_MANDATE.maxPerTransactionUsdc)}`} />
            <Row label="Daily budget" value={`$${formatUsdc(PREVIEW_MANDATE.maxPerDayUsdc)}`} />
            <Row label="Total preview budget" value={`$${formatUsdc(PREVIEW_MANDATE.maxTotalUsdc)}`} />
            <Row label="Attempts per day" value={String(PREVIEW_MANDATE.maxAutonomousAttemptsPerDay)} />
            <Row label="Minimum trust" value={String(PREVIEW_MANDATE.minimumTrustScore)} />
            <Row label="Budget day" value={browserTimezone()} />
            <Row label="Expires" value={`in ${days} days`} />
          </dl>
          <div className="mt-5">
            {walletReady ? (
              <button
                type="button"
                onClick={onSign}
                disabled={signing}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-60"
              >
                {signing ? "Waiting for your wallet…" : "Sign preview mandate"}
              </button>
            ) : (
              <NoWalletHere what="these limits" />
            )}
          </div>
          <p className="mt-3 max-w-xl text-xs leading-relaxed text-muted-foreground">
            <Said claim={previewOnlyWarning()} />
          </p>
          <p className="mt-2 max-w-xl text-xs leading-relaxed text-muted-foreground">
            Your wallet will ask for a signature, not a transaction: nothing is approved, nothing is
            sent, and no allowance is granted.
          </p>
        </>
      )}
      {note ? <p className="mt-4 max-w-xl text-xs leading-relaxed text-state-warn">{note}</p> : null}
    </Panel>
  );
}

/** The signed list, in the words the rest of the screen uses. */
function capabilityList(capabilities: string[]): string {
  const said = capabilities
    .map((capability) => capability.charAt(0).toUpperCase() + capability.slice(1))
    .join(" · ");
  return said || "Nothing";
}

/* Read at render rather than imported: the budget day is the owner's day, and
   only the browser knows which one that is. Falls back to UTC on the server
   pass, where the panel is re-rendered before anybody can click. */
function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * What Nova would have bought while nobody was watching.
 *
 * The whole unattended path ran for real -- live discovery, a live quote,
 * Veyra's trust decision, the owner's signed mandate -- and stopped one step
 * before the step that costs money. So this panel sits beside the receipts and
 * never among them, and every sentence in it says that nothing was bought.
 *
 * The two buttons are the point. Counts can tell somebody whether their limits
 * were right; only they can say whether Nova's judgement was worth funding, and
 * that is the question a week of this is being run to answer.
 */
function ShadowNight({
  brief,
  onFeedback,
}: {
  brief: NovaBrief;
  onFeedback: (decisionId: string, feedback: "useful" | "not_worth_it") => Promise<void>;
}) {
  const shadow = brief.shadow;
  const [sent, setSent] = useState<Record<string, "useful" | "not_worth_it">>({});
  const [failed, setFailed] = useState<string | null>(null);

  const say = useCallback(async (decisionId: string, feedback: "useful" | "not_worth_it") => {
    setSent((current) => ({ ...current, [decisionId]: feedback }));
    setFailed(null);
    try {
      await onFeedback(decisionId, feedback);
    } catch {
      /* Put it back rather than leave a button looking pressed. An opinion the
         server never received is not an opinion anybody recorded. */
      setSent((current) => {
        const next = { ...current };
        delete next[decisionId];
        return next;
      });
      setFailed("That did not save. Try again in a moment.");
    }
  }, [onFeedback]);

  if (shadow.state === "off") return null;

  const { summary, decisions } = shadow;
  const today = decisions.filter(
    (entry) => summary.period && entry.period.start === summary.period.start,
  );

  return (
    <Panel className="mt-4">
      <Label>While you were away</Label>
      <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
        <Said claim={shadowNightClaim(summary)} /> Policy permission does not establish usefulness.
      </p>
      <dl className="mt-4 space-y-0">
        <Row label="Allowed by policy" value={String(summary.wouldInvestigate)}
          tone={summary.wouldInvestigate > 0 ? "good" : "idle"} />
        <Row label="Refused by policy" value={String(summary.wouldDecline)} />
        <Row label="Would spend" value={plain(shadowSpendClaim(summary))} />
        <Row label="Left today" value={plain(shadowRemainingClaim(summary))} />
      </dl>

      {summary.declinedBecause.length > 0 ? (
        <div className="mt-5 border-t border-border/60 pt-4">
          <Label>Why {BRAND.name} stopped the others</Label>
          {/* Built once and read by index: the claims come back in the order
              of declinedBecause, and matching them any other way would be two
              derivations of one list. */}
          <ul className="mt-3 space-y-1.5">
            {shadowDeclineClaims(summary).map((claim, index) => (
              <li key={summary.declinedBecause[index]?.code ?? index}
                  className="text-sm text-muted-foreground">
                <Said claim={claim} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {today.length > 0 ? (
        <ul className="mt-6 space-y-6 border-t border-border/60 pt-5">
          {today.map((entry) => {
            const opinion = sent[entry.decisionId] ?? entry.ownerFeedback;
            return (
              <li key={entry.decisionId}>
                <p className="text-sm text-foreground">{entry.question}</p>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {entry.provider ?? "an endpoint"} · ${formatUsdc(entry.wouldSpendUsdc)}
                  {entry.trustScore !== null ? ` · trust ${entry.trustScore}` : ""}
                </p>
                <p className={`mt-3 text-sm ${
                  entry.verdict === "WOULD_ALLOW" ? "text-state-good" : "text-state-warn"}`}>
                  <Said claim={shadowVerdictClaim(entry.verdict, brief.agent.name)} />
                </p>
                <ul className="mt-2 space-y-1">
                  {entry.checks.map((check) => (
                    <li key={check.code} className="text-xs text-muted-foreground">
                      <span className={check.ok ? "text-state-good" : "text-state-warn"}>
                        {check.ok ? "✓" : "✕"}
                      </span>{" "}
                      {check.detail}
                    </li>
                  ))}
                </ul>
                {opinion ? (
                  <p className="mt-3 text-xs text-muted-foreground">
                    {opinion === "useful"
                      ? "You said this would have been worth it."
                      : "You said you would not have paid for this."}
                  </p>
                ) : (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => say(entry.decisionId, "useful")}
                      className="rounded-lg border border-border px-3 py-1.5 text-xs transition hover:bg-muted"
                    >
                      This looks useful
                    </button>
                    <button
                      type="button"
                      onClick={() => say(entry.decisionId, "not_worth_it")}
                      className="rounded-lg border border-border px-3 py-1.5 text-xs transition hover:bg-muted"
                    >
                      I wouldn&apos;t pay for this
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      {failed ? <p className="mt-4 text-xs text-state-warn">{failed}</p> : null}
    </Panel>
  );
}

/**
 * Everything that was paid for, kept where it cannot disappear.
 *
 * A receipt used to live under the card that produced it, and cards age out of
 * the brief. So a verified purchase -- the thing this whole product exists to
 * produce -- survived exactly as long as the item that happened to occasion it,
 * and after that the only trace on screen was a counter reading "1". The row
 * behind that counter already held the provider, the endpoint, the amount, the
 * verdict and the transaction; the page called "what it has learned" was
 * rendering its length.
 *
 * Refusals belong here too. A signature that was asked for and produced nothing
 * is part of an honest account of what this agent has cost somebody, and
 * leaving it out would make the ledger flattering rather than true.
 */
function Receipts({ brief }: { brief: NovaBrief }) {
  const [query, setQuery] = useState("");
  const settled = brief.investigations
    .filter((entry) => entry.status === "verified" || entry.status === "paid_unverified" || entry.status === "unpaid")
    .sort((left, right) => (right.settledAt ?? "").localeCompare(left.settledAt ?? ""));

  if (settled.length === 0) {
    return (
      <Panel className="mt-4">
        <Label>What {brief.agent.name} has bought</Label>
        <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
          Nothing yet. When {brief.agent.name} pays for an answer, the receipt stays here — what
          was asked, who was paid, what {BRAND.name} made of it and the transaction behind it.
        </p>
      </Panel>
    );
  }

  /* Read from the one place these are derived rather than counted again off
     the same rows. Two counts of one fact is one more chance to print a number
     the rest of the screen disagrees with. */
  const counts = purchaseStanding(brief.standing);
  const matches = settled.filter(entry => `${entry.question} ${entry.provider ?? ""}`.toLowerCase().includes(query.toLowerCase()));

  return (
    <Panel className="mt-4">
      <Label>What {brief.agent.name} has bought</Label>
      {/* Three numbers, because one ratio over them was wrong. "1 of 6" counted
          attempts where nothing moved in the same denominator as paid calls,
          which reads as a far worse hit rate than the money bought. An attempt
          is a decision, a payment is an exposure, a pass is a result. */}
      <dl className="mt-4 space-y-0">
        <Row label="Attempts" value={String(counts.attempts)} />
        <Row label="Money actually moved" value={String(counts.paid)} />
        <Row
          label="Passed the delivery check"
          value={plain(purchaseSummary(counts))}
          tone={counts.passed > 0 ? "good" : "idle"}
        />
        <Row label="Spent" value={`$${formatUsdc(counts.spentUsdc)}`} />
      </dl>

      <input aria-label="Search purchases" placeholder="Search purchases" value={query} onChange={event => setQuery(event.target.value)} className="mt-4 w-full rounded-lg border bg-card p-3 text-sm" />
      {matches.length === 0 && <p role="status" className="mt-4 text-sm text-muted-foreground">No purchases match your search.</p>}
      <ul className="mt-5 space-y-5">
        {matches.map((entry) => {
          const proposal = entry.proposal as { subjectLabel?: string | null; paymentLabel?: string } | null;
          const subject = proposal?.subjectLabel?.trim() || entry.provider || "an endpoint";
          const paid = entry.paidUsdc ?? 0;
          return (
            <li key={entry.researchId} className="border-t border-border/40 pt-4 first:border-t-0 first:pt-0">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-sm text-foreground">{subject}</span>
                <span
                  className={`font-mono text-[11px] uppercase tracking-wider ${
                    entry.status === "verified"
                      ? "text-state-good"
                      : entry.status === "paid_unverified" ? "text-state-warn" : "text-state-idle"
                  }`}
                >
                  {entry.status === "verified"
                    ? "verified"
                    : entry.status === "paid_unverified" ? "paid, not verified" : "nothing was paid"}
                </span>
                {entry.settledAt ? (
                  <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                    {new Date(entry.settledAt).toLocaleDateString()}
                  </span>
                ) : null}
              </div>

              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{entry.question}</p>

              <dl className="mt-3 space-y-0">
                <Row label="Provider" value={entry.provider ?? "unknown"} />
                {proposal?.paymentLabel && <Row label="Payment route" value={proposal.paymentLabel} />}
                {/* Named either way. An authorisation that took nothing still
                    has a number on it, and that number is the first thing
                    somebody checks against their wallet. */}
                <Row
                  label={paid > 0 ? "Paid" : "You signed for"}
                  value={paid > 0
                    ? `$${formatUsdc(paid)}`
                    : `$${formatUsdc(entry.authorisedUsdc ?? 0)} — still in your wallet`}
                  tone={paid > 0 ? "plain" : "idle"}
                />
              </dl>
              <details className="mt-3"><summary className="cursor-pointer py-2 text-sm text-muted-foreground">Details and evidence</summary><dl className="mt-2">
                {entry.executionPublicId ? (
                  <Row label="Execution" value={<Link className="text-link underline" href={`/execution/${entry.executionPublicId}`}>View payment receipt ↗</Link>} />
                ) : null}
                {entry.transaction ? <Row label="Transaction" value={entry.transaction} /> : null}
              </dl>

              {/* The other half of the receipt, and the only half that is not
                  Veyra's word. Postgres is a record Veyra owns; this one anyone
                  can read off the chain and compare against what the page
                  claims. */}
              {entry.arcProof ? (
                <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                  Recorded on Arc ·{" "}
                  <a
                    href={entry.arcProof.explorerUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-link underline underline-offset-4"
                  >
                    {entry.arcProof.transaction
                      ? `${entry.arcProof.transaction.slice(0, 10)}…${entry.arcProof.transaction.slice(-6)}`
                      : `receipt ${entry.arcProof.receiptId.slice(0, 10)}…`}
                  </a>{" "}
                  — who paid, who was paid, how much, and the hashes of what was asked and what
                  came back. This is {BRAND.name}&apos;s own attestation: {BRAND.name} decided the
                  verdict and signed it. What Arc adds is that the record cannot be quietly
                  changed and anyone can read it back without asking {BRAND.name}.
                </p>
              ) : entry.status === "verified" ? (
                <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                  Not on Arc yet. The purchase and its check stand either way — a chain that could
                  not be reached never takes away a result somebody paid for.
                </p>
              ) : null}

              {entry.reading ? (
                <details className="mt-3">
                  <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                    What {brief.agent.name} made of it
                  </summary>
                  <div className="mt-3 space-y-3 border-l border-border/60 pl-4">
                    <div>
                      <Label>What changed</Label>
                      <p className="mt-1.5 text-sm leading-relaxed text-foreground">
                        {entry.reading.whatChanged}
                      </p>
                    </div>
                    {entry.reading.whyItMatters ? (
                      <div>
                        <Label>Why it matters</Label>
                        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                          {entry.reading.whyItMatters}
                        </p>
                      </div>
                    ) : null}
                    {entry.reading.watchNext ? (
                      <div>
                        <Label>What {brief.agent.name} suggests watching next</Label>
                        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                          {entry.reading.watchNext}
                        </p>
                      </div>
                    ) : null}
                    <div>
                      <Label>Source and verification</Label>
                      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                        {entry.reading.provenance}
                      </p>
                    </div>
                  </div>
                </details>
              ) : entry.failure ? (
                <p className="mt-3 text-sm leading-relaxed text-state-warn">{entry.failure}</p>
              ) : null}
              </details>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

/**
 * What Nova learned, each piece of it retractable.
 *
 * A dismissed announcement now teaches a topic picked from its headline, and
 * the pick is a guess. A guess nobody can take back is a permanent demotion of
 * everything on that topic, so every entry carries its own way out.
 */
function Learned({ entries, onForget, counted = false }: {
  entries: NovaMemory[]; onForget: (memoryId: string) => void; counted?: boolean;
}) {
  return <span className="flex flex-wrap justify-end gap-1.5">{entries.map((entry) => (
    <span key={entry.memoryId} className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5">
      {counted && entry.supportCount > 1 ? `${entry.summary} ×${entry.supportCount}` : entry.summary}
      <button type="button" onClick={() => onForget(entry.memoryId)} aria-label={`Forget “${entry.summary}”`} title="Forget this"
        className="-mr-1 px-1 text-muted-foreground hover:text-foreground">×</button>
    </span>
  ))}</span>;
}

/**
 * How the event bears on the owner's own words, in theirs.
 *
 * The three are the whole set a plan may claim. A reading that could name
 * none of them carries no plan at all, which is the card saying the event is
 * real and asks the owner for nothing -- the answer that used to come out as
 * a suggestion to go and look at something.
 */
const PLAN_RELATION: Record<string, string> = {
  decides: "Bears on a choice you left open:",
  requires: "Applies to something you told Nova you use:",
  supersedes: "Changes something you recorded as done:",
};

function ReadingCoverageLine({ coverage }: { coverage: ValueAssessment["coverage"] }) {
  const sentence = coverageSentence(coverage);
  if (!sentence) return null;
  const whole = !coverage?.cut && coverage?.sentencesRead === coverage?.sentencesKept;
  return <p className={`text-xs ${whole ? "text-muted-foreground" : "text-state-warn"}`}>{sentence}</p>;
}

/**
 * A stored reading, and how far it can still be trusted.
 *
 * `context` is what a reading started right now would be given, and `rules`
 * the edition that would produce it. A paragraph written against neither is
 * not wrong so much as answering an older question, and the difference
 * matters most exactly when it is invisible -- the card looks identical.
 *
 * `unrefreshed` says the owner just asked for a new reading and did not get
 * one. What follows is then the earlier text, and it says so.
 */
function PublicReading({ signal, goal, context = [], unrefreshed = false }: {
  signal: NovaSignal; goal?: string | null; context?: string[]; unrefreshed?: boolean;
}) {
  const analysis = assessmentOf(signal);
  const valid = analysis && analysis.goal === goal;
  const subject = signal.evidence.subject as { url?: string; publicMaterial?: { url: string } } | undefined;
  const source = signal.evidence.publicMaterial as { url?: string } | undefined;
  const url = source?.url ?? subject?.publicMaterial?.url ?? subject?.url;
  const safeUrl = url && /^https:\/\//i.test(url) ? url : null;
  if (!valid) return <div className="mt-3 text-sm text-muted-foreground">{safeUrl ? <a href={safeUrl} target="_blank" rel="noreferrer" className="text-accent underline">Open original source ↗</a> : null}{analysis ? <p>The goal changed. Review this event against your current goal.</p> : null}</div>;
  const againstOlderContext = !readAgainst(analysis.projectContext ?? null, context);
  const againstOlderRules = (analysis.rules ?? 0) !== READING_RULES;
  return <div className="mt-4 space-y-3 border-t pt-4 text-sm">
    <p className="text-xs text-muted-foreground">
      Public-source analysis · no wallet charge · {analysis.writtenBy} · read {new Date(analysis.generatedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
      {safeUrl ? <> · <a href={safeUrl} target="_blank" rel="noreferrer" className="text-accent underline">Open original ↗</a></> : null}
    </p>
    {/* How much of the article the reading stands on. Said on every reading,
        because a reading of an opening looks exactly like a reading of an
        article, and it is only the second that the card claims to be. */}
    <ReadingCoverageLine coverage={analysis.coverage} />
    {unrefreshed ? <p className="text-sm text-state-warn">Not re-read just now. What follows is the earlier reading, written {new Date(analysis.generatedAt).toLocaleString()}.</p> : null}
    {againstOlderContext || againstOlderRules ? <p className="text-xs text-state-warn">
      Written {againstOlderContext ? "before your project facts last changed" : "under an earlier edition of Nova’s reading rules"}. Reassess it for the project as it stands.
    </p> : null}
    <p><strong>What changed:</strong> {analysis.whatChanged}</p>
    <p><strong>Why it matters to your goal:</strong> {analysis.whyItMatters}</p>
    {analysis.relativeToWork ? <p><strong>Against what you already have:</strong> {analysis.relativeToWork}</p> : null}
    {/* The work, where there is work. A one-line step and a four-part plan of
        the same step on one card is the card saying it twice, so the plan
        replaces the line rather than joining it. */}
    {analysis.plan ? <div className="rounded-lg border p-3">
      <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Proposed work</p>
      {/* Empty only on a reading stored before a plan had to stand on
          something; the staleness banner above already says so. */}
      {analysis.plan.established.length
        ? <><p className="mt-2"><strong>{PLAN_RELATION[analysis.plan.relation] ?? "Building on what you confirmed:"}</strong></p>
            <ul className="mt-1 space-y-1 text-muted-foreground">{analysis.plan.established.map((statement, index) => <li key={index}>— {statement}</li>)}</ul></>
        : null}
      <p className="mt-2"><strong>Not established:</strong> {analysis.plan.unverified}</p>
      <p className="mt-2"><strong>Do this:</strong> {analysis.plan.action}</p>
      <p className="mt-2 text-xs text-muted-foreground">Proposed work, not a completed check. Nova reads public sources; it has not seen your code.</p>
    </div> : <p className="text-muted-foreground">{analysis.significant
      ? "Nothing here for you to do. It is a real change in what you track, and it does not bear on anything you have confirmed about your project — so Nova is reporting it, not proposing work."
      : "Held back: this material does not establish a significant change for your goal."}</p>}
    {analysis.contextProposal ? <p className="text-muted-foreground">Nova thinks this changes your project context: “{analysis.contextProposal.statement}”. Confirm or reject it under My Agent; it is not treated as true until you do.</p> : null}
    {analysis.projectContext?.length ? <details><summary className="cursor-pointer text-xs text-muted-foreground">Read against {analysis.projectContext.length} project {analysis.projectContext.length === 1 ? "fact" : "facts"} you confirmed</summary><ul className="mt-2 space-y-1 text-xs text-muted-foreground">{analysis.projectContext.map((statement, index) => <li key={index}>{statement}</li>)}</ul></details> : null}
    {analysis.gap ? <div className="rounded-lg border p-3"><p><strong>Still unknown:</strong> {analysis.gap.missing}</p><p className="mt-2"><strong>Useful result to seek:</strong> {analysis.gap.expectedResult}</p><p className="mt-2 text-xs text-muted-foreground">An open question is not proof that a paid service is needed. Review the sources first.</p></div> : <p className="text-muted-foreground">No additional paid research need identified.</p>}
    {analysis.sourcesUnavailable?.length ? <p className="text-state-warn">Could not read: {analysis.sourcesUnavailable.join(", ")}. Coverage is incomplete.</p> : null}
    <details><summary className="cursor-pointer">Sources and supporting excerpts</summary><ul className="mt-3 space-y-3">{analysis.citations.map((cite, i) => {
      const material = analysis.sources.find(s => s.id === cite.sourceId);
      return material ? <li key={i}><a className="text-accent underline" href={material.url} target="_blank" rel="noreferrer">{material.title} ↗</a><blockquote className="mt-1 border-l pl-3 text-muted-foreground">{cite.quote}</blockquote><p className="mt-1 text-xs text-muted-foreground">Published {material.publishedAt ? new Date(material.publishedAt).toLocaleDateString() : "date unavailable"} · read {new Date(material.fetchedAt).toLocaleString()}</p></li> : null;
    })}</ul><p className="mt-2 text-xs text-muted-foreground">Nova’s interpretation can be wrong. Quotes are matched to the source text; that does not verify every conclusion.</p></details>
  </div>;
}

function Row({
  label,
  value,
  tone = "plain",
}: {
  label: string;
  value: React.ReactNode;
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
      <dt className="min-w-0 text-sm text-muted-foreground">{label}</dt>
      <dd className={`min-w-0 max-w-[68%] break-words text-right font-mono text-sm ${toneClass}`}>{value}</dd>
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

/**
 * The one thing a person has to keep.
 *
 * Shown in full rather than masked. A key you cannot read is a key you cannot
 * write on paper, and paper is exactly where this belongs -- it is the only
 * copy that survives a cleared browser. It identifies an agent and its brief;
 * it authorises no payment, because every payment is still signed by the
 * owner's own wallet.
 */
function RecoveryKey({
  who,
  emphatic,
}: {
  who: { publicId: string; ownerSecret: string };
  emphatic: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const value = recoveryKeyFor(who);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Refused clipboard access is not a failure: the key is on screen anyway.
    }
  };

  return (
    <Panel className={emphatic ? "mb-6 border-primary/60" : "mt-4"}>
      <Label>Recovery key · use Nova on another device</Label>
      <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
        {emphatic
          ? "Save this somewhere outside this browser. It is the only way back to your agent if this browser forgets, and nobody can reissue it — the server keeps a fingerprint of it, not the key."
          : "Kept here while this browser remembers your agent. Save it somewhere else and losing the browser stops mattering."}
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <code className="field min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-lg px-3 py-2.5 font-mono text-[12.5px]">
          {value}
        </code>
        <button
          type="button"
          onClick={copy}
          className="rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </Panel>
  );
}

/** Veyra's verdict as a person reads it, not as the policy engine names it. */
const DECISION_LABEL: Record<string, string> = {
  ALLOW: "Allow",
  ALLOW_WITH_LIMITS: "Allow with limits",
  REQUIRE_EVALUATOR: "Allow, answer checked",
};

/**
 * What Veyra found, and what it would cost.
 *
 * Everything above this is free: Nova reads public catalogues and public
 * repositories, and nobody is billed for a brief. This is the one place in the
 * product where money is on the table, so it says the whole of it in four rows
 * a person can read in four seconds -- who, how much, on what rail, and what
 * Veyra decided -- before anything asks for a signature.
 *
 * The reasons underneath are not marketing. Every line is something measured in
 * the last few seconds against the live endpoint: a catalogue can claim a
 * price, only a probe can say the endpoint asked for it.
 */
function DeeperResearch({
  state,
  agentName,
  fallbackHref,
  walletAddress,
  onConnect,
  connecting,
  walletReady,
  onPay,
  refusedAt,
  onLookAgain,
  prior,
}: {
  state: ResearchState;
  agentName: string;
  fallbackHref: string;
  walletAddress: string | null;
  onConnect: () => void;
  connecting: boolean;
  /** False only once detection has settled on there being no wallet here.
   *  Stays true while the answer is still open. See NoWalletHere. */
  walletReady: boolean;
  onPay: (acknowledge?: string) => void;
  /** When Veyra last looked and declined, so an old no reads as an old no. */
  refusedAt?: string | null;
  onLookAgain: () => void;
  /** What this agent already paid to learn about this counterparty. */
  prior?: { tone: "good" | "warn" | "idle"; sentence: string } | null;
}) {
  if (state.stage === "looking") {
    return (
      <Section>
        <p className="mt-2 text-sm text-muted-foreground">
          {BRAND.name} is checking who could answer this, and what they charge…
        </p>
      </Section>
    );
  }

  if (state.stage === "refused") {
    /* A refusal is kept, so it has to carry its own age and a way out. Prices
       move, rails appear, and a seller that could not be paid in the morning
       sometimes can be by the evening -- a permanent no with no button would
       turn one bad moment into a card that is wrong forever. */
    return (
      <Section>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{state.detail}</p>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <Verb onClick={onLookAgain}>Look again</Verb>
          {refusedAt ? (
            <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70">
              checked {formatAway(refusedAt)}
            </span>
          ) : null}
        </div>
      </Section>
    );
  }

  if (state.stage === "failed" && !state.proposal) {
    return (
      <Section>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{state.detail}</p>
        <Link href={fallbackHref} className="mt-3 inline-block text-sm text-link underline underline-offset-4">
          Choose a counterparty yourself
        </Link>
      </Section>
    );
  }

  /* Every remaining stage carries the proposal; the one that may not was
     returned above. Narrowed explicitly rather than asserted, so adding a stage
     that forgets it fails here instead of at somebody's breakfast. */
  const proposal = "proposal" in state ? state.proposal : null;
  if (!proposal) return null;
  const cost = `$${formatUsdc(proposal.costUsdc)}`;

  /* Once money has moved, the price and the trust score are history. What
     matters is what came back and whether it held up, so the proposal collapses
     to one line and the result takes the space. */
  if (state.stage === "settled") {
    return <Outcome investigation={state.investigation} proposal={proposal} agentName={agentName} />;
  }

  return (
    <Section>
      {/* Two different sentences, because they are two different things.
          Research is bought from whoever does it best, and the card says whose
          work it is. An interaction is a deal with one named counterparty and
          nobody else was considered -- saying "picked the best of 8" there
          would describe a choice that was never Veyra's to make. */}
      {proposal.actionType === "interact_with_subject" ? (
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          This is {proposal.subjectLabel ?? proposal.provider} itself, not a report about it.
          {" "}{agentName} would ask it:{" "}
          <span className="text-foreground">{proposal.question}</span>
        </p>
      ) : (
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {BRAND.name} looked at{" "}
          <span className="font-mono text-foreground">{proposal.probed}</span>{" "}
          {proposal.probed === 1 ? "provider" : "providers"} and picked the best one this wallet
          can pay. {agentName} would ask: <span className="text-foreground">{proposal.question}</span>
        </p>
      )}

      {proposal.researchNeed ? <div className="mt-4 space-y-2 text-sm">
        <p><strong>Goal:</strong> {proposal.researchNeed.goal}</p>
        <p><strong>What the public material does not answer:</strong> {proposal.researchNeed.missing}</p>
        <p><strong>Requested result:</strong> {proposal.researchNeed.expectedResult}</p>
        <p className="text-xs text-muted-foreground">This tool accepts the question; its answer may still be incomplete. Veyra checks whether the spend is permitted, not whether it is worth buying.</p>
      </div> : null}
      <dl className="mt-4 space-y-0">
        {proposal.performedVia ? (
          /* Whose work this is. The subject of the question and the party being
             paid are different here, and a card that prints one provider name
             lets a reader believe they are the same. */
          <Row label="Research performed via" value={proposal.performedVia} />
        ) : null}
        <Row label={proposal.performedVia ? "Paid to" : "Provider"} value={proposal.provider} />
        <Row label="Cost" value={cost} />
        <Row label="Trust" value={`${proposal.trustScore}/100`} />
        <Row
          label="Payment"
          value={proposal.paymentLabel}
          tone={proposal.funding === "wallet" ? "good" : "warn"}
        />
        {/* Veyra's own verdict, on the same list as the price, because a person
            deciding whether to pay is weighing the two against each other and
            should not have to hold one of them in their head. Toned, so a
            counterparty nobody has ever paid does not read like one Veyra
            vouches for. */}
        <Row
          label={BRAND.name}
          value={DECISION_LABEL[proposal.decision] ?? proposal.decision}
          tone={proposal.decision === "ALLOW" ? "good" : "warn"}
        />
      </dl>

      <p className="mt-4 text-sm leading-relaxed text-foreground">{proposal.verdict}</p>
      {proposal.routingNote ? (
        <p className="mt-2 text-xs leading-relaxed text-state-warn">{proposal.routingNote}</p>
      ) : null}

      {/* What happened last time this agent paid this seller, before the
          signature -- the only moment it can change anything. Every other
          number on this card comes from a catalogue or a probe; this one was
          bought, and it is the only evidence here that cost the person money
          to obtain. */}
      {prior ? (
        <p
          className={`mt-2 text-xs leading-relaxed ${
            prior.tone === "good"
              ? "text-state-good"
              : prior.tone === "warn" ? "text-state-warn" : "text-muted-foreground"
          }`}
        >
          {prior.sentence}
        </p>
      ) : null}

      {proposal.verifiedAfterPaying ? (
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {BRAND.name} will check the answer against what this endpoint says it returns, after
          the payment and before {"it"} counts as a result.
        </p>
      ) : null}

      {proposal.reasons.length > 0 ? (
        <ul className="mt-3 space-y-1">
          {proposal.reasons.map((reason) => (
            <li key={reason} className="text-xs text-muted-foreground">
              <span className="mr-2 font-mono text-state-good">✓</span>{reason}
            </li>
          ))}
        </ul>
      ) : null}

      {state.stage === "changed" ? (
        <MarketChanged
          changes={state.changes}
          detail={state.detail}
          costUsdc={state.costUsdc}
          onConfirm={() => onPay(state.termsHash)}
        />
      ) : null}

      {state.stage === "failed" ? (
        <p className="mt-4 border-t border-border/60 pt-3 text-sm leading-relaxed text-state-warn">
          {state.detail}
        </p>
      ) : null}

      {state.stage === "signing" ? <SigningPanel terms={state.terms} note={state.note} /> : null}

      <div className="mt-4 flex flex-wrap items-center gap-4">
        {/* A payment the wallet cannot make is refused before this card is
            drawn. The check is repeated here because the cost of missing it is
            a signature somebody gave for nothing, and a disabled button that
            says why is a better failure than an enabled one that does not. */}
        {(state.stage === "ready" || state.stage === "failed") && proposal.payableNow === false ? (
          <p className="text-sm leading-relaxed text-state-warn">
            {proposal.paymentLabel} — this wallet cannot pay that right now, so there is nothing
            here to sign.
          </p>
        ) : state.stage === "ready" || state.stage === "failed" ? (
          walletAddress ? (
            <button
              type="button"
              onClick={() => onPay()}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90"
            >
              {state.stage === "failed" ? `Try again — ${cost}` : `Pay ${cost} with your wallet`}
            </button>
          ) : walletReady ? (
            <button
              type="button"
              onClick={onConnect}
              disabled={connecting}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-60"
            >
              {connecting ? "Opening your wallet…" : `Connect a wallet to pay ${cost}`}
            </button>
          ) : (
            <NoWalletHere what={`this ${cost} payment`} />
          )
        ) : null}

        {state.stage === "approving" ? (
          <span className="text-sm text-muted-foreground">
            {BRAND.name} is reading the market again before anything is signed…
          </span>
        ) : null}
        {state.stage === "settling" ? (
          <span className="text-sm text-muted-foreground">
            Paid. Waiting for the answer, and checking it…
          </span>
        ) : null}

        {state.stage === "ready" || state.stage === "failed" ? (
          <span className="text-xs text-muted-foreground">
            You sign it yourself. {BRAND.name} never holds your money.
          </span>
        ) : null}
      </div>

      {state.stage === "ready" || state.stage === "failed" ? (
        <Link href={fallbackHref} className="mt-3 inline-block text-xs text-link underline underline-offset-4">
          Or choose a counterparty yourself
        </Link>
      ) : null}
    </Section>
  );
}

function Section({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-5 border-t border-border/60 pt-4">
      <Label>Deeper research</Label>
      {children}
    </div>
  );
}

/**
 * The market moved between the price somebody read and the signature they were
 * about to give.
 *
 * This panel is the reason the rest of the file exists. Nothing has been paid,
 * nothing has been substituted for something cheaper, and no button here is the
 * one that was pressed a moment ago -- confirming is a second, separate act
 * against numbers that are on screen at the time it is made.
 */
function MarketChanged({
  changes,
  detail,
  costUsdc,
  onConfirm,
}: {
  changes: TermsChange[];
  detail: string;
  costUsdc: number;
  onConfirm: () => void;
}) {
  return (
    <div className="mt-4 rounded-lg border border-state-warn/40 bg-state-warn/5 p-4">
      <p className="text-sm font-medium text-state-warn">
        The market changed since {BRAND.name} checked it.
      </p>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{detail}</p>

      {changes.length > 0 ? (
        <dl className="mt-3 space-y-0">
          {changes.map((change) => (
            <div
              key={change.field}
              className="flex items-baseline justify-between gap-4 border-b border-border/40 py-2 last:border-b-0"
            >
              <dt className="text-xs text-muted-foreground">{change.label}</dt>
              <dd className="text-right font-mono text-xs">
                <span className="text-muted-foreground line-through">{change.was}</span>
                <span className="mx-2 text-muted-foreground">→</span>
                <span className="text-foreground">{change.now}</span>
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={onConfirm}
          className="rounded-lg border border-state-warn/60 px-4 py-2 text-sm font-semibold text-state-warn transition hover:bg-state-warn/10"
        >
          Pay ${formatUsdc(costUsdc)} on the new terms
        </button>
        <span className="text-xs text-muted-foreground">
          Or leave it. Nothing has been paid.
        </span>
      </div>
    </div>
  );
}

/** What the wallet is about to be shown, shown first. The wallet names one
 *  recipient, one amount and one nonce, and the authorization expires; it is
 *  not an allowance the seller can draw on again. */
function SigningPanel({ terms, note }: { terms: SigningTerms | null; note: string | null }) {
  if (note) {
    return <p className="mt-4 border-t border-border/60 pt-3 text-sm text-state-warn">{note}</p>;
  }
  if (!terms) {
    return (
      <p className="mt-4 border-t border-border/60 pt-3 text-sm text-muted-foreground">
        {BRAND.name} cleared it. Your wallet is about to ask you to sign.
      </p>
    );
  }
  return (
    <div className="mt-4 border-t border-border/60 pt-3">
      <p className="text-sm text-muted-foreground">
        Your wallet will show exactly this. Nothing else can be drawn against it.
      </p>
      <dl className="mt-3 space-y-0">
        <Row label="Amount" value={`$${formatUsdc(terms.amountUsdc)}`} />
        <Row label="To" value={terms.recipient} />
        <Row label="Chain" value={String(terms.chainId)} />
        <Row label="Expires" value={new Date(terms.validBefore * 1000).toLocaleTimeString()} />
      </dl>
    </div>
  );
}

/**
 * What the money bought.
 *
 * Three terminal states, and they are not softened into each other. A payment
 * that went through and whose answer failed the check its own tier demanded is
 * not a completed investigation with a note attached: the money is gone and the
 * result is not trustworthy, and a person is entitled to read those as two
 * facts rather than one hedge.
 */
function Outcome({
  investigation,
  proposal,
  agentName,
}: {
  investigation: NovaInvestigation;
  proposal: NovaResearchProposal;
  agentName: string;
}) {
  const paid = investigation.paidUsdc ?? 0;
  const verified = investigation.status === "verified";
  const paidUnverified = investigation.status === "paid_unverified";

  return (
    <div className="mt-5 border-t border-border/60 pt-4">
      <Label>
        {verified ? "Result" : paidUnverified ? "Paid, not verified" : "Nothing was paid"}
      </Label>

      <p className="mt-2 text-sm leading-relaxed text-foreground">{investigation.question}</p>

      <dl className="mt-3 space-y-0">
        <Row label="Provider" value={investigation.provider ?? proposal.provider} />
        {paid > 0 ? (
          <Row label="Paid" value={`$${formatUsdc(paid)}`} />
        ) : investigation.authorisedUsdc ? (
          /* The amount is named even though it did not move. "Nothing was paid"
             with no number is a card nobody can check against their wallet,
             and checking is the first thing a person does after a payment
             screen tells them something went wrong. */
          <Row
            label="You signed for"
            value={`$${formatUsdc(investigation.authorisedUsdc)} — still in your wallet`}
            tone="idle"
          />
        ) : null}
        {investigation.verification ? (
          /* "Verification PASS" was read as "this answer is correct", which is
             not what any of the nine checks behind it establish: they compare
             the payment to the quote and the response to the shape the seller
             published. Naming what was checked keeps the strong word for the
             claim it can actually carry. */
          <Row
            label="Delivery check"
            value={investigation.verification.verdict}
            tone={investigation.verification.verdict === "PASS"
              ? "good"
              : investigation.verification.verdict === "FAIL" ? "warn" : "idle"}
          />
        ) : null}
        {investigation.executionPublicId ? (
          <Row label="Execution" value={investigation.executionPublicId} />
        ) : null}
        {investigation.transaction ? (
          <Row label="Transaction" value={investigation.transaction} />
        ) : null}
      </dl>

      {investigation.failure ? (
        <p className="mt-3 text-sm leading-relaxed text-state-warn">{investigation.failure}</p>
      ) : null}

      {!verified && investigation.result !== null && investigation.result !== undefined ? (
        /* What the endpoint said, verbatim, under what Veyra made of it. A
           refusal paraphrased and then discarded is how an afternoon goes into
           reconstructing something one line of the response already explained.

           It used to render only a string. A refused payment comes back as raw
           text and showed; a payment that settled and then failed comes back
           parsed, so the one case where the money is actually gone was the one
           case that rendered nothing at all. */
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
            What the endpoint sent back
          </summary>
          <pre className="mt-2 max-h-48 overflow-auto rounded-lg border border-border/60 bg-background/40 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
            {typeof investigation.result === "string"
              ? investigation.result
              : JSON.stringify(investigation.result, null, 2)}
          </pre>
        </details>
      ) : null}

      {/* What was bought, read back.
          A verified purchase used to end at a <pre> full of JSON: Veyra had
          priced it, cleared it and checked it, and then handed over the raw
          body, which is where the flow stops looking like an agent doing work.
          The prose is a model's; the provenance line under it is Veyra's own,
          composed from facts rather than asked of the model. They are kept
          visibly apart because one is a reading and the other is evidence. */}
      {verified && investigation.reading ? (
        <div className="mt-4 space-y-3 border-t border-border/60 pt-4">
          <div>
            <Label>What changed</Label>
            <p className="mt-1.5 text-sm leading-relaxed text-foreground">
              {investigation.reading.whatChanged}
            </p>
          </div>
          {investigation.reading.whyItMatters ? (
            <div>
              <Label>Why it matters</Label>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                {investigation.reading.whyItMatters}
              </p>
            </div>
          ) : null}
          {investigation.reading.watchNext ? (
            <div>
              <Label>What {agentName} suggests watching next</Label>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                {investigation.reading.watchNext}
              </p>
            </div>
          ) : null}
          <div>
            <Label>Source and verification</Label>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              {investigation.reading.provenance}
            </p>
            {investigation.reading.writtenBy ? (
              <p className="mt-1 font-mono text-[11px] text-muted-foreground/70">
                Read back by {investigation.reading.writtenBy}. The words above are its reading of
                what the seller sent; the line before them is {BRAND.name}&apos;s own check.
              </p>
            ) : null}
          </div>
        </div>
      ) : verified ? (
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          {BRAND.name} checked the answer against what this endpoint declares it returns, after
          the payment. It is in what {agentName} knows, with the execution behind it.
        </p>
      ) : null}

      {verified && investigation.result !== null && investigation.result !== undefined ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
            What the endpoint sent back
          </summary>
          <pre className="mt-2 max-h-80 overflow-auto rounded-lg border border-border/60 bg-background/40 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
            {typeof investigation.result === "string"
              ? investigation.result
              : JSON.stringify(investigation.result, null, 2)}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

type VerdictState = { learned: NovaLearned | null; rated: boolean; reason: NovaReason | null; note: string | null };

/**
 * What a verdict did, and -- for a rated reading -- why it was given.
 *
 * The reasons are offered only where the server kept the rating, which is a
 * reading judged against the goal as it stands. Elsewhere there is no reading
 * for a reason to be about, and the chips would record nothing.
 */
function Verdict({ verdict, state, onExplain }: {
  verdict: NovaFeedback;
  state: VerdictState | undefined;
  onExplain: (change: { reason?: NovaReason | null; note?: string | null }) => void;
}) {
  if (!state) return <p role="status" className="mt-2 text-xs text-muted-foreground">Saving…</p>;
  const reasons: readonly NovaReason[] = state.rated && (verdict === "useful" || verdict === "not_interesting")
    ? NOVA_REASONS[verdict]
    : [];
  return (
    <div className="mt-2">
      <p role="status" className="text-xs text-muted-foreground">{learnedSentence(state.learned, verdict)}</p>
      {reasons.length > 0 ? (
        <div className="mt-3">
          <p className="text-xs text-muted-foreground">
            Why? Optional. Kept for reviewing Nova&apos;s work; it does not change what you are shown.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {reasons.map((reason) => (
              <button
                key={reason}
                type="button"
                aria-pressed={state.reason === reason}
                onClick={() => onExplain({ reason: state.reason === reason ? null : reason })}
                className={`rounded-md border px-2 py-1 text-xs ${state.reason === reason ? "border-foreground text-foreground" : "text-muted-foreground"}`}
              >
                {REASON_LABEL[reason]}
              </button>
            ))}
          </div>
          <NoteField saved={state.note} onSave={(note) => onExplain({ note: note.trim() || null })} />
        </div>
      ) : null}
    </div>
  );
}

function NoteField({ saved, onSave }: { saved: string | null; onSave: (note: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  if (!editing) {
    return (
      <div className="mt-2 text-xs">
        {saved ? <p className="text-muted-foreground">&ldquo;{saved}&rdquo;</p> : null}
        <button
          type="button"
          onClick={() => { setText(saved ?? ""); setEditing(true); }}
          className="mt-1 text-link underline underline-offset-4"
        >
          {saved ? "Edit your note" : "Add a note in your own words"}
        </button>
      </div>
    );
  }
  return (
    <form
      className="mt-2 flex flex-col gap-2 sm:flex-row"
      onSubmit={(event) => { event.preventDefault(); onSave(text); setEditing(false); }}
    >
      <input
        value={text}
        onChange={(event) => setText(event.target.value)}
        maxLength={NOTE_MAX}
        aria-label="Your note"
        placeholder="What was right or wrong about it"
        className="min-w-0 flex-1 rounded-lg border bg-background px-3 py-2 text-sm"
      />
      <button type="submit" className="rounded-lg border px-3 py-2 text-sm">Save note</button>
    </form>
  );
}

/** Three findings, three different defects, said as such. */
function missSentence(miss: NovaMiss, agentName: string): string {
  const detail = miss.detail;
  if (miss.finding === "observed") {
    const why = detail.status === "dismissed"
      ? "You hid it."
      : !detail.read
        ? "It was never read against your goal, so it could not reach Today."
        : detail.significant
          ? "Its reading called it significant, and the brief still did not show it."
          : "Its reading judged it not significant for your goal.";
    return `${agentName} had this: “${detail.headline}”, found ${detail.observedAt ? timeAgo(detail.observedAt) : "earlier"}. ${why} Recorded as a miss in what ${agentName} showed, not in what it reads.`;
  }
  if (miss.finding === "covered") {
    return detail.repository
      ? `${agentName} watches ${detail.repository} but has no card for this. Recorded as a reading miss.`
      : `${agentName} reads ${detail.feed} but never picked this article up. Recorded as a reading miss.`;
  }
  return `${agentName} does not read ${detail.host}. Recorded as a coverage gap. Reported gaps decide which sources get added.`;
}

/**
 * "You missed this." The only way a missed event is measured at all: nothing
 * records an event that was never observed, so the owner naming one is the
 * whole of the evidence. The link is checked here and on the server, and
 * opened by neither.
 */
function MissForm({ agentName, onReport }: { agentName: string; onReport: (url: string, note: string) => Promise<NovaMiss> }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="mt-4 block text-sm text-link underline underline-offset-4">
        Did {agentName} miss something?
      </button>
    );
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!missUrl(url)) { setProblem("Paste the full link, starting with https://."); return; }
    setBusy(true);
    setProblem(null);
    setAnswer(null);
    try {
      setAnswer(missSentence(await onReport(url.trim(), note), agentName));
      setUrl("");
      setNote("");
    } catch {
      setProblem("Could not record that. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="mt-4 space-y-3 border-t border-border/60 pt-4">
      <p className="text-xs leading-relaxed text-muted-foreground">
        A link to something {agentName} should have put in front of you. The link is not opened:{" "}
        {agentName} says what it had, and the miss is kept, because reported gaps are what decide which
        sources get added.
      </p>
      <input
        type="url"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        placeholder="https://"
        aria-label="Link to what was missed"
        className="w-full rounded-lg border bg-background px-3 py-2 text-sm"
      />
      <input
        value={note}
        onChange={(event) => setNote(event.target.value)}
        maxLength={NOTE_MAX}
        placeholder="Why it mattered (optional)"
        aria-label="Why it mattered"
        className="w-full rounded-lg border bg-background px-3 py-2 text-sm"
      />
      <button type="submit" disabled={busy} className="rounded-lg border px-4 py-2 text-sm disabled:opacity-50">
        {busy ? "Checking…" : `Tell ${agentName}`}
      </button>
      {answer ? <p role="status" className="text-sm leading-relaxed">{answer}</p> : null}
      {problem ? <p role="alert" className="text-sm text-state-warn">{problem}</p> : null}
    </form>
  );
}

/** A quiet action. These sit beside the one button that can spend money, so
 *  none of them may look like it. */
function Verb({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-sm text-muted-foreground underline decoration-transparent underline-offset-4 transition hover:text-foreground hover:decoration-current"
    >
      {children}
    </button>
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
