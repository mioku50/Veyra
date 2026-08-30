/**
 * Copyright 2026 Circle Internet Group, Inc.  All rights reserved.
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

"use client";

import { type FormEvent, useState } from "react";
import Link from "next/link";
import { ArrowLeft, LayoutDashboard, LockKeyhole } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function LoginPage() {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const formData = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/seller/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: formData.get("password") }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) {
        setError(result.error ?? "Unable to sign in");
        setPending(false);
        return;
      }
      window.location.assign("/dashboard");
    } catch {
      setError("Seller authentication is temporarily unavailable");
      setPending(false);
    }
  }

  return (
    <main className="min-h-screen bg-background">
      <section className="mx-auto grid w-full max-w-6xl gap-8 px-4 py-10 sm:px-6 lg:grid-cols-[1fr_420px] lg:items-center lg:py-16">
        <div>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Badge variant="secondary">Protected seller area</Badge>
            <Badge variant="outline">Signed operator session</Badge>
          </div>
          <h1 className="max-w-3xl text-4xl font-bold tracking-normal text-foreground sm:text-5xl">
            Sign in to manage API commerce.
          </h1>
          <p className="mt-4 max-w-2xl leading-7 text-muted-foreground">
            Seller Dashboard keeps revenue, withdrawals, service creation, and
            analytics behind a simple protected entrypoint while the Store, Runs,
            Agents, and Receipts remain public.
          </p>
          <div className="mt-8 grid gap-3 sm:grid-cols-3">
            {[
              ["Revenue", "Track API purchases and estimated USDC revenue."],
              ["Services", "Create and edit safe seller-created listings."],
              ["Withdrawals", "Track settled balance and move earnings out."],
            ].map(([title, body]) => (
              <div key={title} className="rounded-lg border bg-card/80 p-4">
                <p className="font-semibold">{title}</p>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{body}</p>
              </div>
            ))}
          </div>
        </div>

        <Card className="w-full">
          <CardHeader>
            <div className="mb-4 flex size-11 items-center justify-center rounded-md bg-secondary text-secondary-foreground">
              <LockKeyhole className="size-5" />
            </div>
            <CardTitle className="flex items-center gap-2 text-2xl">
              <LayoutDashboard className="size-5 text-primary" />
              Seller Login
            </CardTitle>
            <p className="text-sm leading-6 text-muted-foreground">
              Sign in to open Seller Dashboard, Seller Analytics, and Creator
              Mode.
            </p>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  placeholder="Password"
                  required
                />
              </div>
              {error && (
                <p className="rounded-md border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
                  {error}
                </p>
              )}
              <Button type="submit" disabled={pending} className="w-full">
                {pending ? "Signing in..." : "Sign in to Seller Dashboard"}
              </Button>
              <Button asChild variant="ghost" className="w-full">
                <Link href="/">
                  <ArrowLeft />
                  Back to public app
                </Link>
              </Button>
            </form>
          </CardContent>
        </Card>
      </section>
    </main>
  );
}
