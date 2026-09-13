/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { chromium, type Page } from "playwright";
import { publicSidebarNavigation } from "../lib/navigation/sidebar.ts";

// Derived from the shared config so a navigation change updates one place, while
// FORBIDDEN_PATTERNS still guards which vocabulary may reach a public surface.
const EXPECTED_PUBLIC_NAV_LABELS = publicSidebarNavigation.flatMap((section) =>
  section.items.map((item) => item.label as string),
);

const FORBIDDEN_PATTERNS = [
  /\bPhase\s+\d+(?:\.\d+)?\b/i,
  /\bFreeModel\b/i,
  /\breceipts?\b/i,
  /\bArc proofs?\b/i,
  /\bproject-owned payer\b/i,
  /\bhosted payer\b/i,
  /\bworkflow payer\b/i,
  /\bprovider cost\b/i,
  /\bplatform fee\b/i,
  /\bSHA-256\b/i,
  /\bidempotency\b/i,
  /\bpolicy_denied\b/i,
  /\bwallet_already_registered\b/i,
  /\bGITHUB_TOKEN\b/i,
  /\bAuthorization\b/i,
  /\braw headers?\b/i,
  /\breceipt count\b/i,
];

/* The public surface, as it actually is. This listed /agent-runner and
   /results, both of which are now frozen behind the developer console and
   answer with a redirect, so the check was inspecting the console rather than
   the product. */
const PUBLIC_PATHS = ["/", "/executions", "/run"];

/* /run supplies its own chrome and deliberately has no shell navigation: a
   single-purpose decision screen nested inside a browsing shell makes both look
   unfinished. So its copy is checked and its navigation is not. */
const SHELL_PATHS = ["/", "/executions"];

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];

function baseUrl() {
  const argument = process.argv.find((value) => value.startsWith("--base-url="));
  return (argument?.slice("--base-url=".length) ?? process.env.BASE_URL ?? "http://127.0.0.1:3100").replace(/\/$/, "");
}

async function verifyPageCleanliness(page: Page, path: string) {
  await page.goto(`${baseUrl()}${path}`, { waitUntil: "load" });

  /* Words, not markup.
   *
   * This used to match the forbidden patterns against innerHTML, which made the
   * rule impossible to satisfy for reasons that had nothing to do with
   * language: href="/receipts" is an address, and class="lucide-receipt-text"
   * is an icon's name in a third-party library. Both tripped the "receipts"
   * rule on a page whose only visible word was "Payments".
   *
   * What is checked now is what a person can actually read: rendered text, plus
   * the attributes that carry copy rather than plumbing. */
  const { visibleText, innerHtmlWithoutDetails } = await page.evaluate(() => {
    const clone = document.body.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("details, script, style, svg").forEach((el) => el.remove());

    const copyAttributes = ["title", "alt", "placeholder", "aria-label"];
    const attributeCopy: string[] = [];
    clone.querySelectorAll("*").forEach((el) => {
      for (const name of copyAttributes) {
        const value = el.getAttribute(name);
        if (value) attributeCopy.push(value);
      }
    });

    return {
      visibleText: clone.innerText || clone.textContent || "",
      innerHtmlWithoutDetails: attributeCopy.join("\n"),
    };
  });

  for (const pattern of FORBIDDEN_PATTERNS) {
    assert(
      !pattern.test(visibleText),
      `Forbidden technical jargon matching ${pattern} found in visible text of ${path}`
    );
    assert(
      !pattern.test(innerHtmlWithoutDetails),
      `Forbidden technical jargon matching ${pattern} found in a title/alt/placeholder/aria-label of ${path}`
    );
  }
}

async function verifyNavigationLinks(page: Page, path: string) {
  await page.goto(`${baseUrl()}${path}`, { waitUntil: "load" });

  /* The public navigation is in the top bar, not a left rail. A left sidebar is
     the right shape for an operator moving between many tools and the wrong one
     for a person reading a single brief; the rail is now the console's alone. */
  const navLabels = await page.evaluate(() => {
    const nav = document.querySelector('[data-testid="public-nav"]');
    if (!nav) return [];
    const links = Array.from(nav.querySelectorAll('a[href^="/"]'));
    return links.map((a) => a.textContent?.trim()).filter((text): text is string => Boolean(text));
  });

  assert.deepEqual(
    navLabels,
    EXPECTED_PUBLIC_NAV_LABELS,
    `Navigation links on ${path} do not match the current public navigation. Found: ${JSON.stringify(navLabels)}`
  );
}

async function verifyLayoutConstraints(page: Page, path: string, viewportName: string) {
  await page.goto(`${baseUrl()}${path}`, { waitUntil: "load" });
  const overflow = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));

  assert(
    overflow.scroll <= overflow.client + 1,
    `${path} overflows horizontally on ${viewportName} (${overflow.scroll} > ${overflow.client}).`
  );
}

async function main() {
  console.log(`[verify-public-ui-cleanliness] starting tests against ${baseUrl()}...`);
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

    for (const path of PUBLIC_PATHS) {
      if (SHELL_PATHS.includes(path)) await verifyNavigationLinks(page, path);
      await verifyPageCleanliness(page, path);
      console.log(`  ✓ ${path} verified clean of forbidden jargon${SHELL_PATHS.includes(path) ? " and has correct navigation links" : ""}`);
    }

    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      for (const path of PUBLIC_PATHS) {
        await verifyLayoutConstraints(page, path, viewport.name);
      }
      console.log(`  ✓ Layout constraints passed for ${viewport.name} (${viewport.width}x${viewport.height})`);
    }

    console.log("[verify-public-ui-cleanliness] PASSED: All public routes are clean of technical jargon and obey layout constraints.");
  } finally {
    await browser.close();
  }
}

await main();
