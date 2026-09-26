/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import { getAddress, isAddress } from "viem";
import { rejectHostedWorkflowSecrets } from "../agent/hosted-workflows.ts";
import { generateOpenAiCompatibleText, resolveReadingLlmConfig } from "../llm/openai-compatible.ts";
import { offerMatchesTerm } from "../discovery/offers.ts";
import { candidateListing, type MarketplaceCandidate } from "../counterparty-selection/marketplace-source.ts";
import {
  selectMarketplaceCounterparty,
  type MarketplaceRankedCandidate,
  type MarketplaceSelection,
} from "../counterparty-selection/marketplace.ts";
import { isExecutableTrustDecision } from "../trust-gate/types.ts";
import { priceX402Call, type X402PricedTerms } from "../x402/execution.ts";
import { buildRequestBody, type RequestBodyPlan } from "../x402/request-body.ts";
import type { JsonSchema } from "../seller/json-schema.ts";
import { policyCapabilityFor } from "./capability.ts";
import {
  DOCS_LIMITS,
  docsPassages,
  rankDocsPages,
  readDocsIndex,
  readDocsPages,
  type DocsPage,
  type DocsPassage,
} from "./docs-lookup.ts";
import { hashTerms, type NovaResearchTerms } from "./research-terms.ts";
import {
  OWNER_QUESTION_LIMITS,
  RESEARCH_BUDGET_USDC,
  paymentLabelFor,
  reasonsFor,
  verdictFor,
  type NovaResearchOutcome,
  type NovaResearchPlan,
  type NovaResearchProposal,
} from "./research.ts";
import { describeReturns, toolLimitations, unpricedNote } from "./tool-card.ts";

/**
 * A question the owner asks Nova directly, answered free first.
 *
 * Until now the owner could put a question only to a tool they had already
 * picked from a card, and Nova's own proposals needed a reading that found an
 * open question: none of the owner's 38 readings had one on 2026-09-26. So
 * choosing a service for a question was something Veyra could do and nobody
 * could ask for.
 *
 * The order is the product:
 *
 *   1  Arc's and Circle's documentation is read for the question, at no
 *      charge. The reading model answers only from the passages it was given,
 *      and names them; an answer that names none is thrown away.
 *   2  Only if that does not answer it, the market on Arc is searched with
 *      the question's words. Circle's catalogue and the ERC-8004 registry are
 *      both searched, and what each listing says about itself decides the
 *      order they are probed in.
 *   3  The first one Veyra allows, that can take this question and that this
 *      wallet can pay, is priced with the exact request. The card says which
 *      of the question's words its listing says, and what was passed over.
 *   4  Approval, signature, payment and the check afterwards are the same
 *      steps as for any card.
 *
 * What a seller is sent is the owner's own question, never a rewrite of it.
 * The English search words are for Veyra's own lookups only.
 */

export type NovaDocsAnswer = {
  /** The pages read, in the order they were chosen. */
  checked: Array<{ title: string; url: string }>;
  /** Sites or pages that could not be read, by name. */
  unavailable: string[];
  answered: boolean;
  /** In the question's own language, from the passages below and nothing else. */
  answer: string | null;
  citations: DocsPassage[];
  /** What the documentation does not say, when it does not answer. */
  missing: string | null;
  /** Why there is no answer when the documentation was never really asked.
   *  Null when it was asked and said what it says. */
  failure: "docs_unavailable" | "nothing_relevant" | "model_unavailable" | "ungrounded" | null;
  writtenBy: string | null;
  checkedAt: string;
};

export type NovaQuestion = {
  questionId: string;
  question: string;
  searchTerms: string[];
  docs: NovaDocsAnswer;
  refusal: { reason: string; detail: string; at: string } | null;
  createdAt: string;
};

type Generate = typeof generateOpenAiCompatibleText;

/** The network a question is answered on. Arc first, and for now Arc only. */
export const QUESTION_NETWORK = "eip155:5042";

