/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const COOKIE_NAME = "seller_session";
export const EXPIRY_MS = 8 * 60 * 60 * 1000; // 8 hours

function getSecret(): string | null {
  const secret = process.env.SELLER_SESSION_SECRET?.trim() || "";
  if (!secret || secret.length < 32) return null;
  return secret;
}

export function getSellerSessionSecret(): string {
  const secret = getSecret();
  if (!secret) {
    throw new Error("SELLER_SESSION_SECRET must be configured and at least 32 characters long.");
  }
  return secret;
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

function getCookieValue(cookieHeader: string | null, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  const cookies = cookieHeader.split(";");
  for (const c of cookies) {
    const [k, ...v] = c.split("=");
    if (k?.trim() === name) {
      return v.join("=").trim();
    }
  }
  return undefined;
}

export function issueSellerSession(): string {
  const secret = getSellerSessionSecret();
  const now = Date.now();
  const exp = now + EXPIRY_MS;
  const payloadStr = JSON.stringify({
    sub: "seller",
    version: 1,
    iat: now,
    exp,
    jti: randomBytes(16).toString("hex"),
  });
  const base64Payload = Buffer.from(payloadStr, "utf8").toString("base64url");
  const hmacHex = sign(base64Payload, secret);
  return `${base64Payload}.${hmacHex}`;
}

export function verifySellerSession(cookieValue: string | undefined): boolean {
  if (!cookieValue || typeof cookieValue !== "string") return false;
  const secret = getSecret();
  if (!secret) return false;

  const parts = cookieValue.split(".");
  if (parts.length !== 2) return false;
  const [base64Payload, hmacHex] = parts;
  if (!base64Payload || !hmacHex) return false;

  const expectedHmac = sign(base64Payload, secret);
  const expectedBuf = Buffer.from(expectedHmac, "hex");
  const actualBuf = Buffer.from(hmacHex, "hex");
  if (expectedBuf.length !== actualBuf.length) return false;
  if (!timingSafeEqual(expectedBuf, actualBuf)) return false;

  try {
    const jsonStr = Buffer.from(base64Payload, "base64url").toString("utf8");
    const payload = JSON.parse(jsonStr);
    if (
      !payload ||
      payload.sub !== "seller" ||
      payload.version !== 1 ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number" ||
      typeof payload.jti !== "string" ||
      !/^[a-f0-9]{32}$/.test(payload.jti)
    ) return false;
    const now = Date.now();
    if (payload.iat > now + 60_000 || payload.exp <= now || payload.exp - payload.iat !== EXPIRY_MS) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export const sellerSessionCookieOptions = {
  httpOnly: true,
  sameSite: "strict" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: EXPIRY_MS / 1000,
};

export function requireSellerAuth(request: Request): Response | null {
  const cookieHeader = request.headers.get("cookie");
  const cookieValue = getCookieValue(cookieHeader, COOKIE_NAME);
  if (!cookieValue) {
    return new Response(JSON.stringify({ error: "Authentication required" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  if (!verifySellerSession(cookieValue)) {
    return new Response(JSON.stringify({ error: "Invalid or expired session" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }
  return null;
}
