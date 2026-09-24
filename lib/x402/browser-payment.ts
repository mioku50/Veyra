/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * x402 `exact` payments signed by the end user's own browser wallet.
 *
 * Execution used to be funded by a private key held on the server, which is
 * defensible for a canary and impossible for a product: it means every visitor
 * spends Veyra's treasury. Here the user signs an EIP-3009
 * `TransferWithAuthorization` in their wallet and Veyra only relays it.
 *
 * The important property is that the signature *is* the ceiling. The signed
 * message commits to the exact `value`, the exact recipient and a validity
 * window, so a relay — this server included — cannot inflate the amount, send
 * it elsewhere, or replay it later. The worst any intermediary can do is fail
 * to deliver it.
 *
 * Nothing in this module touches a key or the network. It reads a live 402
 * challenge and returns typed data to sign and a header to send.
 */

export const X402_VERSION = 2;

/* x402 v2 carries the signed payment in `PAYMENT-SIGNATURE`; `X-PAYMENT` is the
   v1 header. Sending a v2 payload under the v1 name makes a conformant seller
   parse it as v1 and answer "Invalid x402 payment signature" — which is exactly
   what the live Exa endpoint answered before this was corrected. */
export const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
export const PAYMENT_SIGNATURE_HEADER_V1 = "X-PAYMENT";

/** Circle's batched scheme announces itself through the EIP-712 domain name. */
import { gatewayContextForChain } from "./gateway-deposit.ts";

export const CIRCLE_BATCHING_DOMAIN_NAME = "GatewayWalletBatched";
const VANILLA_MAX_TIMEOUT_SECONDS = 3_600;
const GATEWAY_MAX_TIMEOUT_SECONDS = 604_900;

export type X402Accept = {
  scheme: string;
  network: string;
  /** Atomic units of `asset`, as a decimal string. */
  amountAtomic: string;
  asset: `0x${string}`;
  payTo: `0x${string}`;
  maxTimeoutSeconds: number;
  /** EIP-712 domain name and version the signature is separated by. For a
   *  vanilla EIP-3009 accept these are the token's; for a Circle Gateway
   *  batched accept they are the Gateway wallet's. They are NOT the asset's
   *  identity — `asset` is. */
  assetName: string;
  assetVersion: string;
  /** The contract the EIP-712 domain binds to. Circle's batched scheme signs
   *  against the GatewayWallet, not the token, so this is read from
   *  `extra.verifyingContract` and only falls back to the asset. */
  verifyingContract: `0x${string}`;
  /** Circle Gateway batches settlement and legitimately needs a week-long
   *  authorization window, which a vanilla accept never does. */
  gatewayBatched: boolean;
  chainId: number;
  /* The accept exactly as the seller published it. A v2 payload echoes it back
     under `accepted`, and the seller compares it to what it offered, so a
     normalized copy is not interchangeable with the original. */
  raw: Record<string, unknown>;
};

export type TransferAuthorization = {
  from: `0x${string}`;
  to: `0x${string}`;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: `0x${string}`;
};

export class X402PaymentError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "X402PaymentError";
    this.code = code;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** `eip155:8453` → 8453. Anything else is not an EVM chain we can sign for. */
export function evmChainIdFromCaip2(network: unknown): number | null {
  if (typeof network !== "string") return null;
  const match = /^eip155:(\d+)$/.exec(network.trim());
  if (!match) return null;
  const chainId = Number(match[1]);
  return Number.isSafeInteger(chainId) && chainId > 0 ? chainId : null;
}

function atomicAmount(accept: Record<string, unknown>): string | null {
  // Sellers label this `amount` or `maxAmountRequired` depending on how closely
  // they follow the draft; both appear in the live catalog.
  for (const key of ["amount", "maxAmountRequired", "amountAtomic"]) {
    const raw = accept[key];
    if (typeof raw === "string" && /^\d+$/.test(raw)) return raw;
    if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) return String(raw);
  }
  return null;
}

