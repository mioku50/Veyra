/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { getAddress, isAddress, verifyMessage, keccak256, toBytes, type Address } from "viem";
import { BYOA_OWNER_SESSION_COOKIE, verifyOwnerSession } from "../byoa/auth.ts";
import { originSet } from "../byoa/config.ts";
import { claimAuthNonce } from "./auth-nonce.ts";
import { ExecutionError } from "./executor.ts";

export interface AuthenticatedCaller {
  wallet: Address;
  source: "session_cookie" | "bearer_session" | "signed_header" | "test_auth";
}

/** How stale a signed header may be. Short on purpose: it is the width of the
 *  window in which a captured header is worth anything at all. */
export const SIGNED_HEADER_WINDOW_MS = 60_000;

/**
 * The exact sentence a caller signs, and the only one that authenticates.
 *
 * Every term in it is a term the signature covers, and everything the request
 * can change is in it. That is the whole point: until 2026-09-15 this function
 * had a sibling -- a "legacy" message naming only the wallet and the timestamp
 * -- that was tried whenever this one failed to verify. Method, path and nonce
 * were not in it, so one captured legacy signature authenticated any route for
 * the length of its window. Reproduced against /prepare and /autopilot with a
 * single signature and two different nonces. There is no fallback now, and
 * there must never be another: an alternative message that omits a term is an
 * alternative message that does not bind it.
 *
 * Exported so that a client and a test produce the string the same way rather
 * than each writing it out and drifting.
 *
 * `audience` is the origin the signature is for, and the server supplies its
 * own rather than reading one out of the request -- an audience a caller can
 * choose binds nothing. Without it the deployments of this project all accept
 * each other's headers: a signature harvested from a preview build verified
 * against production for the length of its window, at the same path, because
 * nothing in the sentence said which server it was addressed to.
 *
 * `path` carries the query string as well as the pathname. Only the pathname
 * used to be signed, so every parameter after the `?` was a term the request
 * could change and the signature did not cover.
 *
 * The request body is still not covered. Binding it means every route must hand
 * the bytes it is going to parse to this function, and today some read the body
 * before authenticating and some after -- a change to the calling convention
 * rather than to a message format. It also needs one canonicalization rule
 * shared with the durable decision record, which has to bind the same digest;
 * two independent rules for hashing the same body is how a signature comes to
 * verify in one place and not the other. So it belongs with that work, not
 * beside it. Until then: audience, method, full path, nonce and timestamp,
 * single use enforced durably.
 */
export function executionAuthMessage(input: {
  wallet: string;
  audience: string;
  method: string;
  path: string;
  nonce: string;
  timestamp: number | string;
}): string {
  return [
    "Veyra Execution Auth:",
    `Wallet: ${input.wallet.toLowerCase()}`,
    `Audience: ${input.audience}`,
    `Method: ${input.method.toUpperCase()}`,
    `Path: ${input.path}`,
    `Nonce: ${input.nonce}`,
    `Timestamp: ${input.timestamp}`,
  ].join("\n");
}

/**
 * The origin this deployment is serving the request on.
 *
 * Taken from the request rather than from configuration, and then required to
 * be one this deployment recognises. Both halves matter. Configuration would be
 * the obvious source and is the wrong one: an audience nobody set is an
 * authentication path that refuses every caller, and this repository has
 * already had that outage once, for the BYOA origin check. The request is the
 * right source because on a routed platform the host is the routing key -- a
 * header addressed to the preview host reaches the preview, not production --
 * and the allowlist is what closes the case where it is not routed, a local or
 * self-hosted server where Host is whatever the caller typed.
 *
 * The recognised set costs no configuration on Vercel: it already contains the
 * project's production host, this deployment's host and the branch host, none
 * of which a third party can publish.
 */
export function executionAuthAudience(req: Request): string {
  let origin: string;
  try {
    origin = new URL(req.url).origin;
  } catch {
    throw new ExecutionError(
      "This request has no resolvable origin to authenticate against.",
      "AUTH_AUDIENCE_UNKNOWN",
      401,
    );
  }
  const recognised = originSet();
  if (!recognised.has(origin)) {
    throw new ExecutionError(
      `Signed-header authentication is not served on ${origin}.`,
      "AUTH_AUDIENCE_UNKNOWN",
      401,
    );
  }
  return origin;
}

/**
 * Authenticates the caller for execution and mandate management routes.
 * Never trusts a client-supplied wallet string without cryptographic or session proof.
 */
