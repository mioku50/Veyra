/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { getAddress, isAddress, verifyMessage, type Address } from "viem";
import { BYOA_OWNER_SESSION_COOKIE, verifyOwnerSession } from "../byoa/auth.ts";
import { ExecutionError } from "./executor.ts";

export interface AuthenticatedCaller {
  wallet: Address;
  source: "session_cookie" | "bearer_session" | "signed_header" | "test_auth";
}

/**
 * Authenticates the caller for execution and mandate management routes.
 * Never trusts a client-supplied wallet string without cryptographic or session proof.
 */
export async function authenticateExecutionCaller(req: Request): Promise<AuthenticatedCaller> {
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

  // 4. Check Cryptographic Signed Header Challenge
  const walletHeader = req.headers.get("x-wallet-address");
  const signatureHeader = req.headers.get("x-wallet-signature");
  const timestampHeader = req.headers.get("x-wallet-timestamp");

  if (walletHeader && signatureHeader && timestampHeader && isAddress(walletHeader)) {
    const ts = Number(timestampHeader);
    const now = Date.now();
    // 5-minute replay window
    if (Number.isFinite(ts) && Math.abs(now - ts) < 300_000) {
      const message = `Veyra Execution Authentication: ${walletHeader.toLowerCase()}:${ts}`;
      try {
        const valid = await verifyMessage({
          address: getAddress(walletHeader),
          message,
          signature: signatureHeader as `0x${string}`,
        });
        if (valid) {
          return {
            wallet: getAddress(walletHeader),
            source: "signed_header",
          };
        }
      } catch {
        // Invalid signature
      }
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
 * Returns 404 (not 403) on mismatch to prevent cross-wallet enumeration.
 */
export function assertMandateAccess(
  caller: AuthenticatedCaller,
  mandateOwner: string,
  mandateSubject?: string
): void {
  const callerWallet = caller.wallet.toLowerCase();
  const isOwner = mandateOwner.toLowerCase() === callerWallet;
  const isSubject = mandateSubject ? mandateSubject.toLowerCase() === callerWallet : false;

  if (!isOwner && !isSubject) {
    // Cross-wallet protection: return 404
    throw new ExecutionError("Mandate not found", "MANDATE_NOT_FOUND", 404);
  }
}
