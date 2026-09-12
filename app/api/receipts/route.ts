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

import { NextRequest, NextResponse } from "next/server";
import { fetchRecentReceipts } from "@/lib/commerce/receipts";

export const revalidate = 0;

export async function GET(request: NextRequest) {
  const limitParam = request.nextUrl.searchParams.get("limit");
  const limit = limitParam ? Number(limitParam) : 25;
  const wallet = request.nextUrl.searchParams.get("wallet");
  const serviceSlug = request.nextUrl.searchParams.get("serviceSlug");

  try {
    const receipts = await fetchRecentReceipts({
      limit: Number.isFinite(limit) ? limit : 25,
      wallet,
      serviceSlug,
    });

    return NextResponse.json({ receipts });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
