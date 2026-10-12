import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { createPublicClient, createWalletClient, decodeEventLog, encodeAbiParameters, erc20Abi,
  http, keccak256, parseAbi, parseEther, toBytes, toHex, type Abi, type Address, type Hex } from "viem";
import { toWebAuthnAccount } from "viem/account-abstraction";
import { METROPOLIS_DEPLOYMENT, METROPOLIS_FACTORY_ABI, METROPOLIS_ACCOUNT_SALT, readAccountSetup } from "../../lib/monad/account.ts";
import { monadDemoTestnet, MONAD_CONTRACTS } from "../../lib/monad/config.ts";
import { getMonadReadClient } from "../../lib/monad/erc8004.ts";
import { collectMonadEvidence } from "../../lib/monad/evidence.ts";
import { PAYMENT_ACCOUNT_ABI, PAYMENT_GATE_ABI } from "../../lib/monad/payment.ts";
import { METROPOLIS_ORIGIN, PasskeyCompatibilityError, toContractAssertion, webAuthnSignedHash } from "../../lib/monad/passkey.ts";
import { toPasskeyV2Assertion } from "../../lib/monad/passkey-v2.ts";
import { evaluateMonadPurchase, monadApprovalChallenge, signMonadClearance } from "../../lib/monad/trust.ts";
import { assessment, mockClient, policy, publicTestAttester } from "./trust-tests.mts";
import { planPasskeyV2Transition } from "./passkey-v2-plan.mts";

// Focused contract/browser compatibility test. Evidence feeding the existing
// policy is explicitly synthetic. Browser signatures, local fork receipts,
// native P256 and the USDC contract are real; all writes stay on localhost.
const rpc = "http://127.0.0.1:18565";
const fundingSource = process.env.METROPOLIS_TEST_FUNDING_SOURCE as Address;
assert.match(fundingSource ?? "", /^0x[0-9a-fA-F]{40}$/);
const forkBlock = process.env.METROPOLIS_TEST_FORK_BLOCK ?? "69650789";
assert.match(forkBlock, /^\d+$/);
const readMethods = new Set(["eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getBlockByHash",
  "eth_getBalance", "eth_getCode", "eth_getStorageAt", "eth_getTransactionCount", "eth_getTransactionReceipt",
  "eth_call", "eth_getLogs", "eth_gasPrice"]);
