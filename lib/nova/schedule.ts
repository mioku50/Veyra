/**
 * Copyright 2026 Veyra
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getServerSupabaseConfig } from "../supabase/server-env.ts";
import { runRefresh } from "./service.ts";

/**
 * Nova, working while nobody is looking.
 *
 * Everything Nova does on demand already works. What it did not have was a
 * reason to come back: a brief you have to ask for is a search box, and the
 * sentence the product is built around -- "while you were away, Nova checked
 * 18 signals, ignored 14 as noise and found 4 worth your attention" -- is only
 * true if something ran while the person was genuinely away.
 *
 * Three things this has to get right, and they are all about restraint:
 *
 *   1. It must not visit agents nobody owns any more. A Nova is remembered by a
 *      secret in one browser. Clear the browser and the agent is unreachable
 *      forever -- but the row survives, and a scheduler that does not know this
 *      spends GitHub and Circle requests on it every six hours until someone
 *      notices the bill. Dormancy, below.
 *
 *   2. It must not read the same thing many times in one tick. Every Nova
 *      watches some subset of the same seven repositories and the same catalog.
 *      Ten agents refreshed naively is ten identical reads of the same commit
 *      list inside the same second.
 *
 *   3. It must not claim work twice, and it must not lose work it failed at.
 *      Both, below, with a compare-and-swap claim that is rolled back on
 *      failure.
 */

/** Four passes a day. Frequent enough that a day's brief is not stale by the
 *  time someone reads it, rare enough that it is not a scraper. */
export const REFRESH_INTERVAL_HOURS = 6;

/**
 * After two weeks with nobody opening the brief, the scheduler stops.
 *
 * Two weeks rather than a few days because the failure mode is asymmetric: a
 * dormant agent costs its owner one stale brief and one visit to wake it, while
 * an agent visited forever costs requests forever. Waking is free and instant,
 * so erring toward dormancy is the cheap mistake.
 */
export const DORMANT_AFTER_DAYS = 14;

/** A tick's ceiling, whichever comes first. The wall clock matters more than
 *  the count: an agent takes about five seconds, but a slow GitHub turns that
 *  into thirty, and a tick killed mid-refresh leaves a claimed agent behind. */
export const MAX_AGENTS_PER_TICK = 12;
export const TICK_BUDGET_MS = 210_000;

type DueAgent = {
  agent_id: string;
  public_id: string;
  interests: string[];
  last_scheduled_refresh_at: string | null;
};

export type TickOutcome = {
  wentDormant: number;
  due: number;
  refreshed: number;
  failed: number;
  signalsKept: number;
  /** Set when the tick stopped because of the clock rather than the queue. */
  stoppedEarly: boolean;
  durationMs: number;
};

