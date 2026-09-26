/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import { QUESTION_COLUMNS, questionFromRow, type NovaDocsAnswer, type NovaQuestion } from "./ask.ts";
import { db, NovaError } from "./service.ts";

/**
 * The owner's questions to Nova, kept with what the documentation said.
 *
 * Kept because both halves cost something to establish: the documentation
 * lookup is two reading-model calls, and a refusal from the market is a round
 * of live probes. A reload that forgot either would pay for it again to be
 * told the same thing.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function questionsInLastHour(agentId: string, now = new Date()): Promise<number> {
  const { count, error } = await db()
    .from("nova_questions")
    .select("question_id", { count: "exact", head: true })
    .eq("agent_id", agentId)
    .gt("created_at", new Date(now.getTime() - 3_600_000).toISOString());
  if (error) throw new NovaError("Could not reach your questions right now.", "database_unavailable", 503);
  return count ?? 0;
}

export async function recordQuestion(input: {
  agentId: string;
  question: string;
  searchTerms: string[];
  docs: NovaDocsAnswer;
}): Promise<NovaQuestion> {
  const { data, error } = await db()
    .from("nova_questions")
    .insert({
      agent_id: input.agentId,
      question: input.question,
      search_terms: input.searchTerms,
      docs: input.docs,
    })
    .select(QUESTION_COLUMNS)
    .maybeSingle();
  if (error || !data) throw new NovaError("Could not save that question.", "database_unavailable", 503);
  return questionFromRow(data as Record<string, unknown>);
}

export async function loadQuestion(agentId: string, questionId: string): Promise<NovaQuestion> {
  if (!UUID.test(questionId)) throw new NovaError("No such question.", "not_found", 404);
  const { data, error } = await db()
    .from("nova_questions")
    .select(QUESTION_COLUMNS)
    .eq("agent_id", agentId)
    .eq("question_id", questionId)
    .maybeSingle();
  if (error) throw new NovaError("Could not reach that question right now.", "database_unavailable", 503);
  if (!data) throw new NovaError("No such question.", "not_found", 404);
  return questionFromRow(data as Record<string, unknown>);
}

/** Written when Veyra looked for a paid tool and put none in front of the
 *  owner; cleared when one is proposed. */
export async function recordQuestionRefusal(input: {
  agentId: string;
  questionId: string;
  refusal: NovaQuestion["refusal"];
}): Promise<void> {
  await db()
    .from("nova_questions")
    .update({ refusal: input.refusal, updated_at: new Date().toISOString() })
    .eq("agent_id", input.agentId)
    .eq("question_id", input.questionId);
}

