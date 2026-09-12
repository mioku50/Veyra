import { Activity, AlertTriangle, CheckCircle2, Clock3, CreditCard, Gauge, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { brandPageTitle } from "@/lib/brand";
import { getOperationsSnapshot, type OperationsSnapshot } from "@/lib/operations/health";

export const dynamic = "force-dynamic";

export const metadata = {
  title: { absolute: brandPageTitle("Production Operations") },
  description:
    "Execution, provider, payment, and Arc proof health for verifiable paid workflows.",
};

function percentage(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function latency(value: number | null) {
  return value === null ? "No samples" : `${(value / 1_000).toFixed(2)}s`;
}

function MetricCard({
  title,
  value,
  detail,
  icon: Icon,
}: {
  title: string;
  value: string;
  detail: string;
  icon: typeof Activity;
}) {
  return (
    <Card className="rounded-lg">
      <CardContent className="p-5">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">{title}</p>
          <Icon className="size-4 text-primary" />
        </div>
        <p className="mt-3 font-mono text-2xl font-semibold">{value}</p>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  );
}

export default async function OperationsPage() {
  let snapshot: OperationsSnapshot | null = null;
  let error: string | null = null;
  try {
    snapshot = await getOperationsSnapshot();
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Operations metrics are unavailable.";
  }

  return (
    <main className="min-h-screen bg-background">
      <section className="border-b bg-secondary/20">
        <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Badge>Production Operations</Badge>
            <Badge variant="outline">Last 60 minutes</Badge>
            {snapshot ? (
              <Badge
                variant={snapshot.status === "critical" ? "destructive" : "secondary"}
              >
                {snapshot.status}
              </Badge>
            ) : null}
          </div>
          <h1 className="text-4xl font-bold tracking-normal sm:text-5xl">
            Workflow health and recovery
          </h1>
          <p className="mt-4 max-w-3xl leading-7 text-muted-foreground">
            Aggregate execution, provider, checkout, and Arc proof signals. No prompts,
            credentials, raw provider payloads, or tenant identifiers are exposed here.
          </p>
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-6xl gap-6 px-4 py-8 sm:px-6">
        {error || !snapshot ? (
          <Card className="rounded-lg border-destructive/30">
            <CardContent className="flex gap-3 p-5 text-sm text-destructive">
              <AlertTriangle className="size-5 shrink-0" />
              {error ?? "Operations metrics are unavailable."}
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <MetricCard
                title="Workflow failures"
                value={`${snapshot.executions.failed}/${snapshot.executions.total}`}
                detail={`${percentage(snapshot.executions.failureRate)} failure rate · ${snapshot.executions.staleRunning} stale`}
                icon={Activity}
              />
              <MetricCard
                title="Provider p95"
                value={latency(snapshot.providers.p95LatencyMs)}
                detail={`${snapshot.providers.measuredCalls} measured · ${percentage(snapshot.providers.failureRate)} failed`}
                icon={Gauge}
              />
              <MetricCard
                title="Paid checkouts"
                value={String(snapshot.payments.paidCheckouts)}
                detail={`${snapshot.payments.settled} settled · ${snapshot.payments.creditsOrRefunds} credit/refund · ${snapshot.payments.unresolved} unresolved`}
                icon={CreditCard}
              />
              <MetricCard
                title="Arc proof delay p95"
                value={latency(snapshot.arcProofs.p95VerificationDelayMs)}
                detail={`${snapshot.arcProofs.verified} verified · ${snapshot.arcProofs.delayed} delayed · ${snapshot.arcProofs.failed} failed`}
                icon={ShieldCheck}
              />
            </div>

            <Card className="rounded-lg">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  {snapshot.alerts.length > 0 ? (
                    <AlertTriangle className="size-5 text-amber-400" />
                  ) : (
                    <CheckCircle2 className="size-5 text-sky-400" />
                  )}
                  Active alerts
                </CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3">
                {snapshot.alerts.length > 0 ? (
                  snapshot.alerts.map((alert) => (
                    <div key={alert.code} className="rounded-md border p-4 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={alert.severity === "critical" ? "destructive" : "outline"}>
                          {alert.severity}
                        </Badge>
                        <code className="text-xs">{alert.code}</code>
                      </div>
                      <p className="mt-3">{alert.message}</p>
                      <p className="mt-2 text-xs leading-5 text-muted-foreground">
                        {alert.retryPolicy}
                      </p>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No threshold breach is active in the current window.
                  </p>
                )}
              </CardContent>
            </Card>

            <Card className="rounded-lg">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Clock3 className="size-5 text-primary" />
                  Retry policy
                </CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3 text-sm">
                {Object.entries(snapshot.retryPolicy).map(([key, value]) => (
                  <div key={key} className="rounded-md border p-4">
                    <p className="font-mono text-xs text-primary">{key}</p>
                    <p className="mt-2 leading-6 text-muted-foreground">{value}</p>
                  </div>
                ))}
              </CardContent>
            </Card>
          </>
        )}
      </section>
    </main>
  );
}
