/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { initiateDeveloperControlledWalletsClient, registerEntitySecretCiphertext } from "@circle-fin/developer-controlled-wallets";
import { createPublicClient, formatUnits, http, parseAbi, type Address, type Hex } from "viem";
import { ARC_IDENTITY_REGISTRY } from "../lib/discovery/erc8004-arc.ts";
import {
  VEYRA_AGENT_URI,
  VEYRA_REGISTRANT_REF,
  circleCredentials,
  mintedAgentId,
  registrationRefusals,
  veyraRegistrationFile,
  type RegistrantState,
} from "../lib/erc8004/veyra-registration.ts";
import { ARC_MAINNET_EXPLORER_URL, ARC_MAINNET_RPC_URL, arcMainnetChain } from "../lib/wallet/arc.ts";

/**
 * Veyra's ERC-8004 identity on Arc mainnet, registered from its own Circle
 * wallet.
 *
 * The owner runs this with their own Circle credentials in .env.local:
 * CIRCLE_API_KEY, a mainnet key, and CIRCLE_ENTITY_SECRET.
 *
 *   npm run veyra-identity -- entity-secret
 *     Creates the entity secret and registers it with Circle, as Circle's own
 *     example does. The secret goes into .env.local, and Circle's recovery
 *     file into ~/.circle/veyra, outside the repository. Neither is printed.
 *     It refuses when .env.local already names a CIRCLE_ENTITY_SECRET.
 *   npm run veyra-identity -- wallet
 *     Finds the registrant wallet, or creates it: one EOA on Arc mainnet, in a
 *     wallet set of its own. Prints the address to fund with 0.10 USDC.
 *   npm run veyra-identity -- check
 *     Reads only: the balance, Circle's fee estimate, the file at the
 *     agentURI, what the registrant already holds, and a dry call of
 *     register().
 *   npm run veyra-identity -- register --confirm <agentURI>
 *     The one mainnet transaction, register(agentURI). It is refused unless
 *     every check passes and the agentURI typed is the one in the code.
 *
 * Nothing here prints a credential. An error from Circle is reduced to its
 * status and message before it is printed, because the request behind it
 * carries the key.
 */

const REGISTRY = ARC_IDENTITY_REGISTRY as Address;
const REGISTER_SIGNATURE = "register(string)";
const WALLET_SET_NAME = "Veyra ERC-8004 identity";
const FINAL_STATES = new Set(["COMPLETE", "FAILED", "DENIED", "CANCELLED"]);
const REGISTRY_ABI = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "function balanceOf(address owner) view returns (uint256)",
  "function ownerOf(uint256 agentId) view returns (address)",
  "function tokenURI(uint256 agentId) view returns (string)",
]);

const chain = createPublicClient({
  chain: arcMainnetChain,
  transport: http(process.env.ARC_MAINNET_RPC_URL?.trim() || ARC_MAINNET_RPC_URL, { timeout: 20_000, retryCount: 2 }),
});

function describe(error: unknown): string {
  const response = (error as { response?: { status?: number; data?: { code?: number; message?: string } } } | null)?.response;
  if (response) {
    const code = response.data?.code ? ` (code ${response.data.code})` : "";
    return `Circle answered ${response.status ?? "?"}${code}: ${response.data?.message ?? "no message"}`;
  }
  return error instanceof Error ? error.message.split("\n")[0].slice(0, 300) : "an unknown error";
}

let circleClient: ReturnType<typeof initiateDeveloperControlledWalletsClient> | null = null;

/* Made on first use: the entity-secret step runs before there is a secret. */
function circle() {
  if (circleClient) return circleClient;
  const credentials = circleCredentials(process.env);
  if (!credentials.ok) {
    console.error([
      "The Circle credentials are missing or wrong:",
      ...credentials.problems.map((problem) => `  - ${problem}`),
      "Add them to .env.local yourself. Never paste them into a chat.",
    ].join("\n"));
    process.exit(1);
  }
  circleClient = initiateDeveloperControlledWalletsClient({ apiKey: credentials.apiKey, entitySecret: credentials.entitySecret });
  return circleClient;
}

