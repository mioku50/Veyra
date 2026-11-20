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

import { NextResponse, type NextRequest } from "next/server.js";
import { COOKIE_NAME, verifySellerSession } from "./lib/seller/session.ts";
import {
  isFrozenLabsPath,
  isOperatorPath,
  operatorLoginDestination,
} from "./lib/navigation/frozen.ts";

export function proxy(request: NextRequest) {
  const authenticated = verifySellerSession(request.cookies.get(COOKIE_NAME)?.value);
  const { search, searchParams } = request.nextUrl;
  const legacyDeveloperTools = request.nextUrl.pathname === "/developer-tools";
  const pathname = legacyDeveloperTools ? "/console/developer-tools" : request.nextUrl.pathname;

  if (pathname === "/login") {
    const next = operatorLoginDestination(searchParams.get("next"));
    const response = authenticated
      ? NextResponse.redirect(new URL(next, request.url))
      : NextResponse.next();
    response.headers.set("Cache-Control", "private, no-store");
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
    return response;
  }

  // These detail URLs are published by the receipt API. Keep the individual
  // records readable and leave the legacy run and store indexes in Labs.
  const receiptPermalink = /^\/(?:runs|store|workflow-receipts)\/[^/]+$/.test(pathname);
  const frozen = isFrozenLabsPath(pathname);
  const operatorOnly = isOperatorPath(pathname);
  if (!receiptPermalink && !frozen && !operatorOnly) return NextResponse.next();

  const canOpen = receiptPermalink || authenticated ||
    (frozen && !operatorOnly && process.env.VEYRA_LABS_PUBLIC === "true");
  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", pathname + search);
  const response = !canOpen
    ? NextResponse.redirect(loginUrl)
    : legacyDeveloperTools
      ? NextResponse.redirect(new URL(pathname + search, request.url))
      : NextResponse.next();
  response.headers.set("X-Robots-Tag", "noindex, nofollow");
  if (!receiptPermalink) response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config = {
  matcher: [
    "/login",
    "/dashboard/:path*",
    "/console/:path*",
    "/store/:path*",
    "/workflows/:path*",
    "/runs/:path*",
    "/results/:path*",
    "/proofs/:path*",
    "/agent-launch",
    "/agent-setup",
    "/alerts",
    "/developer-tools",
    "/evaluators/:path*",
    "/trust-gate",
    "/trust/select",
    "/trust/mandates",
    "/evaluations/:path*",
    "/agent-runner/:path*",
    "/project-360/:path*",
    "/monitoring/:path*",
    "/my-agents/:path*",
    "/agent-control/:path*",
    "/seller/:path*",
    "/workflow-receipts/:path*",
  ],
};
