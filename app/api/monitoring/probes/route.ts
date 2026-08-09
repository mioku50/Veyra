/**
 * Copyright 2026 Circle Internet Group, Inc.  All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server.js";
import {
  getInMemoryApiQualityAlerts,
  getInMemoryApiQualityObservations,
  runScheduledApiQualityProbes,
} from "../../../../lib/providers/api-quality.ts";

export const dynamic = "force-dynamic";

function authorized(request: NextRequest) {
  const expected = process.env.CRON_SECRET?.trim();
  const actual = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expected || !actual) return false;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

function notFound() {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}

/**
 * GET /api/monitoring/probes
 * Returns recent API quality monitoring alerts and observation metadata.
 */
export async function GET(request: NextRequest) {
  if (!authorized(request)) return notFound();
  try {
    const { searchParams } = new URL(request.url);
    const serviceId = searchParams.get("serviceId") || undefined;
    const alerts = getInMemoryApiQualityAlerts(serviceId);
    const observations = getInMemoryApiQualityObservations();

    return NextResponse.json(
      {
        ok: true,
        serviceId: serviceId || null,
        alertsCount: alerts.length,
        observationsCount: observations.length,
        alerts,
      },
      {
        status: 200,
        headers: { "Cache-Control": "no-store, max-age=0" },
      },
    );
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "probe_fetch_failed",
          message: "Probe metadata could not be loaded.",
        },
      },
      { status: 500, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }
}

/**
 * POST /api/monitoring/probes
 * Triggers scheduled or manual API quality monitoring probes across services.
 */
export async function POST(request: NextRequest) {
  if (!authorized(request)) return notFound();
  try {
    // Probe policy is server-owned. Request bodies must never be able to raise
    // the cooldown, target set, per-probe price, or daily USDC budget.
    const summary = await runScheduledApiQualityProbes({
      probeType: "availability",
      cooldownSeconds: 300,
    });

    return NextResponse.json(
      {
        ok: true,
        summary,
        alertsCount: summary.alerts.length,
        alertsTriggered: summary.alerts,
      },
      {
        status: 200,
        headers: { "Cache-Control": "no-store, max-age=0" },
      },
    );
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "probe_execution_failed",
          message: "API quality probes could not be executed.",
        },
      },
      { status: 500, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }
}
