import assert from "node:assert/strict";
import { chromium } from "playwright";

// Uses a browser's virtual authenticator and live read-only Monad RPC calls.
// This is not a real iPhone/Face ID test or a deployed account transaction.
const origin = process.env.METROPOLIS_SMOKE_ORIGIN ?? "http://localhost:3123";
assert.equal(new URL(origin).hostname, "localhost", "Run the browser smoke against localhost only");
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors: string[] = [];
  const rpcMethods = new Set<string>();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (new URL(request.url()).hostname === "testnet-rpc.monad.xyz") {
      const payload = request.postDataJSON();
      for (const item of Array.isArray(payload) ? payload : [payload]) rpcMethods.add(item.method);
    }
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  await page.goto(`${origin}/metropolis`, { waitUntil: "networkidle" });
  const create = page.getByRole("button", { name: "Create test passkey" });
  await create.waitFor();
  await create.click();
  const verify = page.getByRole("button", { name: "Verify on Monad" });
  await verify.waitFor({ timeout: 20_000 });
  await verify.click();
  const status = page.getByRole("status");
  await status.filter({ hasText: "Monad verified its P256 signature via eth_call" }).waitFor({ timeout: 45_000 });
  assert.ok(rpcMethods.has("eth_chainId") && rpcMethods.has("eth_call"), "The signature must reach the live RPC");
  assert.deepEqual([...rpcMethods].filter((method) => !["eth_chainId", "eth_call"].includes(method)), [], "No write RPC methods");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "No mobile horizontal overflow");
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Verify on Monad" }).waitFor();
  assert.deepEqual(errors, [], "Browser runtime must remain error-free");

  // An alternative hostname must not silently register a different RP credential.
  await page.goto(`${origin.replace("localhost", "127.0.0.1")}/metropolis`, { waitUntil: "networkidle" });
  const alternate = page.getByRole("button", { name: "Create test passkey" });
  await alternate.waitFor();
  assert.equal(await alternate.isDisabled(), true);
  console.log("Metropolis browser smoke PASS: virtual passkey, live P256 eth_call, public-metadata reload, mobile layout and alternate-origin rejection. No transaction sent.");
} finally {
  await browser.close();
}
