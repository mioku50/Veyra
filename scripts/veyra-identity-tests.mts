/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics, parseAbi, zeroAddress, type Hex } from "viem";
import { ARC_IDENTITY_REGISTRY, ARC_REGISTRY_REF } from "../lib/discovery/erc8004-arc.ts";
import {
  VEYRA_AGENT_REGISTRY,
  VEYRA_AGENT_URI,
  VEYRA_ARC_AGENT_ID,
  VEYRA_ORIGIN,
  circleCredentials,
  mintedAgentId,
  registrationRefusals,
  veyraRegistrationFile,
  type RegistrantState,
} from "../lib/erc8004/veyra-registration.ts";

/* ---- the registration file ---- */

{
  const file = veyraRegistrationFile(null, null);
  assert.equal(file.type, "https://eips.ethereum.org/EIPS/eip-8004#registration-v1");
  assert.equal(file.name, "Veyra");
  assert.deepEqual(file.registrations, [], "Before the mint the file names no identity");
  assert.equal(file.x402Support, false, "With no wallet to be paid to, Veyra sells nothing on Arc mainnet");
  assert.equal(file.active, true);
  assert.deepEqual(file.supportedTrust, ["reputation"]);
  for (const url of [file.image, ...file.services.map((service) => service.endpoint)]) {
    assert.ok(url.startsWith(`${VEYRA_ORIGIN}/`), `${url} is on Veyra's own origin`);
  }
  assert.match(file.description, /Veyra's own claim, not independent truth/);
  assert.match(file.description, /no paid service on Arc mainnet/);
  assert.match(file.description, /approves and signs every payment/);
  assert.ok(!JSON.stringify(file).includes("5042002"), "Nothing from Arc Testnet");
  assert.deepEqual(JSON.parse(JSON.stringify(file)), file, "It survives JSON as it is");
}

{
  const file = veyraRegistrationFile(295);
  assert.deepEqual(file.registrations, [{ agentId: 295, agentRegistry: `eip155:5042:${ARC_IDENTITY_REGISTRY}` }]);
  assert.equal(VEYRA_AGENT_REGISTRY, `eip155:5042:${ARC_IDENTITY_REGISTRY}`);
  /* ERC-8004's check for a domain: a registrations entry whose agentRegistry
     and agentId match the identity on chain. */
  const names = (agentId: number) => file.registrations.some((entry) =>
    entry.agentId === agentId && entry.agentRegistry.toLowerCase() === ARC_REGISTRY_REF);
  assert.ok(names(295), "The file names the identity back");
  assert.ok(!names(294));
}

assert.equal(VEYRA_AGENT_URI, `${VEYRA_ORIGIN}/.well-known/agent-registration.json`,
  "At the well-known path, the agentURI's own domain is the one it proves");
assert.ok(VEYRA_ARC_AGENT_ID === null || (Number.isInteger(VEYRA_ARC_AGENT_ID) && VEYRA_ARC_AGENT_ID >= 0));

/* ---- the owner's Circle credentials ---- */

{
  const LIVE = "LIVE_API_KEY:0123456789abcdef0123456789abcdef:fedcba9876543210fedcba9876543210";
  const SECRET = "a".repeat(64);
  const missing = circleCredentials({});
  assert.equal(missing.ok, false);
  assert.equal(!missing.ok && missing.problems.length, 2);

  const testnet = circleCredentials({ CIRCLE_API_KEY: LIVE.replace("LIVE_", "TEST_"), CIRCLE_ENTITY_SECRET: SECRET });
  assert.ok(!testnet.ok && /not a mainnet key/.test(testnet.problems.join(" ")), "A testnet key is refused before the first call");

  const short = circleCredentials({ CIRCLE_API_KEY: LIVE, CIRCLE_ENTITY_SECRET: "abc123" });
  assert.ok(!short.ok && /32 bytes of hex/.test(short.problems.join(" ")));

  const good = circleCredentials({ CIRCLE_API_KEY: ` ${LIVE} `, CIRCLE_ENTITY_SECRET: SECRET });
  assert.ok(good.ok && good.apiKey === LIVE && good.entitySecret === SECRET);

  const said = (secret: string) => {
    const checked = circleCredentials({ CIRCLE_API_KEY: LIVE, CIRCLE_ENTITY_SECRET: secret });
    return checked.ok ? "" : checked.problems.join(" ");
  };
  const CLIENT_KEY = "LIVE_CLIENT_KEY:0123456789abcdef0123456789abcdef:fedcba9876543210fedcba9876543210";
  assert.match(said(CLIENT_KEY), /holds a client key/, "A client key in the secret's place is named as one, as the owner did on 27 September");
  assert.match(said(CLIENT_KEY), /npm run veyra-identity -- entity-secret/);
  assert.match(said(LIVE), /holds an API key/);
  assert.match(said(`0x${SECRET}`), /starts with 0x/);
  assert.match(said(""), /not set\. Create it with/);

  for (const env of [
    { CIRCLE_API_KEY: LIVE.replace("LIVE_", "TEST_"), CIRCLE_ENTITY_SECRET: "z".repeat(64) },
    { CIRCLE_API_KEY: LIVE, CIRCLE_ENTITY_SECRET: CLIENT_KEY },
    { CIRCLE_API_KEY: LIVE, CIRCLE_ENTITY_SECRET: `0x${SECRET}` },
  ]) {
    const checked = circleCredentials(env);
    const said = checked.ok ? "" : checked.problems.join(" ");
    assert.ok(!said.includes(env.CIRCLE_API_KEY) && !said.includes(env.CIRCLE_ENTITY_SECRET), "A problem never repeats a credential");
  }
}

/* ---- the minted id, from the receipt ---- */

{
  const TRANSFER = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"]);
  const OWNER = "0x1111111111111111111111111111111111111111";
  const transfer = (from: Hex, to: Hex, tokenId: bigint, address: string = ARC_IDENTITY_REGISTRY) => ({
    address,
    topics: encodeEventTopics({ abi: TRANSFER, eventName: "Transfer", args: { from, to, tokenId } }) as Hex[],
    data: "0x" as Hex,
  });
  const metadataSet = {
    address: ARC_IDENTITY_REGISTRY,
    topics: ["0x" + "ab".repeat(32)] as Hex[],
    data: encodeAbiParameters([{ type: "string" }], ["agentWallet"]),
  };

  assert.equal(mintedAgentId([metadataSet, transfer(zeroAddress, OWNER, 295n)], OWNER), 295, "The mint, among the registry's other events");
  assert.equal(mintedAgentId([transfer(zeroAddress, OWNER.toUpperCase().replace("0X", "0x") as Hex, 7n)], OWNER.toLowerCase()), 7, "Addresses compared without case");
  assert.equal(mintedAgentId([transfer(zeroAddress, OWNER, 295n, "0x2222222222222222222222222222222222222222")], OWNER), null, "Another contract's Transfer");
  assert.equal(mintedAgentId([transfer(zeroAddress, "0x3333333333333333333333333333333333333333", 295n)], OWNER), null, "A mint to someone else");
  assert.equal(mintedAgentId([transfer("0x4444444444444444444444444444444444444444", OWNER, 295n)], OWNER), null, "A transfer, not a mint");
  assert.equal(mintedAgentId([], OWNER), null);
}

/* ---- when the one transaction may be sent ---- */

{
  const ready: RegistrantState = {
    address: "0x1111111111111111111111111111111111111111",
    balanceUsdc: 0.1,
    feeUsdc: 0.0061,
    identitiesHeld: 0,
    inFlight: 0,
    fileMatches: true,
    wouldMint: 295,
  };
  assert.deepEqual(registrationRefusals(ready), []);
  const refused = (change: Partial<RegistrantState>, pattern: RegExp) => {
    const refusals = registrationRefusals({ ...ready, ...change });
    assert.equal(refusals.length, 1, `${JSON.stringify(change)} gives one reason: ${refusals.join(" | ")}`);
    assert.match(refusals[0], pattern);
  };
  refused({ address: null }, /no registrant wallet/);
  refused({ fileMatches: false }, /Deploy first/);
  refused({ identitiesHeld: 1 }, /already holds an identity\. Veyra registers once/);
  refused({ identitiesHeld: null }, /Could not read how many identities/);
  refused({ inFlight: 1 }, /still in flight/);
  refused({ inFlight: null }, /Circle transactions/);
  refused({ wouldMint: null }, /dry call/);
  refused({ feeUsdc: null }, /no fee estimate/);
  refused({ balanceUsdc: null }, /balance/);
  refused({ balanceUsdc: 0.001 }, /at least 0\.10 USDC/);
}

console.log("veyra identity: all assertions passed");
