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

// One place to make a decision, one place to review the decisions already made,
// and the subsystems that feed them grouped as what they are: evidence. The
// previous five co-equal trust tools asked the visitor to know the architecture
// before they could use the product.
export const publicSidebarNavigation = [
  {
    label: "Run",
    items: [
      { href: "/run", label: "New decision", icon: "activity" },
    ],
  },
  {
    label: "Decisions",
    items: [
      { href: "/executions", label: "Executions", icon: "activity" },
      { href: "/trust/select", label: "Selections", icon: "proof" },
      { href: "/trust/mandates", label: "Mandates", icon: "passport" },
      { href: "/results", label: "Receipts", icon: "results" },
    ],
  },
  {
    label: "Agents",
    items: [
      { href: "/reputation", label: "Agent Trust", icon: "agent" },
      { href: "/trust-gate", label: "Trust Gate", icon: "passport" },
      { href: "/evaluators", label: "Evaluator", icon: "proof" },
    ],
  },
  {
    label: "Evidence",
    items: [
      { href: "/agent-runner", label: "New Report", icon: "templates" },
      { href: "/project-360", label: "Project 360", icon: "project-360" },
      { href: "/monitoring", label: "Monitoring", icon: "monitoring" },
      { href: "/trust", label: "Trust Overview", icon: "proof" },
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
