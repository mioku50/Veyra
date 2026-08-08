/**
 * Copyright 2026 Circle Internet Group, Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import {
  BaseError,
  ContractFunctionRevertedError,
  createWalletClient,
  http,
  isHex,
  parseAbi,
  zeroAddress,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import {
  ARC_ERC8004_IDENTITY_REGISTRY,
  ARC_ERC8004_VALIDATION_REGISTRY,
  fetchAgentIdentityOnchain,
  fetchValidationStatusOnchain,
  getArcPublicClient,
  getCanonicalVeyraAgentIdentity,
} from "../lib/erc8004/client.ts";
import {
  buildCanonicalValidationResponse,
  deriveValidationRequestHash,
  isPendingValidationStatus,
  isTerminalValidationStatus,
} from "../lib/erc8004/validation.ts";
import { getByoaClient } from "../lib/byoa/service.ts";
import type { Erc8183EvaluationRecord } from "../lib/erc8183/types.ts";
import type { Erc8004ValidationLinkRecord } from "../lib/erc8004/types.ts";

const RPC_URL = process.env.ARC_TESTNET_RPC_URL || "https://rpc.testnet.arc.network";
const BASE_URL = (process.env.NEXT_PUBLIC_APP_URL || "https://agent-commerce-six.vercel.app").replace(/\/$/, "");
const ZERO_HASH = `0x${"0".repeat(64)}`;

function requirePrivateKey(value: string | undefined, label: string): Hex {
  assert.ok(value && /^0x[0-9a-fA-F]{64}$/.test(value), `${label} is missing or invalid`);
  return value as Hex;
}

function requireHash(value: string | null | undefined, label: string): Hex {
  assert.ok(value && isHex(value) && value.length === 66 && value !== ZERO_HASH, `${label} is missing, zero, or invalid`);
  return value as Hex;
}

async function getValidationCandidate() {
  const supabase = getByoaClient();
  const { data, error } = await supabase
    .from("erc8183_evaluations")
    .select("*")
    .in("status", ["completed", "rejected"])
    .not("report_hash", "is", null)
    .order("evaluated_at", { ascending: false })
    .limit(25);
  assert.equal(error, null, "Production ERC-8183 evaluation lookup failed");
  assert.ok(data?.length, "No real terminal ERC-8183 evaluation exists for validation acceptance");

  let existingConfirmed: Erc8004ValidationLinkRecord | null = null;
  for (const row of data) {
    const evaluation = row as Erc8183EvaluationRecord;
    const requestHash = deriveValidationRequestHash(evaluation);
    const { data: link, error: linkError } = await supabase
      .from("erc8004_validation_links")
      .select("*")
      .eq("request_hash", requestHash)
      .maybeSingle();
    assert.equal(linkError, null, "Production validation-link lookup failed");
    if (!link) return { evaluation, requestHash, existing: null };
    if (link.status === "confirmed" && !existingConfirmed) {
      existingConfirmed = link as Erc8004ValidationLinkRecord;
    }
  }
  if (existingConfirmed) {
    const exactEvaluation = data.find(
      (item) => item.public_id === existingConfirmed?.evaluation_public_id
    );
    if (exactEvaluation) {
      return {
        evaluation: exactEvaluation as Erc8183EvaluationRecord,
        requestHash: existingConfirmed.request_hash as Hex,
        existing: existingConfirmed,
      };
    }
  }
  throw new Error("No usable ERC-8183 evaluation exists for validation acceptance");
}

async function submitValidationRequest(args: {
  ownerKey: Hex;
  validator: `0x${string}`;
  agentId: bigint;
  evaluation: Erc8183EvaluationRecord;
  requestHash: Hex;
}) {
  const owner = privateKeyToAccount(args.ownerKey);
  const wallet = createWalletClient({
    account: owner,
    chain: arcTestnet,
    transport: http(RPC_URL),
  });
  const requestUri = `${BASE_URL}/api/erc8183/v1/evaluations/${args.evaluation.public_id}`;
  const txHash = await wallet.writeContract({
    address: ARC_ERC8004_VALIDATION_REGISTRY,
    abi: parseAbi([
      "function validationRequest(address validatorAddress, uint256 agentId, string requestURI, bytes32 requestHash)",
    ]),
    functionName: "validationRequest",
    args: [args.validator, args.agentId, requestUri, args.requestHash],
  });
  const receipt = await getArcPublicClient(RPC_URL).waitForTransactionReceipt({
    hash: txHash,
    timeout: 30_000,
  });
  assert.equal(receipt.status, "success", "validationRequest transaction reverted");
  return txHash;
}

async function fetchValidationStatusIfExists(
  requestHash: Hex,
  publicClient: ReturnType<typeof getArcPublicClient>,
) {
  try {
    return await fetchValidationStatusOnchain(requestHash, undefined, publicClient);
  } catch (error) {
    if (
      error instanceof BaseError
      && error.walk((cause) => cause instanceof ContractFunctionRevertedError)
    ) {
      return null;
    }
    throw error;
  }
}

async function main() {
  assert.notEqual(
    process.env.REPUTATION_ALLOW_MEMORY_STORE,
    "true",
    "Production acceptance cannot use reputation memory storage",
  );
  const respondSecret = process.env.ERC8004_VALIDATION_RESPOND_SECRET;
  assert.ok(respondSecret, "ERC8004_VALIDATION_RESPOND_SECRET is missing");
  const ownerKey = requirePrivateKey(
    process.env.VEYRA_IDENTITY_OWNER_PRIVATE_KEY || process.env.CANARY_DEPLOYER_PRIVATE_KEY,
    "Veyra identity owner key",
  );
  const relayerKey = requirePrivateKey(
    process.env.VEYRA_EVALUATOR_RELAYER_PRIVATE_KEY || process.env.ERC8183_EVALUATOR_RELAYER_PRIVATE_KEY,
    "ERC-8004 validation relayer key",
  );
  const owner = privateKeyToAccount(ownerKey);
  const relayer = privateKeyToAccount(relayerKey);
  const publicClient = getArcPublicClient(RPC_URL);

  assert.equal(await publicClient.getChainId(), arcTestnet.id, "Arc RPC returned another chain");
  const [identityCode, validationCode] = await Promise.all([
    publicClient.getCode({ address: ARC_ERC8004_IDENTITY_REGISTRY }),
    publicClient.getCode({ address: ARC_ERC8004_VALIDATION_REGISTRY }),
  ]);
  assert.ok(identityCode && identityCode !== "0x", "Official IdentityRegistry bytecode is missing");
  assert.ok(validationCode && validationCode !== "0x", "Official ValidationRegistry bytecode is missing");

  const identity = await getCanonicalVeyraAgentIdentity(publicClient);
  assert.ok(identity, "Canonical DB + onchain Veyra identity is missing");
  assert.equal(identity.registry_address.toLowerCase(), ARC_ERC8004_IDENTITY_REGISTRY.toLowerCase());
  assert.equal(identity.chain_id, arcTestnet.id);
  assert.equal(identity.owner_address.toLowerCase(), owner.address.toLowerCase());
  const registrationTx = requireHash(identity.registration_tx, "Identity registration transaction");
  const registrationReceipt = await publicClient.getTransactionReceipt({ hash: registrationTx });
  assert.equal(registrationReceipt.status, "success", "Identity registration transaction reverted");
  assert.equal(registrationReceipt.to?.toLowerCase(), ARC_ERC8004_IDENTITY_REGISTRY.toLowerCase());
  const onchainIdentity = await fetchAgentIdentityOnchain(BigInt(identity.agent_id), undefined, publicClient);
  assert.equal(onchainIdentity.owner.toLowerCase(), identity.owner_address.toLowerCase());
  assert.equal(onchainIdentity.tokenURI, identity.metadata_uri);

  const metadataResponse = await fetch(identity.metadata_uri, { signal: AbortSignal.timeout(15_000) });
  assert.equal(metadataResponse.status, 200, "Canonical identity metadata URI is not reachable");
  const metadata = await metadataResponse.json();
  assert.equal(metadata?.identity?.agentId, identity.agent_id, "Metadata agentId differs from canonical identity");
  assert.equal(
    String(metadata?.identity?.registry || "").toLowerCase(),
    ARC_ERC8004_IDENTITY_REGISTRY.toLowerCase(),
    "Metadata registry differs from official registry",
  );

  const candidate = await getValidationCandidate();
  const canonical = buildCanonicalValidationResponse({
    evaluation: candidate.evaluation,
    requestHash: candidate.requestHash,
    agentId: identity.agent_id,
    baseUrl: BASE_URL,
  });

  let requestTx: Hex | null = null;
  let status = await fetchValidationStatusIfExists(candidate.requestHash, publicClient);
  if (!status || status.validatorAddress === zeroAddress) {
    requestTx = await submitValidationRequest({
      ownerKey,
      validator: relayer.address,
      agentId: BigInt(identity.agent_id),
      evaluation: candidate.evaluation,
      requestHash: candidate.requestHash,
    });
    status = await fetchValidationStatusOnchain(candidate.requestHash, undefined, publicClient);
  }
  assert.equal(status.validatorAddress.toLowerCase(), relayer.address.toLowerCase());
  assert.equal(status.agentId.toString(), identity.agent_id);

  let responseTx: Hex;
  if (candidate.existing && isTerminalValidationStatus(status)) {
    responseTx = requireHash(candidate.existing.response_tx, "Existing validation response transaction");
  } else {
    assert.equal(isPendingValidationStatus(status), true, "Validation request is not pending before prepare");
    const prepareResponse = await fetch(`${BASE_URL}/api/erc8004/v1/validations/prepare`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        evaluationPublicId: candidate.evaluation.public_id,
        requestHash: candidate.requestHash,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    assert.equal(prepareResponse.status, 200, `Validation prepare failed (${prepareResponse.status})`);
    const prepared = await prepareResponse.json();
    assert.equal(prepared.agentId, canonical.agentId);
    assert.equal(prepared.evaluationPublicId, canonical.evaluationPublicId);
    assert.equal(prepared.response, canonical.response);
    assert.equal(prepared.responseHash.toLowerCase(), canonical.responseHash.toLowerCase());
    assert.equal(prepared.tag, canonical.tag);

    const missingAuth = await fetch(`${BASE_URL}/api/erc8004/v1/validations/respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestHash: candidate.requestHash }),
      signal: AbortSignal.timeout(20_000),
    });
    assert.equal(missingAuth.status, 401, "Validation respond missing-auth check did not fail closed");
    const wrongAuth = await fetch(`${BASE_URL}/api/erc8004/v1/validations/respond`, {
      method: "POST",
      headers: { authorization: "Bearer definitely-wrong", "content-type": "application/json" },
      body: JSON.stringify({ requestHash: candidate.requestHash }),
      signal: AbortSignal.timeout(20_000),
    });
    assert.equal(wrongAuth.status, 401, "Validation respond wrong-auth check did not fail closed");

    const respondResponse = await fetch(`${BASE_URL}/api/erc8004/v1/validations/respond`, {
      method: "POST",
      headers: { authorization: `Bearer ${respondSecret}`, "content-type": "application/json" },
      body: JSON.stringify({ requestHash: candidate.requestHash }),
      signal: AbortSignal.timeout(45_000),
    });
    assert.equal(respondResponse.status, 200, `Validation respond failed (${respondResponse.status})`);
    const responded = await respondResponse.json();
    assert.equal(responded.success, true);
    assert.equal(responded.response, canonical.response);
    assert.equal(responded.responseHash.toLowerCase(), canonical.responseHash.toLowerCase());
    responseTx = requireHash(responded.txHash, "Validation response transaction");
  }

  const responseReceipt = await publicClient.getTransactionReceipt({ hash: responseTx });
  assert.equal(responseReceipt.status, "success", "validationResponse transaction reverted");
  const finalStatus = await fetchValidationStatusOnchain(candidate.requestHash, undefined, publicClient);
  assert.equal(finalStatus.validatorAddress.toLowerCase(), relayer.address.toLowerCase());
  assert.equal(finalStatus.agentId.toString(), identity.agent_id);
  assert.equal(finalStatus.response, canonical.response);
  assert.equal(finalStatus.responseHash.toLowerCase(), canonical.responseHash.toLowerCase());
  assert.equal(finalStatus.tag, canonical.tag);
  assert.equal(isTerminalValidationStatus(finalStatus), true);

  const { data: storedLink, error: linkError } = await getByoaClient()
    .from("erc8004_validation_links")
    .select("*")
    .eq("request_hash", candidate.requestHash)
    .single();
  assert.equal(linkError, null, "Confirmed validation link could not be reloaded");
  assert.equal(storedLink.agent_id, identity.agent_id);
  assert.equal(storedLink.evaluation_public_id, candidate.evaluation.public_id);
  assert.equal(storedLink.canonical_report_hash.toLowerCase(), canonical.canonicalReportHash.toLowerCase());
  assert.equal(storedLink.response_hash.toLowerCase(), canonical.responseHash.toLowerCase());
  assert.equal(storedLink.status, "confirmed");
  assert.equal(storedLink.response_tx.toLowerCase(), responseTx.toLowerCase());

  const [agentApi, readinessApi, identityPage] = await Promise.all([
    fetch(`${BASE_URL}/api/erc8004/v1/agent`, { signal: AbortSignal.timeout(15_000) }),
    fetch(`${BASE_URL}/api/erc8004/v1/readiness`, { signal: AbortSignal.timeout(15_000) }),
    fetch(`${BASE_URL}/agents/veyra`, { signal: AbortSignal.timeout(15_000) }),
  ]);
  assert.equal(agentApi.status, 200, "Public ERC-8004 agent API is unavailable");
  assert.equal(readinessApi.status, 200, "Public ERC-8004 readiness API is unavailable");
  assert.equal(identityPage.status, 200, "Public Veyra identity page is unavailable");
  const publicAgent = await agentApi.json();
  const readiness = await readinessApi.json();
  assert.equal(publicAgent.identity.agentId, identity.agent_id);
  assert.equal(publicAgent.identity.ownerAddress.toLowerCase(), identity.owner_address.toLowerCase());
  assert.equal(readiness.productionReady, true);

  console.log("ERC8004_PRODUCTION_ACCEPTANCE", JSON.stringify({
    agentId: identity.agent_id,
    identityRegistry: ARC_ERC8004_IDENTITY_REGISTRY,
    owner: identity.owner_address,
    metadataUri: identity.metadata_uri,
    registrationTx,
    validationRequestHash: candidate.requestHash,
    validationRequestTx: requestTx,
    validationResponseTx: responseTx,
    evaluationPublicId: candidate.evaluation.public_id,
  }));
  console.log("ERC-8004 LIVE ACCEPTANCE: PASS");
}

main().catch((error) => {
  console.error(
    "ERC-8004 production acceptance failed:",
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
