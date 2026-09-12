/**
 * Copyright 2026 Veyra
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import Link from "next/link";
import { BadgeCheck, Bot, ReceiptText, ShieldCheck, Store } from "lucide-react";
import { AgentLaunchClient } from "@/app/agent-launch/agent-launch-client";
import { LocalAgentSetupGuide } from "@/components/agent/local-agent-setup-guide";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export const metadata = {
  title: "Fund Local CLI Agent",
  description:
    "Connect an Arc Testnet wallet, fund a buyer-agent wallet, and launch the existing local CLI buyer-agent flow.",
};

export default function AgentLaunchPage() {
  return (
    <main className="min-h-screen bg-background">
      <section className="border-b bg-secondary/30">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-12 sm:px-6 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <Badge variant="secondary">Developer Tools · explicit funding</Badge>
              <Badge variant="outline">Arc Testnet only</Badge>
            </div>
            <h1 className="text-4xl font-bold tracking-normal text-foreground sm:text-5xl">
              Fund Local CLI Agent
            </h1>
            <p className="mt-4 max-w-3xl leading-7 text-muted-foreground">
              Connect an EVM wallet on Arc Testnet, send native or ERC-20 USDC
              to the buyer-agent wallet, then copy a local CLI command. The
              browser never receives private keys and never runs paid x402
              purchases.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <Button asChild variant="outline">
              <Link href="/agent-control">
                <Bot />
                Dry-run planner
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/agent-setup">
                <ShieldCheck />
                Setup Guide
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/store">
                <Store />
                API Store
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/agents">
                <BadgeCheck />
                Passports
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/receipts">
                <ReceiptText />
                Receipts
              </Link>
            </Button>
          </div>
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-7xl gap-4 px-4 py-6 sm:px-6 md:grid-cols-3">
        {[
          [
            "Browser wallet",
            "Only signs explicit funding transactions after user confirmation.",
          ],
          [
            "Local buyer-agent",
            "Existing CLI flow still owns x402 signing, Gateway deposits, and paid calls.",
          ],
          [
            "Testnet guardrails",
            "Funding actions are disabled unless the connected wallet is on Arc Testnet.",
          ],
        ].map(([title, body]) => (
          <div className="rounded-lg border bg-card p-5 shadow-sm" key={title}>
            <div className="mb-3 flex size-10 items-center justify-center rounded-md bg-secondary text-secondary-foreground">
              <ShieldCheck size={20} />
            </div>
            <p className="font-semibold">{title}</p>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{body}</p>
          </div>
        ))}
      </section>

      <section className="mx-auto w-full max-w-7xl px-4 pb-16 sm:px-6">
        <AgentLaunchClient />
      </section>

      <section className="mx-auto w-full max-w-7xl px-4 pb-16 sm:px-6">
        <LocalAgentSetupGuide compact />
      </section>
    </main>
  );
}
