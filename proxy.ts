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

  return NextResponse.next();
}

export const config = {
  matcher: ["/login", "/dashboard/:path*", "/seller/:path*"],
};
