/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { BRAND } from "@/lib/brand";
import { INTEREST_CATALOG, MAX_INTERESTS } from "@/lib/nova/interests";
/* The same mapping the scorer uses. A third copy would be a third chance for
   the button to offer a ban the scorer does not honour. Null for the kinds
   that are not matters of taste -- a payee change, a rail change, an endpoint
   going dark -- so the button is absent rather than disabled: an offer a
   person cannot take reads as a promise the product is refusing to keep. */
import { categoryPhraseFor } from "@/lib/nova/relevance";
import type { NovaBrief, NovaFeedback, NovaInvestigation, NovaSignal } from "@/lib/nova/types";
import type { NovaResearchProposal } from "@/lib/nova/research";
import type { TermsChange } from "@/lib/nova/research-terms";
import { useArcWallet } from "@/components/wallet/use-arc-wallet";
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
  arc: "What it has earned",
};

/* Written in the second person and about the agent, not about the feature. A
   page called Memory that opens by explaining what memory is has described its
   own navigation label back to the reader. */
const VIEW_BLURB: Record<Exclude<NovaView, "today">, (name: string) => string> = {
  agent: (name) => `Who ${name} is, what it watches on your behalf, and the key that proves it is yours.`,
  memory: (name) => `${name} starts from what you told it and changes from what you do. This is the difference so far.`,
  arc: (name) => `${name} is not an identity on Arc yet. It becomes one by doing things that can be checked, not by signing up.`,
};

type Stage = "loading" | "create" | "working" | "brief";

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

/** The start of an absence, read the way a person would say it rather than the
 *  way a log would write it. */
function formatAway(iso: string): string {
  const label = timeAgo(iso);
  return label === "just now" ? "your last visit" : `your last visit ${label}`;
}

