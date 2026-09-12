import Link from "next/link";
import { ArrowRight, ListChecks, ShieldCheck, BadgeCheck, ReceiptText, FileCode, CheckCircle2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BRAND, brandPageTitle } from "@/lib/brand";
import { serviceRegistry } from "@/lib/services/registry";

export const metadata = {
  title: { absolute: brandPageTitle("Audit & Verification") },
  description: "Unified audit trail for Activity, Arc Proofs, Agent Passports, Commerce Receipts, and Audited Services.",
};

const auditCards = [
  {
    title: "Activity",
    href: "/runs",
    icon: ListChecks,
    badge: "Execution Timeline",
    description: "Inspect how buyer agents plan, select paid services, execute x402 calls, and post settlement proofs.",
  },
  {
    title: "Arc Proofs",
    href: "/proofs",
    icon: ShieldCheck,
    badge: "Onchain Registry",
    description: "App-owned AgentCommerceProofRegistry records on Arc Testnet created after successful x402 settlement.",
  },
  {
    title: "Agent Passports",
    href: "/agents",
    icon: BadgeCheck,
    badge: "Identity & Reputation",
    description: "Public buyer-agent reputation passports derived from run history, completed reports, and verified proofs.",
  },
  {
    title: "Commerce Receipts",
    href: "/receipts",
    icon: ReceiptText,
    badge: "Payment Audit",
    description: "Immutable receipts linked to Final Reports, buyer Passports, payment events, and Arc proofs.",
  },
];

export default function ConsoleAuditPage() {
  return (
    <main className="min-h-screen bg-background">
      <section className="border-b bg-secondary/20">
        <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Badge variant="default">Audit & Verification</Badge>
            <Badge variant="outline">Arc Testnet</Badge>
          </div>
          <h1 className="text-4xl font-bold tracking-normal sm:text-5xl">Audit & Verification</h1>
          <p className="mt-4 max-w-3xl leading-7 text-muted-foreground">
            Complete transparency layer for {BRAND.name}. Access real-time activity timelines, onchain Arc proofs, buyer agent passports, verified commerce receipts, and audited service endpoint registries.
          </p>
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-6xl gap-6 px-4 py-8 sm:px-6 md:grid-cols-2">
        {auditCards.map((card) => {
          const Icon = card.icon;
          return (
            <Card key={card.href} className="command-card rounded-lg flex flex-col justify-between">
              <CardHeader>
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex size-10 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <Icon className="size-5" />
                  </div>
                  <Badge variant="secondary">{card.badge}</Badge>
                </div>
                <CardTitle className="text-xl">{card.title}</CardTitle>
                <CardDescription className="mt-2 text-sm leading-6">
                  {card.description}
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-0">
                <Button asChild variant="outline" className="w-full">
                  <Link href={card.href}>
                    View {card.title}
                    <ArrowRight className="ml-2 size-4" />
                  </Link>
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </section>

      <section className="mx-auto w-full max-w-6xl px-4 pb-12 sm:px-6">
        <div className="border-t pt-8">
          <div className="mb-4 flex items-center gap-2">
            <FileCode className="size-5 text-primary" />
            <h2 className="text-2xl font-bold">Audited Service Endpoints & Verification Scope</h2>
          </div>
          <p className="mb-6 text-sm text-muted-foreground">
            Every paid service call generates structured execution logs, payment receipts, buyer identity links, and Arc settlement proofs.
          </p>

          <div className="grid gap-4 lg:grid-cols-2">
            {serviceRegistry.map((service) => (
              <Card key={service.id} className="rounded-lg shadow-sm">
                <CardHeader>
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <Badge variant="default">{service.status}</Badge>
                    <Badge variant="outline">{service.category}</Badge>
                    <Badge variant="outline">{service.priceLabel}</Badge>
                  </div>
                  <CardTitle className="text-lg">{service.name}</CardTitle>
                  <p className="font-mono text-xs text-muted-foreground">{service.endpoint}</p>
                </CardHeader>
                <CardContent className="grid gap-3 text-sm">
                  <p className="text-muted-foreground leading-relaxed">
                    {service.longDescription || service.shortDescription}
                  </p>
                  <div className="flex items-center gap-2 text-xs font-medium text-sky-600 dark:text-sky-400">
                    <CheckCircle2 className="size-4" />
                    <span>Audit scope: Receipts · Activity timelines · Arc proof registry</span>
                  </div>
                  <div className="flex gap-2 pt-2">
                    <Button asChild variant="outline" size="sm" className="flex-1">
                      <Link href={`/receipts?serviceSlug=${service.slug}`}>
                        View receipts
                      </Link>
                    </Button>
                    <Button asChild variant="outline" size="sm" className="flex-1">
                      <Link href={`/store/${service.slug}`}>
                        View store listing
                      </Link>
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