export const ASK_LIMITS = {
  /** Words searched, most specific first. Circle's catalogue is asked for
   *  three of them, one query each. */
  searchWords: 4,
  /** Probed per pass: enough to see a market, few enough to wait for. */
  candidates: 8,
  /** Priced per pass, because each price is a live request. */
  attempts: 4,
  /** Questions per agent per hour. Each one costs two reading-model calls. */
  perHour: 20,
} as const;

/** The owner's question as it will be kept and sent, or why it will not be. */
export function ownerAsk(text: unknown): { ok: true; question: string } | { ok: false; reason: string; detail: string } {
  const question = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
  if (question.length < OWNER_QUESTION_LIMITS.min || question.length > OWNER_QUESTION_LIMITS.max) {
    return {
      ok: false,
      reason: "owner_question_invalid",
      detail: `Write the question you want answered, in ${OWNER_QUESTION_LIMITS.min} to ${OWNER_QUESTION_LIMITS.max} characters.`,
    };
  }
  try {
    rejectHostedWorkflowSecrets(question);
  } catch {
    return {
      ok: false,
      reason: "sensitive_input_rejected",
      detail: "That question looks like it contains a private key, a token or another credential. Nova sends a question to documentation and, if you approve, to a seller, so it was not sent anywhere.",
    };
  }
  return { ok: true, question };
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "how", "what", "which", "who", "when", "where", "why", "does", "can", "could",
  "should", "would", "will", "are", "was", "were", "has", "have", "had", "this", "that", "these", "those", "from",
  "into", "about", "there", "their", "they", "them", "your", "you", "our", "any", "all", "some", "more", "most",
  "not", "but", "use", "using", "used", "get", "much", "many", "now", "right", "today", "please", "tell", "know",
]);

function wordsFrom(values: string[]): string[] {
  const words: string[] = [];
  for (const value of values) {
    for (const word of value.toLowerCase().split(/[^a-z0-9]+/)) {
      if (word.length < 3 || STOPWORDS.has(word) || words.includes(word)) continue;
      words.push(word);
    }
  }
  return words;
}

/** Single lowercase English words, in the order given, as the market is searched. */
export function searchWords(values: string[]): string[] {
  return wordsFrom(values).slice(0, ASK_LIMITS.searchWords);
}

/** Words every seller on this market says. Last, so that Circle's catalogue,
 *  which is asked for three words, is asked for words that choose. */
const EVERYWHERE = new Set(["arc", "usdc", "circle", "x402", "api", "agent", "agents", "onchain", "blockchain", "crypto"]);

/**
 * Names the question itself uses: an acronym, a camelCase name, or a
 * capitalised word that does not open the sentence. A small reading model
 * dropped "Argus" from "Which new tokens launched on Argus?" in favour of
 * "arc"; the name the owner wrote is the most specific word there is.
 */
export function namedIn(question: string): string[] {
  const tokens = question.match(/[A-Za-z][A-Za-z0-9]*/g) ?? [];
  const names = tokens.filter((token, index) =>
    token.length >= 3 && (/^[A-Z0-9]+$/.test(token) || /[a-z][A-Z]/.test(token) || (index > 0 && /^[A-Z][a-z]/.test(token))));
  return wordsFrom(names);
}

/** In the order given, except that what every seller says goes last. */
export function orderSearchTerms(words: string[]): string[] {
  const all = wordsFrom(words);
  return [...all.filter((word) => !EVERYWHERE.has(word)), ...all.filter((word) => EVERYWHERE.has(word))]
    .slice(0, ASK_LIMITS.searchWords);
}

/* ---- the reading model ---- */

