import assert from "node:assert/strict";
import { chromium } from "playwright";
import { parseAccountSetup } from "../../lib/monad/account.ts";

// Uses a browser's virtual authenticator and live read-only Monad RPC calls.
// This is not a real iPhone/Face ID test or a deployed account transaction.
const origin = process.env.METROPOLIS_SMOKE_ORIGIN ?? "http://localhost:3123";
const isLocal = new URL(origin).hostname === "localhost";
const testAccountSetup = process.env.METROPOLIS_SMOKE_ACCOUNT_SETUP === "1";
const canonicalOrigin = "https://agent-commerce-six.vercel.app";
// Serve the local build under the canonical browser origin for a virtual credential.
// This changes no public deployment and uses real read-only RPC calls.
const pageOrigin = testAccountSetup ? canonicalOrigin : origin;
assert.ok(isLocal || origin === "https://agent-commerce-six.vercel.app", "Use localhost or the canonical Veyra origin only");
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  if (testAccountSetup && isLocal) {
    await context.route(`${canonicalOrigin}/**`, async route => {
      const response = await route.fetch({ url: route.request().url().replace(canonicalOrigin,origin) });
      await route.fulfill({ response });
    });
  }
  const page = await context.newPage();
  const errors: string[] = [];
  const requestFailures: string[] = [];
  const rpcMethods = new Set<string>();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("requestfailed", request => {
    if (new URL(request.url()).hostname === "testnet-rpc.monad.xyz") requestFailures.push(request.failure()?.errorText ?? "RPC request failed");
  });
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
  await page.goto(`${pageOrigin}/metropolis`, { waitUntil: "networkidle" });
  const create = page.getByRole("button", { name: "Create test passkey" });
  await create.waitFor();
  await create.click();
  const verify = page.getByRole("button", { name: "Verify on Monad" });
  await verify.waitFor({ timeout: 20_000 });
  await verify.click();
  const status = page.getByRole("status");
  try {
    await status.filter({ hasText: "Monad verified its P256 signature via eth_call" }).waitFor({ timeout: 45_000 });
  } catch (error) {
    console.error("Diagnostic status:",await status.allTextContents(),"RPC methods:",[...rpcMethods],"RPC failures:",requestFailures,"Browser errors:",errors);
    throw error;
  }
  if (testAccountSetup) {
    await page.getByRole("button", { name: "Prepare account", exact: true }).click();
    await page.getByTestId("account-address").waitFor({ timeout: 60_000 });
    const setup = await parseAccountSetup(JSON.parse(await page.getByLabel("Public account setup JSON").inputValue()));
    const savedKey = await page.evaluate(() => JSON.parse(localStorage.getItem("veyra.metropolis.public-credential.v1")!).publicKey);
    assert.equal(`0x${setup.qx.slice(2)}${setup.qy.slice(2)}`, savedKey);
    assert.equal(setup.accountDeployed,false,"Virtual account has not been deployed");
    assert.equal(setup.usdcBalanceUnits,"0");
    assert.equal(await page.getByTestId("account-address").textContent(),setup.accountAddress);
    await context.grantPermissions(["clipboard-read","clipboard-write"],{origin:canonicalOrigin});
    await page.getByRole("button",{name:"Copy public account details"}).click();
    const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
    assert.deepEqual(copied,setup,"Clipboard must contain only validated public setup fields");
    await page.screenshot({path:".local-tools/metropolis-account-setup-mobile.png",fullPage:true});
    await page.route("https://testnet-rpc.monad.xyz/**",route=>route.fulfill({status:503,contentType:"application/json",
      body:JSON.stringify({error:"RPC_INTERNAL_DETAILS_MUST_NOT_REACH_UI"})}));
    await page.getByRole("button",{name:"Prepare account",exact:true}).click();
    await status.filter({hasText:"Account preparation did not complete"}).waitFor({timeout:30_000});
    assert.equal(await page.getByTestId("account-address").count(),0,"Failed refresh must clear stale setup");
    assert.ok(!(await status.allTextContents()).join(" ").includes("RPC_INTERNAL_DETAILS"),"Raw RPC errors stay out of the UI");
    await page.unroute("https://testnet-rpc.monad.xyz/**");
  }
  assert.ok(rpcMethods.has("eth_chainId") && rpcMethods.has("eth_call"), "The signature must reach the live RPC");
  assert.deepEqual([...rpcMethods].filter((method) => !["eth_chainId", "eth_call", "eth_getBlockByNumber", "eth_getCode"].includes(method)), [], "No write RPC methods");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "No mobile horizontal overflow");
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Verify on Monad" }).waitFor();
  if (testAccountSetup) assert.equal(await page.getByRole("button",{name:"Prepare account",exact:true}).isDisabled(),true,"Reload requires a fresh device verification");
  assert.deepEqual(errors, [], "Browser runtime must remain error-free");

  // An alternative hostname must not silently register a different RP credential.
  if (isLocal) {
    await page.goto(`${origin.replace("localhost", "127.0.0.1")}/metropolis`, { waitUntil: "networkidle" });
    const alternate = page.getByRole("button", { name: "Create test passkey" });
    await alternate.waitFor();
    assert.equal(await alternate.isDisabled(), true);
  }
  console.log(`Metropolis browser smoke PASS at ${origin}: virtual passkey, live P256 eth_call, public-metadata reload, mobile layout${testAccountSetup ? ", live factory prediction and public setup copy" : ""}${isLocal ? " and alternate-origin rejection" : ""}. No transaction sent.`);
} finally {
  await browser.close();
}
