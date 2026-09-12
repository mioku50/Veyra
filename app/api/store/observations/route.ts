/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextRequest, NextResponse } from "next/server";
import {
  fetchApiQualityObservationsForServices,
  validatePublicServiceForQualityEvaluation,
  API_QUALITY_SERVICE_NOT_FOUND_RESPONSE,
} from "@/lib/providers/api-quality";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const servicesParam = searchParams.get("services") || searchParams.get("service") || "";
    const windowDaysParam = parseInt(searchParams.get("windowDays") || "30", 10);
    const windowDays = [7, 30, 90].includes(windowDaysParam) ? windowDaysParam : 30;

    const serviceIds = servicesParam
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (serviceIds.length === 0) {
      return NextResponse.json({
        totalObservations: 0,
        observationsByService: {},
        hasSufficientData: false,
      });
    }

    for (const serviceId of serviceIds) {
      const validService = await validatePublicServiceForQualityEvaluation(serviceId);
      if (!validService) {
        return NextResponse.json(API_QUALITY_SERVICE_NOT_FOUND_RESPONSE, { status: 404 });
      }
    }

    const obsMap = await fetchApiQualityObservationsForServices(serviceIds, windowDays);
    const observationsByService: Record<string, number> = {};
    let totalObservations = 0;

    for (const [id, obsList] of Object.entries(obsMap)) {
      const count = obsList.length;
      observationsByService[id] = count;
      totalObservations += count;
    }

    return NextResponse.json({
      totalObservations,
      observationsByService,
      hasSufficientData: totalObservations >= 10,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Unable to fetch observation counts",
        totalObservations: 0,
        observationsByService: {},
        hasSufficientData: false,
      },
      { status: 500 },
    );
  }
}
