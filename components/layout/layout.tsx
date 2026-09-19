"use client";

import type React from "react";
import { useState } from "react";
import { usePathname } from "next/navigation";
import { Sidebar, MobileSidebar } from "@/components/layout/sidebar";
import { ArcWalletProvider } from "@/components/wallet/use-arc-wallet";
import Link from "next/link";
import { consoleSidebarNavigation } from "@/lib/navigation/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { MobileBottomNav } from "@/components/layout/bottom-nav";

export function CommandCenterLayout({
  loggedIn,
  children,
}: {
  loggedIn: boolean;
  children: React.ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname();

  /* The left rail is the console's. The public side navigates from the top bar
     and nothing else.
     A left sidebar is the right shape for an operator moving between many
     tools; it was the wrong shape for a person reading one brief, and framing
     the brief in it was what made the product read as an admin panel with a
     product inside. Four links across the top do the same job without making
     the page look like somewhere you work. */
  const isConsole = pathname === "/console" || pathname.startsWith("/console/");

  /* No background colour here on purpose. `body` carries the ground: two
     violet glows and a dust of points over a near-black purple. An opaque
     `bg-background` on this wrapper paints over all of it and the page reads
     as a flat void -- which is exactly what it did. */
  return (
    <ArcWalletProvider>
      <div className="min-h-screen text-foreground flex flex-col">
        <Topbar loggedIn={loggedIn} onMenuClick={() => setMobileOpen(true)} />
        <MobileSidebar open={mobileOpen} onClose={() => setMobileOpen(false)} />
        <div className="flex flex-1">
          {isConsole ? <Sidebar /> : null}
          <div className="min-w-0 flex-1 pb-[calc(4rem+env(safe-area-inset-bottom))] lg:pb-0">
            {!isConsole &&
            consoleSidebarNavigation.some((section) =>
              section.items.some((item) => item.href === pathname),
            ) ? (
              <div className="mx-auto max-w-6xl px-5 pt-4 text-xs">
                <Link
                  href="/console"
                  className="text-muted-foreground underline underline-offset-4"
                >
                  Developer Console
                </Link>
              </div>
            ) : null}
            {children}
          </div>
        </div>
        <MobileBottomNav />
      </div>
    </ArcWalletProvider>
  );
}
