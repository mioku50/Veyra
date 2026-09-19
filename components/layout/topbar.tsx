"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, MoreHorizontal } from "lucide-react";
import { ActivityDropdown } from "@/components/activity/ActivityDropdown";
import { WalletControl } from "@/components/wallet/wallet-control";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { publicLinks, secondaryLinks } from "@/lib/navigation/sidebar";
import { BRAND } from "@/lib/brand";
import { logout } from "@/app/actions";
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
    <header className="sticky top-0 z-40 h-16 border-b border-white/5 bg-[#07090e]/95 backdrop-blur-xl">
      <div className="flex h-full items-center justify-between gap-2 px-3 lg:px-5">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            size="icon"
            variant="ghost"
            className="lg:hidden shrink-0"
            onClick={onMenuClick}
            aria-label="Open navigation"
          >
            <Menu className="size-5" />
          </Button>
          <Link
            href={isConsole ? "/console" : "/"}
            className="flex min-w-0 items-center gap-2"
          >
            <span
              aria-label={`${BRAND.name} logo`}
              data-testid="brand-monogram"
              className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-sm font-bold text-white"
            >
              {BRAND.monogram}
            </span>
            <span className="hidden min-w-0 sm:block">
              <span className="block text-sm font-semibold">
                {isConsole ? BRAND.developerConsole : BRAND.name}
              </span>
              <span className="text-[10px] text-sky-300">
                {isConsole ? "Developer tools" : "Identity on Arc Testnet"}
              </span>
            </span>
          </Link>
        </div>
        {!isConsole && (
          <nav
            aria-label="Public navigation"
            data-testid="public-nav"
            className="hidden items-center gap-1 lg:flex"
          >
            {publicLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                aria-current={pathname === link.href ? "page" : undefined}
                className={`rounded-lg px-3 py-2 text-sm ${pathname === link.href ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground"}`}
              >
                {link.label}
              </Link>
            ))}
          </nav>
        )}
        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
          <WalletControl compact />
          <ActivityDropdown />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="More">
                <MoreHorizontal className="size-5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {isConsole && (
                <DropdownMenuItem asChild>
                  <Link href="/">Public App</Link>
                </DropdownMenuItem>
              )}
              {secondaryLinks.map((link) => (
                <DropdownMenuItem key={link.href} asChild>
                  <Link href={link.href}>{link.label}</Link>
                </DropdownMenuItem>
              ))}
              {loggedIn && (
                <DropdownMenuItem
                  onSelect={() => {
                    void logout();
                  }}
                >
                  Log out
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}
