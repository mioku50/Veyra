"use client";

import type React from "react";
import { useState } from "react";
import { usePathname } from "next/navigation";
import { Sidebar, MobileSidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { MobileBottomNav } from "@/components/layout/bottom-nav";

/** Surfaces that own their entire viewport and supply their own chrome. The
 *  shell is built for browsing many tools; a single-purpose decision screen is
 *  not one of them, and nesting it inside a second palette makes both look
 *  unfinished. */
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

  /* The left rail is the console's. The public side navigates from the top bar
     and nothing else.
     A left sidebar is the right shape for an operator moving between many
     tools; it was the wrong shape for a person reading one brief, and framing
     the brief in it was what made the product read as an admin panel with a
     product inside. Four links across the top do the same job without making
     the page look like somewhere you work. */
  const isConsole = pathname === "/console" || pathname.startsWith("/console/");

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <Topbar loggedIn={loggedIn} onMenuClick={() => setMobileOpen(true)} />
      <MobileSidebar open={mobileOpen} onClose={() => setMobileOpen(false)} />
      <div className="flex flex-1">
        {isConsole ? <Sidebar /> : null}
        <div className="min-w-0 flex-1 pb-16 md:pb-0">{children}</div>
      </div>
      <MobileBottomNav />
    </div>
  );
}
