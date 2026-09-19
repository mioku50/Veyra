"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Dialog as Drawer } from "radix-ui";
import { X } from "lucide-react";
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
  publicSidebarNavigation,
  secondaryLinks,
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

function getNavSections(
  pathname: string,
): Array<{ label: string; items: NavItem[] }> {
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

function SidebarLink({
  item,
  collapsed,
}: {
  item: NavItem;
  collapsed?: boolean;
}) {
  const pathname = usePathname();
  const active = isActive(pathname, item.href);
  const Icon = item.icon;

  return (
    <Link
      href={item.href}
      title={item.label}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex min-w-0 items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 text-sm font-medium text-muted-foreground transition-all duration-200 hover:border-white/10 hover:bg-white/5 hover:text-foreground",
        active &&
          "border-primary/40 bg-gradient-to-r from-primary/20 via-primary/10 to-transparent text-foreground shadow-[0_0_20px_rgba(123,108,255,0.15)] font-semibold",
        collapsed && "justify-center px-2",
      )}
    >
      {active && (
        <span className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-1 rounded-r-full bg-gradient-to-b from-primary to-[var(--run-accent-deep)] shadow-[0_0_8px_rgba(123,108,255,0.8)]" />
      )}
      <Icon
        className={cn(
          "size-4 shrink-0 transition-transform duration-200 group-hover:scale-110",
          active
            ? "text-primary"
            : "text-muted-foreground group-hover:text-foreground",
        )}
      />
      <span
        className={cn("min-w-0 flex-1 break-words", collapsed && "sr-only")}
      >
        {item.label}
      </span>
      {item.badge && !collapsed ? (
        <span className="rounded-full border border-primary/30 bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary">
          {item.badge}
        </span>
      ) : null}
    </Link>
  );
}

export function Sidebar({ collapsed = false }: { collapsed?: boolean }) {
  const pathname = usePathname();
  const navSections = getNavSections(pathname);

  return (
    <aside
      data-testid="desktop-sidebar"
      className={cn(
        "hidden border-r border-white/5 bg-[#080a0f]/80 backdrop-blur-2xl lg:sticky lg:top-16 lg:block lg:h-[calc(100vh-4rem)]",
        DESKTOP_SIDEBAR_SCROLL_CLASS,
        collapsed ? "w-16" : "w-60",
      )}
    >
      <div className="flex min-h-full flex-col justify-between p-3.5">
        <div className="grid gap-6">
          {navSections.map((section) => (
            <details
              key={section.label}
              open={
                section === navSections[0] ||
                section.items.some((item) => isActive(pathname, item.href))
                  ? true
                  : undefined
              }
            >
              <summary
                className={cn(
                  "mb-2.5 px-3 text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground/70",
                  collapsed && "sr-only",
                )}
              >
                {section.label}
              </summary>
              <div className="grid gap-1.5">
                {section.items.map((item) => (
                  <SidebarLink
                    key={item.href}
                    item={item}
                    collapsed={collapsed}
                  />
                ))}
              </div>
            </details>
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
              "flex items-center gap-2.5 rounded-lg border border-sky-500/20 bg-sky-500/10 px-3 py-2.5 text-xs text-sky-300 backdrop-blur-md shadow-[0_0_15px_rgba(0,208,132,0.1)]",
              collapsed && "justify-center px-2",
            )}
            title={collapsed ? "v0.2.0-beta.8" : undefined}
          >
            <div className="flex h-2 w-2 items-center justify-center">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500" />
            </div>
            {!collapsed && <span className="truncate">v0.2.0-beta.8</span>}
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
  const sections = getNavSections(pathname);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1024px)");
    const close = () => {
      if (media.matches) onClose();
    };
    media.addEventListener("change", close);
    return () => media.removeEventListener("change", close);
  }, [onClose]);
  return (
    <Drawer.Root
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-50 bg-black/70" />
        <Drawer.Content
          data-testid="mobile-sidebar"
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            document
              .querySelector<HTMLButtonElement>(
                'button[aria-label="Open navigation"]',
              )
              ?.focus();
          }}
          className="fixed inset-y-0 left-0 z-50 w-[min(320px,90vw)] overflow-y-auto bg-[#0a0d14] p-5 pt-[max(1.25rem,env(safe-area-inset-top))] shadow-2xl"
        >
          <div className="mb-6 flex items-center justify-between">
            <Drawer.Title className="text-lg font-semibold">
              {BRAND.name}
            </Drawer.Title>
            <Drawer.Close
              className="flex size-11 items-center justify-center rounded-lg hover:bg-white/10"
              aria-label="Close navigation"
            >
              <X className="size-5" />
            </Drawer.Close>
          </div>
          {sections.map((section) => (
            <div key={section.label} className="mb-5">
              <p className="mb-2 text-xs text-muted-foreground">
                {section.label}
              </p>
              <div onClick={onClose}>
                {section.items.map((item) => (
                  <SidebarLink key={item.href} item={item} />
                ))}
              </div>
            </div>
          ))}
          <div className="border-t pt-4" onClick={onClose}>
            {secondaryLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="block rounded-lg px-3 py-3 text-sm text-muted-foreground"
              >
                {link.label}
              </Link>
            ))}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
