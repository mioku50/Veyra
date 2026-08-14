"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { House, ShieldCheck, Bot, Radar, FileText } from "lucide-react";
import { cn } from "@/lib/utils";

const mobileBottomLinks = [
  { href: "/", label: "Home", icon: House },
  { href: "/trust", label: "Trust", icon: ShieldCheck },
  { href: "/agent-runner", label: "Analyze", icon: Bot },
  { href: "/monitoring", label: "Monitoring", icon: Radar },
  { href: "/results", label: "Reports", icon: FileText },
];

function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function MobileBottomNav() {
  const pathname = usePathname();

  // Hide on console pages
  if (pathname.startsWith("/console")) return null;

  return (
    <nav
      aria-label="Mobile bottom navigation"
      className="fixed bottom-0 left-0 right-0 z-40 flex h-16 items-center justify-around border-t border-white/10 bg-[#07090e]/95 backdrop-blur-xl md:hidden pb-safe"
    >
      {mobileBottomLinks.map((link) => {
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
            <div className={cn("flex size-7 items-center justify-center rounded-lg transition-all", active && "bg-primary/15 text-primary shadow-[0_0_10px_rgba(61,126,255,0.4)]")}>
              <Icon className="size-4" />
            </div>
            <span>{link.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
