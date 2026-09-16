"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bot,
  Brain,
  CircleDot,
  Newspaper,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

/* Single source of truth: mirrored from publicSidebarNavigation in
   lib/navigation/sidebar.ts so that the bottom nav and the top bar always
   describe the same product, never two different ones. */
type BottomNavItem = { href: string; label: string; icon: LucideIcon };
const PUBLIC_BOTTOM_LINKS: ReadonlyArray<BottomNavItem> = [
  { href: "/", label: "Today", icon: Newspaper },
  { href: "/agent", label: "Agent", icon: Bot },
  { href: "/memory", label: "Memory", icon: Brain },
  { href: "/arc", label: "Arc", icon: CircleDot },
];

function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function MobileBottomNav() {
  const pathname = usePathname();

  /* Hide on console pages and on /run (full-bleed surface with its own chrome). */
  if (pathname.startsWith("/console") || pathname === "/run" || pathname.startsWith("/run/")) {
    return null;
  }

  return (
    <nav
      aria-label="Mobile bottom navigation"
      className="fixed bottom-0 left-0 right-0 z-40 flex h-16 items-center justify-around border-t border-white/10 bg-[#07090e]/95 backdrop-blur-xl lg:hidden pb-safe"
    >
      {PUBLIC_BOTTOM_LINKS.map((link) => {
        const active = isActive(pathname, link.href);
        const Icon = link.icon;
        return (
          <Link
            key={link.href}
            href={link.href}
            className={cn(
              "flex flex-col items-center justify-center gap-1 px-3 py-1.5 text-[10px] font-medium transition-colors",
              active ? "text-primary font-bold" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <div
              className={cn(
                "flex size-7 items-center justify-center rounded-lg transition-all",
                active && "bg-primary/15 text-primary shadow-[0_0_10px_rgba(123,108,255,0.4)]",
              )}
            >
              <Icon className="size-4" />
            </div>
            <span>{link.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
