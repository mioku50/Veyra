/**
 * Copyright 2026 Veyra
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BadgeCheck,
  Bot,
  ChartNoAxesCombined,
  ChevronDown,
  ClipboardCheck,
  Fuel,
  House,
  LayoutDashboard,
  ListChecks,
  LogIn,
  LogOut,
  PlusCircle,
  ReceiptText,
  Rocket,
  Sparkles,
  Store,
  type LucideIcon,
} from "lucide-react";
import { logout } from "@/app/actions";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ArcWalletWidget } from "@/components/wallet/arc-wallet-widget";
import { BRAND } from "@/lib/brand";
import { cn } from "@/lib/utils";

type GlobalNavClientProps = {
  loggedIn: boolean;
};

const primaryLinks = [
  { href: "/", label: "Home", icon: House },
  { href: "/review", label: "Review Pack", icon: ClipboardCheck },
  { href: "/launch", label: "Launch Pack", icon: Rocket },
  { href: "/demo", label: "Guided Demo", icon: Sparkles },
  { href: "/agent-runner", label: "Live Agent", icon: Bot },
  { href: "/store", label: "API Store", icon: Store },
  { href: "/agent-control", label: "Agent Control", icon: Bot },
  { href: "/agent-launch", label: "Agent Launch", icon: Fuel },
];

const activityLinks = [
  { href: "/runs", label: "Agent Runs", icon: ListChecks },
  { href: "/agents", label: "Agent Passports", icon: BadgeCheck },
  { href: "/receipts", label: "Receipts", icon: ReceiptText },
];

const sellerLinks = [
  { href: "/dashboard", label: "Seller Dashboard", icon: LayoutDashboard },
  { href: "/seller/analytics", label: "Seller Analytics", icon: ChartNoAxesCombined },
  { href: "/seller/services/new", label: "Create API Service", icon: PlusCircle },
];

function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavLink({
  href,
  label,
  icon: Icon,
  pathname,
}: {
  href: string;
  label: string;
  icon: LucideIcon;
  pathname: string;
}) {
  const active = isActive(pathname, href);

  return (
    <Link
      href={href}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary",
        active && "bg-primary/10 text-primary",
      )}
    >
      <Icon className="size-4" />
      {label}
    </Link>
  );
}

export function GlobalNavClient({ loggedIn }: GlobalNavClientProps) {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur supports-[backdrop-filter]:bg-background/78">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 px-4 py-3 sm:px-6 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link href="/" className="flex shrink-0 items-center gap-3">
            <span
              aria-label={`${BRAND.name} logo`}
              data-testid="brand-monogram"
              className="flex size-9 items-center justify-center rounded-md bg-primary text-sm font-bold text-primary-foreground shadow-sm"
            >
              {BRAND.monogram}
            </span>
            <span>
              <span className="block text-sm font-semibold leading-none text-foreground">
                {BRAND.name}
              </span>
              <span className="mt-1 block text-xs text-muted-foreground">
                {BRAND.tagline}
              </span>
            </span>
          </Link>

          <div className="flex items-center gap-2 xl:hidden">
            <ArcWalletWidget variant="compact" />
            {loggedIn ? (
              <form action={logout}>
                <Button type="submit" variant="outline" size="sm">
                  <LogOut />
                  <span className="sr-only sm:not-sr-only sm:ml-2">Logout</span>
                </Button>
              </form>
            ) : (
              <Button asChild size="sm">
                <Link href="/login">
                  <LogIn />
                  <span className="sr-only sm:not-sr-only sm:ml-2">Seller Login</span>
                </Link>
              </Button>
            )}
          </div>
        </div>

        <nav
          className="flex flex-wrap items-center gap-1 xl:flex-nowrap"
          aria-label="Public navigation"
        >
          {primaryLinks.map((link) => (
            <NavLink key={link.href} {...link} pathname={pathname} />
          ))}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                className={cn(
                  "inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary",
                  activityLinks.some((link) => isActive(pathname, link.href)) &&
                    "bg-primary/10 text-primary",
                )}
              >
                Activity
                <ChevronDown className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48">
              {activityLinks.map((link) => {
                const Icon = link.icon;
                return (
                  <DropdownMenuItem key={link.href} asChild>
                    <Link href={link.href} className="flex cursor-pointer items-center gap-2">
                      <Icon className="size-4 text-muted-foreground" />
                      {link.label}
                    </Link>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        </nav>

        <div className="flex flex-col gap-2 border-t pt-3 xl:flex-row xl:items-center xl:border-t-0 xl:pt-0">
          <div className="hidden xl:block">
            <ArcWalletWidget variant="compact" />
          </div>
          {loggedIn ? (
            <>
              <nav
                className="flex flex-wrap items-center gap-1"
                aria-label="Seller navigation"
              >
                {sellerLinks.map((link) => (
                  <NavLink key={link.href} {...link} pathname={pathname} />
                ))}
              </nav>
              <form action={logout} className="hidden xl:block">
                <Button type="submit" variant="outline" size="sm">
                  <LogOut />
                  Logout
                </Button>
              </form>
            </>
          ) : (
            <Button asChild size="sm" className="hidden xl:inline-flex">
              <Link href="/login">
                <LogIn />
                Seller Login
              </Link>
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}
