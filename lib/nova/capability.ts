/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What kind of paid action this is, as opposed to what it is about.
 *
 * A mandate signs `allowedCapabilities`, and until now the values inside it
 * were whatever word Nova happened to search the catalogue with. Those are two
 * different questions and only one of them is a permission:
 *
 *   topic       what is this about        Arc, USDC, x402, stablecoin, onchain
 *   capability  what may Nova pay to do   research, data, inference, identity,
 *                                         payments
 *
 * Measured on the live catalogue before this file existed: of 153 resources
 * reachable from the agent's 21 discovery terms, 31 were reachable only from
 * topic words and had no capability at all, 11 were reachable from two or three
 * different families at once, and 24 more would have been called "payments" --
 * among them a CAPTCHA solver, a meme generator, Messari's news feed, Arkham's
 * market data and eight Apollo people-search endpoints. Not one of the 24
 * performs a payment. Circle's search matches anywhere in the row, so an
 * endpoint reached by searching "payment" is an endpoint that mentions payment,
 * which every x402 listing does.
 *
 * So the term is kept for discovery, where it works, and never reaches a
 * mandate. The capability is read from the endpoint instead.
 */

export const POLICY_CAPABILITIES = [
  "research",
  "data",
  "inference",
  "identity",
  "payments",
] as const;

export type PolicyCapability = (typeof POLICY_CAPABILITIES)[number];

/**
 * What Veyra says when it cannot tell.
 *
 * Deliberately not a member of POLICY_CAPABILITIES and deliberately not
 * "research": it is a value no sensible mandate lists, so an endpoint Veyra
 * cannot classify is refused rather than filed under whichever capability
 * happens to be broadest. The asymmetry is the point. Calling a payment
 * endpoint "research" authorises a payment under a research budget; calling a
 * research endpoint "unclassified" costs a card nobody was going to buy
 * anyway.
 */
export const UNCLASSIFIED_CAPABILITY = "unclassified" as const;

export function isPolicyCapability(value: string): value is PolicyCapability {
  return (POLICY_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * The route is the strongest evidence a catalogue row carries.
 *
 * A provider writes its description for a human browsing a marketplace and its
 * path for its own router, so `/v1/chat/completions` means one thing everywhere
 * while "baseten endpoint via Orthogonal nanopayment proxy" -- the description
 * on that exact row -- means nothing at all. Ten of the agent's current
 * candidates carry that same sentence over ten different services.
 *
 * Matched on tokens rather than on whole segments, because providers write
 * `api_search`, `hl-deposit-withdraw` and `createTask` and mean search, a
 * withdrawal and a task. Segments are split on separators and on camel case.
 *
 * The order is a safety property, not a preference. Money first, then work run
 * on somebody's bill, then the classes that only read. A route that looks like
 * two things is read as the more consequential one, so the mistake this makes
 * is refusing a card the mandate would have allowed -- never authorising a kind
 * of purchase the owner did not list.
 */
const ROUTE_TOKENS: Array<[PolicyCapability, Set<string>]> = [
  ["payments", new Set([
    "topup", "settle", "settles", "settlement", "settlements", "transfer", "transfers",
    "payout", "payouts", "withdraw", "withdrawal", "withdrawals", "deposit", "deposits",
    "invoice", "invoices", "checkout", "swap", "swaps", "bridge", "refund", "refunds",
    "pay", "payment", "payments", "charge", "charges", "book", "booking", "bookings",
    "reserve", "reservation", "reservations", "order", "orders", "purchase", "buy",
  ])],
  ["inference", new Set([
    "chat", "completion", "completions", "embedding", "embeddings", "generate",
    "generation", "generations", "inference", "render", "transcribe", "transcription",
    "summarize", "summarise", "llm", "sdxl", "flux", "diffusion", "imagine",
  ])],
  ["identity", new Set([
    "identity", "identities", "reputation", "attestation", "attestations",
    "credential", "credentials", "kyc", "did", "verify", "verification",
    "intelligence", "entity", "entities", "profile", "profiles",
    "people", "person", "resolve", "enrich",
  ])],
  ["data", new Set([
    "marketdata", "price", "prices", "quote", "quotes", "ohlc", "candle", "candles",
    "metric", "metrics", "balance", "balances", "holdings", "history", "historical",
    "stats", "statistics", "index", "indices", "feed", "feeds", "volume", "vwap",
    "portfolio", "portfolios", "summary", "bidask",
  ])],
  ["research", new Set([
    "search", "searches", "content", "contents", "extract", "scrape", "crawl",
    "news", "scholar", "patent", "patents", "tweet", "tweets", "article", "articles",
    "document", "documents", "answer", "answers", "query", "queries",
    "autocomplete", "discover", "nearby", "research",
  ])],
];

/**
 * The description, read only where the route said nothing.
 *
 * Whole words, because "index" inside "indexed" and "charge" inside "charged"
 * are not the same claim, and a policy value is not a place to be approximate.
 */
const TEXT_RULES: Array<[PolicyCapability, RegExp]> = [
  ["payments", /\b(top[- ]?up|settle(ment)?|transfer|payout|withdraw(al)?|deposit|invoice|checkout|swap|bridg(e|ing)|refund|book a|reservation)\b/i],
  ["inference", /\b(chat|completion|embedding|generat(e|ion)|inference|render(ed|ing)?|transcribe|summari[sz]e|image generation|llm)\b/i],
  ["identity", /\b(identity|reputation|attestation|credential|kyc|verif(y|ication)|intelligence|entity|profile)\b/i],
  ["data", /\b(price|prices|market data|marketdata|ohlc|candle|metric|metrics|balance|holdings|historical|index|ranking|rankings|sentiment|statistics|portfolio)\b/i],
  ["research", /\b(search|content|contents|extract|scrape|crawl|news|scholar|patent|patents|tweet|tweets|article|articles|research|answer|answers)\b/i],
];

/** `api_search` -> api, search. `hl-deposit-withdraw` -> hl, deposit, withdraw.
 *  `createTask` -> create, task. Providers name routes all three ways. */
function tokensOf(segment: string): string[] {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * What kind of paid action this endpoint offers, from what it publishes.
 *
 * Deterministic and local: no model is asked, because a permission a model
 * decides is a permission nobody signed. Given the same row it returns the same
 * capability forever, which is what makes a decision written last Tuesday
 * comparable with one written today.
 */
export function policyCapabilityFor(input: {
  resource: string;
  description?: string | null;
  provider?: string | null;
}): PolicyCapability | typeof UNCLASSIFIED_CAPABILITY {
  let path = "";
  try {
    path = new URL(input.resource).pathname;
  } catch {
    path = String(input.resource || "");
  }
  /* Path segments only, with templated ones dropped. `{inbox_id}` is the
     caller's knowledge, not the endpoint's kind, and a brace in a segment is
     already how firstPayable recognises a route Nova cannot fill. */
  const tokens = new Set(
    path.split("/")
      .filter((part) => part && !part.includes("{"))
      .flatMap(tokensOf),
  );

  for (const [capability, vocabulary] of ROUTE_TOKENS) {
    for (const token of tokens) {
      if (vocabulary.has(token)) return capability;
    }
  }

  const text = [input.description, input.provider].filter(Boolean).join(" ");
  if (text.trim()) {
    for (const [capability, pattern] of TEXT_RULES) {
      if (pattern.test(text)) return capability;
    }
  }

  return UNCLASSIFIED_CAPABILITY;
}
