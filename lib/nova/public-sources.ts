/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import { load } from "cheerio";
import { wasCut, type PublicMaterial } from "./value.ts";
import type { SourceObservation, SourceResult } from "./sources.ts";

export const PUBLIC_FEEDS = [
  { label: "Arc announcements", url: "https://www.arc.io/blog", interests: ["arc", "agent payments"], format: "html" },
  { label: "Circle announcements", url: "https://www.circle.com/blog", interests: ["arc", "agent payments"], format: "html" },
  { label: "Ethereum announcements", url: "https://blog.ethereum.org/en/feed.xml", interests: ["agent standards", "onchain data"], format: "xml" },
  { label: "LangChain announcements", url: "https://www.langchain.com/blog", interests: ["ai"], format: "html" },
] as const;
const ORIGINS = new Set([...PUBLIC_FEEDS.map(f => new URL(f.url).origin), "https://docs.arc.io", "https://developers.circle.com"]);
const REFERENCE_DOCS = [
  { url: "https://docs.arc.io/arc/references/connect-to-arc.md", title: "Arc network connection reference" },
  { url: "https://developers.circle.com/gateway-nanopayments/supported-networks.md", title: "Circle Nanopayments supported networks" },
];

export function publicationUrl(value: string, base: string): string | null {
  try {
    const u = new URL(value, base);
    if (!ORIGINS.has(u.origin) || u.username || u.password || u.port || u.protocol !== "https:") return null;
    if (u.origin !== new URL(base).origin) return null;
    u.hash = ""; u.search = "";
    return u.toString();
  } catch { return null; }
}

/**
 * Fixed official hosts only, no auth, bounded bytes and time. Never retries a
 * 402 with payment.
 *
 * At most one redirect, and only within the same approved origin. Circle
 * moved its Nanopayments reference from /gateway/nanopayments/ to
 * /gateway-nanopayments/ and answered the old address with a 307. With every
 * redirect refused, each reading after that lost the page and printed
 * "coverage is incomplete" on the card, and nothing else noticed. A redirect
 * to another origin, or a second one, is still a failure, and the time bound
 * covers both requests together.
 */
export async function readPublicPage(url: string, fetchImpl = fetch): Promise<string> {
  if (!publicationUrl(url, url)) throw new Error("Unapproved public source");
  const init: RequestInit = { redirect: "manual", signal: AbortSignal.timeout(7000), headers: { Accept: "text/html,application/rss+xml,application/atom+xml,application/xml", "User-Agent": "Veyra-Nova/1.0" } };
  let response = await fetchImpl(url, init);
  if (response.status >= 300 && response.status < 400) {
    const moved = publicationUrl(response.headers.get("location") ?? "", url);
    if (!moved) throw new Error("Public source moved off its approved site");
    response = await fetchImpl(moved, init);
    if (response.status >= 300 && response.status < 400) throw new Error("Public source redirected more than once");
  }
  if (!response.ok || !response.body) throw new Error("Public source unavailable");
  if (Number(response.headers.get("content-length") ?? 0) > 1_500_000) throw new Error("Source too large");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > 1_500_000) throw new Error("Source too large");
      chunks.push(part.value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks).toString("utf8");
}
const plain = (html: string) => load(html).text().replace(/\s+/g, " ").trim();

/**
 * How much of an article Nova keeps, in characters -- and so, since edition 7,
 * how much of it the model reads.
 *
 * It was 6,000, and half the articles on the owner's Today were cut there, so
 * "how much of this article was read" had no honest denominator. The brief
 * does not carry this text to the page.
 */
export const ARTICLE_TEXT_CAP = 12_000;

/** The body of an article page: the longest article-like block. */
function articleBody($: ReturnType<typeof load>): string {
  $("script,style,nav,footer,header,form").remove();
  return $("article, .w-richtext").toArray()
    .map(node => $(node).text().replace(/\s+/g, " ").trim())
    .sort((a, b) => b.length - a.length)[0] ?? "";
}
function recentDate(value: string, now: Date): string | null {
  const date = Date.parse(value); const age = now.getTime() - date;
  return Number.isFinite(date) && age >= 0 && age <= 21 * 86400_000 ? new Date(date).toISOString() : null;
}

