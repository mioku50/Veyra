"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Bell, BellRing, ExternalLink, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";

type TrustAlert = {
  id: string;
  type: string;
  message: string;
  snapshotUrl: string;
  createdAt: string;
};

function relativeTime(value: string) {
  const seconds = Math.max(
    1,
    Math.floor((Date.now() - new Date(value).getTime()) / 1000),
  );
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/* What the alerts API says without an owner session, so the bell reads the same. */
const SESSION_REQUIRED = "A verified owner-wallet session is required.";

export function ActivityDropdown() {
  const [alerts, setAlerts] = useState<TrustAlert[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    /* Only an owner has alerts. Asked for without a session, they were a 401 on
       every page for every visitor, and an error in every console. The session
       check answers 200 either way. */
    fetch("/api/byoa/management/session", { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const session = (await response.json().catch(() => ({}))) as { authenticated?: boolean };
        if (!session.authenticated) throw new Error(SESSION_REQUIRED);
        return fetch("/api/monitoring/alerts?state=unread&limit=5", { signal: controller.signal });
      })
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as {
          alerts?: TrustAlert[];
          unreadCount?: number;
          error?: { message?: string };
        };
        if (!response.ok) throw new Error(body.error?.message ?? SESSION_REQUIRED);
        setAlerts(body.alerts ?? []);
        setUnread(body.unreadCount ?? 0);
      })
      .catch((caught) => {
        if ((caught as Error).name !== "AbortError") {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="relative"
          aria-label={`${unread} unread trust alerts`}
        >
          <Bell className="size-4" />
          {unread > 0 ? (
            <span className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
              {Math.min(unread, 9)}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-[min(390px,calc(100vw-24px))] p-0"
      >
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div>
            <p className="font-semibold">Trust Alerts</p>
            <p className="text-xs text-muted-foreground">Meaningful monitoring changes</p>
          </div>
          <BellRing className="size-4 text-muted-foreground" />
        </div>
        <div className="max-h-[360px] overflow-y-auto">
          {loading ? (
            <div className="grid gap-3 p-4">
              <div className="skeleton-shimmer h-16 rounded-md" />
              <div className="skeleton-shimmer h-16 rounded-md" />
            </div>
          ) : error ? (
            <div className="flex gap-3 p-4 text-sm text-muted-foreground">
              <XCircle className="mt-0.5 size-4 shrink-0" />
              <span>
                {error}{" "}
                <Link href="/monitoring" className="text-primary underline">
                  Verify in Monitoring
                </Link>
              </span>
            </div>
          ) : alerts.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              No unread trust changes.
            </p>
          ) : (
            alerts.map((alert) => (
              <DropdownMenuItem key={alert.id} asChild>
                <Link
                  href={alert.snapshotUrl}
                  className="grid cursor-pointer gap-2 border-b px-4 py-3 last:border-b-0"
                >
                  <div className="flex items-center justify-between gap-3">
                    <Badge variant="outline">{alert.type.replaceAll("_", " ")}</Badge>
                    <span className="text-xs text-muted-foreground">
                      {relativeTime(alert.createdAt)}
                    </span>
                  </div>
                  <p className="line-clamp-2 text-sm font-medium">{alert.message}</p>
                </Link>
              </DropdownMenuItem>
            ))
          )}
        </div>
        <DropdownMenuSeparator className="m-0" />
        <div className="p-3">
          <Button asChild variant="outline" className="w-full">
            <Link href="/alerts">
              View all alerts
              <ExternalLink />
            </Link>
          </Button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