const PLAN_RULES = [
  "You route one question from the owner of an AI agent to where it can be answered. You do not answer it.",
  "pages lists pages of Arc's and Circle's official documentation, by id. Choose up to three whose section, title or description make them likely to answer the question, the most likely first. Choose none if none is likely.",
  "terms: two to four single lowercase English words for searching a market of paid tools and data services for the same question, the words such a service would use to describe itself. Always English: translate the words of a question asked in another language.",
  "The most specific first: a product, protocol or place the question names comes before general words. Prefer words particular to this question over words every Arc service uses, such as arc or usdc.",
  'For example, "Сколько стоит мост USDC через CCTP?" gives ["cctp","bridge","cost"], and "Is the newest token on the Foo launchpad safe to buy?" gives ["foo","launchpad","token","risk"].',
  'Return JSON only: {"pages":[number],"terms":[string]}.',
].join("\n");

const ANSWER_RULES = [
  "Answer the owner's question from the documentation passages given, and from nothing else.",
  "If the passages answer it, write the answer in two or three plain sentences, in the language the question is written in, and list the ids of the passages the answer stands on.",
  "If they do not answer it, or answer only part of it, set answered to false and say in one sentence what they do not say. A partial answer is not an answer.",
  "Never add a fact that is not in the passages: no address, price, date, limit or name from memory.",
  'Return JSON only: {"answered":boolean,"answer":string,"passageIds":[string],"missing":string}.',
].join("\n");

async function askReadingModel(input: {
  rules: string;
  user: unknown;
  generate?: Generate;
  maxCompletionTokens: number;
}) {
  const reading = resolveReadingLlmConfig();
  const result = await (input.generate ?? generateOpenAiCompatibleText)({
    ...(reading.configured ? { config: reading.config } : {}),
    systemPrompt: input.rules,
    userPrompt: JSON.stringify(input.user),
    timeoutMs: 45_000,
    maxAttempts: 1,
    responseFormat: "json_object",
    maxCompletionTokens: input.maxCompletionTokens,
  }).catch(() => null);
  return result?.ok ? result : null;
}

