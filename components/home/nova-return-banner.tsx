"use client";

/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import { useSyncExternalStore } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { NOVA_STORAGE_KEYS } from "@/lib/nova/storage";

function subscribeToStorage(callback: () => void) {
  window.addEventListener("storage", callback);
  return () => window.removeEventListener("storage", callback);
}

function readHasSavedAgent(): boolean {
  try {
    const id = window.localStorage.getItem(NOVA_STORAGE_KEYS.id);
    const key = window.localStorage.getItem(NOVA_STORAGE_KEYS.key);
    return Boolean(id?.trim() && key?.trim());
  } catch {
    return false;
  }
}

function getServerSnapshot(): boolean {
  return false;
}

export function NovaReturnBanner() {
  const hasAgent = useSyncExternalStore(
    subscribeToStorage,
    readHasSavedAgent,
    getServerSnapshot,
  );

  if (!hasAgent) return null;

  return (
    <div
      role="region"
      aria-label="Personal agent"
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/35 bg-primary/10 px-4 py-3 text-sm"
    >
      <p className="text-foreground">
        Your personal agent (Nova) is saved in this browser.
      </p>
      <Link
        href="/nova"
        className="inline-flex items-center gap-1.5 font-semibold text-primary underline-offset-4 hover:underline"
      >
        Continue to your agent
        <ArrowRight className="size-4" />
      </Link>
    </div>
  );
}