function isHexAddress(value: unknown): value is `0x${string}` {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

/**
 * Picks the EVM `exact` accept this wallet can pay, cheapest first, refusing
 * anything above the authorized ceiling.
 *
 * A challenge commonly offers several rails — the live Exa endpoint offers Base
 * and Solana for the same call. Only chains the browser wallet can sign for are
 * considered, and `maxAtomic` is enforced here rather than trusted from the UI.
 */
export function selectPayableAccept(
  challenge: unknown,
  options: {
    maxAtomic: bigint;
    allowedChainIds?: number[];
    /** The terms a Veyra decision was made on. Only an accept on this network,
     *  to this payee, in this asset is considered: a challenge offering the
     *  same price on several chains and to several payees is otherwise decided
     *  by the order the seller lists them in. */
    match?: { network?: string | null; payTo?: string | null; asset?: string | null };
  },
): X402Accept {
  const envelope = asRecord(challenge);
  const rawAccepts = envelope && Array.isArray(envelope.accepts) ? envelope.accepts : [];
  if (rawAccepts.length === 0) {
    throw new X402PaymentError("challenge_unparseable", "The endpoint did not present a payment challenge.");
  }

  const payable: X402Accept[] = [];
  for (const item of rawAccepts) {
    const accept = asRecord(item);
    if (!accept) continue;
    if (accept.scheme !== "exact") continue;

    const chainId = evmChainIdFromCaip2(accept.network);
    if (chainId === null) continue;
    if (options.allowedChainIds && !options.allowedChainIds.includes(chainId)) continue;

    const amountAtomic = atomicAmount(accept);
    if (amountAtomic === null) continue;
    if (!isHexAddress(accept.asset) || !isHexAddress(accept.payTo)) continue;

    const extra = asRecord(accept.extra);
    const assetName = typeof extra?.name === "string" ? extra.name : null;
    const assetVersion = typeof extra?.version === "string" ? extra.version : null;
    // EIP-3009 signing is domain-separated by the token's own name and version.
    // Guessing them produces a signature the token contract will reject, so an
    // accept that omits them is not payable rather than payable-and-broken.
    if (!assetName || !assetVersion) continue;

    /* The scheme half of this was dead: `accept.scheme !== "exact"` has already
       skipped everything else, so only the domain name ever decided it. Said
       plainly now, because a batched accept is signed under a different domain
       and gets a week-long window, and what turns that on should be one
       readable condition. */
    const gatewayBatched = assetName === CIRCLE_BATCHING_DOMAIN_NAME;
    const verifyingContract = isHexAddress(extra?.verifyingContract)
      ? extra.verifyingContract
      : accept.asset;

    if (gatewayBatched) {
      /* Circle's GatewayWallet for this chain, or nothing.
       *
       * The only check here used to be that the verifying contract differed
       * from the asset, which any address satisfies -- so a seller could put
       * 0x1111...1111 in extra.verifyingContract and have a wallet sign a
       * GatewayWalletBatched authorization pointed at a contract of its
       * choosing, for a week. Veyra publishes the Gateway deployment addresses
       * already; this is the one place that was not reading them. */
      const gateway = gatewayContextForChain(chainId);
      if (!gateway) continue;
      if (verifyingContract.toLowerCase() !== gateway.gatewayWallet.toLowerCase()) continue;
    } else if (verifyingContract.toLowerCase() !== accept.asset.toLowerCase()) {
      /* A vanilla EIP-3009 authorization is domain-separated by the token
         itself. A verifying contract that is not the asset is either a mistake
         or an attempt to move the signature somewhere else; neither is payable. */
      continue;
    }

    const timeout = Number(accept.maxTimeoutSeconds);
    // The ceiling stops a hostile seller from demanding a year-long standing
    // authorization. Batching needs a week, so it gets a week — and nothing an
    // agent could not revoke by spending the nonce.
    const ceiling = gatewayBatched
      ? GATEWAY_MAX_TIMEOUT_SECONDS
      : VANILLA_MAX_TIMEOUT_SECONDS;
    payable.push({
      raw: accept,
      scheme: "exact",
      network: accept.network as string,
      amountAtomic,
      asset: accept.asset,
      payTo: accept.payTo,
      maxTimeoutSeconds: Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, ceiling) : 60,
      assetName,
      assetVersion,
      verifyingContract,
      gatewayBatched,
      chainId,
    });
  }

  if (payable.length === 0) {
    throw new X402PaymentError(
      "no_payable_accept",
      "This endpoint offers no payment option a browser wallet can sign for.",
    );
  }

  /* Exa's live challenge offers one price seven ways: a wallet payment on
     Base to one payee, Gateway on Base, World Chain and Arc, a wallet payment
     on Arc, and a wallet payment on Base to a second payee. The first of them
     won every tie, so a decision made on Arc was quoted on Base, to a payee
     nobody had decided on, and refused. */
  const same = (left: string | null | undefined, right: string) =>
    !left || left.trim().toLowerCase() === right.trim().toLowerCase();
  const matching = payable.filter((accept) =>
    same(options.match?.network, accept.network)
    && same(options.match?.payTo, accept.payTo)
    && same(options.match?.asset, accept.asset));
  if (matching.length === 0) {
    throw new X402PaymentError(
      "decided_terms_not_offered",
      "This endpoint no longer offers payment on the network, to the payee and in the asset Veyra decided on.",
    );
  }

  /* Cheapest first. At one price, a wallet payment before a Gateway one: the
     decision binds the payee, the asset and the chain, not the rail, and the
     wallet rail needs no deposit and is valid for an hour rather than a week. */
  matching.sort((left, right) => {
    const byPrice = BigInt(left.amountAtomic) - BigInt(right.amountAtomic);
    if (byPrice !== BigInt(0)) return byPrice < BigInt(0) ? -1 : 1;
    return Number(left.gatewayBatched) - Number(right.gatewayBatched);
  });
  const cheapest = matching[0];
  if (BigInt(cheapest.amountAtomic) > options.maxAtomic) {
    throw new X402PaymentError(
      "price_above_authorization",
      `The endpoint asks ${cheapest.amountAtomic} atomic units, above the authorized ceiling of ${options.maxAtomic}.`,
    );
  }
  return cheapest;
}

