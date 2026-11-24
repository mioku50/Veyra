/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import { isAddress, zeroAddress } from "viem";
import { ARC_MAINNET_NETWORK } from "../../wallet/arc.ts";

export type PreflightBlockingCode =
  | "endpoint_unreachable"
  | "no_402_response"
  | "challenge_unparseable"
  | "critical_failure"
  | "arc_mainnet_usdc_missing"
  | "over_budget"
  | "payto_differs_from_catalog"
  | "payto_differs_from_last_check";

export type PreflightNoteCode =
  | "missing_input_schema"
  | "missing_output_schema"
  | "provider_undocumented"
  | "price_changed"
  | "no_reputation_data";

export type PreflightSignal = {
  code: PreflightBlockingCode | PreflightNoteCode;
  detail: string;
  meta?: Record<string, string | number | null>;
};

export type VerdictPreflight = {
  result: "block" | "pass";
  blocking: PreflightSignal[];
  notes: PreflightSignal[];
};

export const PREFLIGHT_PASS_DISCLAIMER =
  "pass means no concrete blocking fact was observed — it is not an endorsement and does not confirm post-payment delivery.";

export type BuildPreflightInput = {
  probe: {
    reachable: boolean;
    respondedWith402: boolean;
    challengeParseable: boolean;
    criticalFailure: string | null;
    failedChecks: ReadonlyArray<string>;
  };
  network: string | null;
  livePayTo: string | null;
  priceUsdc: number | null;
  priceUnknown: boolean;
  budgetUsdc: number;
  catalogPayTo?: string | null;
  lastCheckPayTo?: string | null;
  lastCheckPriceUsdc?: number | null;
  lastObservationPayTo?: string | null;
  lastObservationPriceUsdc?: number | null;
  reasons: ReadonlyArray<string>;
  statisticalEvidenceAvailable: boolean;
};

function validNonZeroAddress(address: string | null | undefined): string | null {
  if (!address || !isAddress(address)) return null;
  const lower = address.toLowerCase();
  return lower === zeroAddress ? null : lower;
}

export function buildVerdictPreflight(input: BuildPreflightInput): VerdictPreflight {
  const blocking: PreflightSignal[] = [];
  const notes: PreflightSignal[] = [];

  if (!input.probe.reachable) {
    blocking.push({
      code: "endpoint_unreachable",
      detail: "Endpoint did not respond to the probe request.",
    });
  } else if (!input.probe.respondedWith402) {
    blocking.push({
      code: "no_402_response",
      detail: "Endpoint did not respond with HTTP 402 Payment Required.",
    });
  } else if (!input.probe.challengeParseable) {
    blocking.push({
      code: "challenge_unparseable",
      detail: "HTTP 402 challenge could not be parsed as a valid x402 offer.",
    });
  }

  if (input.probe.criticalFailure) {
    blocking.push({
      code: "critical_failure",
      detail: `Critical probe failure: ${input.probe.criticalFailure}.`,
      meta: { criticalFailure: input.probe.criticalFailure },
    });
  }

  const livePayTo = validNonZeroAddress(input.livePayTo);
  const hasArcMainnetUsdc =
    input.network?.toLowerCase() === ARC_MAINNET_NETWORK && livePayTo !== null;
  if (!hasArcMainnetUsdc) {
    blocking.push({
      code: "arc_mainnet_usdc_missing",
      detail: "No valid Arc mainnet (eip155:5042) USDC payment option is present.",
      meta: { network: input.network ?? null },
    });
  }

  if (!input.priceUnknown && input.priceUsdc !== null && input.priceUsdc > input.budgetUsdc) {
    blocking.push({
      code: "over_budget",
      detail: `Quoted price ${input.priceUsdc.toFixed(6)} USDC exceeds caller budget ${input.budgetUsdc.toFixed(6)} USDC.`,
      meta: { priceUsdc: input.priceUsdc, budgetUsdc: input.budgetUsdc },
    });
  }

  const catalogPayTo = validNonZeroAddress(input.catalogPayTo);
  if (catalogPayTo && livePayTo && livePayTo !== catalogPayTo) {
    blocking.push({
      code: "payto_differs_from_catalog",
      detail: `Live payee ${livePayTo} differs from catalogued payee ${catalogPayTo}.`,
      meta: { catalogPayTo, livePayTo },
    });
  }

  const lastCheckPayTo = validNonZeroAddress(input.lastCheckPayTo);
  const lastObservationPayTo = validNonZeroAddress(input.lastObservationPayTo);
  if (livePayTo && lastCheckPayTo && livePayTo !== lastCheckPayTo) {
    blocking.push({
      code: "payto_differs_from_last_check",
      detail: `Live payee ${livePayTo} differs from last saved check payee ${lastCheckPayTo}.`,
      meta: { previousPayTo: lastCheckPayTo, livePayTo, source: "arc_offer_checks" },
    });
  } else if (livePayTo && lastObservationPayTo && livePayTo !== lastObservationPayTo) {
    blocking.push({
      code: "payto_differs_from_last_check",
      detail: `Live payee ${livePayTo} differs from prior observed payee ${lastObservationPayTo}.`,
      meta: { previousPayTo: lastObservationPayTo, livePayTo, source: "x402_endpoint_observations" },
    });
  }

  if (input.probe.failedChecks.includes("declares_input_schema")) {
    notes.push({
      code: "missing_input_schema",
      detail: "Challenge and catalog do not declare an input schema.",
    });
  }
  if (input.probe.failedChecks.includes("declares_output_schema")) {
    notes.push({
      code: "missing_output_schema",
      detail: "Challenge and catalog do not declare an output schema.",
    });
  }
  if (input.probe.failedChecks.includes("provider_documented")) {
    notes.push({
      code: "provider_undocumented",
      detail: "No provider documentation URL is declared.",
    });
  }

  const previousPrice =
    input.lastCheckPriceUsdc !== null && input.lastCheckPriceUsdc !== undefined && input.lastCheckPriceUsdc > 0
      ? input.lastCheckPriceUsdc
      : input.lastObservationPriceUsdc !== null && input.lastObservationPriceUsdc !== undefined && input.lastObservationPriceUsdc > 0
        ? input.lastObservationPriceUsdc
        : null;
  if (!input.priceUnknown && input.priceUsdc !== null && previousPrice !== null
    && Math.abs(input.priceUsdc - previousPrice) > 1e-9) {
    notes.push({
      code: "price_changed",
      detail: `Price changed from ${previousPrice.toFixed(6)} USDC to ${input.priceUsdc.toFixed(6)} USDC since the last saved check.`,
      meta: {
        previousPriceUsdc: previousPrice,
        currentPriceUsdc: input.priceUsdc,
      },
    });
  }

  if (input.reasons.includes("NO_REPUTATION_DATA") || !input.statisticalEvidenceAvailable) {
    notes.push({
      code: "no_reputation_data",
      detail: "No historical Veyra reputation data is available for this counterparty.",
    });
  }

  return {
    result: blocking.length > 0 ? "block" : "pass",
    blocking,
    notes,
  };
}