export function parsePublication(html: string, url: string, now: Date): PublicMaterial | null {
  const $ = load(html);
  let date = $("meta[property='article:published_time']").attr("content") ?? $("time").first().attr("datetime") ?? "";
  for (const node of $("script[type='application/ld+json']").toArray()) {
    try {
      const raw = JSON.parse($(node).text());
      const entries = Array.isArray(raw) ? raw : Array.isArray(raw["@graph"]) ? raw["@graph"] : [raw];
      const article = entries.find((e: Record<string, unknown>) => typeof e?.datePublished === "string");
      if (article) date = article.datePublished;
    } catch { /* Invalid publisher metadata is not a date. */ }
  }
  const rawDate = date || $(".blog_date-time").first().text();
  if (!Number.isFinite(Date.parse(rawDate))) throw new Error("Publication date unavailable");
  const publishedAt = recentDate(rawDate, now);
  if (!publishedAt) return null;
  const title = $("h1").first().text().trim().slice(0, 160);
  const body = articleBody($);
  const text = body.slice(0, ARTICLE_TEXT_CAP);
  if (!title || text.length < 80) throw new Error("Publication content unavailable");
  return { id: url, title, url, text, publishedAt, fetchedAt: now.toISOString(), truncated: body.length > text.length };
}

export function parseFeed(xml: string, base: string, now: Date): PublicMaterial[] {
  const $ = load(xml, { xml: true });
  if (!$("rss,feed").length) throw new Error("Not a publication feed");
  const items: PublicMaterial[] = [];
  for (const node of $("item,entry").toArray().slice(0, 20)) {
    const item = $(node);
    const link = item.find("link").first();
    const url = publicationUrl(link.attr("href") || link.text(), base);
    const publishedAt = recentDate(item.find("pubDate,published,updated").first().text(), now);
    const title = plain(item.find("title").first().text()).slice(0, 160);
    const body = plain(item.find("description,summary,content,content\\:encoded").first().text());
    const text = body.slice(0, ARTICLE_TEXT_CAP);
    if (!url || !publishedAt || !title || text.length < 80) continue;
    if (items.some(s => s.url === url)) continue;
    items.push({ id: url, title, url, text, publishedAt, fetchedAt: now.toISOString(), truncated: body.length > text.length });
  }
  return items.sort((a,b) => b.publishedAt!.localeCompare(a.publishedAt!)).slice(0, 6);
}

