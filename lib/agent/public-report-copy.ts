/**
 * Copyright 2026 Circle Internet Group, Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

export function sanitizePublicReportText(value: string): string {
  if (!value) return "";
  return value
    .replace(/\bPhase\s+\d+(?:\.\d+)?\b[:\s-]*/gi, "")
    .replace(/\bFreeModel\b/gi, "AI provider")
    .replace(/\bproject-owned (?:hosted )?payer\b/gi, "payment wallet")
    .replace(/\bdownstream x402\b/gi, "verified data services")
    .replace(/\bdeterministic aggregation\b/gi, "structured analysis")
    .replace(/\s+/g, " ")
    .trim();
}

const MARKET_SYMBOL_PATTERN = /\b(BTC|ETH|SOL|LINK|UNI|AVAX|MATIC|ARB|OP)\/USD\b/i;
const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/** Shortens a 0x address to a scannable `0x1234…abcd` form. */
export function shortenAddress(value: string): string {
  const trimmed = value.trim();
  if (!EVM_ADDRESS_PATTERN.test(trimmed)) return trimmed;
  return `${trimmed.slice(0, 6)}…${trimmed.slice(-4)}`;
}

/** Extracts `owner/repository` from any GitHub URL or bare `owner/repo` string. */
export function repositoryFullName(value: string): string | null {
  const trimmed = value.trim();
  const urlMatch = trimmed.match(
    /github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:\.git)?(?:[/?#]|$)/i,
  );
  if (urlMatch?.[1]) return urlMatch[1];
  if (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(trimmed)) return trimmed;
  return null;
}

function endpointHost(value: string): string | null {
  try {
    return new URL(value.trim()).host || null;
  } catch {
    return null;
  }
}

function parseStructuredInput(preview: string): Record<string, unknown> | null {
  const trimmed = preview.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // Previews are truncated, so a structured input can legitimately fail to parse.
    return null;
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
}

function agentTrustSubject(input: Record<string, unknown>): string | null {
  const repositoryUrl = text(input.repositoryUrl);
  const repository = repositoryUrl ? repositoryFullName(repositoryUrl) : null;
  if (repository) return repository;

  const agentId = text(input.agentId);
  if (agentId) return agentId;

  const agentWallet = text(input.agentWallet);
  if (agentWallet) return shortenAddress(agentWallet);

  const serviceEndpoint = text(input.serviceEndpoint);
  const host = serviceEndpoint ? endpointHost(serviceEndpoint) : null;
  if (host) return host;

  const contractAddress = text(input.contractAddress);
  return contractAddress ? shortenAddress(contractAddress) : null;
}

function paidApiQualitySubject(input: Record<string, unknown>): string | null {
  const services = [
    ...stringList(input.services),
    ...stringList(input.serviceIds),
    ...(text(input.serviceId) ? [text(input.serviceId) as string] : []),
  ];
  if (services.length === 0) return null;
  return services.length === 1
    ? services[0]
    : `${services[0]} +${services.length - 1} more`;
}

function project360Subject(input: Record<string, unknown>): string | null {
  const modules = stringList(input.modules).length;
  const sources = Array.isArray(input.sources) ? input.sources.length : 0;
  if (modules === 0 && sources === 0) return null;
  const parts: string[] = [];
  if (modules > 0) parts.push(`${modules} module${modules === 1 ? "" : "s"}`);
  if (sources > 0) parts.push(`${sources} source${sources === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

export type PublicReportSubjectInput = {
  workflowType: string;
  workflowLabel: string;
  inputPreview: string;
  summary?: string;
};

/**
 * Derives a human-readable subject for a completed report card.
 *
 * Several workflows encode their input as JSON, so the stored preview is a raw
 * object. Rendering it verbatim leaks internal shapes onto public surfaces, so
 * each workflow maps to the identifier a reader actually recognizes and any
 * unrecognized or still-structured value falls back to the workflow label.
 */
export function publicReportSubject(report: PublicReportSubjectInput): string {
  const preview = report.inputPreview?.trim() ?? "";
  const structured = parseStructuredInput(preview);

  if (structured) {
    const subject =
      report.workflowType === "agent_trust_report"
        ? agentTrustSubject(structured)
        : report.workflowType === "paid_api_quality"
          ? paidApiQualitySubject(structured)
          : report.workflowType === "project_360"
            ? project360Subject(structured)
            : report.workflowType === "treasury_health"
              ? (text(structured.walletAddress) ?? text(structured.wallet))
              : null;
    if (subject) {
      return report.workflowType === "treasury_health"
        ? shortenAddress(subject)
        : sanitizePublicReportText(subject);
    }
    return report.workflowLabel;
  }

  if (report.workflowType === "github_due_diligence") {
    const repository = repositoryFullName(preview);
    if (repository) return repository;
  }

  if (report.workflowType === "market_context") {
    const symbol = `${preview} ${report.summary ?? ""}`.match(MARKET_SYMBOL_PATTERN);
    if (symbol) return `${symbol[0].toUpperCase()} Market Context`;
  }

  if (report.workflowType === "treasury_health" && EVM_ADDRESS_PATTERN.test(preview)) {
    return shortenAddress(preview);
  }

  const cleaned = sanitizePublicReportText(preview);
  // A truncated JSON preview never parses, so guard the raw-object case too.
  return cleaned && !cleaned.startsWith("{") && !cleaned.startsWith("[")
    ? cleaned
    : report.workflowLabel;
}
