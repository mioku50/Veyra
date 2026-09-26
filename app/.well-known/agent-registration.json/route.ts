/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse } from "next/server";
import { veyraRegistrationFile } from "@/lib/erc8004/veyra-registration";

/* Built from constants, so it is prerendered. It changes only with a deploy:
   the agentId is added to the code after the mint. */
export const dynamic = "force-static";

/** Veyra's ERC-8004 registration file on Arc mainnet. The identity's agentURI
 *  points here. Served at this well-known path, it also shows that the
 *  domain is Veyra's. Readers of identities fetch it from anywhere. */
export function GET() {
  return NextResponse.json(veyraRegistrationFile(), {
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}
