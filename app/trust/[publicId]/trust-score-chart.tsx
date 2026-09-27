"use client";

import { useMemo, useState } from "react";

type TrustScorePoint = {
  snapshotId: string;
  score: number | null;
  observedAt: string;
  newRiskCount: number;
  resolvedRiskCount: number;
  verifiedOnArc: boolean;
};

function shortDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

export function TrustScoreChart({ snapshots }: { snapshots: TrustScorePoint[] }) {
  const points = useMemo(
    () =>
      [...snapshots]
        .reverse()
        .filter((snapshot) => snapshot.score !== null)
        .map((snapshot, index, values) => ({
          ...snapshot,
          score: Number(snapshot.score),
          x: values.length === 1 ? 50 : (index / (values.length - 1)) * 100,
          y: 100 - Number(snapshot.score),
        })),
    [snapshots],
  );
  const [activeId, setActiveId] = useState<string | null>(
    points.at(-1)?.snapshotId ?? null,
  );
  const active = points.find((point) => point.snapshotId === activeId) ?? null;

  if (points.length === 0) {
    return (
      <p className="py-16 text-center text-sm text-muted-foreground">
        {snapshots.length === 0
          ? "Run the first check to establish a Trust Score baseline."
          : "Snapshots are verified, but the available evidence is not yet sufficient for a numeric Trust Score."}
      </p>
    );
  }

  return (
    <div className="grid gap-4">
      <div className="relative min-h-64">
        <svg
          viewBox="-9 -8 114 116"
          role="img"
          aria-label="Trust Score history from immutable monitoring snapshots"
          className="h-64 w-full overflow-visible"
          preserveAspectRatio="none"
        >
          {[0, 25, 50, 75, 100].map((score) => (
            <g key={score}>
              <line
                x1="0"
                x2="100"
                y1={100 - score}
                y2={100 - score}
                className="stroke-border"
                strokeWidth="0.5"
                vectorEffect="non-scaling-stroke"
              />
              <text
                x="-2"
                y={101 - score}
                textAnchor="end"
                className="fill-muted-foreground text-[3.5px]"
              >
                {score}
              </text>
            </g>
          ))}
          {points.length > 1 ? (
            <polyline
              points={points.map((point) => `${point.x},${point.y}`).join(" ")}
              fill="none"
              className="stroke-primary"
              strokeWidth="2.5"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
          {points.map((point) => (
            <g
              key={point.snapshotId}
              role="button"
              tabIndex={0}
              aria-label={`${shortDate(point.observedAt)} score ${point.score}`}
              onMouseEnter={() => setActiveId(point.snapshotId)}
              onFocus={() => setActiveId(point.snapshotId)}
              className="cursor-pointer outline-none"
            >
              <circle
                cx={point.x}
                cy={point.y}
                r={activeId === point.snapshotId ? 3.4 : 2.5}
                className="fill-primary stroke-background"
                strokeWidth="1.5"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          ))}
        </svg>
        {active ? (
          <div
            className="pointer-events-none absolute top-2 z-10 w-48 rounded-md border bg-popover p-3 text-xs shadow-xl"
            style={{
              /* Half the tooltip's 12rem from either edge. Clamped in percent,
                 it overhung a phone-width chart and scrolled the page sideways. */
              left: `clamp(6rem, ${active.x}%, calc(100% - 6rem))`,
              transform: "translateX(-50%)",
            }}
          >
            <p className="font-semibold">{shortDate(active.observedAt)}</p>
            <p className="mt-2 text-lg font-semibold">Score: {active.score}</p>
            <div className="mt-2 grid gap-1 text-muted-foreground">
              <p>New risks: {active.newRiskCount}</p>
              <p>Resolved risks: {active.resolvedRiskCount}</p>
              <p>{active.verifiedOnArc ? "Arc verified" : "Arc verification pending"}</p>
            </div>
          </div>
        ) : null}
      </div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{shortDate(points[0].observedAt)}</span>
        <span>{shortDate(points.at(-1)!.observedAt)}</span>
      </div>
    </div>
  );
}
