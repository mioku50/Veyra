/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import { publicationUrl, readPublicPage } from "./public-sources.ts";
import type { PublicMaterial } from "./value.ts";

/**
 * Arc's and Circle's documentation, looked up for one question, at no charge.
 *
 * Both sites publish an index written for agents, `llms.txt`: one line per
 * page, with a title and a short description. Nova picks pages from it and
 * reads them as markdown, from the same fixed official hosts and within the
 * same bounds as every other public read. This is not a search engine. A page
 * the index does not list is a page Nova does not read.
 */

export const DOCS_INDEXES = [
  { site: "Arc documentation", url: "https://docs.arc.io/llms.txt" },
  { site: "Circle documentation", url: "https://developers.circle.com/llms.txt" },
] as const;

export const DOCS_LIMITS = {
  /** Pages read for one question. */
  pagesRead: 3,
  /** Each index is read once an hour per server instance, not per question. */
  indexCacheMs: 3_600_000,
  /** What is kept of a page. Reference pages are long and their tables sit
   *  far down: Arc's contract addresses reach GatewayWallet after 15,000
   *  characters. What the model is given is bounded by passagesPerPage. */
  pageChars: 60_000,
  /** Given to the model per page: all of them when there are few, else the
   *  ones that say the searched words, in the page's own order. */
  passagesPerPage: 40,
  passageChars: 360,
} as const;

export type DocsPage = {
  /** 1-based, stable within one read of the indexes. The model names pages by it. */
  id: number;
  site: string;
  /** The index heading the page sits under: "Overview" means little without it. */
  section: string | null;
  title: string;
  url: string;
  description: string | null;
};

export type DocsIndex = { pages: DocsPage[]; unavailable: string[] };

export type DocsPassage = { id: string; url: string; title: string; quote: string };

/** One index, as its site publishes it. Links off the site's own host are dropped. */
export function parseDocsIndex(text: string, site: string, indexUrl: string): Array<Omit<DocsPage, "id">> {
  const pages: Array<Omit<DocsPage, "id">> = [];
  const seen = new Set<string>();
  let section: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const heading = /^#{2,4}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      section = heading[1].replace(/[*_`]/g, "").trim() || null;
      continue;
    }
    const entry = /^\s*[-*]\s+\[([^\]]{1,160})\]\((https:\/\/[^)\s]+)\)(?::\s*(.+))?$/.exec(line);
    if (!entry) continue;
    const url = publicationUrl(entry[2], indexUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    pages.push({
      site,
      section,
      title: entry[1].trim(),
      url,
      description: entry[3]?.trim().slice(0, 300) || null,
    });
  }
  return pages;
}

let cachedIndex: { index: DocsIndex; at: number } | null = null;

export function clearDocsIndexCache(): void {
  cachedIndex = null;
}

/**
 * Both indexes, numbered as one list. A site that does not answer is named
 * rather than silently missing, and an index with a missing site is not kept
 * for the next question.
 */
export async function readDocsIndex(input: { fetchImpl?: typeof fetch; now?: Date } = {}): Promise<DocsIndex> {
  const now = (input.now ?? new Date()).getTime();
  if (cachedIndex && now - cachedIndex.at < DOCS_LIMITS.indexCacheMs) return cachedIndex.index;
  const reads = await Promise.allSettled(DOCS_INDEXES.map(async (source) =>
    parseDocsIndex(await readPublicPage(source.url, input.fetchImpl), source.site, source.url)));
  const pages: DocsPage[] = [];
  const unavailable: string[] = [];
  reads.forEach((read, index) => {
    if (read.status === "fulfilled" && read.value.length > 0) {
      for (const page of read.value) pages.push({ ...page, id: pages.length + 1 });
    } else {
      unavailable.push(DOCS_INDEXES[index].site);
    }
  });
  const index = { pages, unavailable };
  if (unavailable.length === 0) cachedIndex = { index, at: now };
  return index;
}

/**
 * A page's own words, with its markup taken out and its tables kept by row.
 *
 * A row says where it sits. Arc's contract addresses are one table per
 * product inside a Mainnet tab and a Testnet tab, and "GatewayWallet | 26 |
 * 0x7777…" means nothing, or the wrong thing, without "Gateway, Mainnet".
 * Tabs are markup, and taking the markup out used to take that with it.
 */