async function entitySecretStep() {
  const apiKey = process.env.CIRCLE_API_KEY?.trim() ?? "";
  if (!apiKey.startsWith("LIVE_API_KEY:")) {
    console.error("Put a mainnet CIRCLE_API_KEY (LIVE_API_KEY:…) in .env.local first.");
    process.exit(1);
  }
  const envPath = resolve(process.cwd(), ".env.local");
  const envText = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  if (/^\s*CIRCLE_ENTITY_SECRET\s*=/m.test(envText)) {
    console.error([
      "CIRCLE_ENTITY_SECRET is already in .env.local, so nothing was created.",
      "If that line holds something else, such as a key starting LIVE_CLIENT_KEY:, delete it and run this again.",
    ].join("\n"));
    process.exit(1);
  }

  const dir = join(homedir(), ".circle", "veyra");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  /* Made here, not with the SDK's generateEntitySecret, which prints it. */
  const entitySecret = randomBytes(32).toString("hex");
  /* On disk before Circle holds it, so a failure to write .env.local after
     the registration cannot lose a secret that is already registered. */
  const pending = join(dir, `entity-secret-${Date.now()}.pending`);
  writeFileSync(pending, `${entitySecret}\n`, { mode: 0o600 });
  try {
    await registerEntitySecretCiphertext({ apiKey, entitySecret, recoveryFileDownloadPath: dir });
  } catch (error) {
    rmSync(pending, { force: true });
    throw error;
  }
  appendFileSync(envPath, `${envText === "" || envText.endsWith("\n") ? "" : "\n"}CIRCLE_ENTITY_SECRET=${entitySecret}\n`);
  rmSync(pending, { force: true });
  console.log([
    "",
    "The entity secret is registered with Circle and written to .env.local as CIRCLE_ENTITY_SECRET. It was not printed.",
    `Circle's recovery file is in ${dir}. It is the only way to reset the secret: keep a copy somewhere safe off this computer.`,
    "Next: npm run veyra-identity -- wallet",
  ].join("\n"));
}

async function findRegistrant() {
  const wallets = (await circle().listWallets({ blockchain: "ARC", refId: VEYRA_REGISTRANT_REF })).data?.wallets ?? [];
  return wallets.length > 0 ? wallets[0] : null;
}

async function walletStep() {
  let wallet = await findRegistrant();
  if (wallet) {
    console.log("The registrant wallet already exists.");
  } else {
    const sets = (await circle().listWalletSets({})).data?.walletSets ?? [];
    let walletSetId = sets.find((set) => "name" in set && set.name === WALLET_SET_NAME)?.id;
    if (!walletSetId) {
      walletSetId = (await circle().createWalletSet({ name: WALLET_SET_NAME, idempotencyKey: randomUUID() })).data?.walletSet?.id;
    }
    if (!walletSetId) throw new Error("Circle returned no wallet set.");
    wallet = (await circle().createWallets({
      walletSetId,
      blockchains: ["ARC"],
      accountType: "EOA",
      count: 1,
      metadata: [{ name: "Veyra ERC-8004 registrant", refId: VEYRA_REGISTRANT_REF }],
      idempotencyKey: randomUUID(),
    })).data?.wallets?.[0] ?? null;
    if (!wallet) throw new Error("Circle returned no wallet.");
    console.log("Created the registrant wallet.");
  }
  console.log([
    `  address    ${wallet.address}`,
    `  wallet id  ${wallet.id}`,
    `  on         ${wallet.blockchain}, ${wallet.accountType ?? "EOA"}, ${wallet.state}`,
    "",
    "Next: send 0.10 USDC on Arc mainnet to this address. The call costs about 0.004 USDC.",
    "Then: npm run veyra-identity -- check",
  ].join("\n"));
}

async function fileServed(): Promise<boolean> {
  try {
    const response = await fetch(VEYRA_AGENT_URI, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    return response.ok && isDeepStrictEqual(await response.json(), veyraRegistrationFile());
  } catch {
    return false;
  }
}

async function gather(): Promise<{ state: RegistrantState; walletId: string | null; unread: string[] }> {
  const wallet = await findRegistrant();
  const address = (wallet?.address ?? null) as Address | null;
  /* Why a read from Circle failed, through describe(), so that the owner sees
     the reason and never the key. */
  const unread: string[] = [];
  const unreadable = (what: string) => (error: unknown) => {
    unread.push(`${what}: ${describe(error)}`);
    return null;
  };
  const [balanceUsdc, identitiesHeld, wouldMint, fileMatches, inFlight, feeUsdc] = await Promise.all([
    address ? chain.getBalance({ address }).then((wei) => Number(formatUnits(wei, 18))).catch(() => null) : null,
    address
      ? chain.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: "balanceOf", args: [address] }).then(Number).catch(() => null)
      : null,
    address
      ? chain.simulateContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: "register", args: [VEYRA_AGENT_URI], account: address })
        .then((simulated) => Number(simulated.result)).catch(() => null)
      : null,
    fileServed(),
    /* By wallet id alone. Circle refuses walletIds together with blockchain
       (400, code 2, "API parameter invalid"), and a Circle wallet is on one
       chain already. */
    wallet
      ? circle().listTransactions({ walletIds: [wallet.id] })
        .then((listed) => (listed.data?.transactions ?? []).filter((transaction) => !FINAL_STATES.has(transaction.state)).length)
        .catch(unreadable("Circle transactions"))
      : null,
    wallet
      ? circle().estimateContractExecutionFee({
        source: { walletId: wallet.id },
        contractAddress: REGISTRY,
        abiFunctionSignature: REGISTER_SIGNATURE,
        abiParameters: [VEYRA_AGENT_URI],
      }).then((estimate) => {
        const fee = Number(estimate.data?.high?.networkFee);
        return Number.isFinite(fee) ? fee : null;
      }).catch(unreadable("Circle fee estimate"))
      : null,
  ]);
  return { state: { address, balanceUsdc, feeUsdc, identitiesHeld, inFlight, fileMatches, wouldMint }, walletId: wallet?.id ?? null, unread };
}

