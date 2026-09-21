/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Where the work already is.
 *
 * A goal says where somebody is going. Without a second sentence saying where
 * they are, the best a reading can do is announce that a thing exists -- which
 * is how a release note about sponsored transactions reaches somebody who
 * shipped against it two months ago, labelled as news.
 *
 * Nova may propose a statement and may never confirm one. A model's inference
 * about a project is a question for the owner; written in as fact it becomes,
 * a week later, indistinguishable from something the owner said, and every
 * later reading is judged against it. Confirmation is a separate act by the
 * only party who knows.
 */

export const PROJECT_CONTEXT_LIMITS = {
  /** One statement of state. Long enough for "ERC-8183 escrow is tested on Arc
   *  Testnet", short enough that a dozen of them stay a working memory. */
  statement: 200,
  /** Compact by design. A context nobody rereads is a context nobody
   *  corrects, and a stale fact is worse here than a missing one. */
  confirmed: 12,
  /** What one reading may be given. Bounded so a growing context cannot
   *  quietly crowd the source excerpts out of the prompt. */
  promptCharacters: 1_200,
} as const;

export const PROJECT_CONTEXT_STATUS = ["confirmed", "proposed", "dismissed"] as const;
export type NovaProjectContextStatus = (typeof PROJECT_CONTEXT_STATUS)[number];

/** Who said it. `owner` is the only origin that can be confirmed on arrival. */
export const PROJECT_CONTEXT_ORIGIN = ["owner", "nova_reading", "nova_result"] as const;
export type NovaProjectContextOrigin = (typeof PROJECT_CONTEXT_ORIGIN)[number];

export type NovaProjectContext = {
  contextId: string;
  statement: string;
  status: NovaProjectContextStatus;
  origin: NovaProjectContextOrigin;
  /** For a proposal: what Nova read that suggested it, so the owner confirms a
   *  statement with its source rather than on trust. */
  evidence: Record<string, unknown>;
  updatedAt: string;
  confirmedAt: string | null;
};

export class ProjectContextError extends Error {}

/** One statement, or a refusal. Whitespace is collapsed so that two spellings
 *  of the same sentence cannot both be stored. */
export function normalizeStatement(value: unknown): string {
  if (typeof value !== "string") throw new ProjectContextError("A project fact must be text.");
  const statement = value.trim().replace(/\s+/g, " ");
  if (!statement) throw new ProjectContextError("Write what is already true, or remove the line.");
  if (statement.length > PROJECT_CONTEXT_LIMITS.statement) {
    throw new ProjectContextError(`Keep each project fact under ${PROJECT_CONTEXT_LIMITS.statement} characters.`);
  }
  return statement;
}

/** The owner's whole confirmed list, normalized. Duplicates collapse on case,
 *  because "Operational wallet not chosen" twice is one fact and two votes. */
export function normalizeStatements(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new ProjectContextError("Project context is a list of short facts.");
  const seen = new Set<string>();
  const statements: string[] = [];
  for (const entry of value) {
    const statement = normalizeStatement(entry);
    const key = statement.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    statements.push(statement);
  }
  if (statements.length > PROJECT_CONTEXT_LIMITS.confirmed) {
    throw new ProjectContextError(`Keep it to ${PROJECT_CONTEXT_LIMITS.confirmed} project facts. A working memory nobody rereads is one nobody corrects.`);
  }
  return statements;
}

export function confirmedContext(entries: NovaProjectContext[]): NovaProjectContext[] {
  return entries.filter((entry) => entry.status === "confirmed");
}

export function proposedContext(entries: NovaProjectContext[]): NovaProjectContext[] {
  return entries.filter((entry) => entry.status === "proposed");
}

/**
 * What an analysis is allowed to be told about the project.
 *
 * The filter is the whole point: a proposal is Nova's reading of its owner's
 * work, and letting it into the prompt would let the model confirm its own
 * inference on the next pass. Oldest confirmations first, so the list reads as
 * a history rather than as a queue, and truncated as a whole statement rather
 * than mid-sentence.
 */
export function contextForPrompt(entries: NovaProjectContext[]): string[] {
  const confirmed = confirmedContext(entries)
    .slice()
    .sort((a, b) => Date.parse(a.confirmedAt ?? a.updatedAt) - Date.parse(b.confirmedAt ?? b.updatedAt));
  const lines: string[] = [];
  let characters = 0;
  for (const entry of confirmed) {
    if (lines.length >= PROJECT_CONTEXT_LIMITS.confirmed) break;
    const next = characters + entry.statement.length + 1;
    if (next > PROJECT_CONTEXT_LIMITS.promptCharacters) break;
    characters = next;
    lines.push(entry.statement);
  }
  return lines;
}

/**
 * Whether a stored reading was judged against the state in force now.
 *
 * A reading carries the statements it was given. When those change, the
 * reading is answering a question about a project that no longer exists --
 * "this is new to you" said against last week's state is the exact mistake
 * this feature was built to stop -- so the pass reconsiders it, the same way
 * it reconsiders a changed goal. An older assessment stored no context at
 * all; that matches an empty one and nothing else.
 */
export function readAgainst(stored: string[] | undefined | null, current: string[]): boolean {
  const before = stored ?? [];
  return before.length === current.length && before.every((statement, index) => statement === current[index]);
}

/**
 * A blob somebody pasted, as the facts it probably is.
 *
 * Offered, never applied: the panel shows what it would split into and the
 * owner presses the button. Four facts in one row read the same to the model
 * and cannot be corrected one at a time, which is the whole point of keeping
 * this list short and current -- but silently rewriting what somebody typed
 * about their own project is not the way to fix that.
 */
export function splitStatements(value: string): string[] {
  const parts = value
    .split(/\n+|(?<=[.!?;])\s+(?=[A-ZА-ЯЁ«"'0-9])/u)
    .map((part) => part.trim().replace(/\s+/g, " "))
    .filter((part) => part.replace(/[^\p{L}\p{N}]/gu, "").length >= 3)
    .map((part) => part.slice(0, PROJECT_CONTEXT_LIMITS.statement));
  return parts.length > 1 ? parts.slice(0, PROJECT_CONTEXT_LIMITS.confirmed) : [];
}