export function NovaClient({ view = "today" }: { view?: NovaView } = {}) {
  const [stage, setStage] = useState<Stage>("loading");
  const [identity, setIdentity] = useState<{ publicId: string; ownerSecret: string } | null>(null);
  const [brief, setBrief] = useState<NovaBrief | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showNoise, setShowNoise] = useState(false);

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
  /* One entry per item somebody asked Veyra to price. Keyed by signal rather
     than held as a single "current proposal" because pricing takes seconds
     against live endpoints, and a person who asks about two things should get
     two answers rather than watch the first one be replaced. */
  const [research, setResearch] = useState<Record<string, ResearchState>>({});
  /* Editing what the agent watches. Null when nobody is editing, because an
     empty array is a legitimate mid-edit state -- somebody clearing every chip
     before picking new ones -- and the two must not be the same value. */
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
    if (!response.ok) throw new Error(payload?.error?.message ?? "Nova could not be reached.");
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
        body: JSON.stringify({ interests: draftInterests }),
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
   * The two families behave differently on purpose. Rejecting something removes
   * it, because leaving it there after you said you did not want it is the
   * product arguing. Approving something keeps it and marks the card, because
   * hiding what you just called useful is the opposite of what the word means.
   */
  const say = async (signalId: string, feedback: NovaFeedback) => {
    if (!identity || !brief) return;
    const removes = feedback === "not_interesting" || feedback === "ignore_kind";

    // Applied locally first: feedback that waits for a round trip feels like it
    // did not register, and the server is the record either way.
    if (removes) {
      setBrief({
        ...brief,
        worthAttention: brief.worthAttention.filter((signal) => signal.signalId !== signalId),
      });
    } else {
      setSaid((current) => ({ ...current, [signalId]: feedback }));
    }

    try {
      await call(`/api/nova/v1/agents/${identity.publicId}/signals/${signalId}`, {
        method: "PATCH",
        ownerSecret: identity.ownerSecret,
        body: JSON.stringify({ feedback }),
      });
    } catch {
      /* Feedback that failed to record reappears in the next brief, which is
         the honest outcome: it was not written down, so it should not look as
         though it was. */
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
  const follows = preference("follows");
  const attention = brief.worthAttention;
  const agentName = brief.agent.name;
  const away = brief.whileAway;
  /* Across an absence, the blind spots are the union of every pass's. The last
     pass reading GitHub fine does not undo the four before it that could not. */
  const blind = away?.sourcesUnavailable ?? brief.lastRefresh?.sourcesUnavailable ?? [];

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
            {view !== "today"
              ? VIEW_BLURB[view](agentName)
              : attention.length > 0
                ? <>Found <span className="font-mono text-foreground">{attention.length}</span> {attention.length === 1 ? "thing" : "things"} worth your attention.</>
                : blind.length > 0
                  ? <>Could not reach {blind.join(" and ")}, so this is an incomplete look rather than a quiet day.</>
                  : <>Nothing moved across the <span className="font-mono text-foreground">{brief.lastRefresh?.subjectsChecked ?? 0}</span> things being watched for you.</>}
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

      {error ? <Notice tone="error">{error}</Notice> : null}
      {justCreated && identity ? <RecoveryKey who={identity} emphatic /> : null}
      {brief.wokeFromDormancy ? (
        <Notice tone="warn">
          {agentName} had stopped watching: nobody had opened this brief in a while, and an
          agent nobody reads is not worth the requests. It is watching again from now, but
          there is a gap in what follows.
        </Notice>
      ) : null}
      {blind.length > 0 && attention.length > 0 ? (
        <Notice tone="warn">
          Could not reach {blind.join(" and ")} this time. What is below is real, but it is not
          everything.
        </Notice>
      ) : null}

      {view === "today" ? (
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

              <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-3">
                {research[signal.signalId] ? null : (
                  <button
                    type="button"
                    onClick={() => price(signal)}
                    className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90"
                  >
                    Let {brief.agent.name} investigate
                  </button>
                )}

                {/* Nothing for "investigating": the priced proposal below is the
                    acknowledgement, and a chip above it saying so would be the
                    screen telling a person something the screen is already
                    showing them. */}
                {said[signal.signalId] === "useful" || said[signal.signalId] === "follow" ? (
                  <span className="font-mono text-[11px] uppercase tracking-wider text-state-good">
                    {said[signal.signalId] === "follow" ? "following" : "marked useful"}
                  </span>
                ) : said[signal.signalId] === "investigating" ? null : (
                  <>
                    <Verb onClick={() => say(signal.signalId, "useful")}>Useful</Verb>
                    <Verb onClick={() => say(signal.signalId, "follow")}>
                      Follow {signal.subjectLabel ?? "this"}
                    </Verb>
                    <Verb onClick={() => say(signal.signalId, "not_interesting")}>
                      Not interesting
                    </Verb>
                    {categoryPhraseFor(signal.kind) ? (
                      <Verb onClick={() => say(signal.signalId, "ignore_kind")}>
                        Ignore {categoryPhraseFor(signal.kind)}
                      </Verb>
                    ) : null}
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
                  onPay={(acknowledge) => void pay(signal, acknowledge)}
                  refusedAt={signal.refusal?.at ?? null}
                  onLookAgain={() => void price(signal)}
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
            <Row label="Worth your attention" value={String(away?.signalsKept ?? brief.lastRefresh?.signalsKept ?? 0)} />
            <Row label="Held back as noise" value={String(away?.signalsAsNoise ?? brief.lastRefresh?.signalsAsNoise ?? 0)} />
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

      {view === "agent" ? (
        <Panel className="mt-4">
          <Label>What {brief.agent.name} watches</Label>

          {draftInterests === null ? (
            <>
              <dl className="mt-4 space-y-0">
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
                onClick={() => { setInterestsNote(null); setDraftInterests(brief.agent.interests); }}
                className="field mt-5 w-full rounded-lg px-4 py-3 text-left text-sm transition hover:border-primary/60 hover:text-foreground"
              >
                <span className="font-medium text-foreground">Change what it watches</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Add or remove interests. {brief.agent.name} keeps its memory and everything you
                  have paid for.
                </span>
              </button>
            </>
          ) : (
            <>
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
                  where the sellers are, which today is Base — Circle&apos;s catalogue lists none
                  on Arc. Each card says which chain it pays on.
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
                {brief.watchlist.map((signal) => (
                  <li key={signal.signalId} className="border-t border-border/40 pt-3 first:border-t-0 first:pt-0">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="text-sm text-foreground">{signal.headline}</span>
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
                        onPay={(acknowledge) => void pay(signal, acknowledge)}
                        refusedAt={signal.refusal?.at ?? null}
                        onLookAgain={() => void price(signal)}
                      />
                    ) : (
                      <div className="mt-2">
                        <Verb onClick={() => price(signal)}>
                          Let {brief.agent.name} investigate
                        </Verb>
                      </div>
                    )}
                  </li>
                ))}
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

      {view === "memory" ? (
      <Panel className="mt-4">
        <Label>What {brief.agent.name} knows about you</Label>
        <dl className="mt-4 space-y-0">
          {follows.length > 0 ? (
            <Row label="You follow" value={follows.map((entry) => entry.summary).join(" · ")} tone="good" />
          ) : null}
          {favours.length > 0 ? (
            <Row label="You find useful" value={favours.map((entry) => entry.summary).join(" · ")} />
          ) : null}
          {ignores.length > 0 ? (
            /* Said more than once is shown as said more than once. A preference
               asserted from a single click is a guess, and presenting it with
               the same confidence as one a person has repeated five times is
               how "what Nova knows about you" stops being true. */
            <Row
              label="You usually ignore"
              value={ignores
                .map((entry) => entry.supportCount > 1 ? `${entry.summary} ×${entry.supportCount}` : entry.summary)
                .join(" · ")}
            />
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

      {view === "memory" ? <Receipts brief={brief} /> : null}

      {view === "arc" ? (
        <>
          <Standing brief={brief} />
          {/* Said here because the brief cannot avoid raising it: somebody picks
              Arc as an interest, gets shown a payment, and the payment settles
              on Base. That looks like a contradiction until you know which half
              of the transaction Arc holds, and nobody should have to guess. */}
          <Panel className="mt-4">
            <Label>Why the money is not on Arc</Label>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              Circle&apos;s service catalogue lists{" "}
              <span className="font-mono text-foreground">1,139</span> paid endpoints and not one
              of them is on Arc, so when {agentName} buys an answer it pays where the sellers
              are — usually Base, and the card says so before you sign.
            </p>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              What happens on Arc is the part {BRAND.name} is responsible for: the decision.
              Every authorisation is signed against the Trust Gate on Arc and verified there
              before a wallet is ever asked, so the record of what was allowed, for how much and
              to whom lives on Arc even when the payment does not. That is also where this
              agent&apos;s identity and standing will be, once there is a history worth pointing
              at.
            </p>
          </Panel>
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

  /* What is actually on Arc, as opposed to what Veyra says about itself. The
     three numbers above are read out of Veyra's own database; these are
     transactions anyone can fetch from the chain and check. Keeping them in
     separate blocks is the point -- a page that mixed them would be asking to
     be believed about the half that needs no belief. */
  const proofs = brief.investigations.filter((entry) => entry.arcProof);

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
                  ${(entry.paidUsdc ?? 0).toFixed(4)}
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

  const spent = settled.reduce((total, entry) => total + (entry.paidUsdc ?? 0), 0);
  const verified = settled.filter((entry) => entry.status === "verified").length;

  return (
    <Panel className="mt-4">
      <Label>What {brief.agent.name} has bought</Label>
      <dl className="mt-4 space-y-0">
        <Row label="Spent" value={`$${spent.toFixed(4)}`} />
        <Row
          label="Passed the delivery check"
          value={`${verified} of ${settled.length}`}
          tone={verified > 0 ? "good" : "idle"}
        />
      </dl>

      <ul className="mt-5 space-y-5">
        {settled.map((entry) => {
          const proposal = entry.proposal as { subjectLabel?: string | null } | null;
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
                {/* Named either way. An authorisation that took nothing still
                    has a number on it, and that number is the first thing
                    somebody checks against their wallet. */}
                <Row
                  label={paid > 0 ? "Paid" : "You signed for"}
                  value={paid > 0
                    ? `$${paid.toFixed(4)}`
                    : `$${(entry.authorisedUsdc ?? 0).toFixed(4)} — still in your wallet`}
                  tone={paid > 0 ? "plain" : "idle"}
                />
                {entry.executionPublicId ? (
                  <Row label="Execution" value={entry.executionPublicId} />
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
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

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
      <Label>Recovery key</Label>
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
  onPay,
  refusedAt,
  onLookAgain,
}: {
  state: ResearchState;
  agentName: string;
  fallbackHref: string;
  walletAddress: string | null;
  onConnect: () => void;
  connecting: boolean;
  onPay: (acknowledge?: string) => void;
  /** When Veyra last looked and declined, so an old no reads as an old no. */
  refusedAt?: string | null;
  onLookAgain: () => void;
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
  const cost = `$${proposal.costUsdc.toFixed(4)}`;

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
          ) : (
            <button
              type="button"
              onClick={onConnect}
              disabled={connecting}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-60"
            >
              {connecting ? "Opening your wallet…" : `Connect a wallet to pay ${cost}`}
            </button>
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
          Pay ${costUsdc.toFixed(4)} on the new terms
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
        <Row label="Amount" value={`$${terms.amountUsdc.toFixed(4)}`} />
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
          <Row label="Paid" value={`$${paid.toFixed(4)}`} />
        ) : investigation.authorisedUsdc ? (
          /* The amount is named even though it did not move. "Nothing was paid"
             with no number is a card nobody can check against their wallet,
             and checking is the first thing a person does after a payment
             screen tells them something went wrong. */
          <Row
            label="You signed for"
            value={`$${investigation.authorisedUsdc.toFixed(4)} — still in your wallet`}
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
