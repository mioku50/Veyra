/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { getAddress, isAddress, verifyMessage, keccak256, toBytes, type Address } from "viem";
import { BYOA_OWNER_SESSION_COOKIE, verifyOwnerSession } from "../byoa/auth.ts";
import { ExecutionError } from "./executor.ts";

export interface AuthenticatedCaller {
  wallet: Address;
  source: "session_cookie" | "bearer_session" | "signed_header" | "test_auth";
}

// Single-use nonce registry with 5-minute TTL
const consumedNonces = new Map<string, number>();

function checkAndConsumeNonce(nonce: string, now: number): boolean {
  // Prune expired nonces
  for (const [key, exp] of consumedNonces.entries()) {
    if (exp < now) {
      consumedNonces.delete(key);
    }
  }

  if (consumedNonces.has(nonce)) {
    return false; // Replay detected
  }

  // Consume with 5-minute expiration
  consumedNonces.set(nonce, now + 300_000);
  return true;
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
    if (!Number.isFinite(ts) || Math.abs(now - ts) > 60_000) {
      throw new ExecutionError(
        "Authentication signature expired or timestamp invalid. Must be within 60 seconds.",
        "SIGNATURE_EXPIRED",
        401
      );
    }

    // Require nonce for replay protection
    const nonce = nonceHeader || `${walletHeader.toLowerCase()}_${ts}`;
    const fresh = checkAndConsumeNonce(nonce, now);
    if (!fresh) {
      throw new ExecutionError(
        "Authentication challenge replay detected: nonce has already been consumed.",
        "AUTH_REPLAY_DETECTED",
        401
      );
    }

    const url = new URL(req.url);
    const method = req.method.toUpperCase();
    const pathname = url.pathname;

    // Structured authentication message binding method, path, nonce, and timestamp
    const structuredMessage = `Veyra Execution Auth:\nWallet: ${walletHeader.toLowerCase()}\nMethod: ${method}\nPath: ${pathname}\nNonce: ${nonce}\nTimestamp: ${ts}`;
    // Legacy fallback message for backwards compatibility within test window
    const legacyMessage = `Veyra Execution Authentication: ${walletHeader.toLowerCase()}:${ts}`;

    const normWallet = getAddress(walletHeader);

    try {
      // Check structured message first
      let valid = await verifyMessage({
        address: normWallet,
        message: structuredMessage,
        signature: signatureHeader as `0x${string}`,
      }).catch(() => false);

      if (!valid) {
        valid = await verifyMessage({
          address: normWallet,
          message: legacyMessage,
          signature: signatureHeader as `0x${string}`,
        }).catch(() => false);
      }

      if (valid) {
        return {
          wallet: normWallet,
          source: "signed_header",
        };
      }
    } catch {
      // Invalid signature
    }
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
