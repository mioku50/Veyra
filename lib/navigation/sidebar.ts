export type SidebarIconName =
  | "activity"
  | "agent"
  | "my-agents"
  | "monitoring"
  | "console"
  | "dashboard"
  | "passport"
  | "project-360"
  | "proof"
  | "receipt"
  | "results"
  | "seller"
  | "templates"
  | "tools";

// Split into the two things a visitor can do, so the verification half of the
// product is discoverable instead of living only behind report links.
export const publicSidebarNavigation = [
  {
    label: "Run",
    items: [
      { href: "/", label: "Home", icon: "dashboard" },
      { href: "/agent-runner", label: "New Report", icon: "agent" },
      { href: "/project-360", label: "Project 360", icon: "project-360" },
    ],
  },
  {
    label: "Verify",
    items: [
      { href: "/monitoring", label: "Monitoring", icon: "monitoring" },
      { href: "/results", label: "Reports", icon: "results" },
    ],
  },
] as const satisfies ReadonlyArray<{
  label: string;
  items: ReadonlyArray<{ href: string; label: string; icon: SidebarIconName }>;
}>;

export const consoleSidebarNavigation = [
  {
    label: BRAND.developerConsole,
    items: [
      { href: "/console", label: "Console Home", icon: "console" },
      { href: "/console/agent-api", label: BRAND.agentApi, icon: "agent" },
      { href: "/console/agents", label: "Agent Credentials", icon: "my-agents" },
      { href: "/console/operations", label: "Operations", icon: "activity" },
      { href: "/console/audit", label: "Audit & Verification", icon: "proof" },
      { href: "/console/developer-tools", label: "Developer Tools", icon: "tools" },
    ],
  },
] as const satisfies ReadonlyArray<{
  label: string;
  items: ReadonlyArray<{ href: string; label: string; icon: SidebarIconName }>;
}>;

export const sidebarNavigation = publicSidebarNavigation;

export const DESKTOP_SIDEBAR_SCROLL_CLASS = "overflow-y-auto overscroll-contain";
export const MOBILE_SIDEBAR_SCROLL_CLASS = "overflow-y-auto overscroll-contain";
import { BRAND } from "../brand.ts";