function printState(state: RegistrantState, unread: string[]) {
  const shown = (value: unknown) => value === null ? "could not be read" : String(value);
  console.log([
    `Registrant         ${state.address ?? "none yet"}`,
    `Balance            ${shown(state.balanceUsdc)} USDC on Arc`,
    `Fee (Circle, high) ${shown(state.feeUsdc)} USDC`,
    `Identities held    ${shown(state.identitiesHeld)}`,
    `In flight          ${shown(state.inFlight)}`,
    `File               ${state.fileMatches ? "served, and it is this code's file" : "not this code's file"} (${VEYRA_AGENT_URI})`,
    `Dry call           ${state.wouldMint === null ? "did not succeed" : `would mint agentId ${state.wouldMint}`}`,
    ...(unread.length > 0 ? ["", "Why a Circle read failed:", ...unread.map((reason) => `  - ${reason}`)] : []),
  ].join("\n"));
}

async function checkStep() {
  const { state, unread } = await gather();
  printState(state, unread);
  const refusals = registrationRefusals(state);
  console.log(refusals.length === 0
    ? `\nReady. To register:\n  npm run veyra-identity -- register --confirm ${VEYRA_AGENT_URI}`
    : `\nNot ready:\n${refusals.map((refusal) => `  - ${refusal}`).join("\n")}`);
}

async function registerStep(confirm: string | undefined) {
  if (confirm !== VEYRA_AGENT_URI) {
    console.error(`Confirm the agentURI by typing it:\n  npm run veyra-identity -- register --confirm ${VEYRA_AGENT_URI}`);
    process.exit(1);
  }
  const { state, walletId, unread } = await gather();
  printState(state, unread);
  const refusals = registrationRefusals(state);
  if (refusals.length > 0 || !walletId || !state.address) {
    console.error(`\nRefused:\n${refusals.map((refusal) => `  - ${refusal}`).join("\n")}`);
    process.exit(1);
  }

  console.log(`\nSending register("${VEYRA_AGENT_URI}") from ${state.address} on Arc mainnet.`);
  const id = (await circle().createContractExecutionTransaction({
    walletId,
    contractAddress: REGISTRY,
    abiFunctionSignature: REGISTER_SIGNATURE,
    abiParameters: [VEYRA_AGENT_URI],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    idempotencyKey: randomUUID(),
    refId: "veyra-erc8004-register",
  })).data?.id;
  if (!id) throw new Error("Circle accepted no transaction.");
  console.log(`Circle transaction ${id}`);

  let transaction: { state?: string; txHash?: string; errorReason?: string } | undefined;
  let last = "";
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    transaction = (await circle().getTransaction({ id })).data?.transaction;
    if (transaction?.state && transaction.state !== last) {
      last = transaction.state;
      console.log(`  ${last}`);
    }
    if (transaction?.state && FINAL_STATES.has(transaction.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  if (transaction?.state !== "COMPLETE" || !transaction.txHash) {
    console.error(`Not completed: ${transaction?.state ?? "no state"}${transaction?.errorReason ? `, ${transaction.errorReason}` : ""}.`);
    console.error("Nothing is sent again from here. Run the check step to see where it stands.");
    process.exit(1);
  }

  const receipt = await chain.getTransactionReceipt({ hash: transaction.txHash as Hex });
  const agentId = mintedAgentId(receipt.logs, state.address);
  if (agentId === null) throw new Error(`The receipt of ${transaction.txHash} shows no mint to ${state.address}.`);
  const [owner, uri] = await Promise.all([
    chain.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: "ownerOf", args: [BigInt(agentId)] }),
    chain.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: "tokenURI", args: [BigInt(agentId)] }),
  ]);
  console.log([
    "",
    `Registered: agentId ${agentId}`,
    `  transaction  ${ARC_MAINNET_EXPLORER_URL}/tx/${transaction.txHash}`,
    `  owner        ${owner}${owner.toLowerCase() === state.address.toLowerCase() ? " (the registrant)" : " (NOT the registrant)"}`,
    `  agentURI     ${uri}${uri === VEYRA_AGENT_URI ? "" : " (NOT the one in the code)"}`,
    "",
    `Next: the id goes into the file (VEYRA_ARC_AGENT_ID = ${agentId}), so that the file names the identity back.`,
  ].join("\n"));
}

const command = process.argv[2];
const confirmAt = process.argv.indexOf("--confirm");
try {
  if (command === "entity-secret") await entitySecretStep();
  else if (command === "wallet") await walletStep();
  else if (command === "check") await checkStep();
  else if (command === "register") await registerStep(confirmAt > 0 ? process.argv[confirmAt + 1] : undefined);
  else {
    console.error("Usage: npm run veyra-identity -- entity-secret | wallet | check | register --confirm <agentURI>");
    process.exit(1);
  }
} catch (error) {
  console.error(describe(error));
  process.exit(1);
}
