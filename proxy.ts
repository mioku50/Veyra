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
import { FROZEN_LABS_PREFIXES } from "./lib/navigation/frozen.ts";

/* Labs is frozen behind the developer console.
 *
 * The hosted-report product — GitHub due diligence, Project 360, treasury
 * health, sentiment, builder updates — plus the seller store, the workflow
 * catalogue and the raw activity explorers are a second product that grew
 * beside the first. They already left the product navigation; while they stayed
 * publicly reachable and indexable they still made the whole thing read as a
 * research repository instead of one tool that does one thing.
 *
 * Nothing is deleted and nothing breaks for an operator: opening the developer
 * console marks the session, and every one of these surfaces stays reachable
 * from it. A visitor who never asked for the console is sent there instead, and
 * search engines are told to keep all of it out of the index.
 */
const CONSOLE_COOKIE = "veyra_console";

function isFrozen(pathname: string) {
  return FROZEN_LABS_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export function proxy(request: NextRequest) {
  const authenticated = verifySellerSession(request.cookies.get(COOKIE_NAME)?.value);
  const { pathname } = request.nextUrl;

  // Logged-in user trying to access sign-in page -> redirect to dashboard
  if (pathname === "/login" && authenticated) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  // Logged-out user trying to access protected seller routes -> redirect to sign-in
  if (
    (pathname.startsWith("/dashboard") || pathname.startsWith("/seller")) &&
    !authenticated
  ) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Opening the console is the opt-in, and it lasts the session, so an operator
  // follows the console's own links without meeting this rule again.
  if (pathname === "/console" || pathname.startsWith("/console/")) {
    const response = NextResponse.next();
    if (request.cookies.get(CONSOLE_COOKIE)?.value !== "1") {
      response.cookies.set(CONSOLE_COOKIE, "1", {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: process.env.NODE_ENV === "production",
      });
    }
    return response;
  }

  if (isFrozen(pathname)) {
    const opened = request.cookies.get(CONSOLE_COOKIE)?.value === "1";
    if (opened || process.env.VEYRA_LABS_PUBLIC === "true") {
      const response = NextResponse.next();
      response.headers.set("X-Robots-Tag", "noindex, nofollow");
      return response;
    }
    const destination = request.nextUrl.clone();
    destination.pathname = "/console";
    destination.search = "";
    const response = NextResponse.redirect(destination, 307);
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
    return response;
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/login",
    "/dashboard/:path*",
    "/console",
    "/console/:path*",
    "/store/:path*",
    "/store",
    "/workflows/:path*",
    "/workflows",
    "/runs/:path*",
    "/runs",
    "/results/:path*",
    "/results",
    "/proofs/:path*",
    "/proofs",
    "/agent-launch",
    "/agent-setup",
    "/alerts",
    "/developer-tools",
    "/evaluators",
    "/evaluators/:path*",
    "/trust-gate",
    "/trust/select",
    "/trust/mandates",
    "/evaluations/:path*",
    "/evaluations",
    "/agent-runner/:path*",
    "/agent-runner",
    "/project-360/:path*",
    "/project-360",
    "/monitoring/:path*",
    "/monitoring",
    "/my-agents/:path*",
    "/my-agents",
    "/agent-control/:path*",
    "/agent-control",
    "/seller/:path*",
    "/demo/:path*",
    "/demo",
    "/workflow-receipts/:path*",
  ],
};
