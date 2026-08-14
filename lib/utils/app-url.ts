/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Resolves the canonical public application URL.
 * Priority:
 * 1. NEXT_PUBLIC_APP_URL environment variable
 * 2. VERCEL_PROJECT_PRODUCTION_URL (if on Vercel)
 * 3. VERCEL_URL (if on Vercel deployment)
 * 4. Fallback URL
 */
export function getCanonicalAppUrl(
  fallback: string = process.env.NEXT_PUBLIC_APP_URL || "https://agent-commerce-six.vercel.app",
): string {
  const envUrl =
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : undefined) ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined);

  return (envUrl || fallback).replace(/\/$/, "");
}