export async function observePublications(input: { interests: string[]; now: Date; fetchImpl?: typeof fetch }): Promise<SourceResult> {
  const interests = new Set(input.interests.map(i => i.toLowerCase()));
  const selected = PUBLIC_FEEDS.filter(f => f.interests.some(i => interests.has(i)));
  const results = await Promise.all(selected.map(async feed => {
    const unavailable: string[] = [];
    let unreadableArticles = 0;
    try {
      const body = await readPublicPage(feed.url, input.fetchImpl);
      let materials: PublicMaterial[];
      if (feed.format === "xml") materials = parseFeed(body, feed.url, input.now);
      else {
        const $ = load(body);
        const urls = Array.from(new Set($("a[href]").toArray().map(a => publicationUrl($(a).attr("href") ?? "", feed.url))
          .filter((u): u is string => !!u && new URL(u).pathname.startsWith("/blog/") && !/\/blog\/(tag|category|author)\//.test(u)))).slice(0, 10);
        if (!urls.length) throw new Error("Publication index unavailable");
        /* Three outcomes, not two. The index lists old posts, so a page that
           parses to null is the ordinary case and counts as nothing at all. */
        const reads = await Promise.all(urls.map(async url => {
          let body: string;
          try { body = await readPublicPage(url, input.fetchImpl); }
          catch { return { kind: "unreachable" as const }; }
          try {
            const material = parsePublication(body, url, input.now);
            return material ? { kind: "material" as const, material } : { kind: "not-recent" as const };
          } catch { return { kind: "unreadable" as const }; }
        }));
        materials = reads.flatMap(r => r.kind === "material" ? [r.material] : [])
          .sort((a,b) => b.publishedAt!.localeCompare(a.publishedAt!));
        if (reads.some(r => r.kind === "unreachable")) unavailable.push(`${feed.label} (some articles unavailable)`);
        unreadableArticles = reads.filter(r => r.kind === "unreadable").length;
      }
      const interest = input.interests.find(i => feed.interests.some(f => f === i.toLowerCase()))!;
      const observations: SourceObservation[] = materials.map(material => ({
        kind: "official_publication", ref: material.url, label: feed.label, interest,
        digest: { kind: "official_publication", material }, catalogUpdatedAt: material.publishedAt,
        subjectText: `${material.title} ${material.text}`, context: { url: material.url, publicMaterial: material },
      }));
      return { observations, unavailable, unreadable: unreadableArticles ? { [feed.label]: unreadableArticles } : {} };
    } catch { return { observations: [], unavailable: [feed.label], unreadable: {} }; }
  }));
  const unreadable: Record<string, number> = {};
  for (const result of results) for (const [label, count] of Object.entries(result.unreadable)) unreadable[label] = (unreadable[label] ?? 0) + count;
  return { observations: results.flatMap(r => r.observations), unavailable: results.flatMap(r => r.unavailable), unreadable };
}

/**
 * The article again, when what was kept of it stopped at the old cap.
 *
 * A re-reading reads what was stored, and everything stored before the cap was
 * raised stopped at 6,000 characters -- so without this, giving the model the
 * whole event would reach new articles only, and every card already on the
 * page would be read again from the same opening. Fetched from the same fixed
 * official hosts, with the same bounds, as the first read. Any failure, or a
 * page that yields no more text than was kept, returns the stored material
 * unchanged: a failed refetch costs the improvement, never the reading.
 */
export async function fullerPublication(material: PublicMaterial, fetchImpl = fetch, now = new Date()): Promise<PublicMaterial> {
  if (!wasCut(material) || material.text.length >= ARTICLE_TEXT_CAP) return material;
  try {
    const body = articleBody(load(await readPublicPage(material.url, fetchImpl)));
    const text = body.slice(0, ARTICLE_TEXT_CAP);
    if (text.length <= material.text.length) return material;
    return { ...material, text, truncated: body.length > text.length, fetchedAt: now.toISOString() };
  } catch {
    return material;
  }
}

/** A bounded second look: at the event itself, whole, where what was kept of
 * it stopped at the old cap, and at first-party references. The two are
 * fetched together, so the slowest reading is no slower than before -- the
 * per-card button has sixty seconds and the model alone may take forty-five.
 * Failure stays visible and cannot be reinterpreted as evidence that a paid
 * tool is necessary. */
export async function publicContext(material: PublicMaterial, fetchImpl = fetch): Promise<{ sources: PublicMaterial[]; unavailable: string[] }> {
  const host = new URL(material.url).hostname;
  const event = fullerPublication(material, fetchImpl);
  if (!["www.arc.io", "www.circle.com"].includes(host)) return { sources: [await event], unavailable: [] };
  const [whole, results] = await Promise.all([event, Promise.allSettled(REFERENCE_DOCS.map(async doc => {
    const text = await readPublicPage(doc.url, fetchImpl);
    if (!text.trim() || text.trimStart().startsWith("<!")) throw new Error("Reference unavailable");
    return { id: doc.url, url: doc.url, title: doc.title, text: text.slice(0, 6000), publishedAt: null, fetchedAt: new Date().toISOString() } satisfies PublicMaterial;
  }))]);
  return { sources: [whole, ...results.flatMap(r => r.status === "fulfilled" ? [r.value] : [])],
    unavailable: results.flatMap((r,i) => r.status === "rejected" ? [REFERENCE_DOCS[i].title] : []) };
}
