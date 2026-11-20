/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

/** Legacy tools limited to operators except in explicitly public Labs environments. */
export const FROZEN_LABS_PREFIXES = [
  "/store",
  "/workflows",
  "/runs",
  "/results",
  "/proofs",
  "/evaluations",
  "/agent-runner",
  "/project-360",
  "/monitoring",
  "/my-agents",
  "/agent-control",
  "/seller",

  "/agent-launch",
  "/agent-setup",
  "/alerts",
  "/evaluators",
  "/trust-gate",
  "/trust/select",
  "/trust/mandates",
] as const;

export function isFrozenLabsPath(pathname: string): boolean {
  return FROZEN_LABS_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export function isOperatorPath(pathname: string): boolean {
  return ["/console", "/dashboard", "/seller"].some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export function operatorLoginDestination(next: string | null): string {
  if (!next?.startsWith("/") || next.startsWith("//") || /[\\\s]/.test(next)) {
    return "/dashboard";
  }

  const target = new URL(next, "https://veyra.invalid");
  if (!isOperatorPath(target.pathname) && !isFrozenLabsPath(target.pathname)) {
    return "/dashboard";
  }

  return target.pathname + target.search;
}
