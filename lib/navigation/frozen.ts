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

  /* The second wave, frozen when the front door became the personal agent.
     These are real surfaces an operator still needs, and none of them is a
     destination for someone who has just created an agent:

       the local CLI agent's setup and funding screens -- developer tooling
       the standalone alerts list -- monitoring is already here
       /developer-tools -- the console has its own copy
       the evaluator internals
       the trust gate, the counterparty picker and the mandate editor, which
       are stages of one decision rather than places to go

     Note what is NOT here: /trust stays public, because /trust/<id> is a
     shareable evidence profile with its own preview image, and freezing the
     prefix would take that with it. Only the exact sub-paths are listed. */
  "/agent-launch",
  "/agent-setup",
  "/alerts",
  "/developer-tools",
  "/evaluators",
  "/trust-gate",
  "/trust/select",
  "/trust/mandates",
] as const;