export async function authenticateExecutionCaller(req: Request): Promise<AuthenticatedCaller> {
  const now = Date.now();

  // 1. Check explicit test mode authorization
  if (
    process.env.NODE_ENV === "test" &&
    process.env.EXECUTION_ALLOW_TEST_AUTH === "true"
  ) {
    const testWallet = req.headers.get("x-test-wallet");
    if (testWallet && isAddress(testWallet)) {
      return {
        wallet: getAddress(testWallet),
        source: "test_auth",
      };
    }
  }

  // 2. Check Cookie session (BYOA owner session)
  const cookieHeader = req.headers.get("cookie");
  if (cookieHeader) {
    const cookies = cookieHeader.split(";").map((c) => c.trim().split("="));
    const sessionCookie = cookies.find(([name]) => name === BYOA_OWNER_SESSION_COOKIE);
    if (sessionCookie && sessionCookie[1]) {
      const session = verifyOwnerSession(decodeURIComponent(sessionCookie[1]));
      if (session && isAddress(session.wallet)) {
        return {
          wallet: getAddress(session.wallet),
          source: "session_cookie",
        };
      }
    }
  }

  // 3. Check Authorization Bearer token
  const authHeader = req.headers.get("authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    const session = verifyOwnerSession(token);
    if (session && isAddress(session.wallet)) {
      return {
        wallet: getAddress(session.wallet),
        source: "bearer_session",
      };
    }
  }

  // 4. Check Replay-Hardened Cryptographic Signed Header Challenge
  const walletHeader = req.headers.get("x-wallet-address");
  const signatureHeader = req.headers.get("x-wallet-signature");
  const timestampHeader = req.headers.get("x-wallet-timestamp");
  const nonceHeader = req.headers.get("x-wallet-nonce");

  if (walletHeader && signatureHeader && timestampHeader && isAddress(walletHeader)) {
    const ts = Number(timestampHeader);
    // Strict 1-minute expiration window for signed headers
    if (!Number.isFinite(ts) || Math.abs(now - ts) > SIGNED_HEADER_WINDOW_MS) {
      throw new ExecutionError(
        "Authentication signature expired or timestamp invalid. Must be within 60 seconds.",
        "SIGNATURE_EXPIRED",
        401
      );
    }

    const url = new URL(req.url);
    const method = req.method.toUpperCase();
    /* Query included. A parameter after the `?` is as much a part of what is
       being asked for as the pathname, and it used to be unsigned. */
    const pathname = `${url.pathname}${url.search}`;
    const audience = executionAuthAudience(req);
    const normWallet = getAddress(walletHeader);
    /* A caller who sends no nonce gets one derived from what they did sign, so
       the header stays optional without the message losing a term. It is a
       weaker choice -- one request per wallet per millisecond -- but it is not
       an unbound one. */
    const nonce = nonceHeader || `${walletHeader.toLowerCase()}_${ts}`;

    const valid = await verifyMessage({
      address: normWallet,
      message: executionAuthMessage({
        wallet: walletHeader, audience, method, path: pathname, nonce, timestamp: ts,
      }),
      signature: signatureHeader as `0x${string}`,
    }).catch(() => false);

    if (!valid) {
      /* Said out loud rather than falling through to "authentication required".
         A caller holding a key and getting the message format wrong should not
         spend an afternoon reading it as a missing header. */
      throw new ExecutionError(
        "Authentication signature does not match the request. Sign the exact message naming wallet, audience, method, path (with query), nonce and timestamp.",
        "AUTH_SIGNATURE_INVALID",
        401
      );
    }

    /* Only now. Consuming before verifying meant anyone could burn any nonce
       with a signature that was not even valid -- the legitimate holder loses
       their request, the attacker spends nothing, and nothing in the logs says
       a signature was ever checked. */
    const claim = await claimAuthNonce({ wallet: normWallet, nonce, method, path: pathname });
    if (claim === "replayed") {
      throw new ExecutionError(
        "Authentication challenge replay detected: nonce has already been consumed.",
        "AUTH_REPLAY_DETECTED",
        401
      );
    }
    if (claim === "unavailable") {
      /* The signature is good and the request may well be honest. It is still
         refused, because the only thing that makes a good signature safe to act
         on twice is knowing it has not been acted on already, and right now
         that cannot be known. Retryable, and it says so. */
      throw new ExecutionError(
        "Replay protection is unavailable, so this signed request cannot be accepted. Retry shortly.",
        "AUTH_REPLAY_STORE_UNAVAILABLE",
        503
      );
    }

    return {
      wallet: normWallet,
      source: "signed_header",
    };
  }

  throw new ExecutionError(
    "Authentication required. Provide a valid owner session cookie, bearer token, or signed wallet header.",
    "AUTHENTICATION_REQUIRED",
    401
  );
}

/**
 * Asserts that the authenticated caller owns or is authorized for the given mandate.
 * Returns 404 on cross-wallet mismatch to prevent information enumeration.
 */
export function assertMandateAccess(
  caller: AuthenticatedCaller,
  mandateOrOwner: { ownerWallet: string; subjectWallet?: string } | string,
  subjectWallet?: string
): void {
  const callerAddress = caller.wallet.toLowerCase();
  let ownerAddress: string;
  let subjectAddress: string | undefined;

  if (typeof mandateOrOwner === "string") {
    ownerAddress = mandateOrOwner.toLowerCase();
    subjectAddress = subjectWallet?.toLowerCase();
  } else {
    ownerAddress = mandateOrOwner.ownerWallet.toLowerCase();
    subjectAddress = mandateOrOwner.subjectWallet?.toLowerCase();
  }

  if (callerAddress !== ownerAddress && (!subjectAddress || callerAddress !== subjectAddress)) {
    throw new ExecutionError(
      "Mandate not found or access unauthorized",
      "MANDATE_NOT_FOUND",
      404
    );
  }
}
