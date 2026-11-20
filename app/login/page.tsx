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

"use client";

import { type FormEvent, useState } from "react";
import Link from "next/link";
import { ArrowLeft, LockKeyhole } from "lucide-react";
import { operatorLoginDestination } from "@/lib/navigation/frozen";
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
      const next = new URLSearchParams(window.location.search).get("next");
      window.location.assign(operatorLoginDestination(next));
    } catch {
      setError("Seller authentication is temporarily unavailable");
      setPending(false);
    }
  }

  return (
    <main className="min-h-screen bg-background">
      <section className="mx-auto w-full max-w-md px-4 py-10 sm:px-6 lg:py-16">
        <Card className="w-full">
          <CardHeader>
            <div className="mb-4 flex size-11 items-center justify-center rounded-md bg-secondary text-secondary-foreground">
              <LockKeyhole className="size-5" />
            </div>
            <CardTitle className="text-2xl">Operator sign in</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  placeholder="Password"
                  required
                />
              </div>
              {error && (
                <p role="alert" className="rounded-md border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
                  {error}
                </p>
              )}
              <Button type="submit" disabled={pending} className="w-full">
                {pending ? "Signing in..." : "Sign in"}
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
