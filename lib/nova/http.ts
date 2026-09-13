/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse, type NextRequest } from "next/server";
import { NovaError } from "./service.ts";

/**
 * How an owner proves an agent is theirs.
 *
 * The secret is generated once, returned once, and lives in the person's
 * browser. There is no account, no password and no email, because Nova is
 * usable before anyone has decided to trust Veyra with anything -- and the
 * first screen asks for a name and three interests, not for credentials.
 *
 * The trade is explicit: lose the browser, lose the agent. That is the right
 * trade at this stage and it is said out loud in the interface rather than
 * discovered later.
 */
export const NOVA_KEY_HEADER = "x-nova-key";

export function ownerSecretFrom(request: NextRequest): string {
  return request.headers.get(NOVA_KEY_HEADER)?.trim() ?? "";
}

export function novaErrorResponse(error: unknown): NextResponse {
  if (error instanceof NovaError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(
    { error: { code: "unexpected", message: "Something went wrong reaching your agent." } },
    { status: 500, headers: { "Cache-Control": "no-store" } },
  );
}

/** Nothing Nova returns may be cached: a brief is one person's, and a cached
 *  brief is someone else's brief on a shared edge. */
export const NOVA_HEADERS = { "Cache-Control": "no-store" } as const;
