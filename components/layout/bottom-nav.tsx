"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BadgeCheck,
  FileText,
  House,
  ShieldCheck,
  UserRoundCog,
  type LucideIcon,
} from "lucide-react";
import { publicLinks } from "@/lib/navigation/sidebar";

const iconByName: Record<string, LucideIcon> = {
  proof: ShieldCheck,
  agent: House,
  "my-agents": UserRoundCog,
  results: FileText,
  passport: BadgeCheck,
};

export function MobileBottomNav() {
  const pathname = usePathname();
  if (pathname.startsWith("/console")) return null;
  return (
    <nav
      aria-label="Mobile bottom navigation"
      className="fixed bottom-0 inset-x-0 z-40 grid grid-flow-col auto-cols-fr border-t border-white/10 bg-[#07090e]/95 backdrop-blur-xl lg:hidden pb-[env(safe-area-inset-bottom)]"
    >
      {publicLinks.map((link) => {
        const active =
          pathname === link.href ||
          (link.href !== "/" && pathname.startsWith(`${link.href}/`));
        const Icon = iconByName[link.icon] ?? ShieldCheck;
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={`flex min-h-16 flex-col items-center justify-center gap-1 px-1 text-[10px] ${active ? "text-primary font-semibold" : "text-muted-foreground"}`}
          >
            <Icon className="size-5" />
            <span className="text-center leading-tight">{link.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