const upstreamMethods = new Set<string>();
const upstreamErrors: string[] = [];
const upstream = createServer(async (request, response) => {
  try {
    let body = ""; for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body), items = Array.isArray(payload) ? payload : [payload];
    if (!Array.isArray(payload) && payload.method === "eth_getAccountInfo") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, error: { code: -32601, message: "Use ordinary read methods" } })); return;
    }
    for (const item of items) { assert.ok(readMethods.has(item.method), `Upstream write refused: ${item.method}`); upstreamMethods.add(item.method); }
    const result = await fetch("https://testnet-rpc.monad.xyz", { method: "POST", headers: { "content-type": "application/json" }, body,
      signal: AbortSignal.timeout(15000) });
    if (!result.ok) throw new Error(`Upstream HTTP ${result.status}`);
    response.writeHead(200, { "content-type": "application/json" }); response.end(await result.text());
  } catch (error) { upstreamErrors.push(String(error)); response.writeHead(502); response.end("Read failed"); }
});
await new Promise<void>(resolve => upstream.listen(18566, "127.0.0.1", resolve));
const anvil = spawn(".local-tools/foundry-1.8.5/anvil", ["--network", "monad", "--chain-id", "10143", "--port", "18565", "--host", "127.0.0.1",
  "--fork-url", "http://127.0.0.1:18566", "--fork-block-number", forkBlock, "--fork-state-by-number", "--no-fork-node-info", "--silent"],
{ stdio: ["ignore", "ignore", "pipe"] });
anvil.stderr.on("data", data => upstreamErrors.push(String(data)));
const fork = createPublicClient({ chain: monadDemoTestnet, transport: http(rpc, { timeout: 120000, retryCount: 0 }) });
const wallet = createWalletClient({ account: publicTestAttester, chain: monadDemoTestnet, transport: http(rpc, { timeout: 120000, retryCount: 0 }) });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let id = 0;
async function localRpc(method: string, params: unknown[] = []) {
  assert.equal(new URL(rpc).hostname, "127.0.0.1");
  const response = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  const payload = await response.json(); if (payload.error) throw new Error(payload.error.message); return payload.result;
}
async function finalized(hash: Hex) {
  const receipt = await fork.waitForTransactionReceipt({ hash }); assert.equal(receipt.status, "success");
  await localRpc("anvil_mine", ["0x40"]);
  assert.ok((await fork.getBlock({ blockTag: "finalized" })).number >= receipt.blockNumber); return receipt;
}
function artifact(name: string) {
  return JSON.parse(readFileSync(`contracts/monad/out/${name}.sol/${name}.json`, "utf8")) as { abi: Abi; bytecode: { object: Hex } };
}
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if (await localRpc("eth_chainId") === "0x279f") break; } catch {}
    if (attempt === 99) throw new Error("Fork failed to start");
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  assert.equal(await fork.getChainId(), 10143);
  for (const value of [1, 2, 256]) {
    const address = toHex(value, { size: 20 });
    await fork.getBalance({ address }); await fork.getCode({ address }); await fork.getTransactionCount({ address });
  }
  const live = getMonadReadClient();
  const pinnedBlock = await live.getBlock({ blockNumber: BigInt(forkBlock) });
  assert.equal((await fork.getBlock({ blockNumber: BigInt(forkBlock) })).hash, pinnedBlock.hash);
  await localRpc("anvil_setBalance", [publicTestAttester.address, toHex(parseEther("100"))]);
  const admin = "0x861FBe92678Bd6421aCee2dC37b50FDe1Dc01A1E";
  await localRpc("anvil_impersonateAccount", [admin]); await localRpc("anvil_setBalance", [admin, toHex(parseEther("100"))]);
  const adminWallet = createWalletClient({ account: admin, chain: monadDemoTestnet, transport: http(rpc) });
  await finalized(await adminWallet.writeContract({ address: METROPOLIS_DEPLOYMENT.trustGate,
    abi: parseAbi(["function setAttester(address,bool)"]), functionName: "setAttester", args: [publicTestAttester.address, true] }));

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  // The HTTPS origin is intercepted locally. No deployed frontend is changed or loaded.
  await context.route(`${METROPOLIS_ORIGIN}/**`, route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Local V2 cryptographic test</title>" }));
  const page = await context.newPage(), cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await page.goto(`${METROPOLIS_ORIGIN}/metropolis-v2-local-test`);
  const credential = await page.evaluate(async () => {
    const raw = await navigator.credentials.create({ publicKey: { rp: { id: location.hostname, name: "Veyra local V2 test" },
      user: { id: crypto.getRandomValues(new Uint8Array(32)), name: "local-test", displayName: "Local virtual test" },
      challenge: crypto.getRandomValues(new Uint8Array(32)), pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "required", userVerification: "required" } } }) as PublicKeyCredential;
    const spki = (raw.response as AuthenticatorAttestationResponse).getPublicKey(); if (!spki) throw new Error("No public key");
    const key = await crypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
    const bytes = new Uint8Array(await crypto.subtle.exportKey("raw", key));
    return { id: raw.id, publicKey: `0x${Array.from(bytes.slice(1), x => x.toString(16).padStart(2, "0")).join("")}` };
  }) as { id: string; publicKey: Hex };
  const qx = `0x${credential.publicKey.slice(2, 66)}` as Hex, qy = `0x${credential.publicKey.slice(66)}` as Hex;
  const rpIdHash = await fork.readContract({ address: METROPOLIS_DEPLOYMENT.factory, abi: METROPOLIS_FACTORY_ABI, functionName: "rpIdHash" });
  const compiled = artifact("VeyraPasskeyAccountFactoryV2");
  const deployReceipt = await finalized(await wallet.deployContract({ abi: compiled.abi, bytecode: compiled.bytecode.object,
    args: [METROPOLIS_DEPLOYMENT.trustGate, MONAD_CONTRACTS[10143].usdc, rpIdHash, METROPOLIS_ORIGIN] }));
  const factory = deployReceipt.contractAddress!; assert.ok(factory);
  const salt = keccak256(toHex("Veyra Metropolis personal account v2"));
  const account = await fork.readContract({ address: factory, abi: METROPOLIS_FACTORY_ABI, functionName: "accountAddress", args: [qx, qy, salt] });
  await finalized(await wallet.writeContract({ address: factory, abi: METROPOLIS_FACTORY_ABI, functionName: "createAccount", args: [qx, qy, salt] }));
  const oldAccount = await fork.readContract({ address: METROPOLIS_DEPLOYMENT.factory, abi: METROPOLIS_FACTORY_ABI, functionName: "accountAddress", args: [qx, qy, METROPOLIS_ACCOUNT_SALT] });
  await finalized(await wallet.writeContract({ address: METROPOLIS_DEPLOYMENT.factory, abi: METROPOLIS_FACTORY_ABI, functionName: "createAccount", args: [qx, qy, METROPOLIS_ACCOUNT_SALT] }));
  assert.notEqual(account, oldAccount);
  assert.equal(await fork.readContract({ address: account, abi: parseAbi(["function ACCOUNT_VERSION() view returns(uint256)"]), functionName: "ACCOUNT_VERSION" }), 2n);
  await localRpc("anvil_impersonateAccount", [fundingSource]); await localRpc("anvil_setBalance", [fundingSource, toHex(parseEther("100"))]);
  const fundingWallet = createWalletClient({ account: fundingSource, chain: monadDemoTestnet, transport: http(rpc) });
  for (const recipient of [account, oldAccount]) await finalized(await fundingWallet.writeContract({ address: MONAD_CONTRACTS[10143].usdc,
    abi: erc20Abi, functionName: "transfer", args: [recipient, 1_000_000n] }));

  // Review planning reads finalized V1 state and predicts a distinct V2 deployment
  // without signing or changing the sender nonce. The simulated runtime hashes
  // must match actually deployed local contracts for the same configuration.
  const setup = await readAccountSetup(credential.publicKey, METROPOLIS_ORIGIN, fork);
  const senderNonce = await fork.getTransactionCount({ address: publicTestAttester.address });
  const accountCompiled = artifact("VeyraPasskeyAccountV2");
  const plan = await planPasskeyV2Transition(setup, publicTestAttester.address, compiled.bytecode.object, accountCompiled.bytecode.object, fork);
  assert.equal(await fork.getTransactionCount({ address: publicTestAttester.address }), senderNonce);
  assert.equal(plan.summary.expectedFactoryRuntimeCodeHash, keccak256((await fork.getCode({ address: factory }))!));
  assert.equal(plan.summary.expectedAccountRuntimeCodeHash, keccak256((await fork.getCode({ address: account }))!));
  assert.equal(plan.summary.oldAccount.fundsMoved, false); assert.equal(plan.summary.oldAccount.usdcBalanceUnits, "1000000");
  assert.equal(plan.summary.usdcSpent, "0"); assert.notEqual(plan.summary.predictedAccount, oldAccount);
  assert.equal("to" in plan.factoryTransaction, false);
  assert.equal(plan.conditionalAccountCreation.to, plan.summary.predictedFactory);
  assert.equal(await fork.getCode({ address: plan.summary.predictedFactory }), undefined);
  const makePlan = (value: unknown = setup, client = fork, factoryBytecode = compiled.bytecode.object) =>
    planPasskeyV2Transition(value, publicTestAttester.address, factoryBytecode, accountCompiled.bytecode.object, client);
  await assert.rejects(makePlan(setup, { ...fork, chain: { ...fork.chain, id: 143 } } as unknown as typeof fork), /Testnet/);
  await assert.rejects(makePlan(setup, { ...fork, getChainId: async () => 143 }), /Testnet/);
  await assert.rejects(makePlan({ ...setup, origin: "https://other.invalid" }));
  await assert.rejects(makePlan({ ...setup, privateKey: "forbidden-field" }));
  await assert.rejects(makePlan({ ...setup, accountAddress: "0x0000000000000000000000000000000000001234" }));
  await assert.rejects(makePlan(setup, fork, "0x"), /Compile/);
  await assert.rejects(makePlan(setup, { ...fork, getTransactionCount: async options =>
    options?.blockTag === "pending" ? senderNonce + 1 : senderNonce }), /pending/);
  await assert.rejects(makePlan(setup, { ...fork, estimateFeesPerGas: async () =>
    ({ maxFeePerGas: 0n, maxPriorityFeePerGas: 2n }) } as unknown as typeof fork), /fee/);
  await assert.rejects(makePlan(setup, { ...fork, getCode: async options => options.address === plan.summary.predictedFactory
    ? "0x6000" : fork.getCode(options) }), /already has code/);

  // viem handles DER and metadata. getFn transports an actual navigator assertion
  // byte-for-byte from Chromium to Node; it does not synthesize a signature.
  const signer = toWebAuthnAccount({ credential, rpId: new URL(METROPOLIS_ORIGIN).hostname, getFn: async options => {
    assert.ok(options?.publicKey);
    const challenge = Array.from(new Uint8Array(options.publicKey.challenge as ArrayBuffer));
    const raw = await page.evaluate(async ({ challenge, id }) => {
      const credentialId = Uint8Array.from(atob(id.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
      const credential = await navigator.credentials.get({ publicKey: { challenge: new Uint8Array(challenge), rpId: location.hostname,
        allowCredentials: [{ type: "public-key", id: credentialId }], userVerification: "required" } }) as PublicKeyCredential;
      const response = credential.response as AuthenticatorAssertionResponse;
      const hex = (buffer: ArrayBuffer) => `0x${Array.from(new Uint8Array(buffer), x => x.toString(16).padStart(2, "0")).join("")}`;
      return { id: credential.id, rawId: hex(credential.rawId), response: { authenticatorData: hex(response.authenticatorData),
        clientDataJSON: hex(response.clientDataJSON), signature: hex(response.signature) } };
    }, { challenge, id: credential.id });
    const buffer = (hex: string) => new Uint8Array(toBytes(hex as Hex)).buffer;
    return { id: raw.id, type: "public-key", rawId: buffer(raw.rawId), response: { authenticatorData: buffer(raw.response.authenticatorData),
      clientDataJSON: buffer(raw.response.clientDataJSON), signature: buffer(raw.response.signature), userHandle: null } } as unknown as PublicKeyCredential;
  } });
  async function clearanceFor(executor: Address, amountUsdc = "0.012") {
    const clock = Number((await fork.getBlock()).timestamp), now = new Date(clock * 1000);
    const evidence = await collectMonadEvidence(1n, { ...policy, assessments: [await assessment({ assessedAt: BigInt(clock - 20) })] }, mockClient({ clock }), now);
    const decision = evaluateMonadPurchase(evidence, { executor, amountUsdc, budgetUsdc: "0.02", serviceId: "v2-local-browser",
      requestHash: keccak256(toHex("Local V2 signed format compatibility test")) }, now);
    assert.equal(decision.executable, true); return signMonadClearance(decision, METROPOLIS_DEPLOYMENT.trustGate, publicTestAttester, now);
  }
  async function extraAssertion(clearance: Awaited<ReturnType<typeof clearanceFor>>) {
    const challenge = monadApprovalChallenge(clearance, 0n, clearance.message.expiresAt);
    assert.equal(await fork.readContract({ address: clearance.message.executor, abi: PAYMENT_ACCOUNT_ABI, functionName: "approvalChallenge",
      args: [clearance.message, 0n, clearance.message.expiresAt] }), challenge);
    for (let attempt = 1; attempt <= 32; attempt++) {
      const signed = await signer.sign({ hash: challenge });
      const assertion = toPasskeyV2Assertion(signed.signature, signed.webauthn, challenge, METROPOLIS_ORIGIN);
      const keys = Object.keys(JSON.parse(assertion.clientDataJSON));
      if (keys.length === 4) continue;
      assert.throws(() => toContractAssertion(signed.signature, signed.webauthn, challenge, METROPOLIS_ORIGIN), PasskeyCompatibilityError);
      const data = encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
        [webAuthnSignedHash(assertion), assertion.r, assertion.s, qx, qy]);
      assert.equal(BigInt((await fork.call({ to: toHex(256, { size: 20 }), data })).data!), 1n);
      return { assertion, keys, prompts: attempt };
    }
    throw new Error("Chromium did not emit an additional-field assertion; do not claim that compatibility path passed.");
  }
  const oldClearance = await clearanceFor(oldAccount), oldAuth = await extraAssertion(oldClearance);
  await assert.rejects(fork.simulateContract({ account: publicTestAttester.address, address: oldAccount, abi: PAYMENT_ACCOUNT_ABI,
    functionName: "executePayment", args: [oldClearance.message, oldClearance.signature, 0n, oldClearance.message.expiresAt, oldAuth.assertion] }));
  assert.equal(await fork.readContract({ address: oldAccount, abi: PAYMENT_ACCOUNT_ABI, functionName: "nonce" }), 0n);
  assert.equal(await fork.readContract({ address: MONAD_CONTRACTS[10143].usdc, abi: erc20Abi, functionName: "balanceOf", args: [oldAccount] }), 1_000_000n);

  const clearance = await clearanceFor(account), auth = await extraAssertion(clearance), seller = clearance.message.counterparty;
  const sellerBefore = await fork.readContract({ address: MONAD_CONTRACTS[10143].usdc, abi: erc20Abi, functionName: "balanceOf", args: [seller] });
  const changed = await clearanceFor(account, "0.019");
  await assert.rejects(fork.simulateContract({ account: publicTestAttester.address, address: account, abi: PAYMENT_ACCOUNT_ABI, functionName: "executePayment",
    args: [changed.message, changed.signature, 0n, changed.message.expiresAt, auth.assertion] }));
  const tamperedJSON = `${auth.assertion.clientDataJSON.slice(0, -1)} }`;
  assert.notEqual(tamperedJSON, auth.assertion.clientDataJSON);
  await assert.rejects(fork.simulateContract({ account: publicTestAttester.address, address: account, abi: PAYMENT_ACCOUNT_ABI, functionName: "executePayment",
    args: [clearance.message, clearance.signature, 0n, clearance.message.expiresAt, { ...auth.assertion, clientDataJSON: tamperedJSON }] }));
  assert.equal(await fork.readContract({ address: account, abi: PAYMENT_ACCOUNT_ABI, functionName: "nonce" }), 0n);
  assert.equal(await fork.readContract({ address: METROPOLIS_DEPLOYMENT.trustGate, abi: PAYMENT_GATE_ABI, functionName: "consumedClearances", args: [clearance.digest] }), false);
  const args = [clearance.message, clearance.signature, 0n, clearance.message.expiresAt, auth.assertion] as const;
  const simulation = await fork.simulateContract({ account: publicTestAttester.address, address: account, abi: PAYMENT_ACCOUNT_ABI, functionName: "executePayment", args });
  const receipt = await finalized(await wallet.writeContract({ ...simulation.request, account: publicTestAttester }));
  const transfer = receipt.logs.filter(log => log.address.toLowerCase() === MONAD_CONTRACTS[10143].usdc.toLowerCase())
    .map(log => { try { return decodeEventLog({ abi: erc20Abi, ...log }); } catch { return null; } })
    .filter(log => log?.eventName === "Transfer" && log.args.from.toLowerCase() === account.toLowerCase());
  assert.equal(transfer.length, 1);
  const paymentTransfer = transfer[0]!; assert.equal(paymentTransfer.eventName, "Transfer");
  if (paymentTransfer.eventName !== "Transfer") throw new Error("Expected a transfer");
  assert.equal(paymentTransfer.args.value, 12_000n); assert.equal(paymentTransfer.args.to, seller);
  assert.equal(await fork.readContract({ address: MONAD_CONTRACTS[10143].usdc, abi: erc20Abi, functionName: "balanceOf", args: [account] }), 988_000n);
  assert.equal(await fork.readContract({ address: MONAD_CONTRACTS[10143].usdc, abi: erc20Abi, functionName: "balanceOf", args: [seller] }), sellerBefore + 12_000n);
  assert.equal(await fork.readContract({ address: account, abi: PAYMENT_ACCOUNT_ABI, functionName: "nonce" }), 1n);
  assert.equal(await fork.readContract({ address: METROPOLIS_DEPLOYMENT.trustGate, abi: PAYMENT_GATE_ABI, functionName: "consumedClearances", args: [clearance.digest] }), true);
  await assert.rejects(fork.simulateContract({ account: publicTestAttester.address, address: account, abi: PAYMENT_ACCOUNT_ABI, functionName: "executePayment", args }));
  assert.deepEqual(upstreamErrors, []);
  const proof = { verifiedAt: new Date().toISOString(), scope: "disposable localhost Monad fork; synthetic policy evidence; virtual Chromium authenticator",
    network: "Monad Testnet fork", chainId: 10143, forkBlock, forkBlockHash: pinnedBlock.hash, foundryVersion: "1.8.5", monadExecution: true,
    chromiumVersion: browser.version(), viewport: { width: 390, height: 844 }, accountVersion: 2,
    factory, account, localDeploymentTx: deployReceipt.transactionHash, localPaymentTx: receipt.transactionHash,
    localPaymentBlock: receipt.blockNumber.toString(), localPaymentBlockHash: receipt.blockHash,
    clientDataFields: auth.keys, extraFieldAssertionPreserved: true, virtualPrompts: { v1: oldAuth.prompts, v2: auth.prompts },
    nativeP256Verified: true, v1RejectsValidExtraFields: true, exactUsdcUnits: "12000", alteredAmountRejected: true,
    alteredExtraFieldsRejected: true, nonceAfter: "1", clearanceConsumed: true, replayRejected: true,
    unsignedTransitionPlanVerified: true, constructorRuntimeHashesMatchedLocalDeployments: true, unsafePlanInputsRejected: 9,
    upstreamMethods: [...upstreamMethods].sort(), testnetTransactionsSent: 0, liveFrontendChanged: false,
    universalBrowserCompatibility: false, actualIphonePaymentVerified: false, mainnetReady: false };
  writeFileSync(".local-tools/passkey-v2-browser-fork-result.json", JSON.stringify(proof, null, 2) + "\n");
  console.log(JSON.stringify(proof, null, 2));
} finally {
  if (browser) await browser.close(); anvil.kill("SIGTERM"); upstream.closeAllConnections();
  await new Promise<void>(resolve => upstream.close(() => resolve()));
}
