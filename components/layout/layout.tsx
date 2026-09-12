"use client";

import type React from "react";
import { useState } from "react";
import { usePathname } from "next/navigation";
import { Sidebar, MobileSidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { MobileBottomNav } from "@/components/layout/bottom-nav";

/** Surfaces that own their entire viewport and supply their own chrome. The
 *  command-centre shell is built for browsing many tools; a single-purpose
 *  decision screen is not one of them, and nesting it inside a second palette
 *  makes both look unfinished. */
const FULL_BLEED_ROUTES = ["/run"];

export function CommandCenterLayout({
  loggedIn,
  children,
}: {
  loggedIn: boolean;
  children: React.ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname();

  if (FULL_BLEED_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`))) {
    return <>{children}</>;
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <Topbar loggedIn={loggedIn} onMenuClick={() => setMobileOpen(true)} />
      <MobileSidebar open={mobileOpen} onClose={() => setMobileOpen(false)} />
      <div className="flex flex-1">
        <Sidebar />
        <div className="min-w-0 flex-1 pb-16 md:pb-0">{children}</div>
      </div>
      <MobileBottomNav />
    </div>
  );
}
