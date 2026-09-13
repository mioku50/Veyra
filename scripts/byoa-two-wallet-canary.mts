import assert from "node:assert/strict";
import { chromium } from "playwright";
import { type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

function baseUrl() {
  const argument = process.argv.find((value) => value.startsWith("--base-url="));
  return (
    argument?.split("=", 2)[1] ??
    process.env.BASE_URL ??
    "https://agent-commerce-six.vercel.app"
  ).replace(/\/$/, "");
}

function getOwnerAccount() {
  const key = process.env.BYOA_CANARY_OWNER_PRIVATE_KEY?.trim() ||
    process.env.PHASE26_CHECKOUT_PRIVATE_KEY?.trim() ||
    process.env.BUYER_PRIVATE_KEY?.trim();
  if (key && /^0x[0-9a-fA-F]{64}$/.test(key)) {
    return privateKeyToAccount(key as Hex);
  }
  return privateKeyToAccount(generatePrivateKey());
}

function getAgentAccount() {
  const key = process.env.BYOA_CANARY_AGENT_PRIVATE_KEY?.trim();
  if (key && /^0x[0-9a-fA-F]{64}$/.test(key)) {
    return privateKeyToAccount(key as Hex);
  }
  return privateKeyToAccount(generatePrivateKey());
}

async function main() {
  const targetUrl = baseUrl();
  console.log(`[byoa-two-wallet-canary] Running production canary against ${targetUrl}`);

  const ownerAccount = getOwnerAccount();
  const agentAccount = getAgentAccount();

  assert.notEqual(
    ownerAccount.address.toLowerCase(),
    agentAccount.address.toLowerCase(),
    "Canary Owner and Agent wallets must be distinct.",
  );

  console.log(`[byoa-two-wallet-canary] Owner Wallet: ${ownerAccount.address}`);
  console.log(`[byoa-two-wallet-canary] Agent Wallet: ${agentAccount.address}`);

  let activeAccount = ownerAccount;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.exposeFunction("__arcWalletRequest", async (args: { method: string; params?: unknown[] }) => {
    const method = args.method;
    if (method === "eth_accounts" || method === "eth_requestAccounts") {
      return [activeAccount.address];
    }
    if (method === "eth_chainId") {
      return "0x4cef52"; // 5042002 in hex
    }
    if (method === "personal_sign") {
      const hexMsg = args.params?.[0] as Hex;
      const message = Buffer.from(hexMsg.slice(2), "hex").toString("utf-8");
      return await activeAccount.signMessage({ message });
    }
    if (method === "eth_signTypedData_v4") {
      const typedDataString = args.params?.[1] as string;
      const parsed = JSON.parse(typedDataString);
      return await activeAccount.signTypedData(parsed);
    }
    if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") {
      return null;
    }
    throw new Error(`Unhandled mock RPC method: ${method}`);
  });

  await page.addInitScript(() => {
    const listeners: Record<string, Function[]> = {};
    (window as any).__emitAccountsChanged = (accounts: string[]) => {
      const cbs = listeners["accountsChanged"] || [];
      for (const cb of cbs) {
        try { cb(accounts); } catch { /* ignore listener error */ }
      }
    };
    (window as any).ethereum = {
      isMetaMask: true,
      request: (args: any) => (window as any).__arcWalletRequest(args),
      on: (event: string, fn: Function) => {
        listeners[event] = listeners[event] || [];
        listeners[event].push(fn);
      },
      removeListener: (event: string, fn: Function) => {
        if (!listeners[event]) return;
        listeners[event] = listeners[event].filter((cb) => cb !== fn);
      },
    };
  });

  try {
    console.log("[byoa-two-wallet-canary] 1. Navigating to /my-agents...");
    await page.goto(`${targetUrl}/my-agents`, { waitUntil: "networkidle" });

    const closedNotice = await page.getByText("BYOA canary is closed.", { exact: false }).isVisible();
    if (closedNotice) {
      console.log("[byoa-two-wallet-canary] Canary notice: BYOA canary is closed on target instance (canary owner wallet allowlist required).");
      return;
    }

    await page.getByText("Step 1 — Verify Owner Session").waitFor();

    // 2. Verify Owner Session
    console.log("[byoa-two-wallet-canary] 2. Verifying Owner Session...");
    activeAccount = ownerAccount;
    await page.evaluate((addr) => (window as any).__emitAccountsChanged([addr]), ownerAccount.address);
    await page.getByRole("button", { name: "Verify Owner Signature" }).click();

    await page.getByText(`Verified Owner Session: ${ownerAccount.address.slice(0, 7)}`, { exact: false }).waitFor();

    // 3. Register Agent Wallet
    console.log("[byoa-two-wallet-canary] 3. Registering Agent Wallet...");
    await page.locator("#agent-name").fill("Production Canary Agent");
    await page.locator("#agent-wallet").fill(agentAccount.address);
    await page.getByRole("button", { name: "Register External Agent" }).click();

    await page.getByText("Production Canary Agent").waitFor();

    // 4. Switch Wallet to Agent & Activate
    console.log("[byoa-two-wallet-canary] 4. Switching to Agent Wallet & activating binding...");
    activeAccount = agentAccount;
    await page.evaluate((addr) => (window as any).__emitAccountsChanged([addr]), agentAccount.address);

    await page.getByRole("button", { name: "Create Activation Challenge" }).click();
    await page.getByRole("button", { name: "Sign with Connected Agent Wallet" }).click();
    await page.getByRole("button", { name: "Verify Signature & Activate Wallet" }).click();

    await page.getByText("wallet verified", { exact: false }).waitFor();

    // 5. Save Policy & Issue Credential
    console.log("[byoa-two-wallet-canary] 5. Setting Policy & issuing Credential...");
    await page.getByRole("button", { name: "Save Policy" }).click();
    await page.getByRole("button", { name: "Issue New Scoped Credential" }).click();
    await page.getByText("API Credential (Displayed Once)").waitFor();

    // 6. Sign and Run Workflow
    console.log("[byoa-two-wallet-canary] 6. Signing & executing x402 workflow payment...");
    await page.getByRole("button", { name: "Sign and Run Workflow" }).click();

    await page.getByText("Execution Result & Proof Trail", { exact: false }).waitFor({ timeout: 120_000 });
    await page.getByText("completed", { exact: false }).waitFor();

    // 7. Test Idempotency Replay
    console.log("[byoa-two-wallet-canary] 7. Testing Idempotency Replay...");
    await page.getByRole("button", { name: "Replay with Same Idempotency Key" }).click();

    await page.getByText("Idempotency Replay Verified (Empirical Comparison):", { exact: false }).waitFor();
    await page.getByText("No duplicate payment").waitFor();
    await page.getByText("Receipts identical").waitFor();
    await page.getByText("Proofs identical").waitFor();
    await page.getByText("Allowance preserved").waitFor();
    await page.getByText("Call count preserved").waitFor();

    console.log("[byoa-two-wallet-canary] SUCCESS: Production canary passed end-to-end!");
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("[byoa-two-wallet-canary] FAILED:", err);
  process.exit(1);
});
