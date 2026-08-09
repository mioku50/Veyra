import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { BRAND, BRAND_TITLE } from "../lib/brand.ts";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const FORBIDDEN_BRANDS = [
  "Arc Agent Commerce",
  "Arc Developer Console",
  "Agent Developer Console",
  "Hosted paid API workflows",
] as const;
const ACTIVE_EXTENSIONS = /\.(?:ts|tsx|md|json|py)$/;

function baseUrl() {
  const argument = process.argv.find((value) => value.startsWith("--base-url="));
  return (argument?.slice("--base-url=".length) ?? process.env.BASE_URL ?? "http://127.0.0.1:3100")
    .replace(/\/$/, "");
}

function filesUnder(relativePath: string): string[] {
  const absolutePath = resolve(REPOSITORY_ROOT, relativePath);
  if (statSync(absolutePath).isFile()) return [absolutePath];
  return readdirSync(absolutePath, { withFileTypes: true }).flatMap((entry) => {
    const child = `${relativePath}/${entry.name}`;
    if (child.startsWith("docs/superpowers/")) return [];
    return entry.isDirectory() ? filesUnder(child) : [resolve(REPOSITORY_ROOT, child)];
  });
}

const activeFiles = [
  "README.md",
  "AGENTS.md",
  "contracts/README.md",
  "app",
  "components",
  "lib",
  "docs",
  "examples",
  "sdk/typescript/README.md",
  "sdk/typescript/package.json",
  "sdk/typescript/src",
  "public/openapi/agent-commerce-v1.json",
].flatMap(filesUnder).filter((file) => ACTIVE_EXTENSIONS.test(file));

for (const file of activeFiles) {
  const source = readFileSync(file, "utf8");
  for (const forbidden of FORBIDDEN_BRANDS) {
    assert(
      !source.toLowerCase().includes(forbidden.toLowerCase()),
      `${forbidden} remains in active product file ${file.slice(REPOSITORY_ROOT.length + 1)}`,
    );
  }
}

// EIP-712 domain names are protocol constants that must byte-match the deployed
// contracts (`EIP712("Veyra Trust Gate", "1")`), so they are literals on purpose.
// Routing them through BRAND would silently invalidate every signature the day
// the product name changes.
const BRAND_LITERAL_EXEMPT_FILES = [
  "lib/brand.ts",
  "lib/trust-gate/sign.ts",
  "lib/erc8183/verdict.ts",
];

