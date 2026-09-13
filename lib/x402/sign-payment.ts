/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { buildPaymentTypedData, type X402Accept } from "./browser-payment.ts";

/**
 * The signature step, in the browser, for every surface that has one.
 *
 * Quoting and relaying happen on the server and are shared already. This is the
 * part in between, and it is the part worth sharing most: it decides which
 * chain the wallet is on when it signs, and what the wallet is shown before it
 * does. Two copies of this would not disagree loudly -- they would disagree
 * about the chain, once, in a wallet popup someone approves without reading.
 *
 * Veyra never holds the key. Everything here runs in the reader's browser and
 * returns what their wallet produced.
 */

/** What this needs from a wallet, and nothing more. Deliberately narrower than
 *  useArcWallet's surface so a second wallet adapter can satisfy it. */
export type PaymentWallet = {
  address: string | null;
  chainId: number | null;
  switchToChain: (chainId: number) => Promise<boolean>;
  signTypedData: (typedData: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }) => Promise<string>;
};

/** Published before the wallet is asked, so the two can be compared field by
 *  field. The authorization names one recipient, one amount and one nonce, and
 *  expires; it is not an allowance the seller can draw again. */
export type SigningTerms = {
  chainId: number;
  network: string;
  primaryType: string;
  amountUsdc: number;
  recipient: string;
  nonce: string;
  validBefore: number;
  domainName: string;
  verifyingContract: string;
  gatewayBatched: boolean;
};

export type SignedPayment = {
  authorization: ReturnType<typeof buildPaymentTypedData>["authorization"];
  signature: `0x${string}`;
  terms: SigningTerms;
};

export class PaymentSigningError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "PaymentSigningError";
  }
}

export async function signPaymentAuthorization(input: {
  wallet: PaymentWallet;
  accept: X402Accept;
  nonce: string;
  /** Called with the exact terms the moment before the wallet opens, so a
   *  surface can show them rather than describe them. */
  onTerms?: (terms: SigningTerms) => void;
  /** Called when the wallet has to move chains first, so a surface can say why
   *  a chain-switch prompt just appeared. */
  onSwitchingChain?: (chainId: number) => void;
}): Promise<SignedPayment> {
  const { wallet, accept } = input;
  if (!wallet.address) {
    throw new PaymentSigningError("wallet_missing", "Connect a wallet before paying.");
  }

  /* Be on the chain the endpoint is paid on. The clearance is issued on Arc;
     most of the x402 catalog settles on Base, so the wallet moves for one
     signature and the user is told why. */
  if (wallet.chainId !== accept.chainId) {
    input.onSwitchingChain?.(accept.chainId);
    const switched = await wallet.switchToChain(accept.chainId);
    if (!switched) {
      throw new PaymentSigningError(
        "chain_mismatch",
        `This endpoint settles on chain ${accept.chainId}. Switch your wallet there and try again.`,
      );
    }
  }

  const { authorization, typedData } = buildPaymentTypedData({
    accept,
    from: wallet.address as `0x${string}`,
    nonce: input.nonce as `0x${string}`,
  });

  const terms: SigningTerms = {
    chainId: accept.chainId,
    network: accept.network,
    primaryType: typedData.primaryType as string,
    amountUsdc: Number(authorization.value) / 1e6,
    recipient: authorization.to,
    nonce: authorization.nonce,
    validBefore: Number(authorization.validBefore),
    domainName: accept.assetName,
    verifyingContract: accept.verifyingContract,
    gatewayBatched: Boolean(accept.gatewayBatched),
  };
  input.onTerms?.(terms);

  const signature = await wallet.signTypedData(typedData as {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  });
  return { authorization, signature: signature as `0x${string}`, terms };
}
