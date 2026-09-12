"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, LogOut, Wrench } from "lucide-react";
import { logout } from "@/app/actions";
import { ActivityDropdown } from "@/components/activity/ActivityDropdown";
import { Button } from "@/components/ui/button";
import { WalletWidget } from "@/components/wallet/WalletWidget";
import { BRAND } from "@/lib/brand";

export function Topbar({
  loggedIn,
  onMenuClick,
}: {
  loggedIn: boolean;
  onMenuClick: () => void;
}) {
  const pathname = usePathname();
  const isConsole = pathname.startsWith("/console");

  return (
    <header className="sticky top-0 z-40 h-16 border-b border-white/5 bg-[#07090e]/80 backdrop-blur-xl transition-colors">
      <div className="flex h-full items-center justify-between gap-4 px-4 md:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="md:hidden hover:bg-white/10 text-muted-foreground hover:text-foreground"
            onClick={onMenuClick}
            aria-label="Open navigation"
          >
            <Menu className="size-5" />
          </Button>
          <Link href={isConsole ? "/console" : "/"} className="flex min-w-0 items-center gap-3 group">
            <span
              aria-label={`${BRAND.name} logo`}
              data-testid="brand-monogram"
              className="flex size-9 shrink-0 items-center justify-center rounded-xl from-[var(--run-mint)] to-[var(--run-mint-deep)] bg-gradient-to-b text-sm font-bold text-[#04160e] shadow-[0_0_24px_rgba(52,227,155,0.35)] transition-transform duration-200 group-hover:scale-105"
            >
              {BRAND.monogram}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-bold leading-none text-foreground tracking-tight group-hover:text-primary transition-colors">
                {isConsole ? BRAND.developerConsole : BRAND.name}
              </span>
              <span className="mt-1 inline-flex max-w-full items-center gap-2 text-xs text-muted-foreground">
                <span className="truncate">
                  {isConsole ? "Developer and operator tools" : BRAND.tagline}
                </span>
                {isConsole ? (
                  <span className="hidden rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 font-medium text-amber-300 sm:inline-flex items-center text-[10px]">
                    <span className="mr-1.5 size-1.5 rounded-full bg-amber-300 animate-pulse" />
                    Developer Mode
                  </span>
                ) : (
                  <span className="hidden rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 font-medium text-emerald-300 sm:inline-flex items-center text-[10px]">
                    <span className="mr-1.5 size-1.5 rounded-full bg-emerald-400 animate-pulse shadow-[0_0_8px_rgba(0,208,132,0.8)]" />
                    Arc Testnet
                  </span>
                )}
              </span>
            </span>
          </Link>
        </div>

        <div className="flex shrink-0 items-center gap-2.5">
          <ActivityDropdown />
          <WalletWidget compact />
          {isConsole ? (
            <>
              <Button asChild size="sm" variant="outline" className="hidden sm:inline-flex border-white/10 hover:bg-white/5">
                <Link href="/">Public App</Link>
              </Button>
              {loggedIn ? (
                <form action={logout} className="hidden lg:block">
                  <Button type="submit" variant="outline" size="sm" className="border-white/10 hover:bg-white/5">
                    <LogOut className="size-4" />
                    Logout
                  </Button>
                </form>
              ) : null}
            </>
          ) : (
            <Button asChild size="sm" variant="outline" className="hidden sm:inline-flex border-white/10 hover:bg-white/5 hover:border-primary/40">
              <Link href="/console">
                <Wrench className="size-4 text-primary" />
                {BRAND.developerConsole}
              </Link>
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}
