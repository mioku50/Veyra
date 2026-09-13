/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";
import {
  buildPaymentTypedData,
  decodePaymentResponse,
  encodePaymentHeader,
  evmChainIdFromCaip2,
  selectPayableAccept,
  challengeResource,
  X402PaymentError,
  X402_VERSION,
  PAYMENT_SIGNATURE_HEADER,
} from "../lib/x402/browser-payment.ts";

/* A challenge in the shape the live catalog actually returns. Captured from
   api.exa.ai, which offers Base and Solana for the same call. */
const LIVE_CHALLENGE = {
  x402Version: 2,
  // v2 publishes a descriptor object here, not the URL string.
  resource: {
    url: "https://api.exa.ai/contents",
    description: "Exa /contents endpoint",
    mimeType: "application/json",
  },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:8453",
      amount: "1000",
      payTo: "0x6d6E695b09861467c7d462f5AAF31cF3540B9192",
      maxTimeoutSeconds: 60,
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      extra: { name: "USD Coin", version: "2" },
    },
    {
      scheme: "exact",
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      amount: "1000",
      payTo: "12Ec2cJmfR1C9uwejzxcuMhUgEC7wDrLgm1wBvvR5w9E",
      maxTimeoutSeconds: 60,
      asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      extra: { name: "USD Coin", version: "2" },
    },
  ],
};

assert.equal(evmChainIdFromCaip2("eip155:8453"), 8453);
assert.equal(evmChainIdFromCaip2("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"), null);
assert.equal(evmChainIdFromCaip2("eip155:not-a-number"), null);

// The Solana rail is skipped rather than mis-signed.
const accept = selectPayableAccept(LIVE_CHALLENGE, { maxAtomic: 10_000n, allowedChainIds: [8453] });
assert.equal(accept.network, "eip155:8453");
assert.equal(accept.chainId, 8453);
assert.equal(accept.amountAtomic, "1000");
assert.equal(accept.assetName, "USD Coin");
assert.equal(accept.assetVersion, "2");
assert.deepEqual(accept.raw, LIVE_CHALLENGE.accepts[0]);

// A ceiling below the asking price refuses before anything is presented to sign.
assert.throws(
  () => selectPayableAccept(LIVE_CHALLENGE, { maxAtomic: 999n, allowedChainIds: [8453] }),
  (error: unknown) => error instanceof X402PaymentError && error.code === "price_above_authorization",
);

// A wallet on the wrong chain has nothing it can sign for.
assert.throws(
  () => selectPayableAccept(LIVE_CHALLENGE, { maxAtomic: 10_000n, allowedChainIds: [5042002] }),
  (error: unknown) => error instanceof X402PaymentError && error.code === "no_payable_accept",
);

// An accept without the token's EIP-712 domain is unsignable, not signable-and-wrong.
assert.throws(
  () => selectPayableAccept(
    { accepts: [{ ...LIVE_CHALLENGE.accepts[0], extra: {} }] },
    { maxAtomic: 10_000n, allowedChainIds: [8453] },
  ),
  (error: unknown) => error instanceof X402PaymentError && error.code === "no_payable_accept",
);

assert.throws(
  () => selectPayableAccept({}, { maxAtomic: 10_000n }),
  (error: unknown) => error instanceof X402PaymentError && error.code === "challenge_unparseable",
);

/* The payload has to be signable by a real wallet and recoverable to the signer.
   A wrong domain or a wrong type list still produces a signature — it just
   recovers to the wrong address, and the token contract rejects it on chain
   after the user has already approved. Recovering here is what proves the
   domain separator and the struct match EIP-3009. */
const account = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const nonce = `0x${"11".repeat(32)}` as `0x${string}`;
const now = 1_757_000_000_000;
const { authorization, typedData } = buildPaymentTypedData({
  accept,
  from: account.address,
  nonce,
  now,
});

assert.equal(authorization.from, account.address);
assert.equal(authorization.to, accept.payTo);
assert.equal(authorization.value, "1000");
assert.equal(authorization.nonce, nonce);
// Backdated by a minute, and valid for the seller's own stated window.
assert.equal(Number(authorization.validAfter), Math.floor(now / 1000) - 600);
assert.equal(Number(authorization.validBefore), Math.floor(now / 1000) + accept.maxTimeoutSeconds);

assert.deepEqual(typedData.domain, {
  name: "USD Coin",
  version: "2",
  chainId: 8453,
  verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
});
assert.equal(typedData.primaryType, "TransferWithAuthorization");

const signature = await account.signTypedData(typedData);
const recovered = await recoverTypedDataAddress({ ...typedData, signature });
assert.equal(
  recovered,
  account.address,
  "the signed payload must recover to the signer, or the token contract will reject it",
);

/* The v2 envelope a seller reads back. `accepted` must be the accept exactly as
   published — a normalized copy is not interchangeable — and `resource` binds
   the payment to what is being bought. */
const header = encodePaymentHeader({
  accept, authorization, signature, resource: challengeResource(LIVE_CHALLENGE),
});
const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
assert.equal(decoded.x402Version, X402_VERSION);
/* Echoed verbatim. Sending the URL string where the challenge published a
   descriptor object made the live Exa endpoint answer X402_INVALID_SIGNATURE —
   which reads like a crypto fault and is not one. Verified against Circle's own
   reference client: with the descriptor echoed, both produce byte-identical
   headers and both reach the facilitator. */
assert.deepEqual(decoded.resource, LIVE_CHALLENGE.resource);
assert.deepEqual(challengeResource(LIVE_CHALLENGE), LIVE_CHALLENGE.resource);
assert.equal(challengeResource({}), null);
assert.deepEqual(decoded.accepted, LIVE_CHALLENGE.accepts[0]);
assert.equal(decoded.payload.signature, signature);
assert.deepEqual(decoded.payload.authorization, authorization);
// v2 carries this in PAYMENT-SIGNATURE; X-PAYMENT is the v1 header, and using
// it makes a conformant seller parse a v2 payload as v1 and reject it.
assert.equal(PAYMENT_SIGNATURE_HEADER, "PAYMENT-SIGNATURE");

// Settlement comes back base64 in a header, and a malformed one is not a crash.
const settlement = { success: true, transaction: "0xabc", network: "eip155:8453" };
assert.deepEqual(
  decodePaymentResponse(Buffer.from(JSON.stringify(settlement)).toString("base64")),
  settlement,
);
assert.equal(decodePaymentResponse("not base64 json"), null);
assert.equal(decodePaymentResponse(null), null);

console.log("[x402-browser-payment-test] passed: live challenge shape, rail selection, ceiling refusal, EIP-3009 domain recovery, header encoding, settlement decoding");