for (const root of ["app", "components", "lib"]) {
  for (const file of filesUnder(root).filter((candidate) => /\.(?:ts|tsx)$/.test(candidate))) {
    const relativePath = file.slice(REPOSITORY_ROOT.length + 1);
    if (BRAND_LITERAL_EXEMPT_FILES.includes(relativePath)) continue;
    const source = readFileSync(file, "utf8");
    assert(
      !/[("'`]Veyra(?:\s|[)"'`])/.test(source),
      `Hardcoded Veyra product copy must use BRAND in ${relativePath}`,
    );
  }
}

// The exemptions above are only safe while they still match the contracts.
for (const [file, domainName] of [
  ["lib/trust-gate/sign.ts", "Veyra Trust Gate"],
  ["lib/erc8183/verdict.ts", "Veyra ERC8183 Evaluator"],
] as const) {
  const source = readFileSync(resolve(REPOSITORY_ROOT, file), "utf8");
  assert(
    source.includes(`name: "${domainName}",`),
    `${file} must keep the literal EIP-712 domain name "${domainName}".`,
  );
}
for (const [contract, domainName] of [
  ["contracts/src/VeyraTrustGate.sol", "Veyra Trust Gate"],
  ["contracts/src/VeyraERC8183Evaluator.sol", "Veyra ERC8183 Evaluator"],
] as const) {
  const source = readFileSync(resolve(REPOSITORY_ROOT, contract), "utf8");
  assert(
    source.includes(`EIP712("${domainName}", "1")`),
    `${contract} must keep the EIP-712 domain name "${domainName}" its signers assume.`,
  );
}

assert.deepEqual(BRAND, {
  name: "Veyra",
  monogram: "V",
  tagline: "Verified workflows for people and AI agents",
  description:
    "Run paid data and analysis workflows, receive structured reports, and verify the results on Arc.",
  developerConsole: "Veyra Developer Console",
  agentApi: "Veyra Agent API",
  reports: "Veyra Reports",
});

const layoutSource = readFileSync(resolve(REPOSITORY_ROOT, "app/layout.tsx"), "utf8");
for (const marker of [
  "applicationName: BRAND.name",
  "template: `%s | ${BRAND.name}`",
  "openGraph:",
  "twitter:",
  "appleWebApp:",
  'manifest: "/manifest.webmanifest"',
  '"/icon.svg"',
]) {
  assert(layoutSource.includes(marker), `Root metadata is missing ${marker}`);
}

const iconSource = readFileSync(resolve(REPOSITORY_ROOT, "app/icon.svg"), "utf8");
assert(iconSource.includes('viewBox="0 0 64 64"'));
assert(iconSource.includes('aria-label="Veyra"'));
assert(iconSource.includes("<path"));
assert(!iconSource.includes(">AC<"));

const openApi = JSON.parse(
  readFileSync(resolve(REPOSITORY_ROOT, "public/openapi/agent-commerce-v1.json"), "utf8"),
) as {
  info?: { title?: string; version?: string; description?: string };
  servers?: Array<{ url?: string }>;
  paths?: Record<string, unknown>;
};
assert.equal(openApi.info?.title, BRAND.agentApi);
assert.equal(
  openApi.info?.description,
  "Machine API for verified Veyra workflows, Project 360 free discovery and explicit quoting, continuous trust monitoring, alerts, signed webhooks, and public trust badges.",
);
assert.equal(openApi.info?.version, "1.5.0");
assert.equal(openApi.servers?.[0]?.url, "https://agent-commerce-six.vercel.app");
for (const path of [
  "/api/agent/v1/workflows",
  "/api/agent/v1/project-360/discoveries",
  "/api/agent/v1/project-360/discoveries/{discoveryId}",
  "/api/agent/v1/project-360/discoveries/{discoveryId}/quote",
  "/api/agent/v1/quotes",
  "/api/agent/v1/runs",
  "/api/agent/v1/runs/{runId}",
  "/api/agent/v1/reports/{reportId}",
  "/api/agent/v1/alerts",
  "/api/agent/v1/webhooks",
  "/api/public/trust/{publicId}/status",
  "/api/trust/{publicId}/badge.svg",
]) {
  assert(path in (openApi.paths ?? {}), `OpenAPI path changed or disappeared: ${path}`);
}

async function assertNoHorizontalOverflow(page: Page, path: string) {
  await page.goto(`${baseUrl()}${path}`, { waitUntil: "load" });
  const viewport = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  assert(
    viewport.scrollWidth <= viewport.clientWidth + 1,
    `${path} overflows horizontally (${viewport.scrollWidth} > ${viewport.clientWidth})`,
  );
}

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${baseUrl()}/`, { waitUntil: "load" });
  assert.equal(await page.title(), BRAND_TITLE);
  assert.equal(
    await page.locator('meta[property="og:title"]').getAttribute("content"),
    BRAND_TITLE,
  );
  assert.equal(
    await page.locator('meta[property="og:description"]').getAttribute("content"),
    BRAND.description,
  );
  assert.equal(
    await page.locator('meta[name="twitter:title"]').getAttribute("content"),
    BRAND_TITLE,
  );
  assert.equal(
    await page.locator('meta[name="twitter:description"]').getAttribute("content"),
    BRAND.description,
  );
  assert((await page.locator('link[rel="manifest"]').getAttribute("href"))?.includes("manifest.webmanifest"));
  assert((await page.locator('link[rel="icon"]').first().getAttribute("href"))?.includes("icon.svg"));
  assert.equal(
    (await page.locator('[data-testid="brand-monogram"]').first().innerText()).trim(),
    BRAND.monogram,
  );
  await page.getByRole("heading", { name: BRAND.name, exact: true }).waitFor();
  await page.getByText(BRAND.tagline, { exact: true }).first().waitFor();
  await page.getByText(BRAND.description, { exact: true }).waitFor();
  await page.getByText("Arc Testnet", { exact: true }).first().waitFor();

  await page.goto(`${baseUrl()}/console`, { waitUntil: "load" });
  assert.equal(await page.title(), BRAND.developerConsole);
  await page.getByRole("heading", { name: BRAND.developerConsole, exact: true }).waitFor();
  await page.getByText("Developer and operator tools", { exact: true }).first().waitFor();

  await page.goto(`${baseUrl()}/console/agent-api`, { waitUntil: "load" });
  assert.equal(await page.title(), BRAND.agentApi);
  await page.getByRole("heading", { name: BRAND.agentApi, exact: true }).waitFor();

  await page.goto(`${baseUrl()}/this-veyra-page-does-not-exist`, { waitUntil: "load" });
  await page.getByRole("heading", { name: `This ${BRAND.name} page does not exist` }).waitFor();

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    for (const path of ["/", "/agent-runner", "/results", "/proofs", "/console", "/console/agent-api"]) {
      await assertNoHorizontalOverflow(page, path);
    }
  }

  const iconPage = await browser.newPage({ viewport: { width: 240, height: 100 } });
  await iconPage.setContent(
    [16, 32, 48, 64]
      .map(
        (size) =>
          `<img alt="${BRAND.name} ${size}" src="${baseUrl()}/icon.svg" width="${size}" height="${size}">`,
      )
      .join(""),
  );
  await iconPage.waitForFunction(() =>
    Array.from(document.images).every((image) => image.complete && image.naturalWidth > 0),
  );
  assert.equal(await iconPage.locator("img").count(), 4);

  console.log(
    "[branding-test] passed: canonical brand, active-source regression, metadata, OpenAPI, V monogram, 16/32/48/64 icon rendering, and responsive layout",
  );
} finally {
  await browser.close();
}
