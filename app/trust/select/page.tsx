import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Scale, Search, ShieldCheck } from "lucide-react";
import { TrustSelectionClient } from "./trust-selection-client";

export const metadata = {
  title: "Agent-to-Agent Counterparty Selection",
  description: "Discover and rank ERC-8004 counterparties using existing Veyra evidence and TrustGate policy.",
};

export default function TrustSelectionPage() {
  return (
    <main className="min-h-screen bg-background">
      <section className="border-b bg-gradient-to-b from-[#0a0d15] to-[#07090e] py-12">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <Badge className="mb-4">Agent-to-Agent Trust Discovery</Badge>
          <h1 className="max-w-4xl text-3xl font-extrabold sm:text-5xl">
            Choose who your agent should trust.
          </h1>
          <p className="mt-4 max-w-3xl text-muted-foreground">
            Veyra verifies ERC-8004 identity, checks eligibility through TrustGate,
            and applies a deterministic ranking. Selection is free of payment and
            execution side effects.
          </p>
          <div className="mt-7 grid gap-3 sm:grid-cols-3">
            {[
              [Search, "Verified discovery", "Known public candidates or your explicit list"],
              [ShieldCheck, "Eligibility first", "Policy-denied candidates cannot win"],
              [Scale, "Immutable receipt", "Reproducible ranking with exact evidence hashes"],
            ].map(([Icon, title, text]) => (
              <Card key={String(title)}>
                <CardContent className="flex gap-3 p-4">
                  <Icon className="size-5 text-primary" />
                  <div>
                    <p className="font-semibold">{String(title)}</p>
                    <p className="text-xs text-muted-foreground">{String(text)}</p>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>
      <TrustSelectionClient />
    </main>
  );
}
