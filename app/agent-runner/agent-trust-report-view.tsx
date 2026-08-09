"use client";

import Link from "next/link";
import {
  BadgeCheck,
  Check,
  Download,
  ExternalLink,
  HelpCircle,
  Radar,
  ShieldAlert,
  Share2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatAgentTrustReportAsMarkdown } from "@/lib/agent-trust/markdown";
import type {
  AgentTrustReport,
  ScoreCategory,
} from "@/lib/agent-trust/types";

const CATEGORY_LABELS = {
  codeHealth: "Code Health",
  agentIdentity: "Agent Identity",
  executionReliability: "Execution Reliability",
  paymentHistory: "Payment History",
  serviceReliability: "Service Reliability",
  contractTransparency: "Contract Transparency",
} as const;

function scoreTone(score: number | null) {
  if (score === null) return "border-muted bg-muted/20";
  if (score >= 75) return "border-emerald-500/30 bg-emerald-500/5";
  if (score >= 50) return "border-amber-500/30 bg-amber-500/5";
  return "border-red-500/30 bg-red-500/5";
}

function categoryCard(
  key: keyof typeof CATEGORY_LABELS,
  category: ScoreCategory | undefined,
) {
  return (
    <div key={key} className={`rounded-md border p-4 ${scoreTone(category?.score ?? null)}`}>
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {CATEGORY_LABELS[key]}
      </p>
      <div className="mt-2 flex items-end justify-between gap-3">
        <p className="text-2xl font-bold">
          {category?.score === null || !category ? "Not scored" : `${category.score}`}
        </p>
        {category ? (
          <div className="flex flex-wrap justify-end gap-1">
            <Badge variant="outline">{category.confidence} confidence</Badge>
            <Badge variant="secondary">{category.evidenceCount} evidence</Badge>
          </div>
        ) : (
          <Badge variant="secondary">Excluded</Badge>
        )}
      </div>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">
        {category?.summary ?? "This category was excluded because no reliable evidence was available."}
      </p>
    </div>
  );
}

