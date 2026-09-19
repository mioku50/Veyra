"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { House, UserRoundCog, FileText, ShieldCheck } from "lucide-react";
import { publicLinks } from "@/lib/navigation/sidebar";
const icons = [House, UserRoundCog, FileText, ShieldCheck];
export function MobileBottomNav() {
  const pathname = usePathname();
  if (pathname.startsWith("/console")) return null;
  return (
    <nav
      aria-label="Mobile bottom navigation"
      className="fixed bottom-0 inset-x-0 z-40 grid grid-cols-4 border-t border-white/10 bg-[#07090e]/95 backdrop-blur-xl lg:hidden pb-[env(safe-area-inset-bottom)]"
    >
      {publicLinks.map((link, index) => {
        const active =
          pathname === link.href ||
          (link.href !== "/" && pathname.startsWith(`${link.href}/`));
        const Icon = icons[index];
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={`flex min-h-16 flex-col items-center justify-center gap-1 px-1 text-[10px] ${active ? "text-primary font-semibold" : "text-muted-foreground"}`}
          >
            <Icon className="size-5" />
            <span>{link.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