export function markdownPassages(text: string): string[] {
  const lines = text
    .replace(/\r/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .split("\n");
  const flat = (value: string) => value.replace(/<\/?[A-Za-z][^>]*>/g, " ").replace(/[*_`>]+/g, " ").replace(/\s+/g, " ").trim();
  const passages: string[] = [];
  const keep = (value: string) => {
    if (value.length >= 20) passages.push(value.slice(0, DOCS_LIMITS.passageChars));
  };
  let heading: string | null = null;
  let tab: string | null = null;
  let paragraph: string[] = [];
  /* Where the previous line's table row went, so that a separator right
     after it can take it back out: a header row names columns, not facts. */
  let previousRow: number | null = null;
  const flush = () => {
    const joined = flat(paragraph.join(" "));
    paragraph = [];
    if (!joined) return;
    const text = tab ? `${tab}: ${joined}` : joined;
    if (text.length <= DOCS_LIMITS.passageChars) {
      keep(text);
      return;
    }
    let current = "";
    for (const sentence of text.split(/(?<=[.!?:])\s+/)) {
      if (current && `${current} ${sentence}`.length > DOCS_LIMITS.passageChars) {
        keep(current);
        current = "";
      }
      current = current ? `${current} ${sentence}` : sentence;
    }
    if (current) keep(current);
  };
  for (const raw of lines) {
    const line = raw.trim();
    const rowBefore = previousRow;
    previousRow = null;
    if (!line) {
      flush();
      continue;
    }
    const title = /^#{1,6}\s+(.+)$/.exec(line);
    if (title) {
      flush();
      heading = flat(title[1]) || null;
      tab = null;
      continue;
    }
    const opened = /<(?:Tab|Accordion|Step|Card|Expandable)\b[^>]*\btitle="([^"]+)"/.exec(line);
    if (opened) {
      flush();
      tab = flat(opened[1]) || null;
      continue;
    }
    if (/^<\/(?:Tab|Accordion|Step|Card|Expandable)>$/.test(line)) {
      flush();
      tab = null;
      continue;
    }
    /* A table is rows, and an address or a limit sits in one of them. */
    if (line.startsWith("|")) {
      flush();
      if (/^\|?[\s:|-]+\|?$/.test(line)) {
        if (rowBefore !== null && rowBefore === passages.length - 1) passages.pop();
        continue;
      }
      const row = flat(line.replace(/\|/g, " | ")).replace(/^\|\s*|\s*\|$/g, "");
      const where = [heading, tab].filter(Boolean).join(", ");
      const before = passages.length;
      keep(where ? `${where}: ${row}` : row);
      if (passages.length > before) previousRow = passages.length - 1;
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return passages;
}

/**
 * The chosen pages, read. A page that does not answer, or answers with a web
 * page instead of its markdown, is named as unread; it is never guessed at.
 */
export async function readDocsPages(
  pages: DocsPage[],
  input: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<{ materials: PublicMaterial[]; unavailable: string[] }> {
  const fetchedAt = (input.now ?? new Date()).toISOString();
  const reads = await Promise.allSettled(pages.slice(0, DOCS_LIMITS.pagesRead).map(async (page) => {
    const text = await readPublicPage(page.url, input.fetchImpl);
    if (!text.trim() || text.trimStart().startsWith("<")) throw new Error("Not a markdown page");
    const title = page.section && page.section !== page.title ? `${page.section}: ${page.title}` : page.title;
    return {
      id: page.url,
      title: `${title} (${page.site})`,
      url: page.url,
      text: text.slice(0, DOCS_LIMITS.pageChars),
      truncated: text.length > DOCS_LIMITS.pageChars,
      publishedAt: null,
      fetchedAt,
    } satisfies PublicMaterial;
  }));
  return {
    materials: reads.flatMap((read) => read.status === "fulfilled" ? [read.value] : []),
    unavailable: reads.flatMap((read, index) => read.status === "rejected" ? [pages[index].title] : []),
  };
}

/**
 * Numbered passages, so an answer can say which ones it stands on. A long page
 * gives the passages that say the searched words, the rarer on that page the
 * more they count, kept in the page's own order and under their own numbers.
 * On Arc's contract addresses every other row says "mainnet" and "contract";
 * one says "wallet".
 */
export function docsPassages(materials: PublicMaterial[], terms: string[] = []): DocsPassage[] {
  const wanted = Array.from(new Set(terms.flatMap((term) => Array.from(wordsOf(term)))));
  return materials.flatMap((material, pageIndex) => {
    const all = markdownPassages(material.text)
      .map((quote, index) => ({ id: `d${pageIndex + 1}.${index + 1}`, url: material.url, title: material.title, quote }));
    if (all.length <= DOCS_LIMITS.passagesPerPage || wanted.length === 0) return all.slice(0, DOCS_LIMITS.passagesPerPage);
    const words = all.map((passage) => wordsOf(passage.quote));
    const weight = new Map(wanted.map((word) => {
      const holding = words.filter((set) => set.has(word)).length;
      return [word, holding === 0 ? 0 : Math.log(1 + all.length / holding)];
    }));
    const said = (index: number) => wanted.reduce((sum, word) => sum + (words[index].has(word) ? weight.get(word) ?? 0 : 0), 0);
    const chosen = new Set(all
      .map((_, index) => ({ index, said: said(index) }))
      .sort((left, right) => right.said - left.said || left.index - right.index)
      .slice(0, DOCS_LIMITS.passagesPerPage)
      .map((entry) => entry.index));
    return all.filter((_, index) => chosen.has(index));
  });
}

const WORD = /[a-z0-9]+/g;

/* "GatewayWallet" says gateway and wallet. */
function wordsOf(text: string): Set<string> {
  const words = new Set<string>();
  for (const word of text.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().match(WORD) ?? []) {
    if (word.length < 2) continue;
    words.add(word);
    if (word.length > 3 && word.endsWith("s")) words.add(word.slice(0, -1));
  }
  return words;
}

/**
 * Pages whose title, section or description say the searched words, rarest
 * words counting most. Used when the reading model cannot choose: a word
 * every page says ("usdc" in Circle's index) chooses nothing.
 */
export function rankDocsPages(pages: DocsPage[], terms: string[], limit: number = DOCS_LIMITS.pagesRead): DocsPage[] {
  const wanted = Array.from(new Set(terms.flatMap((term) => Array.from(wordsOf(term)))));
  if (wanted.length === 0) return [];
  const words = pages.map((page) => wordsOf([page.section, page.title, page.description].filter(Boolean).join(" ")));
  const weight = new Map(wanted.map((word) => {
    const holding = words.filter((set) => set.has(word)).length;
    return [word, holding === 0 ? 0 : Math.log(1 + pages.length / holding)];
  }));
  return pages
    .map((page, index) => ({
      page,
      score: wanted.reduce((sum, word) => sum + (words[index].has(word) ? weight.get(word) ?? 0 : 0), 0),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.page.id - right.page.id)
    .slice(0, limit)
    .map((entry) => entry.page);
}