function downloadReport(report: AgentTrustReport, format: "json" | "markdown") {
  const content =
    format === "json"
      ? `${JSON.stringify(report, null, 2)}\n`
      : formatAgentTrustReportAsMarkdown(report);
  const blob = new Blob([content], {
    type:
      format === "json"
        ? "application/json;charset=utf-8"
        : "text/markdown;charset=utf-8",
  });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = `veyra-agent-trust-${report.reportId}.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(href);
}

function availabilityLabel(value: string) {
  return value.replaceAll("_", " ");
}

export function AgentTrustReportView({
  report,
  copied,
  onShare,
  receiptUrl,
}: {
  report: AgentTrustReport;
  copied: boolean;
  onShare: () => void;
  receiptUrl: string;
}) {
  const score = report.trustScore;
  const scoreEntries = Object.entries(CATEGORY_LABELS) as Array<
    [keyof typeof CATEGORY_LABELS, string]
  >;
  const monitoringQuery = new URLSearchParams(
    Object.entries({
      agentId: report.input.agentId,
      agentWallet: report.input.agentWallet,
      repositoryUrl: report.input.repositoryUrl,
      contractAddress: report.input.contractAddress,
      serviceEndpoint: report.input.serviceEndpoint,
    }).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );

  return (
    <Card className="rounded-lg">
      <CardContent className="grid gap-7 p-5 sm:p-7">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b pb-6">
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Badge variant="secondary">Veyra flagship workflow</Badge>
              {report.verification.verifiedOnArc ? (
                <Badge className="gap-1 border border-emerald-500/30 bg-emerald-500/10 text-emerald-500">
                  <BadgeCheck className="size-3.5" />
                  Verified on Arc
                </Badge>
              ) : (
                <Badge variant="outline">
                  {report.verification.status === "verification_failed"
                    ? "Arc verification failed"
                    : "Arc verification pending"}
                </Badge>
              )}
            </div>
            <h2 className="text-2xl font-bold">Veyra Agent Trust Report</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {report.subject.name}
            </p>
            <div className="mt-3 flex max-w-3xl flex-wrap gap-2">
              {report.subject.agentId ? <Badge variant="outline" className="font-mono">{report.subject.agentId}</Badge> : null}
              {report.subject.wallet ? <Badge variant="outline" className="max-w-full break-all font-mono">{report.subject.wallet}</Badge> : null}
              {report.subject.repository ? <Badge variant="outline" className="font-mono">{report.subject.repository.fullName}</Badge> : null}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={`/monitoring?${monitoringQuery.toString()}`}>
                <Radar className="size-4" />
                Monitor
              </Link>
            </Button>
            <Button variant="outline" size="sm" onClick={onShare}>
              {copied ? <Check className="size-4 text-emerald-500" /> : <Share2 className="size-4" />}
              {copied ? "Copied!" : "Share"}
            </Button>
            <Button variant="outline" size="sm" onClick={() => downloadReport(report, "json")}>
              <Download className="size-4" /> JSON
            </Button>
            <Button variant="outline" size="sm" onClick={() => downloadReport(report, "markdown")}>
              <Download className="size-4" /> Markdown
            </Button>
          </div>
        </div>

        <div className={`rounded-lg border p-5 ${scoreTone(score.overall)}`}>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Trust Score
          </p>
          <div className="mt-2 flex flex-wrap items-end gap-3">
            <p className="text-5xl font-bold">
              {score.overall === null ? "Limited data" : score.overall}
            </p>
            {score.overall !== null ? <span className="pb-1 text-muted-foreground">/ 100</span> : null}
            <Badge variant="outline" className="mb-1">
              {availabilityLabel(score.status)}
            </Badge>
          </div>
          <div className="mt-4 grid gap-2 text-sm leading-6">
            {report.executiveSummary.map((line) => <p key={line}>{line}</p>)}
          </div>
        </div>

        <section>
          <h3 className="text-sm font-semibold">Score breakdown</h3>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {scoreEntries.map(([key]) => categoryCard(key, score.categories[key]))}
          </div>
          {score.excludedCategories.length ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Excluded from the weighted score: {score.excludedCategories.join(", ")}.
            </p>
          ) : null}
        </section>

        <section className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-md border p-4">
            <h3 className="font-semibold">Agent identity</h3>
            <dl className="mt-3 grid gap-2 text-sm">
              <div><dt className="text-muted-foreground">Registry</dt><dd>{availabilityLabel(report.identity.status)}</dd></div>
              <div><dt className="text-muted-foreground">Agent ID</dt><dd className="break-all font-mono">{report.identity.publicAgentId ?? "Not available"}</dd></div>
              <div><dt className="text-muted-foreground">Wallet</dt><dd className="break-all font-mono">{report.identity.registeredWallet ?? "Not available"}</dd></div>
              <div><dt className="text-muted-foreground">Status</dt><dd>{availabilityLabel(report.identity.agentStatus)}</dd></div>
              <div><dt className="text-muted-foreground">Wallet verification</dt><dd>{report.identity.ownerVerified === null ? "Unavailable" : report.identity.ownerVerified ? "Verified" : "Not verified"}</dd></div>
              <div><dt className="text-muted-foreground">Agent Passport</dt><dd>{report.identity.passportPresent ? "Present" : "Not found"}</dd></div>
              <div><dt className="text-muted-foreground">Policy</dt><dd>{report.identity.policy ? `${report.identity.policy.status} · max ${report.identity.policy.maxPricePerRunUsdc ?? "n/a"} USDC/run` : "Unavailable"}</dd></div>
              <div><dt className="text-muted-foreground">Arc USDC blocklist</dt><dd>{availabilityLabel(report.arcCompliance?.status ?? "not_provided")}</dd></div>
            </dl>
          </div>
          <div className="rounded-md border p-4">
            <h3 className="font-semibold">Code & project intelligence</h3>
            <p className="mt-3 text-sm text-muted-foreground">
              {report.codeIntelligence.repository?.fullName ?? availabilityLabel(report.codeIntelligence.status)}
            </p>
            {report.codeIntelligence.repository ? (
              <a
                href={report.codeIntelligence.repository.canonicalUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
              >
                Open repository <ExternalLink className="size-3" />
              </a>
            ) : null}
            {report.codeIntelligence.snapshot ? (
              <dl className="mt-4 grid grid-cols-2 gap-3 border-t pt-3 text-sm">
                <div>
                  <dt className="text-muted-foreground">Primary language</dt>
                  <dd>{report.codeIntelligence.snapshot.stack?.primaryLanguage ?? "Unavailable"}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">30-day commits</dt>
                  <dd>{report.codeIntelligence.snapshot.activity?.commitCount30d ?? "Unavailable"}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Last commit</dt>
                  <dd>{report.codeIntelligence.snapshot.activity?.lastCommitAt ?? "Unavailable"}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Due diligence</dt>
                  <dd>{report.codeIntelligence.assessment?.overallStatus?.replaceAll("_", " ") ?? "Unavailable"}</dd>
                </div>
              </dl>
            ) : null}
            {report.githubDueDiligenceReportUrl ? (
              <Link href={report.githubDueDiligenceReportUrl} className="mt-2 block text-sm font-medium text-primary hover:underline">
                View GitHub Due Diligence report
              </Link>
            ) : null}
          </div>
          <div className="rounded-md border p-4">
            <h3 className="font-semibold">Execution & payments</h3>
            <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
              <div><dt className="text-muted-foreground">Completed</dt><dd className="text-lg font-semibold">{report.executionReliability.completedRuns ?? "Unavailable"}</dd></div>
              <div><dt className="text-muted-foreground">Failed</dt><dd className="text-lg font-semibold">{report.executionReliability.failedRuns ?? "Unavailable"}</dd></div>
              <div><dt className="text-muted-foreground">Success rate</dt><dd>{report.executionReliability.successRate === null ? "Unavailable" : `${report.executionReliability.successRate}%`}</dd></div>
              <div><dt className="text-muted-foreground">Paid USDC</dt><dd>{report.paymentsAndReceipts.totalPaidUsdc ?? "Unavailable"}</dd></div>
              <div><dt className="text-muted-foreground">Receipts</dt><dd>{report.paymentsAndReceipts.receiptsCount ?? "Unavailable"}</dd></div>
              <div><dt className="text-muted-foreground">Arc proof coverage</dt><dd>{report.executionReliability.verificationCoverage === null ? "Unavailable" : `${report.executionReliability.verificationCoverage}%`}</dd></div>
            </dl>
          </div>
          <div className="rounded-md border p-4">
            <h3 className="font-semibold">Services & endpoint</h3>
            <dl className="mt-3 grid gap-2 text-sm">
              <div><dt className="text-muted-foreground">Published services</dt><dd>{report.services.publishedServiceCount}</dd></div>
              <div><dt className="text-muted-foreground">Service signals</dt><dd>{availabilityLabel(report.services.status)}</dd></div>
              <div><dt className="text-muted-foreground">Endpoint</dt><dd>{availabilityLabel(report.endpointAvailability.status)}</dd></div>
              <div><dt className="text-muted-foreground">Response time</dt><dd>{report.endpointAvailability.responseTimeMs === null ? "Unavailable" : `${report.endpointAvailability.responseTimeMs} ms`}</dd></div>
            </dl>
            {report.services.services.length ? (
              <div className="mt-4 grid gap-2 border-t pt-3 text-xs">
                {report.services.services.map((service) => (
                  <div key={service.publicId} className="rounded-md bg-secondary/30 p-3">
                    <p className="font-semibold">{service.name} · v{service.version}</p>
                    <p className="mt-1 text-muted-foreground">
                      {service.status} · {service.availabilityStatus} · {service.priceUsdc} USDC
                    </p>
                    <p className="mt-1 text-muted-foreground">
                      Executions: {service.successfulExecutions ?? "insufficient"} · Failure rate: {service.failureRate === null ? "insufficient" : `${service.failureRate}%`} · Median latency: {service.medianLatencyMs === null ? "insufficient" : `${service.medianLatencyMs} ms`} · Settled: {service.verifiedSettlementCount ?? "insufficient"}
                    </p>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          <div className="rounded-md border p-4 sm:col-span-2">
            <h3 className="font-semibold">Arc contract transparency</h3>
            <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
              <div><dt className="text-muted-foreground">Status</dt><dd>{availabilityLabel(report.contractTransparency.status)}</dd></div>
              <div><dt className="text-muted-foreground">Bytecode</dt><dd>{report.contractTransparency.hasBytecode === null ? "Unavailable" : report.contractTransparency.hasBytecode ? "Present" : "Not found"}</dd></div>
              <div><dt className="text-muted-foreground">Proxy</dt><dd>{report.contractTransparency.proxyDetected === null ? "Unavailable" : report.contractTransparency.proxyDetected ? "Detected" : "Not detected"}</dd></div>
              <div><dt className="text-muted-foreground">Upgradeable</dt><dd>{report.contractTransparency.upgradeable === null ? "Unavailable" : report.contractTransparency.upgradeable ? "Yes" : "No signal"}</dd></div>
              <div><dt className="text-muted-foreground">Pausable</dt><dd>{report.contractTransparency.pausable === null ? "Unavailable" : report.contractTransparency.pausable ? "Yes" : "No signal"}</dd></div>
              <div><dt className="text-muted-foreground">Explorer verification</dt><dd>{availabilityLabel(report.contractTransparency.verificationStatus)}</dd></div>
            </dl>
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-2">
          <div>
            <h3 className="flex items-center gap-2 font-semibold"><Check className="size-4 text-emerald-500" /> Evidence-backed strengths</h3>
            <ul className="mt-3 grid gap-2 text-sm">
              {report.evidenceBackedStrengths.length
                ? report.evidenceBackedStrengths.map((item) => (
                    <li key={item.id} className="rounded-md bg-emerald-500/5 p-3">{item.detail}</li>
                  ))
                : <li className="text-muted-foreground">No positive signal is shown without evidence.</li>}
            </ul>
          </div>
          <div>
            <h3 className="flex items-center gap-2 font-semibold"><ShieldAlert className="size-4 text-amber-500" /> Risks & review items</h3>
            <ul className="mt-3 grid gap-2 text-sm">
              {report.risksAndReviewItems.length
                ? report.risksAndReviewItems.map((item) => (
                    <li key={item.id} className="rounded-md bg-amber-500/5 p-3">{item.detail}</li>
                  ))
                : <li className="text-muted-foreground">No material review item was identified in collected evidence.</li>}
            </ul>
          </div>
        </section>

        <section>
          <h3 className="flex items-center gap-2 font-semibold"><HelpCircle className="size-4" /> Questions before integration</h3>
          <ul className="mt-3 grid gap-2 text-sm text-muted-foreground">
            {report.questionsBeforeIntegration.map((question) => <li key={question}>• {question}</li>)}
          </ul>
        </section>

        <details className="rounded-md border p-4 text-sm">
          <summary className="cursor-pointer font-semibold">Evidence, freshness, limitations, payment & verification</summary>
          <div className="mt-4 grid gap-5 text-xs text-muted-foreground">
            <div>
              <p className="font-semibold text-foreground">Data freshness</p>
              {report.dataFreshness.map((item) => (
                <p key={`${item.source}-${item.fetchedAt}`} className="mt-1">
                  {item.source}: {item.fetchedAt} · {item.cacheMode} · {item.upstreamStatus}
                </p>
              ))}
            </div>
            <div>
              <p className="font-semibold text-foreground">Limitations</p>
              {report.limitations.map((item) => <p key={item} className="mt-1">• {item}</p>)}
            </div>
            <div>
              <p className="font-semibold text-foreground">Report hash</p>
              <p className="mt-1 break-all font-mono">{report.verification.reportHash}</p>
              {report.verification.proofs.map((proof) => (
                <p key={proof.receiptId} className="mt-2 break-all">
                  {proof.receiptId}: {proof.status}
                  {proof.explorerUrl ? (
                    <> · <a href={proof.explorerUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">Arcscan</a></>
                  ) : null}
                </p>
              ))}
              <Button asChild variant="outline" size="sm" className="mt-3">
                <Link href={receiptUrl}>Commerce receipts</Link>
              </Button>
            </div>
          </div>
        </details>
      </CardContent>
    </Card>
  );
}
