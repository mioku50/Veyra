/**
 * Copyright 2026 Circle Internet Group, Inc.  All rights reserved.
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

const PUBLIC_PATHS = ["/", "/agent-runner", "/agent-runner?workflow=github", "/results"];

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

  const { visibleText, innerHtmlWithoutDetails } = await page.evaluate(() => {
    const clone = document.body.cloneNode(true) as HTMLElement;
    const hiddenElements = clone.querySelectorAll("details, script, style");
    hiddenElements.forEach((el) => el.remove());

    return {
      visibleText: clone.innerText || clone.textContent || "",
      innerHtmlWithoutDetails: clone.innerHTML || "",
    };
  });

  for (const pattern of FORBIDDEN_PATTERNS) {
    assert(
      !pattern.test(visibleText),
      `Forbidden technical jargon matching ${pattern} found in visible text of ${path}`
    );
    assert(
      !pattern.test(innerHtmlWithoutDetails),
      `Forbidden technical jargon matching ${pattern} found in HTML body (outside <details>) of ${path}`
    );
  }
}

async function verifyNavigationLinks(page: Page, path: string) {
  await page.goto(`${baseUrl()}${path}`, { waitUntil: "load" });

  const navLabels = await page.evaluate(() => {
    const sidebar = document.querySelector('[data-testid="desktop-sidebar"]');
    if (!sidebar) return [];
    const links = Array.from(sidebar.querySelectorAll('a[href^="/"]'));
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
      await verifyNavigationLinks(page, path);
      await verifyPageCleanliness(page, path);
      console.log(`  ✓ ${path} verified clean of forbidden jargon and has correct navigation links`);
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
