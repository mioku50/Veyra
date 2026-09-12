import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BadgeCheck,
  CalendarClock,
  CheckCircle2,
  ExternalLink,
  FileText,
  Fingerprint,
  History,
  Minus,
  Play,
  ShieldCheck,
  Code2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getPublicTrustProfile, TrustMonitoringError } from "@/lib/monitoring/service";
import type { TrustDeltaChange, TrustSubjectType } from "@/lib/monitoring/types";
import { ShareProfileButton } from "./share-profile-button";
import { TrustScoreChart } from "./trust-score-chart";
import { TrustBadgeEmbed } from "./trust-badge-embed";
import { publicAppUrl } from "@/lib/public-url";
import { BRAND } from "@/lib/brand";

type RouteContext = { params: Promise<{ publicId: string }> };

export const dynamic = "force-dynamic";

function formatDate(value: string | null, options?: { short?: boolean }) {
  if (!value) return "Not checked yet";
  return new Intl.DateTimeFormat("en", options?.short
    ? { month: "short", day: "numeric", year: "numeric" }
    : { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function statusLabel(value: string | null) {
  if (!value) return "Awaiting baseline";
  return value.replaceAll("_", " ").replace(/^\w/, (letter) => letter.toUpperCase());
}

function objectTypeLabel(type: TrustSubjectType) {
  const labels: Record<TrustSubjectType, string> = {
    github_repository: "GitHub repository",
    ai_agent: "AI agent",
    wallet: "Wallet",
    arc_contract: "Arc contract",
    service_endpoint: "Service endpoint",
    project_360: "Project 360",
  };
  return labels[type];
}

async function profileOrNotFound(publicId: string) {
  try {
    return await getPublicTrustProfile(publicId);
  } catch (error) {
    if (error instanceof TrustMonitoringError && error.status === 404) notFound();
    throw error;
  }
}

export async function generateMetadata({ params }: RouteContext): Promise<Metadata> {
  const { publicId } = await params;
  const data = await profileOrNotFound(publicId);
  const score = data.profile.currentScore ?? "—";
  const description = [
    data.profile.name,
    `Trust Score: ${score}`,
    statusLabel(data.profile.trustStatus),
    data.profile.lastVerifiedOnArcAt
      ? `Last verified on Arc: ${formatDate(data.profile.lastVerifiedOnArcAt, { short: true })}`
      : "Arc verification pending",
  ].join(" · ");
  return {
    title: `${data.profile.name} Trust Profile`,
    description,
    alternates: { canonical: `/trust/${data.profile.id}` },
    openGraph: {
      type: "website",
      siteName: BRAND.name,
      title: `${BRAND.name} Trust Profile`,
      description,
      url: `/trust/${data.profile.id}`,
      images: [{ url: `/trust/${data.profile.id}/opengraph-image` }],
    },
    twitter: {
      card: "summary_large_image",
      title: `${BRAND.name} Trust Profile`,
      description,
      images: [`/trust/${data.profile.id}/opengraph-image`],
    },
  };
}

function ChangeIcon({ change }: { change: TrustDeltaChange }) {
  if (change.kind === "new_risk") return <AlertTriangle className="size-4 text-red-400" />;
  if (change.kind === "improved") return <ArrowUpRight className="size-4 text-sky-400" />;
  return <Activity className="size-4 text-blue-400" />;
}

export default async function PublicTrustProfilePage({ params }: RouteContext) {
  const { publicId } = await params;
  const data = await profileOrNotFound(publicId);
  const current = data.snapshots[0] ?? null;
  const identityRows = [
    ["GitHub", data.profile.identity.repositoryUrl],
    ["Agent ID", data.profile.identity.agentId],
    ["Wallet", data.profile.identity.wallet],
    ["Contract", data.profile.identity.contractAddress],
    ["Endpoint", data.profile.identity.serviceEndpoint],
  ].filter((row): row is [string, string] => Boolean(row[1]));
  const newRisks =
    data.currentDelta?.changes.filter((change) => change.kind === "new_risk") ?? [];
  const resolvedRisks =
    data.currentDelta?.changes.filter(
      (change) =>
        change.kind === "improved" && change.code.startsWith("resolved_risk_"),
    ) ?? [];
  const freshCheckQuery = new URLSearchParams(
    Object.entries({
      agentId: data.profile.identity.agentId,
      repositoryUrl: data.profile.identity.repositoryUrl,
      agentWallet: data.profile.identity.wallet,
      contractAddress: data.profile.identity.contractAddress,
      serviceEndpoint: data.profile.identity.serviceEndpoint,
    }).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
  const freshCheckUrl = data.profile.objectType === "project_360"
    ? `/monitoring?project360Job=${encodeURIComponent(current?.fullReportUrl.split("/").at(-1) ?? "")}#project-360-monitoring`
    : `/monitoring?${freshCheckQuery.toString()}`;

  return (
    <main className="min-h-screen bg-background">
      <section className="border-b bg-secondary/20">
        <div className="mx-auto grid w-full max-w-7xl gap-7 px-4 py-12 sm:px-6 lg:grid-cols-[1fr_auto] lg:items-end">
          <div>
            <div className="mb-4 flex flex-wrap gap-2">
              <Badge>Veyra Trust Profile</Badge>
              <Badge variant="outline">{objectTypeLabel(data.profile.objectType)}</Badge>
              {current?.verifiedOnArc ? (
                <Badge className="border border-sky-500/30 bg-sky-500/10 text-sky-400">
                  <BadgeCheck className="mr-1 size-3.5" />
                  Arc verified
                </Badge>
              ) : null}
            </div>
            <h1 className="max-w-4xl text-4xl font-bold sm:text-5xl">
              {data.profile.name}
            </h1>
            <p className="mt-4 font-mono text-sm text-muted-foreground">
              {data.profile.id}
            </p>
            <div className="mt-5 grid gap-2 text-sm text-muted-foreground">
              {identityRows.map(([label, value]) => (
                <div key={label} className="flex flex-wrap gap-2">
                  <span className="font-medium text-foreground">{label}</span>
                  <span className="break-all font-mono">{value}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {current ? (
              <Button asChild>
                <Link href={current.fullReportUrl}>
                  <FileText /> View full report
                </Link>
              </Button>
            ) : null}
            <Button asChild variant="outline">
              <Link href={freshCheckUrl}>
                <Play /> Run fresh check
              </Link>
            </Button>
            <ShareProfileButton title={`${data.profile.name} · Veyra Trust Profile`} />
          </div>
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-7xl gap-5 px-4 py-8 sm:px-6 lg:grid-cols-4">
        <Card className="rounded-lg lg:col-span-2">
          <CardContent className="flex items-end justify-between gap-5 p-6">
            <div>
              <p className="text-sm text-muted-foreground">Current Trust Score</p>
              <p className="mt-3 font-mono text-6xl font-semibold">
                {data.profile.currentScore ?? "—"}
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                {statusLabel(data.profile.trustStatus)}
              </p>
            </div>
            {data.profile.scoreChange !== null ? (
              <Badge
                className={
                  data.profile.scoreChange > 0
                    ? "bg-sky-500/10 text-sky-400"
                    : data.profile.scoreChange < 0
                      ? "bg-red-500/10 text-red-400"
                      : ""
                }
              >
                {data.profile.scoreChange > 0 ? (
                  <ArrowUpRight className="mr-1 size-4" />
                ) : data.profile.scoreChange < 0 ? (
                  <ArrowDownRight className="mr-1 size-4" />
                ) : (
                  <Minus className="mr-1 size-4" />
                )}
                {data.currentDelta?.score.before ?? "—"} →{" "}
                {data.currentDelta?.score.after ?? "—"}
              </Badge>
            ) : null}
          </CardContent>
        </Card>
        <Card className="rounded-lg">
          <CardContent className="p-6">
            <CalendarClock className="size-5 text-primary" />
            <p className="mt-4 text-sm text-muted-foreground">Last checked</p>
            <p className="mt-2 font-medium">{formatDate(data.profile.lastCheckedAt)}</p>
          </CardContent>
        </Card>
        <Card className="rounded-lg">
          <CardContent className="p-6">
            <ShieldCheck className="size-5 text-primary" />
            <p className="mt-4 text-sm text-muted-foreground">Snapshots</p>
            <p className="mt-2 font-mono text-2xl font-semibold">
              {data.profile.snapshotCount}
            </p>
          </CardContent>
        </Card>
      </section>

      <section className="mx-auto grid w-full max-w-7xl gap-6 px-4 pb-8 sm:px-6 lg:grid-cols-[1.35fr_0.65fr]">
        <Card className="rounded-lg">
          <CardHeader>
            <CardTitle>Trust Score history</CardTitle>
          </CardHeader>
          <CardContent>
            <TrustScoreChart snapshots={data.snapshots} />
          </CardContent>
        </Card>
        <Card className="rounded-lg">
          <CardHeader>
            <CardTitle>Latest risk changes</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-5">
            <div>
              <p className="text-sm font-semibold text-red-400">New risks</p>
              <div className="mt-3 grid gap-2">
                {newRisks.length ? newRisks.map((risk) => (
                  <p key={risk.code} className="text-sm">{risk.title}</p>
                )) : (
                  <p className="text-sm text-muted-foreground">No new risk in the latest snapshot.</p>
                )}
              </div>
            </div>
            <div>
              <p className="text-sm font-semibold text-sky-400">Resolved risks</p>
              <div className="mt-3 grid gap-2">
                {resolvedRisks.length ? resolvedRisks.map((risk) => (
                  <p key={risk.code} className="text-sm">{risk.title}</p>
                )) : (
                  <p className="text-sm text-muted-foreground">No risk was resolved in the latest snapshot.</p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="mx-auto w-full max-w-7xl px-4 pb-8 sm:px-6">
        <Card className="rounded-lg">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Code2 className="size-5 text-primary" />
              Embed this Trust Badge
            </CardTitle>
          </CardHeader>
          <CardContent>
            <TrustBadgeEmbed
              appUrl={publicAppUrl()}
              profileId={data.profile.id}
            />
          </CardContent>
        </Card>
      </section>

      <section className="mx-auto w-full max-w-7xl px-4 pb-12 sm:px-6">
        <div className="mb-5 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-2xl font-semibold">Meaningful Change Timeline</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Real canonical snapshots, deterministic deltas, and exact Arc proofs.
            </p>
          </div>
          <History className="size-6 text-primary" />
        </div>
        <div className="grid gap-5">
          {data.snapshots.length === 0 ? (
            <Card><CardContent className="p-8 text-center text-muted-foreground">No snapshots yet.</CardContent></Card>
          ) : data.snapshots.map((snapshot) => (
            <Card
              id={`snapshot-${snapshot.snapshotId}`}
              key={snapshot.snapshotId}
              className="scroll-mt-20 rounded-lg"
            >
              <CardContent className="grid gap-5 p-5 lg:grid-cols-[180px_1fr_auto]">
                <div>
                  <p className="text-lg font-semibold">{formatDate(snapshot.observedAt, { short: true })}</p>
                  <p className="mt-2 font-mono text-3xl font-semibold">{snapshot.score ?? "—"}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{statusLabel(snapshot.trustStatus)}</p>
                </div>
                <div className="grid content-start gap-3">
                  <p className="font-medium">
                    {snapshot.delta.previousSnapshotId
                      ? snapshot.delta.score.before === null &&
                        snapshot.delta.score.after === null
                        ? "Trust Score remains limited by available evidence"
                        : `Trust Score ${snapshot.delta.score.before ?? "—"} → ${snapshot.delta.score.after ?? "—"}`
                      : `Baseline Trust Score ${snapshot.score ?? "—"}`}
                  </p>
                  {snapshot.delta.changes.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No material trust signal changed.
                    </p>
                  ) : (
                    <div className="grid gap-2">
                      {snapshot.delta.changes.map((change) => (
                        <div key={change.code} className="flex items-start gap-2 text-sm">
                          <ChangeIcon change={change} />
                          <span>{change.title}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    {snapshot.verifiedOnArc ? (
                      <CheckCircle2 className="size-4 text-sky-400" />
                    ) : (
                      <Fingerprint className="size-4" />
                    )}
                    {snapshot.verifiedOnArc ? "Arc proof verified" : "Arc verification pending"}
                  </div>
                </div>
                <div className="flex flex-wrap content-start gap-2">
                  <Button asChild size="sm" variant="outline">
                    <Link href={snapshot.fullReportUrl}>View full report</Link>
                  </Button>
                  {snapshot.proofUrl ? (
                    <Button asChild size="sm" variant="outline">
                      <Link href={snapshot.proofUrl} target="_blank" rel="noreferrer">
                        Arc proof <ExternalLink />
                      </Link>
                    </Button>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    </main>
  );
}
