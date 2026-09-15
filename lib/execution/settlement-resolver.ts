/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createPublicClient,
  http,
  erc20Abi,
  parseEventLogs,
  decodeFunctionData,
  type Address,
  type Hash,
  type PublicClient,
} from "viem";
import { arcTestnet, base, mainnet } from "viem/chains";
import type { ExecutionAttempt } from "./types.ts";

export const ARC_USDC_CONTRACT: Address = "0x3600000000000000000000000000000000000000";
export const TRANSACTION_HASH_REGEX = /^0x[0-9a-fA-F]{64}$/;

export const EIP3009_ABI = [
  {
    name: "receiveWithAuthorization",
    type: "function",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    name: "transferWithAuthorization",
    type: "function",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    /* The canonical answer to "did this authorization get spent", and the only
       one available when the response that would have carried a transaction
       hash never arrived. EIP-3009 keeps a bit per (authorizer, nonce); the
       token is the authority on it, not the seller. */
    name: "authorizationState",
    type: "function",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  {
    name: "AuthorizationUsed",
    type: "event",
    inputs: [
      { name: "authorizer", type: "address", indexed: true },
      { name: "nonce", type: "bytes32", indexed: true },
    ],
  },
] as const;

export function normalizeHex32(hex?: string | null): string | null {
  if (!hex || typeof hex !== "string") return null;
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return `0x${clean.padStart(64, "0").toLowerCase()}`;
}

export interface SettlementResolution {
  resolved: boolean;
  settled: boolean;
  failed: boolean;
  failureReason?: string | null;
  txHash?: string | null;
  settledAmountUsdc?: number;
  payer?: `0x${string}`;
  payTo?: `0x${string}`;
  /** What the answer rests on. A settlement read from the token's own
   *  authorization bit is as certain as one read from a receipt, but it cannot
   *  name the transaction that did it, and a reader deserves to know which of
   *  the two they are looking at -- and a batched purchase, which no public
   *  record describes at all, is a third thing again. */
  proof?: "transaction_receipt" | "authorization_state" | "gateway_batch_presumed";
}

const UNRESOLVED: SettlementResolution = { resolved: false, settled: false, failed: false };

/**
 * The chain an authorization was signed for.
 *
 * This used to be Arc and nothing else, while the browser relay happily settles
 * on Base -- so a Base payment that needed reconciling was looked for on a
 * chain it was never on, found nothing, and stayed unresolved forever. An
 * unknown network resolves to nothing rather than to a default, because
 * guessing the chain is how you prove a payment did not happen by looking in
 * the wrong place.
 */
export function chainForNetwork(network?: string | null) {
  switch ((network ?? "").trim().toLowerCase()) {
    // Absent means Arc: every attempt written before the field existed was one.
    case "":
    case "arc":
    case "arc-testnet":
    case "eip155:5042002":
      return arcTestnet;
    case "base":
    case "eip155:8453":
      return base;
    case "ethereum":
    case "mainnet":
    case "eip155:1":
      return mainnet;
    default:
      return null;
  }
}

export interface SettlementResolver {
  resolve(params: {
    attempt: ExecutionAttempt;
    hint?: string;
  }): Promise<SettlementResolution>;
}

/**
 * Whether one authorization has been redeemed, asked of the token directly.
 *
 * For callers that hold a live authorization and a claim about it -- a seller
 * answering 402, say -- and want the chain's answer instead of the claim.
 * Returns null when the question could not be put: an unknown network, an RPC
 * that did not answer. Null is not "no".
 */
export async function readAuthorizationUsed(input: {
  network?: string | null;
  asset: string;
  payer: string;
  nonce: string;
  rpcUrl?: string;
  /** True for Circle's batched scheme, which the token cannot answer for. */
  gatewayBatched?: boolean | null;
}): Promise<boolean | null> {
  /* A batched authorization is domain-separated by the GatewayWallet, not by
     the token, so its nonce was never an EIP-3009 nonce on this contract and
     the token will answer false for it forever -- for one that was paid and
     one that was not, indistinguishably. Asking anyway and reading the answer
     as "unspent" is how a settled purchase gets recorded as a refusal. */
  if (input.gatewayBatched === true) return null;
  const chain = chainForNetwork(input.network);
  const nonce = normalizeHex32(input.nonce);
  if (!chain || !nonce || !input.asset || !input.payer) return null;
  try {
    const client = createPublicClient({
      chain,
      transport: http(
        chain.id === arcTestnet.id
          ? (input.rpcUrl || process.env.ARC_TESTNET_RPC_URL || process.env.ARC_RPC_URL)
          : undefined,
      ),
    }) as PublicClient;
    const used = await client.readContract({
      address: input.asset as Address,
      abi: EIP3009_ABI,
      functionName: "authorizationState",
      args: [input.payer as Address, nonce as `0x${string}`],
    });
    return used === true;
  } catch {
    return null;
  }
}

export class RealArcSettlementResolver implements SettlementResolver {
  private rpcUrl?: string;

  constructor(options?: { rpcUrl?: string }) {
    this.rpcUrl = options?.rpcUrl || process.env.ARC_TESTNET_RPC_URL || process.env.ARC_RPC_URL;
  }

  async resolve(params: {
    attempt: ExecutionAttempt;
    hint?: string;
  }): Promise<SettlementResolution> {
    const { attempt, hint } = params;
    const x402Context = attempt.x402Context;

    // 1. REQUIRE COMPLETE x402 CONTEXT — fail unresolved if any mandatory context is missing
    if (
      !x402Context ||
      !x402Context.payerWallet ||
      !x402Context.asset ||
      x402Context.authorizedAmountUsdc == null ||
      !x402Context.authorizationNonce ||
      x402Context.authorizationValidBefore == null
    ) {
      return { resolved: false, settled: false, failed: false };
    }

    const expectedPayer = x402Context.payerWallet.toLowerCase();
    const expectedPayTo = (x402Context.payTo || attempt.counterpartyWallet).toLowerCase();
    const expectedAsset = (x402Context.asset || ARC_USDC_CONTRACT).toLowerCase();
    const expectedNonce = normalizeHex32(x402Context.authorizationNonce);
    const expectedValidBefore = Number(x402Context.authorizationValidBefore);

    // 2. EXACT AMOUNT MATCH — derive canonical integer atomic units
    const expectedAmountAtomic = BigInt(
      x402Context.authorizedAmountAtomic ?? Math.round(x402Context.authorizedAmountUsdc * 1_000_000)
    );

    /* Which rail this authorization belongs to decides what may be asked of it.
       They are not variants of one question with a different RPC URL.

       A vanilla EIP-3009 authorization is answerable: the token keeps a bit per
       (authorizer, nonce) and a receipt can be bound to the transfer. Circle's
       batched scheme is answerable by nobody outside Circle. The buyer signs
       against the GatewayWallet, the seller hands the authorization to Gateway,
       Gateway locks the funds in its own ledger, and some minutes or hours later
       one transaction applies the *net* position of every participant in the
       batch. There is no transfer to find, no nonce on the token to read, and
       no public per-authorization status: /v1/x402/verify validates the signed
       message and nothing else -- it answered isValid for a payer with no
       deposit at all, and short-circuits on expiry before it would reach a
       nonce. So the batched rail gets its own resolution, which is honest about
       resting on an argument rather than on a record. */
    if (x402Context.gatewayBatched === true) {
      return this.resolveBatchedAuthorization({
        validBefore: expectedValidBefore,
        amountAtomic: expectedAmountAtomic,
        payer: expectedPayer as Address,
        payTo: expectedPayTo as Address,
      });
    }

    const chain = chainForNetwork(x402Context.network);
    if (!chain) return UNRESOLVED;

    let publicClient: PublicClient;
    try {
      publicClient = createPublicClient({
        chain,
        /* The configured URL is Arc's. Every other chain uses viem's default
           endpoint for itself; this is a read-only call on a public contract. */
        transport: http(chain.id === arcTestnet.id ? this.rpcUrl : undefined),
      }) as PublicClient;
    } catch {
      return UNRESOLVED;
    }

    /* Two ways to answer, in order of how much they can say.

       A transaction receipt names the transfer and proves it, so it is tried
       first whenever there is a hash to try. But the failure this resolver
       exists for -- a response that never arrived -- is exactly the one that
       leaves no hash, and that meant the attempt sat in SETTLEMENT_UNVERIFIED
       with its budget reserved and no way out of it.

       The token itself always knows. EIP-3009 records a bit per (authorizer,
       nonce), and both were written down before the request was sent. */
    const candidateTx = hint || attempt.paymentTx || x402Context.facilitatorReference;
    if (candidateTx && TRANSACTION_HASH_REGEX.test(candidateTx)) {
      const byReceipt = await this.resolveFromTransaction({
        publicClient,
        candidateTx: candidateTx as Hash,
        expectedPayer,
        expectedPayTo,
        expectedAsset,
        expectedNonce,
        expectedValidBefore,
        expectedAmountAtomic,
      }).catch(() => null);
      if (byReceipt) return byReceipt;
    }

    return await this.resolveFromAuthorizationState({
      publicClient,
      asset: expectedAsset as Address,
      payer: expectedPayer as Address,
      nonce: expectedNonce as `0x${string}`,
      validBefore: expectedValidBefore,
      amountAtomic: expectedAmountAtomic,
      payTo: expectedPayTo as Address,
    }).catch(() => UNRESOLVED);
  }

  /**
   * A batched purchase whose response never arrived.
   *
   * Nothing can be read. What can be reasoned about is the window: until
   * validBefore passes the authorization is live and the seller may still hand
   * it to Gateway, so there is no answer yet and the attempt stays open. Once
   * it passes, whatever was going to happen has happened -- Gateway refuses an
   * expired authorization, and so would the GatewayWallet -- and the only
   * question left is which way, permanently unanswerable.
   *
   * It is booked as spent. Not because that is known, but because the two
   * mistakes are not the same size. A mandate is a promise about a ceiling: if
   * the money left and the reservation is released, the buyer's own cap is
   * quietly exceeded by real funds. If it did not leave and the spend is booked,
   * one day's cap is under-used and resets at midnight. The asymmetry decides
   * it, and the probabilities point the same way -- the response went missing
   * after the seller already held a valid authorization.
   *
   * What it must never do is become evidence about the seller. There is no
   * transaction, so no reputation row is written, and the proof grade says
   * presumed rather than observed.
   */
  private async resolveBatchedAuthorization(input: {
    validBefore: number;
    amountAtomic: bigint;
    payer: Address;
    payTo: Address;
  }): Promise<SettlementResolution> {
    // Still redeemable by whoever holds it. Nothing to conclude.
    if (!Number.isFinite(input.validBefore) || Date.now() / 1000 <= input.validBefore) {
      return UNRESOLVED;
    }
    return {
      resolved: true,
      settled: true,
      failed: false,
      settledAmountUsdc: Number(input.amountAtomic) / 1_000_000,
      payer: input.payer,
      payTo: input.payTo,
      txHash: null,
      proof: "gateway_batch_presumed",
    };
  }

  /**
   * What the chain says about one authorization, when no receipt is available.
   *
   * The bit is the whole answer to whether money moved. What it cannot do is
   * name the transaction that moved it, so a settlement proved this way carries
   * no hash -- a weaker receipt and a far stronger fact than the "FAILED,
   * nothing transferred" it replaces.
   *
   * An unused authorization is not yet good news. Until validBefore passes the
   * signature is still redeemable by anyone holding it, so "not spent" means
   * "not spent yet" and the attempt stays open. Only an expired and unused
   * authorization is safe to call a failure -- and then it is a certain one.
   */
  private async resolveFromAuthorizationState(input: {
    publicClient: PublicClient;
    asset: Address;
    payer: Address;
    nonce: `0x${string}`;
    validBefore: number;
    amountAtomic: bigint;
    payTo: Address;
  }): Promise<SettlementResolution> {
    const used = await input.publicClient.readContract({
      address: input.asset,
      abi: EIP3009_ABI,
      functionName: "authorizationState",
      args: [input.payer, input.nonce],
    });

    if (used === true) {
      return {
        resolved: true,
        settled: true,
        failed: false,
        /* The signature fixed the payee and the amount, so redemption can only
           have moved this much to this address. Nothing here is taken from
           what the seller said. */
        settledAmountUsdc: Number(input.amountAtomic) / 1_000_000,
        payer: input.payer,
        payTo: input.payTo,
        txHash: null,
        proof: "authorization_state",
      };
    }

    if (Number.isFinite(input.validBefore) && Date.now() / 1000 > input.validBefore) {
      return {
        resolved: true,
        settled: false,
        failed: true,
        failureReason: "AUTHORIZATION_EXPIRED_UNUSED",
        proof: "authorization_state",
      };
    }

    // Still redeemable. Nobody may call this a failure yet.
    return UNRESOLVED;
  }

  /**
   * The receipt path, unchanged: a candidate transaction bound to this exact
   * authorization. Returns null rather than a verdict when it has nothing to
   * say, so an unrelated or unfindable transaction falls through to the token
   * instead of ending the resolution.
   */
  private async resolveFromTransaction(input: {
    publicClient: PublicClient;
    candidateTx: Hash;
    expectedPayer: string;
    expectedPayTo: string;
    expectedAsset: string;
    expectedNonce: string | null;
    expectedValidBefore: number;
    expectedAmountAtomic: bigint;
  }): Promise<SettlementResolution | null> {
    const {
      publicClient, candidateTx, expectedPayer, expectedPayTo,
      expectedAsset, expectedNonce, expectedValidBefore, expectedAmountAtomic,
    } = input;

      const [receipt, transaction] = await Promise.all([
        publicClient.getTransactionReceipt({ hash: candidateTx as Hash }).catch(() => null),
        publicClient.getTransaction({ hash: candidateTx as Hash }).catch(() => null),
      ]);

      if (!receipt) {
        return null;
      }

      // 3 & 4. BIND TRANSACTION TO AUTHORIZATION
      let isAuthorizationBound = false;

      // Check method A: Decoded calldata from transaction.input
      if (transaction && transaction.input && transaction.input !== "0x") {
        try {
          const decoded = decodeFunctionData({
            abi: EIP3009_ABI,
            data: transaction.input,
          });

          if (
            decoded &&
            (decoded.functionName === "receiveWithAuthorization" ||
              decoded.functionName === "transferWithAuthorization")
          ) {
            const args: any = decoded.args;
            const fromMatch = args[0]?.toLowerCase() === expectedPayer;
            const toMatch = args[1]?.toLowerCase() === expectedPayTo;
            const valueMatch = BigInt(args[2] ?? 0) === expectedAmountAtomic;
            const validBeforeMatch = Number(args[4] ?? 0) === expectedValidBefore;
            const nonceMatch = normalizeHex32(args[5]) === expectedNonce;
            const assetMatch = transaction.to?.toLowerCase() === expectedAsset;

            if (fromMatch && toMatch && valueMatch && validBeforeMatch && nonceMatch && assetMatch) {
              isAuthorizationBound = true;
            }
          }
        } catch {
          // Calldata was not standard EIP-3009 call
        }
      }

      // Check method B: Decoded logs from receipt (for contract relayers / facilitators)
      if (!isAuthorizationBound && receipt.logs && receipt.logs.length > 0) {
        try {
          const authLogs = parseEventLogs({
            abi: EIP3009_ABI,
            eventName: "AuthorizationUsed",
            logs: receipt.logs,
          });

          for (const authLog of authLogs) {
            const contractMatch = authLog.address.toLowerCase() === expectedAsset;
            const authorizerMatch = authLog.args.authorizer.toLowerCase() === expectedPayer;
            const nonceMatch = normalizeHex32(authLog.args.nonce) === expectedNonce;

            if (contractMatch && authorizerMatch && nonceMatch) {
              isAuthorizationBound = true;
              break;
            }
          }
        } catch {
          // Log parsing error
        }
      }

      // Handle Reverted Transaction
      if (receipt.status === "reverted") {
        // A reverted transaction proves failure ONLY if it was bound to this authorization
        if (isAuthorizationBound) {
          return {
            resolved: true,
            settled: false,
            failed: true,
            failureReason: "ONCHAIN_PAYMENT_TX_REVERTED",
            txHash: receipt.transactionHash,
          };
        }
        // Unrelated reverted transaction -> remain unresolved
        return null;
      }

      // Handle Successful Transaction
      if (receipt.status === "success" && isAuthorizationBound) {
        // Verify canonical Arc USDC Transfer event log
        const transferLogs = parseEventLogs({
          abi: erc20Abi,
          eventName: "Transfer",
          logs: receipt.logs,
        });

        for (const log of transferLogs) {
          const logContract = log.address.toLowerCase();
          const logFrom = log.args.from.toLowerCase();
          const logTo = log.args.to.toLowerCase();
          const logValue = BigInt(log.args.value);

          const assetMatch = logContract === expectedAsset;
          const payerMatch = logFrom === expectedPayer;
          const payToMatch = logTo === expectedPayTo;
          const amountMatch = logValue === expectedAmountAtomic;

          if (assetMatch && payerMatch && payToMatch && amountMatch) {
            return {
              resolved: true,
              settled: true,
              failed: false,
              txHash: receipt.transactionHash,
              settledAmountUsdc: Number(expectedAmountAtomic) / 1_000_000,
              payer: log.args.from,
              payTo: log.args.to,
            };
          }
        }
      }

    return null;
  }
}

/**
 * Mock Settlement Resolver for unit and integration testing without network RPC.
 */
export class MockSettlementResolver implements SettlementResolver {
  private handler: (params: { attempt: ExecutionAttempt; hint?: string }) => Promise<SettlementResolution> | SettlementResolution;

  constructor(
    handler: (params: { attempt: ExecutionAttempt; hint?: string }) => Promise<SettlementResolution> | SettlementResolution
  ) {
    this.handler = handler;
  }

  async resolve(params: { attempt: ExecutionAttempt; hint?: string }): Promise<SettlementResolution> {
    return this.handler(params);
  }
}
