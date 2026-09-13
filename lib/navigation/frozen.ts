/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

/** Surfaces frozen behind the developer console. Declared once so the
 *  middleware that enforces it and the tests that check the navigation cannot
 *  drift apart — a product nav entry pointing at one of these would send the
 *  shell's own visitors to a console they never asked for. */
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
  "/demo",
  "/workflow-receipts",
] as const;