/**
 * The domain type, spelled out, because a wallet asked over the raw RPC will not
 * infer it.
 *
 * viem adds this automatically, which is exactly what hid the bug: every local
 * signature in every test was valid, and every signature a person actually made
 * in MetaMask was not. `eth_signTypedData_v4` hashes the domain with
 * `hashStruct("EIP712Domain", ...)`, and with no EIP712Domain entry in `types`
 * that encodes an empty struct -- a domain separator belonging to no contract on
 * any chain. The seller recovers a stranger's address and answers
 * `invalid_exact_evm_payload_signature`, which is the truth.
 *
 * The corroboration was sitting in the database: execution_attempts had never
 * held a single row. Not one browser-signed x402 payment has ever settled,
 * here or on /run.
 *
 * The order matters as much as the presence. EIP-712 encodes fields in the
 * order they are declared, so this list has to match the domain object built
 * below field for field.
 */
export const EIP712_DOMAIN_TYPE = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/**
 * The exact EIP-712 payload the wallet is asked to sign, plus the authorization
 * it commits to. The caller shows the authorization to the user; the wallet
 * shows the same numbers, so the two can be compared before signing.
 */
export function buildPaymentTypedData(input: {
  accept: X402Accept;
  from: `0x${string}`;
  nonce: `0x${string}`;
  now?: number;
}) {
  const now = Math.floor((input.now ?? Date.now()) / 1000);
  const authorization: TransferAuthorization = {
    from: input.from,
    to: input.accept.payTo,
    value: input.accept.amountAtomic,
    // Backdated by ten minutes, matching the reference client: a seller's clock
    // running behind must not reject an otherwise valid authorization.
    validAfter: String(now - 600),
    validBefore: String(now + input.accept.maxTimeoutSeconds),
    nonce: input.nonce,
  };

  return {
    authorization,
    typedData: {
      domain: {
        name: input.accept.assetName,
        version: input.accept.assetVersion,
        chainId: input.accept.chainId,
        verifyingContract: input.accept.verifyingContract,
      },
      types: {
        EIP712Domain: EIP712_DOMAIN_TYPE,
        ...TRANSFER_WITH_AUTHORIZATION_TYPES,
      },
      primaryType: "TransferWithAuthorization" as const,
      message: authorization,
    },
  };
}

/**
 * The base64 `PAYMENT-SIGNATURE` value: an x402 v2 payment payload.
 *
 * The envelope is not free-form. A v2 seller reads `accepted` and compares it to
 * the accept it published, and reads `resource` to bind the payment to the thing
 * being bought — so both are echoed verbatim rather than rebuilt.
 */
export function encodePaymentHeader(input: {
  accept: X402Accept;
  authorization: TransferAuthorization;
  signature: `0x${string}`;
  /* Echoed exactly as the challenge published it. In v2 this is an object —
     `{url, description, mimeType}` on the live Exa endpoint — not the URL
     string. Sending the string made the seller's comparison fail and produced
     `X402_INVALID_SIGNATURE`, which reads like a crypto fault and is not one. */
  resource: unknown;
  extensions?: Record<string, unknown>;
}): string {
  const payload: Record<string, unknown> = {
    x402Version: X402_VERSION,
    payload: {
      authorization: input.authorization,
      signature: input.signature,
    },
    resource: input.resource,
    accepted: input.accept.raw,
  };
  if (input.extensions && Object.keys(input.extensions).length > 0) {
    payload.extensions = input.extensions;
  }
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

/** The challenge's `resource`, whatever shape it has, for echoing back. */
export function challengeResource(challenge: unknown): unknown {
  const envelope = asRecord(challenge);
  return envelope?.resource ?? null;
}

/** Sellers answer with a base64 `X-PAYMENT-RESPONSE` describing settlement. */
export function decodePaymentResponse(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const decoded = Buffer.from(value.trim(), "base64").toString("utf8");
    const parsed = JSON.parse(decoded);
    return asRecord(parsed);
  } catch {
    return null;
  }
}
