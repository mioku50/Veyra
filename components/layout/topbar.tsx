"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, LogOut, Wrench } from "lucide-react";
import { logout } from "@/app/actions";
import { ActivityDropdown } from "@/components/activity/ActivityDropdown";
import { Button } from "@/components/ui/button";
import { WalletWidget } from "@/components/wallet/WalletWidget";
import { BRAND } from "@/lib/brand";
import { publicSidebarNavigation } from "@/lib/navigation/sidebar";

/* The public navigation, flattened. It lived in a left rail, which is the right
   shape for an operator moving between many tools and the wrong one for a
   person reading a single brief. Four links across the top do the same job
   without making the page look like somewhere you work. */
const PUBLIC_LINKS: ReadonlyArray<{ href: string; label: string }> =
  publicSidebarNavigation.flatMap((section) =>
    section.items.map((item) => ({ href: item.href as string, label: item.label as string })));

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
              className="flex size-9 shrink-0 items-center justify-center rounded-xl from-[var(--run-accent)] to-[var(--run-accent-deep)] bg-gradient-to-b text-sm font-bold text-white shadow-[0_0_24px_rgba(123,108,255,0.35)] transition-transform duration-200 group-hover:scale-105"
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
                  <span className="hidden rounded-full border border-sky-400/30 bg-sky-400/10 px-2 py-0.5 font-medium text-sky-300 sm:inline-flex items-center text-[10px]">
                    <span className="mr-1.5 size-1.5 rounded-full bg-sky-400 animate-pulse shadow-[0_0_8px_rgba(0,208,132,0.8)]" />
                    Arc Testnet
                  </span>
                )}
              </span>
            </span>
          </Link>
        </div>

        {isConsole ? null : (
          <nav
            aria-label="Public navigation"
            data-testid="public-nav"
            /* lg, not md: at 768 the brand block, four links, the wallet widget
               and the console button together ran 819px wide and pushed the
               page into a horizontal scroll. Below that width the hamburger
               carries the same four links. */
            className="hidden min-w-0 flex-1 items-center gap-1 lg:flex"
          >
            {PUBLIC_LINKS.map((link) => {
              const active = link.href === "/"
                ? pathname === "/"
                : pathname === link.href || pathname.startsWith(`${link.href}/`);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`shrink-0 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                    active
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-primary/10 hover:text-primary"
                  }`}
                >
                  {link.label}
                </Link>
              );
            })}
          </nav>
        )}

        <div className="flex shrink-0 items-center gap-2.5">
          <ActivityDropdown />
          {/* Only where an on-chain action lives. A wallet button in the chrome
              of a page that has not asked for one tells a first-time visitor
              that this is a thing you need a wallet to use -- which is false,
              and is the first thing they read. Nova asks for a wallet on the
              card that needs it, at the moment it needs it, with the amount
              already on screen. */}
          {isConsole ? <WalletWidget compact /> : null}
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