let client: SupabaseClient | null = null;
function db(): SupabaseClient {
  if (!client) {
    const config = getServerSupabaseConfig();
    client = createClient(config.url, config.key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

/**
 * A reader that answers each URL once per tick.
 *
 * Not a cache in the usual sense -- nothing survives the tick. It exists
 * because a tick is one moment: the agents refreshed in it should see the same
 * world, and reading circlefin/stablecoin-evm twelve times in four seconds
 * gives twelve identical answers for twelve times the rate-limit budget.
 *
 * Failures are shared too. If GitHub is down, it is down for every agent in
 * this tick, and eleven more attempts would neither discover otherwise nor be
 * a kindness to a host already struggling.
 */
export function tickReader(underlying: typeof fetch = fetch): typeof fetch {
  type Snapshot = { status: number; statusText: string; headers: [string, string][]; body: string };
  const answers = new Map<string, Promise<Snapshot>>();

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    // Only GETs are shared. Nothing here writes, but a POST that slipped
    // through would be silently collapsed into one, which is a bug worth
    // making impossible rather than unlikely.
    if (method !== "GET") return underlying(input, init);

    let answer = answers.get(url);
    if (!answer) {
      answer = (async (): Promise<Snapshot> => {
        const response = await underlying(input, init);
        return {
          status: response.status,
          statusText: response.statusText,
          headers: [...response.headers.entries()],
          body: await response.text(),
        };
      })();
      answers.set(url, answer);
    }

    const snapshot = await answer;
    // 204 and 304 must be constructed with a null body or the Response
    // constructor throws, which would turn an empty success into a crash.
    const bodyless = snapshot.status === 204 || snapshot.status === 304;
    return new Response(bodyless ? null : snapshot.body, {
      status: snapshot.status,
      statusText: snapshot.statusText,
      headers: snapshot.headers,
    });
  };
}

/**
 * Stops visiting agents nobody has opened in {@link DORMANT_AFTER_DAYS}.
 *
 * Run before claiming, so an abandoned agent is never picked up in the same
 * tick that retires it. Returns how many went dormant, which is the number
 * worth watching: a steady trickle is people clearing browsers, a spike is a
 * bug in how visits are recorded.
 */
export async function sweepDormant(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - DORMANT_AFTER_DAYS * 86_400_000).toISOString();
  const stamp = { dormant_since: now.toISOString() };

  /* Two sweeps, because NULL compares false against everything. An agent whose
     last_opened_at is null would never match `lt(cutoff)` and would be visited
     forever -- the exact leak this function exists to stop, hiding inside the
     function meant to stop it. createNova now records creation as a visit so
     the second sweep should find nothing; it stays because "should" is not a
     guarantee, and the cost of being wrong here is unbounded. */
  const [opened, never] = await Promise.all([
    db().from("nova_agents").update(stamp)
      .is("dormant_since", null).lt("last_opened_at", cutoff).select("agent_id"),
    db().from("nova_agents").update(stamp)
      .is("dormant_since", null).is("last_opened_at", null).lt("created_at", cutoff).select("agent_id"),
  ]);
  return (opened.data ?? []).length + (never.data ?? []).length;
}

/**
 * Agents whose next scheduled pass is due.
 *
 * Oldest first, nulls first: an agent that has never had a scheduled pass is
 * the most overdue thing in the table. Over-fetches so that agents lost to the
 * claim race below still leave a full tick's worth of work.
 */
export async function findDue(now: Date, limit = MAX_AGENTS_PER_TICK): Promise<DueAgent[]> {
  const cutoff = new Date(now.getTime() - REFRESH_INTERVAL_HOURS * 3_600_000).toISOString();
  const columns = "agent_id, public_id, interests, last_scheduled_refresh_at";

  /* Two queries rather than one `or(...)`. PostgREST takes that filter as a
     string, and the value here is an ISO timestamp full of the dots and colons
     that string is delimited by -- a quoting mistake there does not fail, it
     silently matches nothing, and a scheduler that quietly finds no work is the
     hardest kind of broken to notice. Two plain filters cannot be misread. */
  const [never, stale] = await Promise.all([
    db().from("nova_agents").select(columns)
      .is("dormant_since", null)
      .is("last_scheduled_refresh_at", null)
      .order("created_at", { ascending: true })
      .limit(limit * 2),
    db().from("nova_agents").select(columns)
      .is("dormant_since", null)
      .lt("last_scheduled_refresh_at", cutoff)
      .order("last_scheduled_refresh_at", { ascending: true })
      .limit(limit * 2),
  ]);
  if (never.error && stale.error) return [];

  // Never-visited first: an agent that has had no scheduled pass at all is the
  // most overdue thing in the table, whatever the timestamps say.
  return [
    ...((never.data ?? []) as DueAgent[]),
    ...((stale.data ?? []) as DueAgent[]),
  ].slice(0, limit * 2);
}

/**
 * Takes an agent, or discovers somebody else already has.
 *
 * The claim is the stamp: `last_scheduled_refresh_at` moves to now only if it
 * still holds the value this tick read. A second tick running concurrently
 * reads the same row, tries the same swap, matches nothing, and moves on. No
 * lock table, no lease to expire.
 */
async function claim(agent: DueAgent, now: Date): Promise<boolean> {
  const query = db()
    .from("nova_agents")
    .update({ last_scheduled_refresh_at: now.toISOString() })
    .eq("agent_id", agent.agent_id);
  const { data } = await (agent.last_scheduled_refresh_at === null
    ? query.is("last_scheduled_refresh_at", null)
    : query.eq("last_scheduled_refresh_at", agent.last_scheduled_refresh_at)
  ).select("agent_id");
  return (data ?? []).length === 1;
}

/**
 * Puts the clock back after a failed pass.
 *
 * Without this the claim would double as a completion: an agent whose refresh
 * threw would look freshly visited and wait a full interval before anyone
 * looked at it again, having produced nothing. Releasing makes it due
 * immediately, so the next tick picks it up.
 */
async function release(agent: DueAgent): Promise<void> {
  await db()
    .from("nova_agents")
    .update({ last_scheduled_refresh_at: agent.last_scheduled_refresh_at })
    .eq("agent_id", agent.agent_id);
}

/**
 * One tick: retire the abandoned, refresh the due, report what happened.
 *
 * Agents are refreshed one at a time on purpose. In parallel they would finish
 * sooner and spend the rate-limit budget in a burst; serially, the shared
 * reader means the second agent onward mostly reads from the first one's
 * answers, and the tick is bounded by the clock rather than by a thundering
 * herd.
 */
export async function runScheduledTick(input?: {
  now?: Date;
  maxAgents?: number;
  budgetMs?: number;
}): Promise<TickOutcome> {
  const now = input?.now ?? new Date();
  const started = Date.now();
  const maxAgents = input?.maxAgents ?? MAX_AGENTS_PER_TICK;
  const budgetMs = input?.budgetMs ?? TICK_BUDGET_MS;

  const wentDormant = await sweepDormant(now);
  const due = await findDue(now, maxAgents);
  const reader = tickReader();

  let refreshed = 0;
  let failed = 0;
  let signalsKept = 0;
  let stoppedEarly = false;

  for (const agent of due) {
    if (refreshed + failed >= maxAgents) break;
    if (Date.now() - started > budgetMs) {
      stoppedEarly = true;
      break;
    }
    if (!(await claim(agent, now))) continue;
    try {
      const result = await runRefresh({
        agent: { agent_id: agent.agent_id, interests: agent.interests ?? [] },
        trigger: "scheduled",
        now: new Date(),
        fetchImpl: reader,
      });
      refreshed += 1;
      signalsKept += result.newSignals;
    } catch {
      /* One agent's bad pass is not the tick's. The claim is released so it is
         due again, and the loop continues -- a single unreachable source must
         not stop every other person's agent from being updated. */
      failed += 1;
      await release(agent).catch(() => {});
    }
  }

  return {
    wentDormant,
    due: due.length,
    refreshed,
    failed,
    signalsKept,
    stoppedEarly,
    durationMs: Date.now() - started,
  };
}
