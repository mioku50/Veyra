/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  getAddress,
  parseAbiParameters,
  toFunctionSelector,
  toHex,
  zeroAddress,
  type Hex,
} from "viem";
import {
  ARC_TESTNET_CHAIN_ID,
  onchainProofMetadataFromRow,
  proofRegistryAbi,
  publishStoredProof,
  type OnchainPaymentEventRecord,
} from "../lib/commerce/onchain-proof.ts";
import { ERC8183_AGENTIC_COMMERCE_ABI } from "../lib/erc8183/abi.ts";

const configuredRpc = "https://arc-rpc.example.test/";
const overrideRpc = "https://arc-override.example.test/";
const testKey = toHex(1n, { size: 32 });
const registry = "0x0000000000000000000000000000000000000011";
const buyer = "0x0000000000000000000000000000000000000022";
const seller = "0x0000000000000000000000000000000000000033";
const attester = "0x0000000000000000000000000000000000000044";
const receiptHash = toHex(7n, { size: 32 });
const serviceHash = toHex(8n, { size: 32 });
const requestHash = toHex(9n, { size: 32 });
const responseHash = toHex(10n, { size: 32 });
const transactionHash = toHex(11n, { size: 32 });
const blockHash = toHex(12n, { size: 32 });
const timestamp = 1_800_000_000n;

type RpcCall = {
  id: number;
  method: string;
  params?: unknown[];
};

function mockArcRpc(
  context: TestContext,
  expectedUrl: string,
  respond: (call: RpcCall) => unknown,
) {
  const methods: string[] = [];
  context.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), expectedUrl);
    assert(init && typeof init.body === "string");
    const call = JSON.parse(init.body) as RpcCall;
    methods.push(call.method);
    const result = respond(call);
    return result instanceof Response ? result : Response.json({ jsonrpc: "2.0", id: call.id, result });
  });
  return methods;
}

