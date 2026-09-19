import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, devices } from "playwright";

const base = (process.env.BASE_URL ?? "http://127.0.0.1:3100").replace(
  /\/$/,
  "",
);
const screenshots =
  process.env.FRONTEND_SCREENSHOTS ?? "/tmp/veyra-frontend-evidence";
await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
let offlineNova = false;
let failedLog = false;
let lastLogUrl = "";
const hash = `0x${"a".repeat(64)}`;
const recipient = `0x${"1".repeat(40)}`;
const first = {
  executionId: "vexec_frontend_paid",
  rail: "x402",
  state: "SETTLED_SERVICE_FAILED",
  capability: "web_search",
  counterpartyWallet: recipient,
  authorizedAmountUsdc: 0.001,
  actualSettledAmountUsdc: 0.001,
  paymentTx: hash,
  settlementProof: "onchain_final",
  createdAt: "2026-09-19T12:00:00Z",
  x402: { network: "eip155:8453", payerWallet: `0x${"2".repeat(40)}` },
};
const rejected = {
  ...first,
  executionId: "vexec_frontend_rejected",
  state: "SETTLEMENT_FAILED",
  actualSettledAmountUsdc: 0,
  paymentTx: null,
  settlementProof: null,
};
const older = {
  ...first,
  executionId: "vexec_frontend_older",
  capability: "old_record",
  state: "COMPLETED",
  x402: { ...first.x402, network: "eip155:1" },
};
const brief = {
  agent: {
    publicId: "nva_frontend_fixture",
    name: "Nova",
    interests: ["Arc"],
    createdAt: "2026-09-19T00:00:00Z",
    arcIdentity: null,
    ownerWallet: null,
  },
  greeting: "Good morning",
  worthAttention: [],
  noise: [],
  watchlist: [1, 2].map((index) => ({
    signalId: `signal_${index}`,
    subjectLabel: "Foundry",
    subjectId: "foundry",
    observedAt: "2026-09-19T00:00:00Z",
    headline: `Foundry: update ${index}`,
    interest: "onchain data",
    settlesOn: null,
  })),
  memory: [],
  investigations: [],
  standing: {
    verifiedResearch: 0,
    veyraDecisions: 0,
    observedOutcomes: 0,
    readyForArcIdentity: false,
    spentUsdc: 0,
    attestedOnArc: 0,
    providers: [],
  },
  shadow: {
    state: "off",
    blocked: "No mandate",
    limits: null,
    summary: {},
    decisions: [],
  },
  lastRefresh: null,
  whileAway: null,
  wokeFromDormancy: false,
};
const mutations: string[] = [];
await context.route("**/api/**", async (route) => {
  const url = new URL(route.request().url());
  if (route.request().method() !== "GET") {
    mutations.push(url.pathname);
    return route.abort();
  }
  if (url.pathname.includes("/api/nova/")) {
    if (offlineNova) return route.abort("failed");
    return route.fulfill({ json: brief });
  }
  if (url.pathname === "/api/execution/v1") {
    lastLogUrl = url.href;
    if (failedLog)
      return route.fulfill({ status: 503, json: { error: "offline" } });
    return route.fulfill({
      json: {
        executions: url.searchParams.has("cursor")
          ? [older]
          : [first, rejected],
        nextCursor: url.searchParams.has("cursor") ? null : "fixture-next",
      },
    });
  }
  if (url.pathname.endsWith("/session"))
    return route.fulfill({ json: { authenticated: false } });
  return route.fulfill({ json: { alerts: [], unreadCount: 0 } });
});
try {
  for (const query of [
    "limit=0",
    "limit=101",
    "limit=nope",
    "cursor=not-a-cursor",
    `cursor=${Buffer.from(JSON.stringify({ createdAt: "2026-09-19T12:00:00Z", executionId: "vexec_x),or(state.eq.COMPLETED)" })).toString("base64url")}`,
  ]) {
    const response = await context.request.get(
      `${base}/api/execution/v1?${query}`,
    );
    assert.equal(
      response.status(),
      400,
      "invalid cursor/limit is rejected before a database query",
    );
  }
  await page.goto(base);
  await page.getByLabel("Agent name", { exact: true }).waitFor();
  for (const width of [360, 390, 768, 820, 1023, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const nav = page.getByRole("navigation", {
      name: width < 1024 ? "Mobile bottom navigation" : "Public navigation",
      exact: true,
    });
    assert.deepEqual(await nav.getByRole("link").allTextContents(), [
      "Today",
      "My Agent",
      "Memory",
      "Identity & Trust",
    ]);
    assert(await nav.isVisible());
    if (width < 1024)
      assert(
        await page
          .getByRole("button", { name: "Open navigation", exact: true })
          .isVisible(),
      );
    assert(
      await page
        .getByRole("button", { name: "Connect wallet", exact: true })
        .isVisible(),
    );
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
  }
  await page.setViewportSize({ width: 820, height: 900 });
  const menu = page.getByRole("button", {
    name: "Open navigation",
    exact: true,
  });
  await menu.click();
  const drawer = page.getByRole("dialog", { name: "Veyra", exact: true });
  await drawer.waitFor();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    assert(
      await page.evaluate(
        () => !!document.activeElement?.closest('[role="dialog"]'),
      ),
      "focus stays in drawer",
    );
  }
  await page.keyboard.press("Escape");
  await drawer.waitFor({ state: "detached" });
  assert.equal(await menu.evaluate((e) => e === document.activeElement), true);
  await page.keyboard.press("Tab");
  assert.equal(
    await page.evaluate(
      () => !!document.activeElement?.closest('[aria-hidden="true"]'),
    ),
    false,
  );
  await menu.click();
  await drawer.getByRole("link", { name: "Memory", exact: true }).click();
  await page.waitForURL(`${base}/memory`);
  await drawer.waitFor({ state: "detached" });

  // Brief request fails after the browser has remembered a real-shaped identity.
  await page.evaluate(() => {
    localStorage.setItem("veyra.nova.id", "nva_frontend_fixture");
    localStorage.setItem("veyra.nova.key", "frontend-fixture-secret");
  });
  offlineNova = true;
  await page.reload();
  await page
    .getByRole("heading", { name: "Your agent could not be loaded" })
    .waitFor();
  assert.equal(
    await page.evaluate(() => localStorage.getItem("veyra.nova.key")),
    "frontend-fixture-secret",
  );
  assert.equal(await page.getByLabel("Agent name", { exact: true }).count(), 0);
  offlineNova = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByRole("button", { name: "Purchases", exact: true }).click();
  await page
    .getByText("Nothing yet. When Nova pays", { exact: false })
    .waitFor();
  await page.goto(`${base}/agent`);
  await page
    .getByRole("heading", { name: "Your agent", exact: true })
    .waitFor();
  await page
    .locator("summary")
    .filter({ hasText: "Foundry · 2 updates" })
    .click();
  await page.getByText("Foundry: update 1", { exact: true }).waitFor();
  await page.getByText("Foundry: update 2", { exact: true }).waitFor();
  await page.screenshot({
    path: `${screenshots}/agent-tablet.png`,
    fullPage: true,
  });
  await page.goto(`${base}/arc`);
  await page
    .getByRole("heading", { name: "Identity & Trust", exact: true })
    .waitFor();

  await page.goto(`${base}/executions`);
  await page
    .getByRole("heading", { name: "Payment recorded · delivery failed" })
    .waitFor();
  const rows = page.locator("main > ul > li");
  assert.equal(await rows.count(), 2);
  assert((await rows.first().innerText()).includes("0.001 USDC"));
  assert.equal(
    await rows
      .first()
      .getByRole("link", { name: "Payment transaction ↗" })
      .getAttribute("href"),
    `https://basescan.org/tx/${hash}`,
  );
  await page.getByRole("button", { name: "Settled", exact: true }).click();
  await rows
    .filter({ hasText: "Payment failed" })
    .waitFor({ state: "detached" });
  assert.equal(await rows.count(), 1);
  await page
    .getByRole("button", { name: "Failed / refused", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Payment failed", exact: true })
    .waitFor();
  assert.equal(await rows.count(), 2);
  await page.getByRole("button", { name: "All", exact: true }).click();
  await page.getByRole("button", { name: "Load older entries" }).click();
  await page
    .getByText("old record · Ethereum · x402", { exact: true })
    .waitFor();
  assert.equal(await rows.count(), 3);
  assert(lastLogUrl.includes("cursor=fixture-next"));
  failedLog = true;
  await page.getByRole("button", { name: "Refresh the log" }).click();
  await page.locator("main").getByRole("alert").waitFor();
  assert.equal(await rows.count(), 3);
  assert(
    (await page.locator("main").getByRole("alert").innerText()).includes(
      "out of date",
    ),
  );
  await page.reload();
  await page.locator("main").getByRole("alert").waitFor();
  assert.equal(
    await page.getByText("No decisions recorded yet.", { exact: true }).count(),
    0,
  );
  failedLog = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page
    .getByRole("heading", { name: "Payment failed", exact: true })
    .waitFor();
  await page.screenshot({
    path: `${screenshots}/decisions-tablet.png`,
    fullPage: true,
  });

  await page.goto(`${base}/run`);
  await page
    .getByRole("link", { name: "Install a wallet", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Connect wallet", exact: true })
    .click();
  await page.getByRole("dialog", { name: "Wallet", exact: true }).waitFor();
  await page
    .getByRole("dialog")
    .getByRole("link", { name: "Install a wallet" })
    .waitFor();
  await page.keyboard.press("Escape");
  // All controls consume one wallet state; connecting never switches networks.
  await context.route("https://rpc.testnet.arc.network/**", async (route) => {
    const body = route.request().postDataJSON();
    const answer = (request: { id: number }) => ({
      jsonrpc: "2.0",
      id: request.id,
      result: "0x0",
    });
    await route.fulfill({
      json: Array.isArray(body) ? body.map(answer) : answer(body),
    });
  });
  await context.addInitScript(
    ({ recipient }) => {
      const callbacks: Record<string, Array<(value: unknown) => void>> = {};
      const calls: string[] = [];
      let connected = false;
      Object.assign(window, {
        walletTestCalls: calls,
        walletTestEmit: (event: string, value: unknown) =>
          callbacks[event]?.forEach((fn) => fn(value)),
        ethereum: {
          request: async ({ method }: { method: string }) => {
            calls.push(method);
            if (method === "eth_chainId") return "0x2105";
            if (method === "eth_requestAccounts") {
              connected = true;
              return [recipient];
            }
            if (method === "eth_accounts") return connected ? [recipient] : [];
            if (method === "wallet_revokePermissions") {
              connected = false;
              return null;
            }
            throw new Error(`Unexpected wallet request: ${method}`);
          },
          on: (event: string, fn: (value: unknown) => void) => {
            (callbacks[event] ??= []).push(fn);
          },
          removeListener: (event: string, fn: (value: unknown) => void) => {
            callbacks[event] =
              callbacks[event]?.filter((value) => value !== fn) ?? [];
          },
        },
      });
    },
    { recipient },
  );
  await page.goto(`${base}/executions`);
  const walletTrigger = page
    .locator("header")
    .getByRole("button", { name: "Connect wallet", exact: true });
  await walletTrigger.click();
  const walletDialog = page.getByRole("dialog", {
    name: "Wallet",
    exact: true,
  });
  await walletDialog
    .getByRole("button", { name: "Connect wallet", exact: true })
    .click();
  await walletDialog
    .getByText("Connected network: Base", { exact: true })
    .waitFor();
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute("aria-label") ===
      "Wallet 0x1111…1111",
  );
  await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes(`counterpartyWallet=${recipient}`),
    ),
    page.getByRole("button", { name: "Received by me", exact: true }).click(),
  ]);
  assert(lastLogUrl.includes(`counterpartyWallet=${recipient}`));
  await page.evaluate(() =>
    (window as any).walletTestEmit("accountsChanged", [`0x${"3".repeat(40)}`]),
  );
  await page.getByRole("button", { name: "Wallet 0x3333…3333" }).waitFor();
  await page.getByRole("button", { name: "Wallet 0x3333…3333" }).click();
  await walletDialog
    .getByRole("button", { name: "Disconnect wallet", exact: true })
    .click();
  await walletDialog
    .getByRole("button", { name: "Connect wallet", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Received by me", exact: true })
      .count(),
    0,
  );
  assert(
    !(
      await page.evaluate(() => (window as any).walletTestCalls as string[])
    ).some((method) => /sign|send|switchEthereumChain/i.test(method)),
  );
  await page.keyboard.press("Escape");

  // Mobile Safari-like user agent: no extension means usable wallet-app links.
  const mobile = await browser.newContext({ ...devices["iPhone 13"] });
  await mobile.route("**/api/**", (route) =>
    route.fulfill({ json: { authenticated: false, alerts: [] } }),
  );
  const phone = await mobile.newPage();
  await phone.goto(`${base}/run`);
  await phone
    .getByRole("button", { name: "Open in your wallet app", exact: true })
    .click();
  const deepLink = await phone
    .getByRole("link", { name: "MetaMask", exact: true })
    .getAttribute("href");
  assert.equal(
    deepLink,
    `https://metamask.app.link/dapp/${new URL(base).host}/run`,
  );
  await phone
    .getByText("Your wallet app has separate browser storage.", {
      exact: false,
    })
    .waitFor();
  await phone.evaluate(() => window.scrollTo(0, 0));
  await phone.screenshot({
    path: `${screenshots}/manual-purchase-mobile.png`,
    fullPage: false,
  });
  await mobile.close();
  assert.equal(mutations.length, 0, "no live writes, signatures or payments");
  assert.deepEqual(errors, []);
  console.log(
    "frontend browser: navigation at six widths, modal keyboard behavior, offline key preservation/retry, payment precision/networks/filters/pagination, stale/error history, shared wallet connect/change/disconnect, mobile wallet-app links and invalid API cursors passed",
  );
} finally {
  await context.close();
  await browser.close();
}
