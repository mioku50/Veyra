/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */

/**
 * Something the owner says Nova should have shown them.
 *
 * Roadmap item 3 is to extend coverage from missed owner-relevant events, and
 * the coverage report says plainly that a miss cannot be measured from this
 * side: nothing records an event that was never observed. Only the owner
 * naming one establishes it. This is where they name it.
 *
 * A reported link is parsed and never fetched. Fetching it would turn an owner
 * form into a way to make the server read any address on the internet, and the
 * answer the owner needs does not require it: whether Nova already had this,
 * reads where it came from, or reads nothing there at all. Those are three
 * different defects -- ranking, reading, coverage -- and only the third is
 * fixed by adding a source.
 *
 * Pure, so the page can check a link before sending it.
 */
export type MissFinding = "observed" | "covered" | "not_covered";

/** What Nova found when the owner said it missed something. */
export type NovaMiss = {
  url: string;
  finding: MissFinding;
  detail: {
    headline?: string;
    observedAt?: string;
    status?: string;
    /** Read against the goal as it stands now. */
    read?: boolean;
    significant?: boolean | null;
    feed?: string;
    repository?: string;
    host?: string;
  };
};

export const MISS_URL_MAX = 2048;

/** Parameters that identify who shared a link, not what it points at. */
const TRACKING = /^(utm_.*|ref|ref_src|fbclid|gclid|mc_cid|mc_eid)$/i;

export function missUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > MISS_URL_MAX) return null;
  let url: URL;
  try { url = new URL(text); } catch { return null; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || !url.hostname.includes(".")) return null;
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) if (TRACKING.test(key)) url.searchParams.delete(key);
  return url;
}

const bareHost = (host: string) => host.toLowerCase().replace(/^www\./, "");

/**
 * Every spelling under which a stored publication could hold this article.
 * Stored links are https, with no query and no fragment, and keep whatever
 * `www.` and trailing slash the publisher's own index used.
 */
export function publicationVariants(url: URL): string[] {
  const host = bareHost(url.hostname);
  const path = url.pathname.replace(/\/+$/, "");
  const paths = path ? [path, `${path}/`] : ["/"];
  return [host, `www.${host}`].flatMap(h => paths.map(p => `https://${h}${p}`));
}

type Feed = { label: string; url: string; format: string };

/**
 * Where Nova would have found this, if it reads there at all.
 *
 * An index page covers what sits under it -- www.circle.com/blog does not
 * cover a Circle press release. A feed on a host of its own covers the host.
 */
export function coverageOf(
  url: URL,
  feeds: readonly Feed[],
  watchedRepositories: readonly string[],
): { feed: string } | { repository: string } | null {
  const host = bareHost(url.hostname);
  for (const feed of feeds) {
    const source = new URL(feed.url);
    if (bareHost(source.hostname) !== host) continue;
    const index = feed.format === "xml" ? "" : source.pathname.replace(/\/+$/, "");
    if (!index || url.pathname === index || url.pathname.startsWith(`${index}/`)) return { feed: feed.label };
  }
  if (host === "github.com") {
    const [owner, name] = url.pathname.split("/").filter(Boolean);
    const watched = owner && name
      ? watchedRepositories.find(ref => ref.toLowerCase() === `${owner}/${name}`.toLowerCase())
      : undefined;
    if (watched) return { repository: watched };
  }
  return null;
}
