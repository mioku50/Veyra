"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  BadgeCheck,
  Bot,
  FileText,
  Github,
  House,
  Layers,
  LayoutTemplate,
  ReceiptText,
  ShieldCheck,
  Radar,
  Store,
  Terminal,
  Wrench,
  UserRoundCog,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DESKTOP_SIDEBAR_SCROLL_CLASS,
  MOBILE_SIDEBAR_SCROLL_CLASS,
  publicSidebarNavigation,
  consoleSidebarNavigation,
  type SidebarIconName,
} from "@/lib/navigation/sidebar";
import { BRAND } from "@/lib/brand";

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  badge?: string;
};

const iconByName: Record<SidebarIconName, LucideIcon> = {
  activity: Activity,
  agent: Bot,
  "my-agents": UserRoundCog,
  monitoring: Radar,
  console: Terminal,
  dashboard: House,
  passport: BadgeCheck,
  "project-360": Layers,
  proof: ShieldCheck,
  receipt: ReceiptText,
  results: FileText,
  seller: Store,
  templates: LayoutTemplate,
  tools: Wrench,
};

function getNavSections(pathname: string): Array<{ label: string; items: NavItem[] }> {
  const navigation = pathname.startsWith("/console")
    ? consoleSidebarNavigation
    : publicSidebarNavigation;
  return navigation.map((section) => ({
    label: section.label,
    items: section.items.map((item) => ({
      ...item,
      icon: iconByName[item.icon],
    })),
  }));
}

function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  if (href === "/console") return pathname === "/console";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function SidebarLink({ item, collapsed }: { item: NavItem; collapsed?: boolean }) {
  const pathname = usePathname();
  const active = isActive(pathname, item.href);
  const Icon = item.icon;

  return (
    <Link
      href={item.href}
      title={collapsed ? item.label : undefined}
      className={cn(
        "group relative flex min-w-0 items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 text-sm font-medium text-muted-foreground transition-all duration-200 hover:border-white/10 hover:bg-white/5 hover:text-foreground",
        active &&
          "border-primary/40 bg-gradient-to-r from-primary/20 via-primary/10 to-transparent text-foreground shadow-[0_0_20px_rgba(61,126,255,0.15)] font-semibold",
        collapsed && "justify-center px-2",
      )}
    >
      {active && (
        <span className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-1 rounded-r-full bg-gradient-to-b from-primary to-cyan-400 shadow-[0_0_8px_rgba(61,126,255,0.8)]" />
      )}
      <Icon
        className={cn(
          "size-4 shrink-0 transition-transform duration-200 group-hover:scale-110",
          active ? "text-primary" : "text-muted-foreground group-hover:text-foreground",
        )}
      />
      <span className={cn("min-w-0 flex-1 truncate", collapsed && "sr-only")}>
        {item.label}
      </span>
      {item.badge && !collapsed ? (
        <span className="rounded-full border border-primary/30 bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-cyan-300">
          {item.badge}
        </span>
      ) : null}
    </Link>
  );
}

export function Sidebar({ collapsed = false }: { collapsed?: boolean }) {
  const pathname = usePathname();
  const navSections = getNavSections(pathname);
  const isConsole = pathname.startsWith("/console");

  return (
    <aside
      data-testid="desktop-sidebar"
      className={cn(
        "hidden border-r border-white/5 bg-[#080a0f]/80 backdrop-blur-2xl md:sticky md:top-16 md:block md:h-[calc(100vh-4rem)]",
        DESKTOP_SIDEBAR_SCROLL_CLASS,
        collapsed ? "w-16" : "w-60",
      )}
    >
      <div className="flex min-h-full flex-col justify-between p-3.5">
        <div className="grid gap-6">
          {navSections.map((section) => (
            <div key={section.label}>
              <p
                className={cn(
                  "mb-2.5 px-3 text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground/70",
                  collapsed && "sr-only",
                )}
              >
                {section.label}
              </p>
              <div className="grid gap-1.5">
                {section.items.map((item) => (
                  <SidebarLink key={item.href} item={item} collapsed={collapsed} />
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-auto grid gap-2.5 border-t border-white/5 pt-4">
          <Link
            href="https://github.com/mioku50/Veyra#readme"
            target="_blank"
            rel="noreferrer"
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-muted-foreground transition-all duration-200 hover:bg-white/5 hover:text-foreground",
              collapsed && "justify-center px-2",
            )}
            title={collapsed ? "View README" : undefined}
          >
            <Github className="size-4" />
            <span className={cn(collapsed && "sr-only")}>View README</span>
          </Link>
          <div
            className={cn(
              "flex items-center gap-2.5 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2.5 text-xs text-emerald-300 backdrop-blur-md shadow-[0_0_15px_rgba(0,208,132,0.1)]",
              collapsed && "justify-center px-2",
            )}
            title={collapsed ? "v0.2.0-beta.4 · System Operational" : undefined}
          >
            <span className="relative flex size-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex size-2 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(0,208,132,0.8)]" />
            </span>
            <span className={cn("font-semibold tracking-wide", collapsed && "sr-only")}>
              v0.2.0-beta.4 · System Operational
            </span>
          </div>
        </div>
      </div>
    </aside>
  );
}

export function MobileSidebar({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const pathname = usePathname();
  const navSections = getNavSections(pathname);
  const isConsole = pathname.startsWith("/console");

  return (
    <div
      data-testid="mobile-sidebar"
      aria-hidden={!open}
      className={cn("fixed inset-0 z-50 md:hidden", !open && "pointer-events-none")}
    >
      <button
        type="button"
        aria-label="Close navigation"
        className={cn(
          "absolute inset-0 bg-black/70 backdrop-blur-sm transition-opacity duration-300",
          open ? "opacity-100" : "opacity-0",
        )}
        onClick={onClose}
      />
      <div
        className={cn(
          "absolute left-0 top-0 h-full w-[min(300px,85vw)] border-r border-white/10 bg-[#0a0d14]/95 p-5 shadow-2xl backdrop-blur-2xl transition-transform duration-300 cubic-bezier(0.32, 0.72, 0, 1)",
          MOBILE_SIDEBAR_SCROLL_CLASS,
          open ? "translate-x-0" : "-translate-x-full",
        )}
        role="dialog"
        aria-label="Primary navigation"
      >
        <div className="mb-6 flex items-center gap-3 border-b border-white/5 pb-4">
          <span
            aria-label={`${BRAND.name} logo`}
            data-testid="brand-monogram"
            className="flex size-10 items-center justify-center rounded-xl bg-gradient-to-br from-primary via-blue-600 to-cyan-400 text-sm font-bold text-white shadow-[0_0_20px_rgba(61,126,255,0.4)]"
          >
            {BRAND.monogram}
          </span>
          <div>
            <p className="text-sm font-bold tracking-tight text-foreground">
              {isConsole ? BRAND.developerConsole : BRAND.name}
            </p>
            <p className="text-xs text-muted-foreground">
              {isConsole ? "Developer and operator tools" : BRAND.tagline}
            </p>
          </div>
        </div>
        <div className="grid gap-6">
          {navSections.map((section) => (
            <div key={section.label}>
              <p className="mb-2 px-1 text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground/70">
                {section.label}
              </p>
              <div className="grid gap-1.5" onClick={onClose}>
                {section.items.map((item) => (
                  <SidebarLink key={item.href} item={item} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
