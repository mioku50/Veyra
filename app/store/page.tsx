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

import { StoreMarketplace } from "@/app/store/store-marketplace";
import { Card, CardContent } from "@/components/ui/card";
import {
  categoriesForServices,
  listPublicStoreServices,
} from "@/lib/services/store-service-persistence";
import { connection } from "next/server";
import { Suspense } from "react";

export const metadata = {
  title: "API Store for AI Agents",
  description:
    "Discover x402-powered paid APIs that AI agents can buy with USDC on Arc.",
};

async function StoreMarketplaceData() {
  await connection();
  const { services, warning } = await listPublicStoreServices();

  return (
    <StoreMarketplace
      services={services}
      categories={categoriesForServices(services)}
      warning={warning}
    />
  );
}

function StoreMarketplaceFallback() {
  return (
    <main className="min-h-screen bg-background">
      <section className="border-b bg-secondary/30">
        <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
          <Card className="rounded-lg">
            <CardContent className="p-6 text-sm text-muted-foreground">
              Loading API Store...
            </CardContent>
          </Card>
        </div>
      </section>
    </main>
  );
}

export default function StorePage() {
  return (
    <Suspense fallback={<StoreMarketplaceFallback />}>
      <StoreMarketplaceData />
    </Suspense>
  );
}