/* Plain text for a page that prints text, cut at a word rather than inside one. */
const clean = (value: unknown, max: number) => {
  if (typeof value !== "string") return "";
  const text = value.replace(/[`*]+/g, "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 0 ? cut.lastIndexOf(" ") : cut.length)}…`;
};

/** Page ids that exist, and the search words, from the model's answer. */
export function parseQuestionPlan(text: string, pageCount: number): { pageIds: number[]; terms: string[] } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const pageIds = Array.isArray(record.pages)
    ? Array.from(new Set(record.pages.filter((id): id is number =>
      typeof id === "number" && Number.isInteger(id) && id >= 1 && id <= pageCount)))
      .slice(0, DOCS_LIMITS.pagesRead)
    : [];
  const terms = searchWords(Array.isArray(record.terms)
    ? record.terms.filter((term): term is string => typeof term === "string")
    : []);
  return { pageIds, terms };
}

/**
 * The model's answer, kept only if it stands on passages it was given. One
 * passage id nobody supplied throws the whole answer out, the way an invented
 * citation fails a reading: a sentence about somebody's money that points at a
 * source that does not exist is worse than no sentence.
 */
export function parseDocsAnswer(
  text: string,
  passages: DocsPassage[],
): Pick<NovaDocsAnswer, "answered" | "answer" | "citations" | "missing" | "failure"> {
  const ungrounded = { answered: false, answer: null, citations: [], missing: null, failure: "ungrounded" as const };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return ungrounded;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return ungrounded;
  const record = raw as Record<string, unknown>;
  const missing = clean(record.missing, 300) || null;
  if (record.answered !== true) return { answered: false, answer: null, citations: [], missing, failure: null };

  const answer = clean(record.answer, 700);
  const byId = new Map(passages.map((passage) => [passage.id, passage]));
  const ids = Array.isArray(record.passageIds)
    ? Array.from(new Set(record.passageIds.filter((id): id is string => typeof id === "string")))
    : [];
  if (!answer || ids.length === 0 || ids.some((id) => !byId.has(id))) return ungrounded;
  return { answered: true, answer, citations: ids.slice(0, 4).map((id) => byId.get(id)!), missing: null, failure: null };
}

/**
 * Step 1: the documentation, for nothing.
 *
 * Also where the search words for the market come from, since the same call
 * reads the question. If the model cannot be reached, the words are the
 * question's own English words and the pages are the ones whose titles say
 * them; a question in another language then finds nothing, and says so.
 */
export async function lookUpDocs(input: {
  question: string;
  fetchImpl?: typeof fetch;
  now?: Date;
  generate?: Generate;
}): Promise<{ searchTerms: string[]; docs: NovaDocsAnswer }> {
  const now = input.now ?? new Date();
  const index = await readDocsIndex({ fetchImpl: input.fetchImpl, now });

  const planned = await askReadingModel({
    rules: PLAN_RULES,
    user: {
      question: input.question,
      pages: index.pages.map(({ id, section, title, description }) => ({ id, section, title, description })),
    },
    generate: input.generate,
    maxCompletionTokens: 4_000,
  });
  const plan = planned ? parseQuestionPlan(planned.text, index.pages.length) : null;
  const searchTerms = orderSearchTerms([
    ...namedIn(input.question),
    ...(plan && plan.terms.length > 0 ? plan.terms : searchWords([input.question])),
  ]);
  const chosen: DocsPage[] = plan
    ? plan.pageIds.map((id) => index.pages[id - 1]).filter((page): page is DocsPage => Boolean(page))
    : rankDocsPages(index.pages, searchTerms);

  const base: NovaDocsAnswer = {
    checked: [],
    unavailable: index.unavailable,
    answered: false,
    answer: null,
    citations: [],
    missing: null,
    failure: null,
    writtenBy: null,
    checkedAt: now.toISOString(),
  };
  if (index.pages.length === 0) return { searchTerms, docs: { ...base, failure: "docs_unavailable" } };
  if (chosen.length === 0) return { searchTerms, docs: { ...base, failure: plan ? "nothing_relevant" : "model_unavailable" } };

  const read = await readDocsPages(chosen, { fetchImpl: input.fetchImpl, now });
  const unavailable = [...index.unavailable, ...read.unavailable];
  const checked = read.materials.map(({ title, url }) => ({ title, url }));
  if (read.materials.length === 0) return { searchTerms, docs: { ...base, unavailable, failure: "docs_unavailable" } };

  const passages = docsPassages(read.materials, [...searchTerms, input.question]);
  const answered = await askReadingModel({
    rules: ANSWER_RULES,
    user: { question: input.question, passages: passages.map(({ id, title, quote }) => ({ id, page: title, text: quote })) },
    generate: input.generate,
    maxCompletionTokens: 6_000,
  });
  if (!answered) return { searchTerms, docs: { ...base, checked, unavailable, failure: "model_unavailable" } };
  return {
    searchTerms,
    docs: {
      ...base,
      checked,
      unavailable,
      ...parseDocsAnswer(answered.text, passages),
      writtenBy: `${answered.provider} · ${answered.model}`,
    },
  };
}

/* ---- step 2: the market on Arc ---- */

export type QuestionFit = {
  /** The searched words the listing says, each weighted by how few listings
   *  say it and by how early it was searched: a word every seller uses
   *  decides nothing, and the owner's own names come first. */
  fit: number;
  matched: string[];
  /** Whether it says any word more particular than what every Arc seller
   *  says. A listing that says only "arc" is not a fit for anything. */
  specific: boolean;
  /** The listing's own description, as the card quotes it. */
  listing: string | null;
  /** A GET that wants a value in its address Nova would have to supply. */
  needsParameters: boolean;
};

/**
 * Whether a GET wants something Nova would have to put in its address.
 *
 * Nova calls a GET exactly as listed. An endpoint that needs a transaction
 * hash or an address in its query would take the payment and answer with an
 * error. Most registry GETs publish no schema and say it in words instead:
 * "pass ?tx=0x…", "(ids=a,b,c)". Read conservatively: an optional parameter
 * with a default reads the same, and is passed over the same.
 */
export function needsParameters(candidate: Pick<MarketplaceCandidate, "method" | "resource" | "description" | "inputSchema">): boolean {
  if (candidate.method !== "GET") return false;
  if (/[{}]/.test(candidate.resource)) return true;
  try {
    if (/\/:[A-Za-z_]/.test(new URL(candidate.resource).pathname)) return true;
  } catch {
    return true;
  }
  const required = (candidate.inputSchema as { required?: unknown } | null)?.required;
  if (Array.isArray(required) && required.length > 0) return true;
  const description = candidate.description ?? "";
  return /[?&(]\s*[a-z_][a-z0-9_]*=/i.test(description) || /\bpass\s+\?/i.test(description);
}

/**
 * How well each listing fits the question, from what the listing says.
 *
 * Weighted three ways. A word few listings say counts more. A word searched
 * earlier counts more, because the words are ordered: the owner's own names
 * first, then the most specific. And a word every seller on Arc says counts a
 * quarter. Unweighted by position, "Which tokens launched on Argus?" ranked a
 * listing saying token, launchpad and risk above Fuci's Argus launches.
 */
export function fitToQuestion(pool: MarketplaceCandidate[], terms: string[]): Map<string, QuestionFit> {
  const listings = pool.map(candidateListing);
  const holding = new Map(terms.map((term) => [term, listings.filter((listing) => offerMatchesTerm(listing, term)).length]));
  const weight = (term: string) =>
    Math.log(1 + pool.length / Math.max(1, holding.get(term) ?? 1))
    * (1 + (terms.length - 1 - terms.indexOf(term)) / Math.max(1, terms.length))
    * (EVERYWHERE.has(term) ? 0.25 : 1);
  const fits = new Map<string, QuestionFit>();
  pool.forEach((candidate, index) => {
    const matched = terms.filter((term) => offerMatchesTerm(listings[index], term));
    fits.set(candidate.candidateId, {
      fit: matched.reduce((sum, term) => sum + weight(term), 0),
      matched,
      specific: matched.some((term) => !EVERYWHERE.has(term)),
      listing: candidate.description ? candidate.description.slice(0, 300) : null,
      needsParameters: needsParameters(candidate),
    });
  });
  return fits;
}

/** Best fit first; among equals, the cheaper; then a stable order. */
export function orderByFit(pool: MarketplaceCandidate[], fits: Map<string, QuestionFit>): MarketplaceCandidate[] {
  return [...pool].sort((left, right) =>
    (fits.get(right.candidateId)?.fit ?? 0) - (fits.get(left.candidateId)?.fit ?? 0)
    || left.priceUsdc - right.priceUsdc
    || left.candidateId.localeCompare(right.candidateId));
}

export const DATA_TOOL_LIMIT =
  "It takes no question. Veyra calls it exactly as listed, and what comes back is its current data, not an answer written to your question.";

const NO_WALLET = "0x0000000000000000000000000000000000000000" as const;
const NO_FIT: QuestionFit = { fit: 0, matched: [], specific: false, listing: null, needsParameters: false };

type Walked =
  | {
      kind: "payable";
      winner: MarketplaceRankedCandidate;
      request: RequestBodyPlan;
      quote: X402PricedTerms;
      fit: QuestionFit;
      passedOver: string[];
    }
  | { kind: "none"; passedOver: string[]; allowed: number; cannotPay: number };

/**
 * The first candidate, best fit first, that Veyra allows, that can take this
 * question and that this wallet can pay: priced with the exact request.
 */
async function firstAnswering(input: {
  selection: MarketplaceSelection;
  fits: Map<string, QuestionFit>;
  question: string;
  price: typeof priceX402Call;
  /** The question's own words: a listing that says none of the particular
   *  ones is not considered at all. Off for the general web search. */
  requireSpecific: boolean;
}): Promise<Walked> {
  const fitOf = (candidate: MarketplaceRankedCandidate) => input.fits.get(candidate.marketplace.candidateId) ?? NO_FIT;
  const ordered = [...input.selection.candidates].sort((left, right) =>
    fitOf(right).fit - fitOf(left).fit || left.marketplace.priceUsdc - right.marketplace.priceUsdc);
  const passedOver: string[] = [];
  const pass = (candidate: MarketplaceRankedCandidate, reason: string) => {
    if (passedOver.length < 3) passedOver.push(`${candidate.marketplace.provider?.name ?? "A tool"} (${pathOf(candidate.marketplace.resource)}): ${reason}`);
  };
  let allowed = 0;
  let cannotPay = 0;
  let attempts = 0;

  for (const candidate of ordered) {
    if (input.requireSpecific && !fitOf(candidate).specific) continue;
    if (!isExecutableTrustDecision(candidate.trustDecision)) {
      pass(candidate, "Veyra would not authorise it.");
      continue;
    }
    allowed += 1;
    if (attempts >= ASK_LIMITS.attempts) break;
    const { marketplace } = candidate;
    const fit = fitOf(candidate);
    if (/[{}]/.test(marketplace.resource)) {
      pass(candidate, "it answers about one specific record, and the question does not say which.");
      continue;
    }

    let request: RequestBodyPlan;
    if (marketplace.method === "GET") {
      if (fit.needsParameters) {
        pass(candidate, "it needs a value from you in its address, such as an id or an address, and Nova does not fill those in yet.");
        continue;
      }
      request = { body: {}, guessed: false, intentField: null, note: null };
    } else {
      request = buildRequestBody({
        intent: input.question,
        capability: "research",
        inputSchema: (marketplace.inputSchema ?? null) as JsonSchema | null,
      });
      if (request.guessed || request.intentField === null) {
        pass(candidate, "its published inputs have nowhere to put a question.");
        continue;
      }
    }

    attempts += 1;
    const priced = await input.price({
      resource: marketplace.resource,
      method: marketplace.method,
      requestBody: request.body,
      maxAmountUsdc: RESEARCH_BUDGET_USDC,
      inputSchema: marketplace.inputSchema,
      match: { network: marketplace.network, payTo: marketplace.payTo, asset: marketplace.asset },
    });
    if (priced.kind === "free") {
      pass(candidate, unpricedNote(priced.status));
      continue;
    }
    if (priced.kind === "refused") {
      pass(candidate, priced.code === "decided_terms_not_offered"
        ? "its live payment terms no longer match its listing."
        : "it would not price this request.");
      continue;
    }
    if (BigInt(priced.quote.accept.amountAtomic) <= BigInt(0)) {
      pass(candidate, "it asks for a payment of nothing, which Veyra can neither authorise nor check.");
      continue;
    }
    /* Read for the rail the quote chose. A listing that names a Gateway
       deposit can also take a wallet payment, and then no deposit is needed. */
    if (priced.quote.accept.gatewayBatched && marketplace.payableNow === false) {
      cannotPay += 1;
      pass(candidate, `it settles only through ${paymentLabelFor("gateway_deposit", priced.quote.accept.network)}, and there is no deposit to pay from.`);
      continue;
    }
    return { kind: "payable", winner: candidate, request, quote: priced.quote, fit, passedOver };
  }
  return { kind: "none", passedOver, allowed, cannotPay };
}

function pathOf(resource: string): string {
  try {
    return new URL(resource).pathname;
  } catch {
    return resource;
  }
}

/**
 * Step 2 and 3: a tool on Arc for the question, priced, or why there is none.
 *
 * Two passes. First the question's own words. Then, if nothing that says them
 * can be asked and paid, a web search: the general option, labelled as one,
 * with what was passed over on the way.
 */
export async function proposeForQuestion(input: {
  question: Pick<NovaQuestion, "questionId" | "question" | "searchTerms" | "docs">;
  wallet?: string | null;
  now?: Date;
  fetchImpl?: typeof fetch;
  /** The selection engine and the live price, injectable the way the relay
   *  and the reading model are elsewhere: the walk between them is what a
   *  test has to reach without a network or a bill. */
  selectImpl?: typeof selectMarketplaceCounterparty;
  priceImpl?: typeof priceX402Call;
}): Promise<NovaResearchOutcome> {
  const { question } = input;
  const select = input.selectImpl ?? selectMarketplaceCounterparty;
  const price = input.priceImpl ?? priceX402Call;
  const requesterWallet = input.wallet && isAddress(input.wallet) ? getAddress(input.wallet) : NO_WALLET;
  const specific = searchWords(question.searchTerms);
  const passes = [
    ...(specific.length > 0 ? [{ terms: specific, general: false }] : []),
    { terms: ["search"], general: true },
  ];

  const passedOver: string[] = [];
  let probed = 0;
  let allowed = 0;
  let cannotPay = 0;
  let reached = false;
  for (const pass of passes) {
    const query = pass.terms.slice(0, 3).join(" ");
    let fits = new Map<string, QuestionFit>();
    let selection: MarketplaceSelection;
    try {
      selection = await select({
        request: {
          capability: "research",
          query,
          network: QUESTION_NETWORK,
          budgetUsdc: RESEARCH_BUDGET_USDC,
          limit: ASK_LIMITS.candidates,
          mustInclude: null,
        },
        tenant: { tenantKey: `nova:q:${question.questionId}`, requesterWallet },
        now: input.now,
        fetchImpl: input.fetchImpl,
        issueClearance: false,
        requireWordMatch: true,
        order: (pool) => {
          fits = fitToQuestion(pool, pass.terms);
          return orderByFit(pool, fits);
        },
      });
    } catch {
      continue;
    }
    reached = true;
    probed += selection.probed;
    const walked = await firstAnswering({ selection, fits, question: question.question, price, requireSpecific: !pass.general });
    if (walked.kind === "payable") {
      return {
        ok: true,
        ...questionProposal({
          question,
          selection,
          walked,
          probed,
          general: pass.general,
          query,
          passedOver: [...passedOver, ...walked.passedOver],
        }),
      };
    }
    passedOver.push(...walked.passedOver);
    allowed += walked.allowed;
    cannotPay += walked.cannotPay;
  }

  const searched = specific.length > 0 ? ` Searched for: ${specific.join(", ")}.` : "";
  const closest = passedOver.length > 0 ? ` Passed over: ${passedOver.join(" ")}` : "";
  if (!reached) {
    return { ok: false, reason: "lookup_failed", detail: "Veyra could not reach the market on Arc just now. Nothing was priced." };
  }
  if (probed === 0) {
    return { ok: false, reason: "nothing_fits", detail: `Nothing on Arc's market says it does this, and no web search could be reached.${searched} Nothing was priced.` };
  }
  if (allowed === 0) {
    return { ok: false, reason: "nothing_allowed", detail: `Veyra probed ${probed} tools on Arc and would not put any of them in front of you.${searched} Nothing was paid.` };
  }
  if (cannotPay > 0) {
    return { ok: false, reason: "not_payable", detail: `The tools that fit settle only through a Circle Gateway deposit on Arc, and there is none to pay from.${closest} Nothing was signed.` };
  }
  return { ok: false, reason: "nothing_askable", detail: `Veyra found tools on Arc it would authorise, and none of them can take this question.${closest} Nothing was paid.` };
}

function questionProposal(input: {
  question: Pick<NovaQuestion, "questionId" | "question" | "docs">;
  selection: MarketplaceSelection;
  walked: Extract<Walked, { kind: "payable" }>;
  probed: number;
  general: boolean;
  query: string;
  passedOver: string[];
}): { proposal: NovaResearchProposal; plan: NovaResearchPlan } {
  const { winner, request, quote, fit } = input.walked;
  const marketplace = winner.marketplace;
  const provider = marketplace.provider?.name ?? "Unknown provider";
  const terms: NovaResearchTerms = {
    provider,
    resource: marketplace.resource,
    /* Read from the endpoint, never from the words that found it. */
    capability: policyCapabilityFor({ resource: marketplace.resource, description: fit.listing, provider }),
    priceAtomic: quote.accept.amountAtomic,
    payTo: quote.accept.payTo,
    network: quote.accept.network,
    funding: quote.accept.gatewayBatched ? "gateway_deposit" : "wallet",
  };
  const decision = winner.trustDecision;
  const costUsdc = quote.quotedUsdc;
  const maxExposureUsdc = winner.recommendedMaxExposureUsdc || marketplace.priceUsdc;
  const outputSchema = (marketplace.outputSchema ?? quote.outputSchema ?? null) as Record<string, unknown> | null;
  const inputSchema = (marketplace.inputSchema ?? quote.inputSchema ?? null) as Record<string, unknown> | null;
  const payableNow = quote.accept.gatewayBatched ? marketplace.payableNow : true;

  const proposal: NovaResearchProposal = {
    askedBy: "owner",
    questionId: input.question.questionId,
    question: input.question.question,
    capability: terms.capability,
    provider,
    resource: marketplace.resource,
    costUsdc,
    trustScore: Math.round(winner.trustScore ?? 0),
    funding: terms.funding,
    paymentLabel: paymentLabelFor(terms.funding, terms.network),
    payableNow,
    decision,
    verdict: verdictFor(decision, costUsdc),
    maxExposureUsdc,
    verifiedAfterPaying: decision !== "ALLOW",
    reasons: reasonsFor(winner),
    probed: input.probed,
    checkedFirst: input.question.docs.checked,
    checkedAt: input.question.docs.checkedAt,
    sentAs: request.intentField,
    returns: describeReturns(outputSchema),
    limitations: [
      ...(marketplace.method === "GET" ? [DATA_TOOL_LIMIT] : []),
      ...toolLimitations({
        sentAs: request.intentField,
        outputSchema,
        catalogDrift: winner.probe?.catalogDrift ?? [],
        respondedWith402: winner.probe ? winner.probe.respondedWith402 : null,
      }),
    ],
    routingNote: input.passedOver.length > 0 ? `Passed over first: ${input.passedOver.join(" ")}` : null,
    actionType: "research_subject",
    subjectLabel: null,
    performedVia: null,
    chosenFor: { matched: input.general ? [] : fit.matched, listing: fit.listing, general: input.general },
    searchedFor: input.query,
    expiresAt: input.selection.expiresAt,
    termsHash: hashTerms(terms),
  };
  const plan: NovaResearchPlan = {
    terms,
    query: input.query,
    requestBody: request.body,
    requestNote: null,
    inputSchema,
    outputSchema,
    candidateId: marketplace.candidateId,
    method: marketplace.method,
    verificationRequired: decision !== "ALLOW",
    maxExposureUsdc,
  };
  return { proposal, plan };
}

/* ---- storage shape ---- */

export const QUESTION_COLUMNS = "question_id, question, search_terms, docs, refusal, created_at";

export function questionFromRow(row: Record<string, unknown>): NovaQuestion {
  const docs = (row.docs && typeof row.docs === "object" ? row.docs : {}) as Partial<NovaDocsAnswer>;
  return {
    questionId: String(row.question_id),
    question: String(row.question ?? ""),
    searchTerms: Array.isArray(row.search_terms) ? row.search_terms.filter((term): term is string => typeof term === "string") : [],
    docs: {
      checked: Array.isArray(docs.checked) ? docs.checked : [],
      unavailable: Array.isArray(docs.unavailable) ? docs.unavailable : [],
      answered: docs.answered === true,
      answer: typeof docs.answer === "string" ? docs.answer : null,
      citations: Array.isArray(docs.citations) ? docs.citations : [],
      missing: typeof docs.missing === "string" ? docs.missing : null,
      failure: docs.failure ?? null,
      writtenBy: typeof docs.writtenBy === "string" ? docs.writtenBy : null,
      checkedAt: typeof docs.checkedAt === "string" ? docs.checkedAt : String(row.created_at ?? ""),
    },
    refusal: row.refusal && typeof row.refusal === "object" ? row.refusal as NovaQuestion["refusal"] : null,
    createdAt: String(row.created_at ?? ""),
  };
}
