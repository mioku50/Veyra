/**
 * Copyright 2026 Circle Internet Group, Inc. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { BRAND } from "../brand.ts";
import type {
  NumericMetric,
  HostedWorkflowArcProofItem,
  HostedWorkflowReceiptItem,
} from "./api-quality-report.ts";
import type { TreasuryAnalytics } from "../providers/treasury-health-types.ts";
import { calculateTreasuryHealthScore } from "../providers/treasury-health.ts";
import type { ConfidenceLevel } from "../providers/api-quality-types.ts";
import type { ArcUsdcBlocklistStatus } from "../wallet/arc-usdc.ts";

export interface TreasuryHealthRiskItem {
  code: string;
  title: string;
  severity: "low" | "medium" | "high" | "critical";
  description: string;
  impact: string;
}

export interface TreasuryHealthPublicReport {
  reportId: string;
  workflow: string;
  workflowType: "treasury_health";
  status: string;
  targetWallet: string;
  generatedAt: string;

  // Section 1: Executive Summary
  executiveSummary: string;

  // Section 2: USDC Flow Overview
  usdcFlowOverview: {
    totalInboundUsdc: NumericMetric;
    totalOutboundUsdc: NumericMetric;
    netFlowUsdc: NumericMetric;
    transferCount: NumericMetric;
    uniqueCounterparties: NumericMetric;
    summary: string;
  };

  // Section 3: Period Comparison (7/30/90d)
  periodComparison: {
    periods: Array<{
      windowDays: number;
      inboundUsdc: number;
      outboundUsdc: number;
      netFlowUsdc: number;
      transferCount: number;
      avgDailyBurnUsdc: number;
    }>;
    summary: string;
  };

  // Section 4: AI Agent Expenses
  agentExpenses: {
    identifiedAgentPayments: number;
    totalAgentSpendUsdc: NumericMetric;
    agentRecipients: Array<{ address: string; totalUsdc: number; txCount: number }>;
    summary: string;
  };

  // Section 5: Payment Distribution by Recipient
  paymentDistribution: {
    topRecipients: Array<{
      address: string;
      totalUsdc: number;
      percentage: number;
      txCount: number;
      arcUsdcBlocklistStatus: ArcUsdcBlocklistStatus;
    }>;
    otherRecipientsCount: number;
    otherRecipientsUsdc: number;
    summary: string;
  };

  // Section 6: Counterparty Concentration (HHI)
  counterpartyConcentration: {
    herfindahlIndex: NumericMetric;
    concentrationLevel: "low" | "moderate" | "high" | "critical";
    topCounterpartyShare: NumericMetric;
    summary: string;
  };

  // Section 7: Recurring Payments
  recurringPayments: {
    detected: Array<{
      counterparty: string;
      avgAmountUsdc: number;
      frequency: string;
      occurrences: number;
    }>;
    summary: string;
  };

  // Section 8: Burn Rate Analysis
  burnRateAnalysis: {
    currentDailyBurnUsdc: NumericMetric;
    previousDailyBurnUsdc: NumericMetric;
    burnRateChangePercent: NumericMetric;
    trendDirection: "increasing" | "stable" | "decreasing";
    summary: string;
  };

  // Section 9: Anomalous Transfers
  anomalousTransfers: {
    detected: Array<{
      txHash: string;
      amountUsdc: number;
      direction: "inbound" | "outbound";
      reason: string;
      timestamp: string;
    }>;
    summary: string;
  };

  // Section 10: Treasury Runway
  treasuryRunway: {
    currentBalanceUsdc: NumericMetric;
    estimatedRunwayDays: NumericMetric;
    burnRateBasis: string;
    summary: string;
  };

  // Section 11: Treasury Health Score
  treasuryHealthScore: {
    overallScore: number | null;
    confidence: ConfidenceLevel;
    breakdown: {
      liquidityScore: number | null;
      burnRateStabilityScore: number | null;
      counterpartyDiversificationScore: number | null;
      inflowOutflowBalanceScore: number | null;
      anomalyAbsenceScore: number | null;
      recurringPaymentRegularityScore: number | null;
    };
    summary: string;
  };

  // Section 12: Recommendations
  recommendations: string[];

  // Section 13: Risks and Review Items
  risksAndReviewItems: TreasuryHealthRiskItem[];

  // Section 14: Evidence and Data Window
  evidenceAndDataWindow: {
    dataSource: string;
    network: string;
    chainId: number;
    blocksScanned: number;
    firstTransferAt: string | null;
    lastTransferAt: string | null;
    dataTruncated: boolean;
    targetArcUsdcBlocklistStatus: ArcUsdcBlocklistStatus;
    blocklistCheckedAt: string | null;
    summary: string;
  };

  // Section 15: Payment & Arc Verification Details
  verification: {
    status: string;
    network: string;
    proofs: HostedWorkflowArcProofItem[];
    receipts: HostedWorkflowReceiptItem[];
    verifiedSteps: number;
    requiredSteps: number;
  };
}

export interface BuildTreasuryHealthPublicReportInput {
  reportId: string;
  targetWallet: string;
  analytics: TreasuryAnalytics;
  status?: string;
  generatedAt?: string;
  proofs?: HostedWorkflowArcProofItem[];
  receipts?: HostedWorkflowReceiptItem[];
}

export function buildTreasuryHealthPublicReport(
  input: BuildTreasuryHealthPublicReportInput
): TreasuryHealthPublicReport {
  const { analytics } = input;
  const score = calculateTreasuryHealthScore(analytics);
  const confidence = score.confidence;

  const proofs = input.proofs || [];
  const receipts = input.receipts || [];
  const verifiedProofs = proofs.filter((p) => p.status === "verified" && Boolean(p.txHash));
  const hasFailedProof = proofs.some((p) => p.status === "failed");
  const requiredSteps = receipts.length > 0 ? receipts.length : Math.max(proofs.length, 1);
  const verifiedSteps = verifiedProofs.length;

  let verificationStatus: string;
  if (hasFailedProof || (input.status === "failed" && verifiedSteps === 0)) {
    verificationStatus = "verification_failed";
  } else if (verifiedSteps > 0 && verifiedSteps >= requiredSteps) {
    verificationStatus = "verified";
  } else if (verifiedSteps > 0 && verifiedSteps < requiredSteps) {
    verificationStatus = "partially_verified";
  } else {
    verificationStatus = "verification_pending";
  }

  const recommendations = [];
  const risksAndReviewItems: TreasuryHealthRiskItem[] = [];
  
  if (score.overallScore !== null && score.overallScore < 50) {
    recommendations.push("Consider reducing burn rate or securing additional funding immediately.");
  }
  if (analytics.concentrationLevel === "critical") {
    risksAndReviewItems.push({
      code: "high_concentration",
      title: "Critical Counterparty Concentration",
      severity: "critical",
      description: "A large percentage of outbound funds goes to a single counterparty.",
      impact: "Dependency risk if this counterparty is compromised."
    });
  }
  if (analytics.dataTruncated) {
    risksAndReviewItems.push({
      code: "data_truncated",
      title: "Data Truncated",
      severity: "medium",
      description: "Over 50,000 transfers found. Analysis is truncated to the most recent.",
      impact: "Long-term trends may not be fully represented."
    });
  }
  if (analytics.targetArcUsdcBlocklistStatus === "blocklisted") {
    risksAndReviewItems.push({
      code: "arc_usdc_target_blocklisted",
      title: "Treasury Wallet Is Blocklisted on Arc",
      severity: "critical",
      description: "The Arc USDC contract reports the analyzed treasury wallet as blocklisted.",
      impact: "USDC transfers involving this wallet are rejected by Arc protocol enforcement.",
    });
  }
  const blockedCounterparties = analytics.topRecipients.filter(
    (item) => item.arcUsdcBlocklistStatus === "blocklisted",
  );
  if (blockedCounterparties.length > 0) {
    risksAndReviewItems.push({
      code: "arc_usdc_counterparty_blocklisted",
      title: "Top Counterparty Is Blocklisted on Arc",
      severity: "critical",
      description: `${blockedCounterparties.length} top outbound counterparty address(es) are currently blocklisted by the Arc USDC contract.`,
      impact: "Future transfers involving those addresses will be rejected onchain.",
    });
  }
  if (
    analytics.targetArcUsdcBlocklistStatus === "unknown" ||
    analytics.topRecipients.some((item) => item.arcUsdcBlocklistStatus === "unknown")
  ) {
    risksAndReviewItems.push({
      code: "arc_usdc_blocklist_status_unknown",
      title: "Arc Blocklist Status Could Not Be Fully Verified",
      severity: "medium",
      description: "At least one required onchain blocklist read was unavailable; no clear status was inferred.",
      impact: "Recheck the affected addresses immediately before relying on this report for a payment decision.",
    });
  }

  return {
    reportId: input.reportId,
    workflow: "treasury_health",
    workflowType: "treasury_health",
    status: input.status || "completed",
    targetWallet: input.targetWallet,
    generatedAt: input.generatedAt || "unknown",

    executiveSummary: `Treasury Health analysis for wallet ${input.targetWallet}. Score: ${score.overallScore ?? "N/A"}/100.`,

    usdcFlowOverview: {
      totalInboundUsdc: { value: analytics.totalInboundUsdc, confidence },
      totalOutboundUsdc: { value: analytics.totalOutboundUsdc, confidence },
      netFlowUsdc: { value: analytics.netFlowUsdc, confidence },
      transferCount: { value: analytics.transferCount, confidence },
      uniqueCounterparties: { value: analytics.uniqueCounterparties, confidence },
      summary: `Total inbound: ${analytics.totalInboundUsdc} USDC. Total outbound: ${analytics.totalOutboundUsdc} USDC.`
    },

    periodComparison: {
      periods: analytics.periods,
      summary: "Comparison of 7, 30, and 90 day windows."
    },

    agentExpenses: {
      identifiedAgentPayments: analytics.identifiedAgentPayments,
      totalAgentSpendUsdc: { value: analytics.totalAgentSpendUsdc, confidence },
      agentRecipients: analytics.agentRecipients,
      summary: "Analysis of spending towards known AI agents."
    },

    paymentDistribution: {
      topRecipients: analytics.topRecipients,
      otherRecipientsCount: analytics.otherRecipientsCount,
      otherRecipientsUsdc: analytics.otherRecipientsUsdc,
      summary: "Distribution of outbound payments."
    },

    counterpartyConcentration: {
      herfindahlIndex: { value: analytics.herfindahlIndex, confidence },
      concentrationLevel: analytics.concentrationLevel,
      topCounterpartyShare: { value: analytics.topCounterpartyShare, confidence },
      summary: `HHI index is ${analytics.herfindahlIndex.toFixed(2)} (${analytics.concentrationLevel} concentration).`
    },

    recurringPayments: {
      detected: analytics.recurringPayments,
      summary: `Detected ${analytics.recurringPayments.length} recurring payment flows.`
    },

    burnRateAnalysis: {
      currentDailyBurnUsdc: { value: analytics.currentDailyBurnUsdc, confidence },
      previousDailyBurnUsdc: { value: analytics.previousDailyBurnUsdc, confidence },
      burnRateChangePercent: { value: analytics.burnRateChangePercent, confidence },
      trendDirection: analytics.trendDirection,
      summary: `Burn rate is ${analytics.trendDirection}.`
    },

    anomalousTransfers: {
      detected: analytics.anomalousTransfers,
      summary: `Detected ${analytics.anomalousTransfers.length} anomalous transfers.`
    },

    treasuryRunway: {
      currentBalanceUsdc: { value: analytics.currentBalanceUsdc, confidence },
      estimatedRunwayDays: { value: analytics.estimatedRunwayDays, confidence },
      burnRateBasis: "30-day average",
      summary: `Estimated runway: ${analytics.estimatedRunwayDays.toFixed(1)} days.`
    },

    treasuryHealthScore: {
      overallScore: score.overallScore,
      confidence: score.confidence,
      breakdown: score.breakdown,
      summary: `Treasury Health Score: ${score.overallScore ?? "N/A"}/100`
    },

    recommendations,
    risksAndReviewItems,

    evidenceAndDataWindow: {
      dataSource: analytics.dataSource,
      network: "Arc Testnet",
      chainId: 5042002,
      blocksScanned: analytics.blocksScanned,
      firstTransferAt: analytics.firstTransferAt,
      lastTransferAt: analytics.lastTransferAt,
      dataTruncated: analytics.dataTruncated,
      targetArcUsdcBlocklistStatus: analytics.targetArcUsdcBlocklistStatus,
      blocklistCheckedAt: analytics.blocklistCheckedAt,
      summary: `Observed the last ${analytics.observationWindowDays} days across ${analytics.blocksScanned} blocks. Truncated: ${analytics.dataTruncated}.`
    },

    verification: {
      status: verificationStatus,
      network: "arc-testnet",
      proofs,
      receipts,
      verifiedSteps,
      requiredSteps,
    }
  };
}

export function formatTreasuryHealthReportAsMarkdown(
  report: TreasuryHealthPublicReport
): string {
  const proofsList =
    report.verification.proofs.length > 0
      ? report.verification.proofs
          .map(
            (p) =>
              `- ${p.txHash ? `\`${p.txHash}\`` : p.receiptId ? `Receipt \`${p.receiptId}\`` : "Proof record"} (${p.status})${p.explorerUrl ? ` — [View Arc Proof](${p.explorerUrl})` : ""}`
          )
          .join("\n")
      : "- No on-chain proof metadata recorded.";

  return `# Treasury Health Report: ${report.targetWallet}

**Report ID:** \`${report.reportId}\`  
**Workflow:** \`${report.workflow}\`  
**Status:** \`${report.status}\`  
**Generated At:** ${report.generatedAt}  
**Generated by:** ${BRAND.name}

---

## Executive Summary
${report.executiveSummary}

## USDC Flow Overview
${report.usdcFlowOverview.summary}

## Period Comparison
${report.periodComparison.summary}

## AI Agent Expenses
${report.agentExpenses.summary}

## Payment Distribution
${report.paymentDistribution.summary}

## Counterparty Concentration
${report.counterpartyConcentration.summary}

## Recurring Payments
${report.recurringPayments.summary}

## Burn Rate Analysis
${report.burnRateAnalysis.summary}

## Anomalous Transfers
${report.anomalousTransfers.summary}

## Treasury Runway
${report.treasuryRunway.summary}

## Treasury Health Score
${report.treasuryHealthScore.summary}

## Recommendations
${report.recommendations.map(r => `- ${r}`).join("\n") || "- None"}

## Identified Risks & Review Items
${report.risksAndReviewItems.map(r => `- **[${r.severity.toUpperCase()}]** ${r.title} (\`${r.code}\`)\n  ${r.description}\n  *Impact:* ${r.impact}`).join("\n") || "- None"}

## Evidence & Data Window
${report.evidenceAndDataWindow.summary}

---

## Payment & Arc Verification Details
- **Verification Status:** \`${report.verification.status}\`
- **Network:** \`${report.verification.network}\`

${proofsList}
`;
}
