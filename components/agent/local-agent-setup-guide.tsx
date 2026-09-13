import Link from "next/link";
import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  ClipboardList,
  Github,
  KeyRound,
  ShieldCheck,
  Terminal,
  Wallet,
} from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const repoUrl = "https://github.com/mioku50/Agent-Commerce";
const cloneCommand = "git clone https://github.com/mioku50/Agent-Commerce.git";
const installCommand = "cd Agent-Commerce && npm install";
const demoCommand =
  'AGENT_MAX_IN_FLIGHT=1 npm run agent -- --task "Analyze tone and sentiment for a short builder update" --limit 0.005';

const setupSteps = [
  "Open the project repository and clone it locally.",
  "Install dependencies with npm install.",
  "Create .env.local from .env.example.",
  "Set BASE_URL=https://agent-commerce-six.vercel.app for the production demo.",
  "Set or generate AGENT_PRIVATE_KEY locally only.",
  "Fund the buyer-agent wallet on Arc Testnet from /agent-launch.",
  "Run the generated npm command from the repository root.",
  "Open the resulting run timeline, commerce receipt, and Agent Passport.",
];

const envItems = [
  ["BASE_URL", "Production demo URL used by the local buyer-agent."],
  ["AGENT_PRIVATE_KEY", "Buyer-agent private key; local .env.local only."],
  ["AGENT_MAX_IN_FLIGHT", "Set to 1 for deterministic demo runs."],
  ["AGENT_SKIP_FUNDING", "Optional; reuse a wallet that is already funded."],
  ["AGENT_SKIP_DEPOSIT", "Optional; reuse existing Gateway balance."],
  ["AGENT_DEPOSIT_USDC", "Optional deposit amount for Gateway-funded runs."],
  ["NEXT_PUBLIC_AGENT_DB_SUPABASE_URL", "Preferred database URL for public UI/runtime reads."],
  [
    "NEXT_PUBLIC_AGENT_DB_SUPABASE_PUBLISHABLE_KEY",
    "Preferred publishable key for public Supabase reads.",
  ],
  ["AGENT_DB_SUPABASE_URL", "Preferred server database URL for CLI persistence."],
  [
    "AGENT_DB_SUPABASE_SECRET_KEY",
    "Operator-only: preferred for CLI timeline/passport persistence.",
  ],
];

export function LocalAgentSetupGuide({ compact = false }: { compact?: boolean }) {
  return (
    <section className="grid gap-5">
      <Card className="command-card rounded-lg shadow-sm">
        <CardHeader>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Badge variant="secondary">Run the buyer-agent locally</Badge>
            <Badge variant="outline">Private keys never enter the browser</Badge>
          </div>
          <CardTitle className="flex items-center gap-2 text-2xl">
            <Terminal className="size-6" />
            Local agent setup
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-5">
          <p className="text-sm leading-6 text-muted-foreground">
            The web app is the funding, planning, and proof surface. The paid
            buyer-agent execution remains a local CLI flow from this repository,
            where your `.env.local` and buyer-agent private key stay on your
            machine.
          </p>

          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-md border bg-muted/35 p-4">
              <Github className="mb-3 size-5 text-primary" />
              <p className="font-semibold">Repository</p>
              <p className="mt-2 break-all text-xs text-muted-foreground">{repoUrl}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button asChild size="sm" variant="outline">
                  <Link href={repoUrl} target="_blank" rel="noreferrer">
                    GitHub
                    <ArrowRight />
                  </Link>
                </Button>
                <Button asChild size="sm" variant="outline">
                  <Link href={`${repoUrl}#readme`} target="_blank" rel="noreferrer">
                    README
                    <BookOpen />
                  </Link>
                </Button>
              </div>
            </div>

            <div className="rounded-md border bg-muted/35 p-4 md:col-span-2">
              <p className="font-semibold">Reviewer quick path</p>
              <div className="mt-3 grid gap-3">
                <div className="rounded-md border bg-background/70 p-3">
                  <code className="break-all font-mono text-xs">{cloneCommand}</code>
                </div>
                <div className="rounded-md border bg-background/70 p-3">
                  <code className="break-all font-mono text-xs">{installCommand}</code>
                </div>
                <div className="rounded-md border bg-background/70 p-3">
                  <code className="break-all font-mono text-xs">{demoCommand}</code>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <CopyButton value={cloneCommand} label="Copy clone command" />
                <CopyButton value={demoCommand} label="Copy demo command" />
              </div>
            </div>
          </div>

          {!compact ? (
            <>
              <div className="grid gap-3 md:grid-cols-2">
                {setupSteps.map((step, index) => (
                  <div
                    key={step}
                    className="flex gap-3 rounded-md border bg-background/55 p-4 text-sm"
                  >
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 font-mono text-xs text-primary">
                      {index + 1}
                    </span>
                    <span className="leading-6 text-muted-foreground">{step}</span>
                  </div>
                ))}
              </div>

              <div className="grid gap-4 lg:grid-cols-[1fr_0.9fr]">
                <Card className="rounded-lg bg-background/45">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-lg">
                      <ClipboardList className="size-5" />
                      Required local environment
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="grid gap-3">
                    {envItems.map(([name, detail]) => (
                      <div
                        key={name}
                        className="grid gap-2 rounded-md border bg-muted/20 p-3 sm:grid-cols-[180px_1fr]"
                      >
                        <code className="font-mono text-xs text-code">{name}</code>
                        <p className="text-xs leading-5 text-muted-foreground">{detail}</p>
                      </div>
                    ))}
                  </CardContent>
                </Card>

                <div className="grid gap-4">
                  <Card className="rounded-lg border-sky-400/20 bg-sky-400/5">
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2 text-lg">
                        <ShieldCheck className="size-5 text-sky-300" />
                        Security boundary
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="grid gap-3 text-sm leading-6 text-muted-foreground">
                      <p>Never paste private keys into the browser.</p>
                      <p>`.env.local` stays local and must never be committed.</p>
                      <p>The browser wallet only funds the buyer-agent wallet.</p>
                      <p>The local CLI signs x402 payments and calls paid endpoints.</p>
                    </CardContent>
                  </Card>

                  <Card className="rounded-lg border-amber-400/20 bg-amber-400/5">
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2 text-lg">
                        <KeyRound className="size-5 text-amber-300" />
                        Reviewer/operator limitation
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="text-sm leading-6 text-muted-foreground">
                      The current CLI persistence flow uses Supabase service-role
                      credentials to write run timelines, passports, and receipt
                      metadata. That is appropriate for an operator/reviewer demo,
                      but it is not yet a fully public end-user flow.
                    </CardContent>
                  </Card>
                </div>
              </div>

              <div className="flex flex-col gap-3 rounded-md border bg-muted/25 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex gap-3">
                  <Wallet className="mt-0.5 size-5 shrink-0 text-primary" />
                  <div>
                    <p className="font-semibold">After the run</p>
                    <p className="text-sm text-muted-foreground">
                      Open the new run timeline, receipt, and Agent Passport
                      from the Review Status API.
                    </p>
                  </div>
                </div>
                <Button asChild variant="outline">
                  <Link href="/api/review/status">
                    Review status
                    <ArrowRight />
                  </Link>
                </Button>
              </div>
            </>
          ) : (
            <Button asChild variant="outline">
              <Link href="/agent-setup">
                Open full setup guide
                <ArrowRight />
              </Link>
            </Button>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