function editEnvironment(context: TestContext, values: Record<string, string | undefined>) {
  const original = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  const assign = (env: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  assign(values);
  context.after(() => assign(original));
}

test("reconciles a proof after a brief head lag using contiguous Arc windows", async (context) => {
  editEnvironment(context, {
    ARC_TESTNET_RPC_URL: configuredRpc,
    AGENT_COMMERCE_PROOF_REGISTRY_ADDRESS: registry,
    AGENT_COMMERCE_PROOF_REGISTRY_DEPLOYMENT_BLOCK: "25000",
    AGENT_COMMERCE_PROOF_ATTESTER_PRIVATE_KEY: testKey,
    AGENT_COMMERCE_PROOF_ATTESTER_ADDRESS: undefined,
  });
  const proofBlock = 30_000n;
  const ranges: Array<[bigint, bigint]> = [];
  const registrationSelector = toFunctionSelector("isRegistered(bytes32)");
  const proofLogTopics = encodeEventTopics({
    abi: proofRegistryAbi,
    eventName: "ProofRegistered",
    args: { receiptId: receiptHash, serviceHash, buyer },
  });
  const methods = mockArcRpc(context, configuredRpc, (call) => {
    switch (call.method) {
      case "eth_chainId": return toHex(ARC_TESTNET_CHAIN_ID);
      case "eth_call": {
        const [{ data }] = call.params as [{ data: Hex }];
        const isRegistrationCheck = data.startsWith(registrationSelector);
        return isRegistrationCheck
          ? encodeFunctionResult({ abi: proofRegistryAbi, functionName: "isRegistered", result: true })
          : encodeFunctionResult({
              abi: proofRegistryAbi,
              functionName: "getProof",
              result: [serviceHash, buyer, seller, 12_000n, requestHash, responseHash, timestamp],
            });
      }
      case "eth_blockNumber": return toHex(50_000n);
      case "eth_getLogs": {
        const [filter] = call.params as [{ fromBlock: Hex; toBlock: Hex; topics: Array<Hex | null> }];
        const from = BigInt(filter.fromBlock);
        const to = BigInt(filter.toBlock);
        assert.ok(to - from + 1n <= 9_000n);
        assert.deepEqual(filter.topics, [proofLogTopics[0], receiptHash, null, null]);
        ranges.push([from, to]);
        if (ranges.length === 1) {
          return Response.json({
            jsonrpc: "2.0",
            id: call.id,
            error: { code: -32014, message: "Block is not yet available" },
          });
        }
        return from <= proofBlock && to >= proofBlock ? [{
          address: registry,
          topics: proofLogTopics,
          data: encodeAbiParameters(
            parseAbiParameters("address, uint256, bytes32, bytes32, uint64, address"),
            [seller, 12_000n, requestHash, responseHash, timestamp, attester],
          ),
          blockHash,
          blockNumber: toHex(proofBlock),
          transactionHash,
          transactionIndex: "0x0",
          logIndex: "0x0",
          removed: false,
        }] : [];
      }
      case "eth_getBlockByNumber":
        assert.deepEqual(call.params, [toHex(proofBlock), false]);
        return { hash: blockHash, number: toHex(proofBlock), timestamp: toHex(timestamp), transactions: [] };
      default: throw new Error("Unexpected RPC method: " + call.method);
    }
  });

  const updates: Record<string, unknown>[] = [];
  const supabase = {
    from(table: string) {
      assert.equal(table, "payment_events");
      return {
        update(values: Record<string, unknown>) {
          updates.push(values);
          return {
            async eq(column: string, id: string) {
              assert.equal(column, "id");
              assert.equal(id, "proof-fixture");
              return { error: null };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
  const record = {
    id: "proof-fixture",
    endpoint: "/fixture",
    payer: buyer,
    amount_usdc: "0.012",
    receipt_hash: receiptHash,
    service_hash: serviceHash,
    request_hash: requestHash,
    response_hash: responseHash,
    onchain_buyer: buyer,
    onchain_seller: seller,
    onchain_amount_atomic: "12000",
    onchain_contract_address: null,
    onchain_chain_id: null,
    onchain_tx_hash: null,
    onchain_status: null,
    onchain_block_number: null,
    onchain_proof_id: null,
    onchain_attester: null,
    onchain_verified_at: null,
    onchain_last_attempt_at: null,
    onchain_attempt_count: null,
    onchain_error: null,
  } satisfies OnchainPaymentEventRecord;
  const result = await publishStoredProof({ supabase, record });
  assert.equal(result.status, "verified");
  assert.deepEqual(ranges, [
    [41_001n, 50_000n], [41_001n, 50_000n], [32_001n, 41_000n], [25_000n, 32_000n],
  ]);
  assert.equal(result.transactionHash, transactionHash);
  assert.equal(result.blockNumber, 30_000);
  assert.equal(updates.at(-1)?.onchain_attester, getAddress(attester));
  assert.equal(updates.at(-1)?.onchain_tx_hash, transactionHash);
  assert.equal(updates.at(-1)?.onchain_verified_at, new Date(Number(timestamp) * 1000).toISOString());
  assert.equal(methods.at(-1), "eth_getBlockByNumber");
  assert.ok(!methods.includes("eth_sendRawTransaction"));

  const failedRow = { ...record, onchain_status: "failed" };
  const signedRequest = "eth_sendRawTransaction: " + "0x" + "ab".repeat(100);
  assert.equal(onchainProofMetadataFromRow({
    ...failedRow,
    onchain_error: signedRequest,
  })?.error, "proof_failed");
  assert.equal(onchainProofMetadataFromRow({
    ...failedRow,
    onchain_error: "Status: 429. " + signedRequest,
  })?.error, "proof_rpc_unavailable");
});

test("escrow reads, verdict submission, and receipt use the same configured or explicit RPC", async (context) => {
  editEnvironment(context, { ARC_TESTNET_RPC_URL: configuredRpc });
  const { executeOffchainJobEvaluation } = await import("../lib/erc8183/evaluator.ts");
  for (const rpcUrl of [undefined, overrideRpc]) {
    await context.test(rpcUrl ? "explicit RPC wins" : "configured RPC is used for every call", async (subtest) => {
      const methods = mockArcRpc(subtest, rpcUrl ?? configuredRpc, (call) => {
        switch (call.method) {
          case "eth_call": return encodeFunctionResult({
            abi: ERC8183_AGENTIC_COMMERCE_ABI,
            functionName: "getJob",
            result: {
              id: 1n, client: buyer, provider: seller, evaluator: attester,
              description: "escrow fixture", budget: 20_000n, expiredAt: timestamp,
              status: 1, hook: zeroAddress,
            },
          });
          case "eth_blockNumber": return toHex(50_000n);
          case "eth_getLogs": return [];
          case "eth_chainId": return toHex(ARC_TESTNET_CHAIN_ID);
          case "eth_getTransactionCount": return "0x0";
          case "eth_getBlockByNumber": return { baseFeePerGas: "0x1", transactions: [] };
          case "eth_maxPriorityFeePerGas": return "0x1";
          case "eth_gasPrice": return "0x2";
          case "eth_estimateGas": return "0x10000";
          case "eth_sendRawTransaction": return transactionHash;
          case "eth_getTransactionReceipt":
            assert.deepEqual(call.params, [transactionHash]);
            return { transactionHash, status: "0x1", blockHash, blockNumber: toHex(50_000n), logs: [] };
          default: throw new Error("Unexpected RPC method: " + call.method);
        }
      });
      const result = await executeOffchainJobEvaluation({
        chainId: ARC_TESTNET_CHAIN_ID,
        agenticCommerce: registry,
        jobId: "1",
        deliverable: {
          version: 1,
          contentUri: "https://fixture.example.test/output",
          contentHash: responseHash,
          contentType: "application/json",
          schemaId: "veyra://schemas/structured-deliverable-v1",
          policyId: "structured-deliverable-v1",
        },
        evaluatorContract: attester,
        attesterPrivateKey: testKey,
        relayerPrivateKey: testKey,
        rpcUrl,
      });
      // A Funded job triggers deterministic rejection before content fetch.
      assert.equal(result.status, "rejected", result.failureMessage);
      assert.equal(result.settlementTxHash, transactionHash);
      assert.ok(methods.includes("eth_getLogs"));
      assert.ok(methods.includes("eth_sendRawTransaction"));
      assert.ok(methods.includes("eth_getTransactionReceipt"));
    });
  }
});
