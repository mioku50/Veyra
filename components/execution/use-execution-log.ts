"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicExecutionView } from "@/lib/execution/public-view";

export function useExecutionLog(recipient: string | null) {
  const [executions, setExecutions] = useState<PublicExecutionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updated, setUpdated] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const lastRequest = useRef<{ cursor: string | null; reset: boolean }>({
    cursor: null,
    reset: true,
  });

  const load = useCallback(
    async (next: string | null, reset: boolean) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      lastRequest.current = { cursor: next, reset };
      setLoading(true);
      setError(null);
      try {
        const query = new URLSearchParams({ limit: "25" });
        if (next) query.set("cursor", next);
        if (recipient) query.set("counterpartyWallet", recipient);
        const response = await fetch(`/api/execution/v1?${query}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!response.ok)
          throw new Error(
            "The decision log could not be loaded. Please try again.",
          );
        const data = await response.json();
        if (!Array.isArray(data.executions))
          throw new Error("The log returned an unexpected response.");
        if (controller.signal.aborted) return;
        setExecutions((previous) =>
          reset
            ? data.executions
            : [
                ...new Map(
                  [...previous, ...data.executions].map((e) => [
                    e.executionId,
                    e,
                  ]),
                ).values(),
              ],
        );
        setCursor(data.nextCursor ?? null);
        setUpdated(new Date().toISOString());
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error ? cause.message : "Could not load the log.",
          );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [recipient],
  );

  useEffect(() => {
    // Switching scope must never display another wallet's previous rows.
    setExecutions([]);
    setUpdated(null);
    setCursor(null);
    void load(null, true);
    return () => request.current?.abort();
  }, [load]);

  return {
    executions,
    loading,
    error,
    updated,
    cursor,
    refresh: () => void load(null, true),
    retry: () =>
      void load(lastRequest.current.cursor, lastRequest.current.reset),
    loadMore: () => {
      if (cursor) void load(cursor, false);
    },
  };
}
